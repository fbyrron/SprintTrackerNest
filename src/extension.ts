// src/extension.ts
//
// The extension entry point for SprintTrackerNest.
//
// This is the host wiring layer (it imports `vscode`). Its job is to:
// activate/deactivate, register commands, register the three webview views, and
// push a single computed view model to all surfaces (status bar + 3 sidebar
// views) without recomputing per-surface (Requirements 17.1, 17.2).
//
// DATA SOURCE — Jira is the primary source. When connected AND a board id is
// set, the host fetches board data from Jira, maps it to the SAME `SprintData`
// shape the pure core already consumes, validates it via `loadSprintData`, and
// builds the view model via `buildViewModel`. When NOT connected the host shows
// the not-connected state, and when connected WITHOUT a board it shows the
// distinct connected-no-board state (both: status bar "Connect here…" + a calm
// prompt in the sidebar) and does NOT fetch or read any sample JSON.
//
// All business computation is delegated to the pure core
// (`core/sprintEngine.ts`); this file never reimplements it.

import * as vscode from "vscode";

import { buildViewModel, loadSprintData, SprintDataError } from "../core/sprintEngine";
import type { SprintViewModel } from "../core/types";
import type { AccountState } from "./sidebar";
import type { TicketBoardData } from "./jira/ticketBoard";
import {
  createStatusBarItem,
  renderStatusBar,
  renderStatusBarError,
  OPEN_SIDEBAR_COMMAND,
  SPRINT_DATA_UNREADABLE_TEXT,
  CONNECT_PROMPT_TEXT,
} from "./statusBar";
import { SidebarProvider } from "./sidebar";
import { JiraAuth } from "./jira/auth";
import { JiraClient, JiraClientError } from "./jira/client";

/**
 * The three native webview view ids contributed under the `sprintpulse` view
 * container (see `package.json` → `contributes.views.sprintpulse`).
 */
const CURRENT_SPRINT_VIEW_ID = "sprintpulse.currentSprint";
const ROADMAP_VIEW_ID = "sprintpulse.roadmap";
const SETTINGS_VIEW_ID = "sprintpulse.settings";

/**
 * globalState key for the last SUCCESSFUL fetch cache (FIX 2). Holds only
 * non-secret sprint/ticket data so startup is never blank: on activate we
 * hydrate from it immediately, then a background fetch swaps in fresh data.
 */
const CACHE_KEY = "sprintpulse.cache.v1";

/**
 * The shape persisted in globalState under {@link CACHE_KEY}.
 *
 * We store the raw `SprintData` JSON string we already pass to
 * `loadSprintData` (rebuilding via loadSprintData + buildViewModel on startup
 * keeps the pure core the source of truth), plus the built ticket board, the
 * fetch timestamp, and the board id the data was fetched for (so a stale cache
 * for a DIFFERENT board is ignored). Contains no secrets — never the token.
 */
interface FetchCache {
  readonly version: 1;
  readonly boardId: string;
  readonly sprintDataJson: string;
  readonly ticketBoard: TicketBoardData;
  readonly fetchedAtIso: string;
}

/** Command ids. */
const REFRESH_COMMAND = "sprintpulse.refresh";
const CONNECT_JIRA_COMMAND = "sprintpulse.connectJira";
const DISCONNECT_JIRA_COMMAND = "sprintpulse.disconnectJira";
const SET_BOARD_ID_COMMAND = "sprintpulse.setBoardId";

/**
 * The top-level states the app can be in.
 *   - not-connected:      NO credentials (the connect-prompt state)
 *   - connected-no-board: connected but NO board id set — nothing to fetch yet
 *   - ok:                 a view model built from fresh (or last-good) Jira data
 *   - unreadable:         a fetch/validation error carrying a readable message
 */
type AppState =
  | { readonly kind: "ok"; readonly viewModel: SprintViewModel }
  | { readonly kind: "not-connected" }
  | { readonly kind: "connected-no-board" }
  | { readonly kind: "unreadable"; readonly message: string };

// ---------------------------------------------------------------------------
// Module-level handles owned across activate/deactivate.
// ---------------------------------------------------------------------------

let statusBarItem: vscode.StatusBarItem | undefined;
let sidebarProviders: SidebarProvider[] = [];

let auth: JiraAuth | undefined;
let client: JiraClient | undefined;

/** The ExtensionContext, retained so the fetch cache can read/write globalState. */
let extensionContext: vscode.ExtensionContext | undefined;

/** The most recently computed app state; read by the sidebar view-model getter. */
let currentState: AppState = { kind: "not-connected" };

/** The last successfully fetched view model, cached across transient errors. */
let lastGoodViewModel: SprintViewModel | null = null;

/**
 * The ticket-board data (per-column tickets + progress counts) for the current
 * ok state, or null when not-connected / error / no active sprint. Cached
 * alongside `lastGoodViewModel` and pushed to the roadmap view. It flows
 * OUTSIDE the SprintViewModel by design.
 */
let currentTicketBoard: TicketBoardData | null = null;

/** ISO string of the last successful fetch, or null when never fetched. */
let lastFetchedIso: string | null = null;

/** True while a fetch is in flight, to avoid overlapping fetches. */
let fetching = false;

/**
 * Activate the extension: construct auth/client, own the status bar, register
 * commands + the three views, then run the initial fetch/render.
 */
export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  auth = new JiraAuth(context);
  client = new JiraClient(auth);

  // Own the single status bar item (bound to the sidebar command inside).
  statusBarItem = createStatusBarItem();
  context.subscriptions.push(statusBarItem);

  const getViewModel = () =>
    currentState.kind === "ok" ? currentState.viewModel : null;

  const currentSprintProvider = new SidebarProvider(context.extensionUri, getViewModel, {
    viewId: CURRENT_SPRINT_VIEW_ID,
    htmlFile: "currentSprint.html",
    pushCurrentState: pushCurrentStateToProvider,
  });

  const roadmapProvider = new SidebarProvider(context.extensionUri, getViewModel, {
    viewId: ROADMAP_VIEW_ID,
    htmlFile: "roadmap.html",
    getBoardUrl,
    getAccountState,
    getSyncStateIso,
    getTicketBoard,
    onMessage: handleWebviewCommand,
    pushCurrentState: pushCurrentStateToProvider,
  });

  const settingsProvider = new SidebarProvider(context.extensionUri, getViewModel, {
    viewId: SETTINGS_VIEW_ID,
    htmlFile: "settings.html",
    getBoardUrl,
    getAccountState,
    getSyncStateIso,
    getTicketBoard,
    onMessage: handleWebviewCommand,
    pushCurrentState: pushCurrentStateToProvider,
  });

  sidebarProviders = [currentSprintProvider, roadmapProvider, settingsProvider];

  for (const provider of sidebarProviders) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(provider.viewId, provider)
    );
  }

  // The status-bar click reveals the sidebar only (no fetch).
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_SIDEBAR_COMMAND, openSidebar)
  );

  // Refresh: the ONLY path that pulls sprint + ticket data from Jira.
  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      void fetchAndRender();
    })
  );

  // Connect / disconnect / set-board commands.
  context.subscriptions.push(
    vscode.commands.registerCommand(CONNECT_JIRA_COMMAND, connectJira)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(DISCONNECT_JIRA_COMMAND, disconnectJira)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(SET_BOARD_ID_COMMAND, setBoardId)
  );

  // Hydrate from the last SUCCESSFUL fetch cache (FIX 2) so the views + status
  // bar show last-known data IMMEDIATELY on startup instead of blank/error,
  // then the background fetch below swaps in fresh data.
  hydrateFromCache();

  // Initial render: reflect the current (possibly hydrated) state, then do the
  // initial fetch so the HUD refreshes on startup.
  renderCurrentState();
  void fetchAndRender();
}

/**
 * Hydrate `currentState` from the persisted last-good fetch cache (FIX 2).
 *
 * Only hydrates when connected AND a board id is set AND a cache exists for
 * THAT board id (a cache saved for a different board is ignored as stale). It
 * rebuilds the ok state WITHOUT any network call:
 *   loadSprintData(cachedJson) → buildViewModel(data, new Date())
 * so business-day counts (and the countdown) are recomputed against the CURRENT
 * date even from a cache saved days ago. Sets `currentState = ok`, restores the
 * cached ticket board + fetch timestamp.
 *
 * Resilient: a corrupt/unparseable/mismatched cache is ignored and we fall
 * through to the normal not-connected/loading path. Never throws out of
 * activate.
 */
function hydrateFromCache(): void {
  if (!auth) {
    return;
  }
  // Not connected or no board ⇒ do not hydrate; keep the not-connected state
  // (the connect prompt) and show no misleading data error.
  if (!canFetch()) {
    return;
  }
  const boardId = auth.getBoardId();
  if (boardId === null) {
    return;
  }
  const cache = readCache();
  if (cache === null || cache.boardId !== boardId) {
    return; // no cache, or a stale cache for a different board ⇒ ignore
  }
  try {
    const data = loadSprintData(cache.sprintDataJson);
    const viewModel = buildViewModel(data, new Date());
    lastGoodViewModel = viewModel;
    currentTicketBoard = cache.ticketBoard;
    lastFetchedIso = cache.fetchedAtIso;
    currentState = { kind: "ok", viewModel };
  } catch {
    // Corrupt/unparseable cache ⇒ ignore and fall through to the normal path.
    // Do NOT crash activate.
  }
}

/** Dispose owned resources defensively. */
export function deactivate(): void {
  for (const provider of sidebarProviders) {
    try {
      provider.dispose();
    } catch {
      /* ignore teardown errors */
    }
  }
  try {
    statusBarItem?.dispose();
  } catch {
    /* ignore teardown errors */
  }
  sidebarProviders = [];
  statusBarItem = undefined;
  auth = undefined;
  client = undefined;
}

// ---------------------------------------------------------------------------
// Getters shared with the providers
// ---------------------------------------------------------------------------

/** The Open Board URL, or undefined when no board/project key is resolved. */
function getBoardUrl(): string | undefined {
  return client?.buildBoardUrl() ?? undefined;
}

/** The current Jira account state for the settings view. */
function getAccountState(): AccountState {
  return {
    connected: auth?.isConnected() ?? false,
    displayName: auth?.getAccountDisplayName() ?? null,
  };
}

/** ISO string of the last successful fetch (for the "Last synced" line). */
function getSyncStateIso(): string | null {
  return lastFetchedIso;
}

/**
 * The current ticket-board data (per-column tickets + progress counts) for the
 * roadmap view, or null when not-connected / error / no active sprint.
 */
function getTicketBoard(): TicketBoardData | null {
  return currentState.kind === "ok" ? currentTicketBoard : null;
}

/** True when we have credentials AND a board id — the fetchable state. */
function canFetch(): boolean {
  return (auth?.isConnected() ?? false) && (auth?.getBoardId() ?? null) !== null;
}

/**
 * Classify the current non-ok connectivity state from auth alone (no fetch):
 *   - not connected (no creds)              → "not-connected"
 *   - connected but NO board id set         → "connected-no-board"
 *   - connected AND a board id set          → "fetchable" (caller should fetch)
 *
 * Used to pick the right calm signal to push when we are not showing a built
 * view model (and to decide whether a fetch should even run).
 */
function computeConnectivity(): "not-connected" | "connected-no-board" | "fetchable" {
  const connected = auth?.isConnected() ?? false;
  if (!connected) {
    return "not-connected";
  }
  const boardId = auth?.getBoardId() ?? null;
  return boardId === null ? "connected-no-board" : "fetchable";
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

/**
 * Reveal the sidebar ONLY (focus the current-sprint view). This does NOT fetch:
 * the status-bar click just opens the HUD. Refreshing data is the Refresh
 * command's job (the single Jira-pull path).
 */
async function openSidebar(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${CURRENT_SPRINT_VIEW_ID}.focus`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `SprintTrackerNest: could not open the sidebar. ${detail}`
    );
  }
}

/**
 * Run the connect flow. On success, self-heal the accountId and do one full
 * fetch. On failure, just render the (still) not-connected state — no fetch.
 */
async function connectJira(): Promise<void> {
  if (!auth) {
    return;
  }
  const connected = await auth.connect();
  renderCurrentState();
  pushAccountAndSyncToAll();
  if (connected) {
    // Repair the stored accountId for this connect before the first fetch so
    // tickets filter to the connected user server-side.
    await auth.ensureAccountId();
    void fetchAndRender();
  }
}

/** Disconnect from Jira, clear cached data, and reflect the not-connected state. */
async function disconnectJira(): Promise<void> {
  if (!auth) {
    return;
  }
  await auth.disconnect();
  clearCache(); // drop the persisted last-good fetch (FIX 2)
  lastGoodViewModel = null;
  currentTicketBoard = null;
  lastFetchedIso = null;
  currentState = { kind: "not-connected" };
  renderCurrentState();
  pushAccountAndSyncToAll();
}

/** Prompt for + store a board id, then fetch + render. */
async function setBoardId(): Promise<void> {
  if (!client) {
    return;
  }
  const boardId = await client.setBoardIdFlow();
  if (boardId !== null) {
    // Board stored — fetch once. Does NOT re-run the connect flow.
    void fetchAndRender();
  }
  // Re-push board/account state so the settings view relabels its button.
  pushAccountAndSyncToAll();
}

/**
 * Handle command messages posted by the roadmap/settings webviews. Each maps to
 * the matching registered command so the webview and the command palette share
 * one code path.
 */
function handleWebviewCommand(type: string): void {
  switch (type) {
    case "openBoard": {
      const url = getBoardUrl();
      if (url) {
        void vscode.env.openExternal(vscode.Uri.parse(url));
      }
      break;
    }
    case "connectJira":
      void vscode.commands.executeCommand(CONNECT_JIRA_COMMAND);
      break;
    case "disconnectJira":
      void vscode.commands.executeCommand(DISCONNECT_JIRA_COMMAND);
      break;
    case "setBoardId":
      void vscode.commands.executeCommand(SET_BOARD_ID_COMMAND);
      break;
    case "refresh":
      void vscode.commands.executeCommand(REFRESH_COMMAND);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Fetch + render
// ---------------------------------------------------------------------------

/**
 * Fetch board data from Jira (when possible) and render all surfaces.
 *
 * - Not connected / no board ⇒ not-connected state, no fetch.
 * - Otherwise ⇒ map → `loadSprintData` → `buildViewModel`, cache the view
 *   model + timestamp, render ok.
 * - On failure ⇒ unreadable state carrying the error message. If a last-good
 *   view model exists it stays available but the error is surfaced.
 *
 * This is the single Jira-pull path: Refresh, Connect, Set Board, and activate
 * all route through here. The status-bar click does NOT call it.
 */
async function fetchAndRender(): Promise<void> {
  if (!auth || !client) {
    return;
  }

  if (!canFetch()) {
    // Distinguish "no creds" from "connected but no board" — both are calm
    // (non-error) states, but the views show different copy and the status bar
    // still prompts. Neither fetches.
    currentState =
      computeConnectivity() === "connected-no-board"
        ? { kind: "connected-no-board" }
        : { kind: "not-connected" };
    renderCurrentState();
    return;
  }

  if (fetching) {
    return; // avoid overlapping fetches
  }
  fetching = true;

  // Show the spinner overlay and KEEP the current content on screen. We do NOT
  // recompute or push a new AppState until the fetch resolves, so an in-flight
  // fetch never blanks the view or flashes a premature error.
  broadcastLoading(true);

  const boardId = auth.getBoardId() as string;
  try {
    const result = await client.fetchBoardData(boardId);
    // Reuse the engine's validation + view-model assembly.
    const sprintDataJson = JSON.stringify(result.sprintData);
    const data = loadSprintData(sprintDataJson);
    const viewModel = buildViewModel(data, new Date());

    lastGoodViewModel = viewModel;
    currentTicketBoard = result.ticketBoard;
    lastFetchedIso = result.fetchedAt.toISOString();
    currentState = { kind: "ok", viewModel };

    // Persist this successful fetch so the next startup hydrates instantly
    // (FIX 2). Cache the raw SprintData JSON + ticket board + timestamp + the
    // board id it was fetched for. No secrets are stored.
    writeCache({
      version: 1,
      boardId,
      sprintDataJson,
      ticketBoard: result.ticketBoard,
      fetchedAtIso: lastFetchedIso,
    });
  } catch (error) {
    const message =
      error instanceof JiraClientError || error instanceof SprintDataError
        ? error.message
        : error instanceof Error
        ? error.message
        : String(error);
    currentTicketBoard = null;
    currentState = { kind: "unreadable", message };
  } finally {
    fetching = false;
    // Hide the spinner first, then render the freshly-computed state. Order
    // matters so the view swaps content only after loading clears.
    broadcastLoading(false);
  }

  // Only now (fetch resolved) do we compute-and-render the new state.
  renderCurrentState();
}

// ---------------------------------------------------------------------------
// Last-good fetch cache (FIX 2) — persisted in globalState, no secrets.
// ---------------------------------------------------------------------------

/** Read the persisted fetch cache, or null when absent/unshaped. */
function readCache(): FetchCache | null {
  const raw = extensionContext?.globalState.get<FetchCache>(CACHE_KEY);
  if (
    raw &&
    raw.version === 1 &&
    typeof raw.boardId === "string" &&
    typeof raw.sprintDataJson === "string" &&
    typeof raw.fetchedAtIso === "string" &&
    raw.ticketBoard !== undefined &&
    raw.ticketBoard !== null
  ) {
    return raw;
  }
  return null;
}

/**
 * Persist the last-good fetch cache. Resilient: a persistence failure NEVER
 * breaks a fetch — the update is fire-and-forget inside try/catch.
 */
function writeCache(cache: FetchCache): void {
  try {
    void extensionContext?.globalState.update(CACHE_KEY, cache);
  } catch {
    // Non-fatal: caching is best-effort and must not affect the live fetch.
  }
}

/** Clear the persisted fetch cache (on disconnect). Resilient. */
function clearCache(): void {
  try {
    void extensionContext?.globalState.update(CACHE_KEY, undefined);
  } catch {
    // Non-fatal.
  }
}

/**
 * Render the current app state to the status bar and all sidebar views.
 */
function renderCurrentState(): void {
  renderToStatusBar(currentState);
  pushToSidebar(currentState);
}

/** Render the current state to the status bar. */
function renderToStatusBar(state: AppState): void {
  if (!statusBarItem) {
    return;
  }
  switch (state.kind) {
    case "ok":
      renderStatusBar(statusBarItem, state.viewModel);
      break;
    case "not-connected":
      renderStatusBarError(statusBarItem, CONNECT_PROMPT_TEXT);
      break;
    case "connected-no-board":
      // Still no sprint to show — keep the connect prompt.
      renderStatusBarError(statusBarItem, CONNECT_PROMPT_TEXT);
      break;
    case "unreadable":
      renderStatusBarError(statusBarItem, SPRINT_DATA_UNREADABLE_TEXT);
      break;
  }
}

/**
 * Push the current state to all three sidebar views.
 *
 * Delegates each view to {@link pushStateToProvider} so the per-provider push
 * (used by the ready/visibility handshake, Change 1) and the broadcast share
 * exactly one code path.
 */
function pushToSidebar(state: AppState): void {
  if (sidebarProviders.length === 0) {
    return;
  }
  for (const provider of sidebarProviders) {
    pushStateToProvider(provider, state);
  }
}

/**
 * Push a given app state to ONE provider.
 *
 * Chooses the correct top-level signal for the state, then ALWAYS pushes
 * account/board/sync (so Settings updates) plus the ticket board (so the
 * roadmap columns populate or clear):
 *   - ok                 ⇒ viewModel + ticketBoard
 *   - not-connected      ⇒ calm notConnected signal (no red card)
 *   - connected-no-board ⇒ calm connectedNoBoard signal (no red card)
 *   - unreadable         ⇒ red error card carrying the message
 */
function pushStateToProvider(provider: SidebarProvider, state: AppState): void {
  switch (state.kind) {
    case "ok":
      provider.pushViewModel();
      break;
    case "not-connected":
      // Being disconnected is NOT an error: the calm signal, never the red card.
      provider.pushNotConnected();
      break;
    case "connected-no-board":
      // Connected but no board is also NOT an error: its own calm signal.
      provider.pushConnectedNoBoard();
      break;
    case "unreadable":
      // A genuine fetch/validation error ⇒ the red error card is correct here.
      provider.postError(`Sprint data is unavailable: ${state.message}`);
      break;
  }
  // Always push account/board/sync so Settings relabels + toggles sections.
  provider.pushBoardState();
  provider.pushAccountState();
  provider.pushSyncState();
  // Ticket board: real data in ok, null (cleared) in every other state via the
  // getTicketBoard() guard.
  provider.pushTicketBoard();
}

/**
 * Host callback wired into each provider's `pushCurrentState` option (Change 1).
 * Pushes the CURRENT app state to THAT one provider so a freshly-resolved view
 * immediately shows the correct calm/ok state on the ready handshake — instead
 * of sitting in its default empty HTML with a stale 0/0 bar until a Refresh.
 */
function pushCurrentStateToProvider(provider: SidebarProvider): void {
  pushStateToProvider(provider, currentState);
}

/** Push just account + board + sync state to all views (labels/visibility). */
function pushAccountAndSyncToAll(): void {
  for (const provider of sidebarProviders) {
    provider.pushBoardState();
    provider.pushAccountState();
    provider.pushSyncState();
  }
}

/**
 * Broadcast the loading state to all three views so each can show/hide its
 * spinner overlay WITHOUT clearing its current content.
 */
function broadcastLoading(isLoading: boolean): void {
  for (const provider of sidebarProviders) {
    provider.setLoading(isLoading);
  }
}
