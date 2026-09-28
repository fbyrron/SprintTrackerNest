// src/sidebar.ts
//
// The webview view surfaces for SprintTrackerNest.
//
// SprintTrackerNest contributes THREE native webview views inside the
// `sprintpulse` view container (so VS Code draws real collapsible headers per
// view):
//   - sprintpulse.currentSprint  → current sprint + health
//   - sprintpulse.roadmap        → "Jira Tickets": ticket progress + next
//                                   sprint collapsibles + "Open Board" block
//   - sprintpulse.settings       → account line + connect/board/refresh actions
//
// Rather than one provider class per view, we use a SINGLE reusable provider
// (`SidebarProvider`) parameterized with:
//   - the view id (must match `contributes.views.sprintpulse[].id`)
//   - the HTML asset filename to load (currentSprint.html / roadmap.html /
//     settings.html)
//   - the set of extra command messages the view may send the host, wired via
//     an `onMessage` callback the host supplies.
//
// It does NOT recompute any business value (Requirement 17.2). The extension
// host owns building the view model via `buildViewModel`; each provider obtains
// the current view model through a supplied getter and only forwards it to its
// webview as a `{type:"viewModel"}` message.
//
// Messaging protocol (see design "Webview Messaging Protocol"):
//   host → webview:  { type: "viewModel"; payload: SprintViewModel }
//                    { type: "error"; message: string }
//                    { type: "boardState"; boardUrl: string | null }
//                    { type: "accountState"; connected: boolean;
//                      displayName: string | null }
//                    { type: "syncState"; lastFetchedIso: string | null }
//                    { type: "ticketBoard"; payload: TicketBoardData | null }
//                    { type: "notConnected" } | { type: "connectedNoBoard" }
//   webview → host:  { type: "ready" } | { type: "refresh" }
//                    | { type: "openBoard" } | { type: "setBoardId" }
//                    | { type: "connectJira" } | { type: "disconnectJira" }

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { SprintViewModel } from "../core/types";
import type { TicketBoardData } from "./jira/ticketBoard";

/**
 * Callback the extension host supplies so the provider can pull the current
 * view model on demand. The host owns computation; returning `null`/`undefined`
 * means "nothing to render yet" and the provider simply skips the push rather
 * than clearing the panel.
 */
export type ViewModelGetter = () => SprintViewModel | null | undefined;

/**
 * Callback invoked when the webview posts a command message the host must act
 * on (e.g. `openBoard`, `setBoardId`). `ready`/`refresh` are handled internally
 * and are NOT forwarded here.
 */
export type WebviewCommandHandler = (type: string) => void;

/** Host → webview message shape carrying the single view model. */
interface ViewModelMessage {
  type: "viewModel";
  payload: SprintViewModel;
}

/** Host → webview error message shape (rendered in the sidebar error card). */
interface ErrorMessage {
  type: "error";
  message: string;
}

/**
 * Host → webview not-connected message. Being disconnected is NOT an error, so
 * it is a distinct message (never the red error card). Views render a calm,
 * muted empty state on receipt. Carries no payload.
 */
interface NotConnectedMessage {
  type: "notConnected";
}

/**
 * Host → webview connected-but-no-board message. Like {@link NotConnectedMessage}
 * this is NOT an error — Jira is connected but no scrum board id is set yet, so
 * there is nothing to fetch. Views render a calm, muted empty state with copy
 * that nudges the user to set a board in Settings. Carries no payload.
 */
interface ConnectedNoBoardMessage {
  type: "connectedNoBoard";
}

/** Host → webview board-state message (drives the roadmap "Open Board" button). */
interface BoardStateMessage {
  type: "boardState";
  boardUrl: string | null;
}

/**
 * Host → webview account-state message. Drives the settings view's account name
 * line (shown only when connected) and its "Connect Jira" / "Disconnect Jira"
 * label. `displayName` is `null` until real account data is available.
 */
interface AccountStateMessage {
  type: "accountState";
  connected: boolean;
  displayName: string | null;
}

/**
 * Host → webview sync-state message. Drives the settings view's
 * "Last synced: <date+time>" / "Never synced" line. `lastFetchedIso` is an ISO
 * string of the last successful fetch, or null when nothing has been fetched.
 */
interface SyncStateMessage {
  type: "syncState";
  lastFetchedIso: string | null;
}

/**
 * Host → webview ticket-board message. Drives the "Jira Tickets" (roadmap) view:
 * the ticket progress bar (done/total) plus one collapsible sub-group per board
 * column listing the connected user's tickets. `payload` is null when not
 * connected / on error / no active sprint ⇒ the view clears its columns.
 */
interface TicketBoardMessage {
  type: "ticketBoard";
  payload: TicketBoardData | null;
}

/**
 * Host → webview loading message. Drives each view's loading spinner overlay.
 * While `isLoading` is true a view shows its spinner WITHOUT clearing the
 * currently-rendered content; when false the spinner is hidden. Broadcast to
 * all views around each fetch.
 */
interface LoadingMessage {
  type: "loading";
  isLoading: boolean;
}

/** The current Jira account state, as supplied by the host getter. */
export interface AccountState {
  readonly connected: boolean;
  readonly displayName: string | null;
}

/** Any message the host may send a webview. */
type OutboundMessage =
  | ViewModelMessage
  | ErrorMessage
  | NotConnectedMessage
  | ConnectedNoBoardMessage
  | BoardStateMessage
  | AccountStateMessage
  | SyncStateMessage
  | TicketBoardMessage
  | LoadingMessage;

/** Webview → host message shapes. */
interface WebviewInboundMessage {
  type?: unknown;
}

/**
 * Options that specialize a {@link SidebarProvider} instance for one view.
 */
export interface SidebarProviderOptions {
  /** The webview view id; must match the `package.json` views contribution. */
  readonly viewId: string;
  /** The HTML asset filename under `webview/` to load for this view. */
  readonly htmlFile: string;
  /**
   * Optional handler for command messages the webview posts (other than the
   * internal `ready`/`refresh`). The provider calls this after its own
   * bookkeeping so the host can act (open board, prompt for id, etc.).
   */
  readonly onMessage?: WebviewCommandHandler;
  /**
   * Optional getter for the current board URL. When provided, the provider
   * sends a `{type:"boardState"}` message alongside each view-model push so the
   * roadmap view can enable/disable its "Open Board" button. `undefined`/`null`
   * ⇒ no board configured yet.
   */
  readonly getBoardUrl?: () => string | null | undefined;
  /**
   * Optional getter for the current Jira account state. When provided, the
   * provider sends a `{type:"accountState"}` message alongside each push so the
   * settings view can show/hide the account name and drive its Connect /
   * Disconnect label. `undefined` ⇒ treated as not connected.
   */
  readonly getAccountState?: () => AccountState | null | undefined;
  /**
   * Optional getter for the last-successful-fetch ISO timestamp. When provided,
   * the provider sends a `{type:"syncState"}` message alongside each push so the
   * settings view can render "Last synced: …" / "Never synced". `null`/
   * `undefined` ⇒ never synced.
   */
  readonly getSyncStateIso?: () => string | null | undefined;
  /**
   * Optional getter for the current ticket-board data. When provided, the
   * provider sends a `{type:"ticketBoard"}` message alongside each push so the
   * roadmap view can render its per-column ticket lists + progress bar.
   * `null`/`undefined` ⇒ the view clears its columns (not connected / error /
   * no active sprint).
   */
  readonly getTicketBoard?: () => TicketBoardData | null | undefined;
  /**
   * Optional callback the host supplies so the provider can ask the host to
   * (re)push the CURRENT top-level app state to THIS one provider — the same
   * thing the host's `pushToSidebar` does for all providers, but scoped to a
   * single view. Unlike the ad-hoc pushViewModel/pushBoardState/... sequence,
   * this includes the calm not-connected / connected-no-board signals, so a
   * view that has just resolved immediately shows the correct state instead of
   * sitting in its default (empty + 0/0) HTML. The provider invokes it from the
   * `ready` handshake and on becoming visible again.
   */
  readonly pushCurrentState?: (provider: SidebarProvider) => void;
}

/**
 * A reusable `WebviewViewProvider` for the SprintPulse views.
 *
 * Construct with the extension URI (to locate `webview/` assets), the
 * view-model getter, and the per-view {@link SidebarProviderOptions}.
 * `extension.ts` registers one instance per view id and calls
 * {@link pushViewModel} whenever the data store changes.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getViewModel: ViewModelGetter,
    private readonly options: SidebarProviderOptions
  ) {}

  /** The view id this provider serves. */
  public get viewId(): string {
    return this.options.viewId;
  }

  /**
   * Called by VS Code when the view first becomes visible (and again if it is
   * disposed and re-created). Wires up options, HTML, and the message loop.
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    const webview = webviewView.webview;
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, "webview");

    webview.options = {
      enableScripts: true,
      // Restrict resource loading to the extension's webview asset folder.
      localResourceRoots: [webviewRoot]
    };

    webview.html = this.buildHtml(webview, webviewRoot);

    // Webview → host messages.
    this.disposables.push(
      webview.onDidReceiveMessage((message: WebviewInboundMessage) => {
        const type =
          message && typeof message === "object" && typeof message.type === "string"
            ? message.type
            : undefined;
        if (type === undefined) {
          return;
        }
        // Requirement 17.3 + FIX 1: on the ready handshake, (re)send the
        // CURRENT top-level app state to this view via the host's
        // pushCurrentState callback. That includes the calm not-connected /
        // connected-no-board signals — not just the view model — so the view
        // shows the correct calm state the instant it resolves (no blank, no
        // stale 0/0 bar, no need to click Refresh). Fall back to the ad-hoc
        // per-message pushes when no callback was supplied.
        if (type === "ready") {
          this.pushCurrentState();
          return;
        }
        // `refresh` re-pushes the current state immediately (so the panel never
        // looks stale) AND is forwarded to the host so it can run a real Jira
        // fetch and re-push the fresh state when it completes.
        if (type === "refresh") {
          this.pushCurrentState();
          this.options.onMessage?.(type);
          return;
        }
        // Any other command message is forwarded to the host handler.
        this.options.onMessage?.(type);
      })
    );

    // Recover a dropped `ready` handshake: if the view is revealed again, push
    // the current state so the panel is never left empty. Re-sending is
    // harmless (the webview just re-renders the same payload).
    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.pushCurrentState();
        }
      })
    );

    webviewView.onDidDispose(() => {
      this.dispose();
      this.view = undefined;
    });
  }

  /**
   * Send the current view model to the webview as a `{type:"viewModel"}`
   * message (Requirements 17.2, 17.3).
   *
   * No-ops when the view is not resolved or the host has no view model yet.
   */
  public pushViewModel(): void {
    if (!this.view) {
      return;
    }
    const vm = this.getViewModel();
    if (vm === null || vm === undefined) {
      return;
    }
    const message: ViewModelMessage = { type: "viewModel", payload: vm };
    this.postMessage(message);
  }

  /**
   * Send the current board-URL state to the webview (roadmap view only cares).
   * No-ops when the view is not resolved or no `getBoardUrl` was supplied.
   */
  public pushBoardState(): void {
    if (!this.view || !this.options.getBoardUrl) {
      return;
    }
    const url = this.options.getBoardUrl();
    this.postMessage({ type: "boardState", boardUrl: url ?? null });
  }

  /**
   * Send the current Jira account state to the webview (settings view cares).
   * No-ops when the view is not resolved or no `getAccountState` was supplied.
   */
  public pushAccountState(): void {
    if (!this.view || !this.options.getAccountState) {
      return;
    }
    const account = this.options.getAccountState();
    this.postMessage({
      type: "accountState",
      connected: account?.connected ?? false,
      displayName: account?.displayName ?? null,
    });
  }

  /**
   * Send the last-synced timestamp to the webview (settings view cares).
   * No-ops when the view is not resolved or no `getSyncStateIso` was supplied.
   */
  public pushSyncState(): void {
    if (!this.view || !this.options.getSyncStateIso) {
      return;
    }
    const iso = this.options.getSyncStateIso();
    this.postMessage({ type: "syncState", lastFetchedIso: iso ?? null });
  }

  /**
   * Send the current ticket-board data to the webview (roadmap view cares).
   * No-ops when the view is not resolved or no `getTicketBoard` was supplied.
   * A `null`/`undefined` payload is sent through so the view can clear its
   * columns.
   */
  public pushTicketBoard(): void {
    if (!this.view || !this.options.getTicketBoard) {
      return;
    }
    const board = this.options.getTicketBoard();
    this.postMessage({ type: "ticketBoard", payload: board ?? null });
  }

  /**
   * Broadcast the current loading state to this webview as
   * `{type:"loading", isLoading}`. The webview shows/hides its spinner overlay
   * WITHOUT clearing existing content. No-ops when the view is not resolved.
   */
  public setLoading(isLoading: boolean): void {
    if (!this.view) {
      return;
    }
    this.postMessage({ type: "loading", isLoading });
  }

  /**
   * Send an error/prompt message to the webview's error card as
   * `{type:"error", message}`. No-ops when the view is not resolved.
   */
  public postError(message: string): void {
    if (!this.view) {
      return;
    }
    this.postMessage({ type: "error", message });
  }

  /**
   * Send the not-connected signal to the webview as `{type:"notConnected"}`.
   * Distinct from {@link postError}: being disconnected is not an error, so the
   * view renders a calm muted empty state instead of the red error card.
   * No-ops when the view is not resolved.
   */
  public pushNotConnected(): void {
    if (!this.view) {
      return;
    }
    this.postMessage({ type: "notConnected" });
  }

  /**
   * Send the connected-but-no-board signal to the webview as
   * `{type:"connectedNoBoard"}`. Mirrors {@link pushNotConnected}: Jira is
   * connected but no board id is set, so the view shows a calm muted empty
   * state (never the red error card) nudging the user to set a board.
   * No-ops when the view is not resolved.
   */
  public pushConnectedNoBoard(): void {
    if (!this.view) {
      return;
    }
    this.postMessage({ type: "connectedNoBoard" });
  }

  /**
   * (Re)push the CURRENT top-level app state to THIS view.
   *
   * Delegates to the host-supplied `pushCurrentState` callback when present so
   * the host decides which top-level signal to send (notConnected /
   * connectedNoBoard / error / viewModel+ticketBoard) plus account/board/sync.
   * This is what the `ready` handshake and visibility handler call so a view
   * shows the correct calm state the instant it resolves. Falls back to the
   * legacy per-message push sequence when no callback was supplied.
   */
  public pushCurrentState(): void {
    if (!this.view) {
      return;
    }
    if (this.options.pushCurrentState) {
      this.options.pushCurrentState(this);
      return;
    }
    // Legacy fallback (no callback supplied): the ad-hoc push sequence.
    this.pushViewModel();
    this.pushBoardState();
    this.pushAccountState();
    this.pushSyncState();
    this.pushTicketBoard();
  }

  /**
   * True when the webview view has been resolved and is currently visible.
   */
  public isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  /** Dispose the message/visibility listeners registered during resolve. */
  public dispose(): void {
    while (this.disposables.length > 0) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {
        // Ignore disposal errors — nothing actionable at teardown.
      }
    }
  }

  /**
   * Post a message to the webview, swallowing any failure.
   *
   * A dropped/failed post must never propagate into the host. The `ready`
   * handshake recovery on the next reveal covers the case where a push is lost.
   */
  private postMessage(message: OutboundMessage): void {
    if (!this.view) {
      return;
    }
    try {
      void Promise.resolve(this.view.webview.postMessage(message)).catch(() => {
        /* swallow — recovered on next reveal via the ready handshake */
      });
    } catch {
      /* swallow — recovered on next reveal via the ready handshake */
    }
  }

  /**
   * Load this view's HTML from disk and rewrite it for the webview:
   * - inject a CSP with the real `webview.cspSource` and a per-load nonce,
   * - rewrite the css/js asset references to webview URIs via
   *   `webview.asWebviewUri`,
   * - stamp the script nonce.
   *
   * Each HTML template carries `%CSP%` and `%NONCE%` placeholders. Asset
   * references are rewritten by matching any `href="*.css"` and `src="*.js"`
   * attribute so the same routine serves all three views regardless of which
   * per-view script/stylesheet they name.
   */
  private buildHtml(webview: vscode.Webview, webviewRoot: vscode.Uri): string {
    const nonce = createNonce();

    // Lock the webview down: only our styles, only our nonce'd script, no
    // remote content, no inline handlers.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    let html: string;
    try {
      const htmlPath = path.join(webviewRoot.fsPath, this.options.htmlFile);
      html = fs.readFileSync(htmlPath, "utf8");
    } catch {
      // If the asset is missing we still return a minimal, non-empty document
      // so the panel is never blank.
      return fallbackHtml(csp, nonce);
    }

    return html
      .replace(/%CSP%/g, csp)
      .replace(/%NONCE%/g, nonce)
      // Rewrite any relative *.css href to its webview URI.
      .replace(/href="([^"?:]+\.css)"/g, (_m, file: string) => {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, file));
        return `href="${uri.toString()}"`;
      })
      // Rewrite any relative *.js src to its webview URI.
      .replace(/src="([^"?:]+\.js)"/g, (_m, file: string) => {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, file));
        return `src="${uri.toString()}"`;
      });
  }
}

/** Build a random nonce for the CSP `script-src`. */
function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Minimal non-empty document rendered only if a view's HTML cannot be read.
 * Keeps the promise that the panel is never left blank.
 */
function fallbackHtml(csp: string, nonce: string): string {
  return [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="UTF-8" />`,
    `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    `<title>SprintTrackerNest</title>`,
    `</head>`,
    `<body>`,
    `<main><p>SprintTrackerNest view assets could not be loaded.</p></main>`,
    `<script nonce="${nonce}"></script>`,
    `</body>`,
    `</html>`
  ].join("\n");
}
