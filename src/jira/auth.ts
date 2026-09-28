// src/jira/auth.ts
//
// Jira authentication + credential storage for SprintTrackerNest.
//
// This is a host-side (Node) module: it imports `vscode` and uses Node's
// built-in `https` to verify credentials. It NEVER touches the pure core.
//
// Credential storage split:
//   - site URL, account email, account display name, boardId, projectKey →
//     `context.globalState` (non-secret).
//   - the Jira API token → `context.secrets` (SecretStorage) ONLY.
//
// The token is never logged, never written to settings.json, and never written
// to any file. `getCreds()` returns it only to the in-process https client.

import * as vscode from "vscode";
import * as https from "https";
import { URL } from "url";

/** globalState key for the Jira site base URL (e.g. https://x.atlassian.net). */
const KEY_SITE = "sprintpulse.jira.site";
/** globalState key for the Atlassian account email. */
const KEY_EMAIL = "sprintpulse.jira.email";
/** globalState key for the resolved account display name. */
const KEY_DISPLAY_NAME = "sprintpulse.jira.displayName";
/** globalState key for the connected account id (Atlassian accountId). */
const KEY_ACCOUNT_ID = "sprintpulse.jira.accountId";
/** globalState key for the configured board id (stored as a string). */
const KEY_BOARD_ID = "sprintpulse.jira.boardId";
/** globalState key for the resolved project key (for the Open Board URL). */
const KEY_PROJECT_KEY = "sprintpulse.jira.projectKey";
/** SecretStorage key for the Jira API token. */
const SECRET_TOKEN = "sprintpulse.jira.token";

/** Resolved credentials the https client needs. */
export interface JiraCreds {
  readonly site: string;
  readonly email: string;
  readonly token: string;
}

/**
 * Owns Jira credentials and the connect/disconnect flows.
 *
 * Construct once in `activate` with the `ExtensionContext`, then share the
 * instance with the client and the extension host.
 */
export class JiraAuth {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get globalState(): vscode.Memento {
    return this.context.globalState;
  }

  private get secrets(): vscode.SecretStorage {
    return this.context.secrets;
  }

  // ---- lightweight, synchronous state (non-secret) ----------------------

  /** The stored site URL, or null. */
  public getSite(): string | null {
    return this.globalState.get<string>(KEY_SITE) ?? null;
  }

  /** The stored account email, or null. */
  public getEmail(): string | null {
    return this.globalState.get<string>(KEY_EMAIL) ?? null;
  }

  /** The stored account display name, or null. */
  public getAccountDisplayName(): string | null {
    return this.globalState.get<string>(KEY_DISPLAY_NAME) ?? null;
  }

  /**
   * The stored connected-account id (Atlassian accountId), or null.
   *
   * Used to assignee-filter the sprint issues and the Open Board URL to the
   * connected user's own tickets. May be null when Jira omitted `accountId`
   * from the `myself` response (it is then stored as "" and normalized to null
   * here).
   */
  public getAccountId(): string | null {
    const id = this.globalState.get<string>(KEY_ACCOUNT_ID);
    return id === undefined || id.length === 0 ? null : id;
  }

  /** The stored board id (string) or null. */
  public getBoardId(): string | null {
    return this.globalState.get<string>(KEY_BOARD_ID) ?? null;
  }

  /** The stored project key or null. */
  public getProjectKey(): string | null {
    return this.globalState.get<string>(KEY_PROJECT_KEY) ?? null;
  }

  /**
   * Considered "connected" when a site + email are stored (non-secret markers).
   * The token's presence is verified during the connect flow before these are
   * written, so their presence implies a token in SecretStorage.
   */
  public isConnected(): boolean {
    return this.getSite() !== null && this.getEmail() !== null;
  }

  // ---- board + project key persistence ----------------------------------

  public async setBoardId(boardId: string): Promise<void> {
    await this.globalState.update(KEY_BOARD_ID, boardId);
  }

  public async setProjectKey(projectKey: string): Promise<void> {
    await this.globalState.update(KEY_PROJECT_KEY, projectKey);
  }

  // ---- full credentials (includes the secret token) ---------------------

  /**
   * Resolve the full credential triple, or null when not fully available.
   *
   * The token is read from SecretStorage on demand. Never cache/log the result.
   */
  public async getCreds(): Promise<JiraCreds | null> {
    const site = this.getSite();
    const email = this.getEmail();
    if (site === null || email === null) {
      return null;
    }
    const token = await this.secrets.get(SECRET_TOKEN);
    if (token === undefined || token.length === 0) {
      return null;
    }
    return { site, email, token };
  }

  /**
   * Self-heal the stored accountId for older connects that saved none.
   *
   * If {@link getAccountId} already returns a value, return it unchanged. If it
   * is null AND we are connected (site + email + token available), call
   * `GET /rest/api/3/myself` once, store the returned accountId, and return it.
   * When still unresolved (not connected, network error, or Jira omitted the
   * id) return null and store nothing.
   *
   * This repairs the "show all" fallback: with a real accountId the ticket
   * fetch can filter server-side to the connected user's own tickets. Even if
   * this stays null, the client falls back to `currentUser()` server-side.
   */
  public async ensureAccountId(): Promise<string | null> {
    const existing = this.getAccountId();
    if (existing !== null) {
      return existing;
    }
    const creds = await this.getCreds();
    if (creds === null) {
      return null; // not connected — nothing to heal
    }
    try {
      const me = await verifyMyself(creds.site, creds.email, creds.token);
      if (me.accountId.length > 0) {
        await this.globalState.update(KEY_ACCOUNT_ID, me.accountId);
        return me.accountId;
      }
    } catch {
      // Non-fatal: leave the stored value as-is; currentUser() covers us.
    }
    return null;
  }

  // ---- connect / disconnect flows ----------------------------------------

  /**
   * Run the connect flow: three prompts (site, email, token), verify against
   * `GET /rest/api/3/myself`, then persist on success.
   *
   * Cancelling any prompt aborts without saving. On a verification failure the
   * token is NOT stored and an error message is shown. Returns true on a
   * successful connect.
   */
  public async connect(): Promise<boolean> {
    const siteRaw = await promptForSite();
    if (siteRaw === undefined) {
      return false; // cancelled
    }

    const email = await vscode.window.showInputBox({
      prompt: "Atlassian account email",
      placeHolder: "ernestbyrron.flores@infor.com",
      ignoreFocusOut: true,
    });
    if (email === undefined) {
      return false; // cancelled
    }

    const token = await vscode.window.showInputBox({
      prompt: "Jira API token",
      password: true,
      ignoreFocusOut: true,
    });
    if (token === undefined) {
      return false; // cancelled
    }

    const site = normalizeSite(siteRaw);
    const trimmedEmail = email.trim();

    if (site.length === 0 || trimmedEmail.length === 0 || token.length === 0) {
      void vscode.window.showErrorMessage(
        "SprintTrackerNest: site URL, email, and API token are all required to connect to Jira."
      );
      return false;
    }

    // Verify before persisting anything.
    let displayName: string;
    let accountId: string;
    try {
      const me = await verifyMyself(site, trimmedEmail, token);
      displayName = me.displayName;
      accountId = me.accountId;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `SprintTrackerNest: could not connect to Jira. ${detail}`
      );
      return false; // do NOT store the token
    }

    // Persist: token to SecretStorage, the rest to globalState.
    await this.secrets.store(SECRET_TOKEN, token);
    await this.globalState.update(KEY_SITE, site);
    await this.globalState.update(KEY_EMAIL, trimmedEmail);
    await this.globalState.update(KEY_DISPLAY_NAME, displayName);
    await this.globalState.update(KEY_ACCOUNT_ID, accountId);

    void vscode.window.showInformationMessage(
      `SprintTrackerNest: connected to Jira as ${displayName}.`
    );
    return true;
  }

  /**
   * Clear the token from SecretStorage and clear site/email/displayName/
   * accountId/boardId/projectKey from globalState. Shows a confirmation message.
   */
  public async disconnect(): Promise<void> {
    await this.secrets.delete(SECRET_TOKEN);
    await this.globalState.update(KEY_SITE, undefined);
    await this.globalState.update(KEY_EMAIL, undefined);
    await this.globalState.update(KEY_DISPLAY_NAME, undefined);
    await this.globalState.update(KEY_ACCOUNT_ID, undefined);
    await this.globalState.update(KEY_BOARD_ID, undefined);
    await this.globalState.update(KEY_PROJECT_KEY, undefined);
    void vscode.window.showInformationMessage("SprintTrackerNest: disconnected from Jira.");
  }
}

/** The default Infor Jira site offered as the first QuickPick option. */
const INFOR_SITE_URL = "https://infor.atlassian.net";
/** Sentinel value for the "enter a different site" QuickPick item. */
const SITE_OTHER = "__other__";

/**
 * Prompt for the Jira site via a QuickPick with an Infor default and an
 * "enter a different site…" escape hatch.
 *
 * - Pick the Infor item ⇒ returns {@link INFOR_SITE_URL}.
 * - Pick "Enter a different site…" ⇒ shows the free-text input box; returns its
 *   value (or undefined if that box is cancelled).
 * - Cancel the QuickPick itself ⇒ returns undefined (aborts the connect flow).
 */
async function promptForSite(): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: INFOR_SITE_URL, value: INFOR_SITE_URL },
      { label: "Enter a different site…", value: SITE_OTHER },
    ],
    {
      title: "Jira site URL",
      placeHolder: "Select your Jira site",
      ignoreFocusOut: true,
    }
  );
  if (picked === undefined) {
    return undefined; // cancelled ⇒ abort connect
  }
  if (picked.value !== SITE_OTHER) {
    return picked.value;
  }
  return vscode.window.showInputBox({
    prompt: "Jira site URL",
    placeHolder: "https://your-domain.atlassian.net",
    ignoreFocusOut: true,
  });
}

/**
 * Normalize a user-entered site URL: trim, prepend https:// if no scheme, and
 * strip any trailing slash so later path joins are clean.
 */
export function normalizeSite(raw: string): string {
  let s = raw.trim();
  if (s.length === 0) {
    return s;
  }
  if (!/^https?:\/\//i.test(s)) {
    s = "https://" + s;
  }
  // Strip trailing slashes.
  s = s.replace(/\/+$/, "");
  return s;
}

/** Build the `Authorization: Basic ...` header value from email:token. */
export function basicAuthHeader(email: string, token: string): string {
  const encoded = Buffer.from(`${email}:${token}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/** The subset of the `myself` response we persist. */
interface MyselfResult {
  readonly displayName: string;
  /** The Atlassian accountId, or "" when the response omitted it. */
  readonly accountId: string;
}

/**
 * Verify credentials by calling `GET <site>/rest/api/3/myself` with Basic auth.
 * Resolves with the account's `{ displayName, accountId }` on 2xx; rejects with
 * a readable message on 401/403, other HTTP errors, or a network failure.
 * `accountId` is "" when Jira omits it from the response.
 *
 * The token is only used to build the auth header — it is never logged.
 */
function verifyMyself(site: string, email: string, token: string): Promise<MyselfResult> {
  return new Promise<MyselfResult>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(`${site}/rest/api/3/myself`);
    } catch {
      reject(new Error(`"${site}" is not a valid URL.`));
      return;
    }

    const req = https.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        headers: {
          Authorization: basicAuthHeader(email, token),
          Accept: "application/json",
          "User-Agent": "SprintTrackerNest",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            reject(new Error("Authentication failed — check your email and API token."));
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new Error(`Jira returned HTTP ${status}.`));
            return;
          }
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = JSON.parse(body) as {
              displayName?: unknown;
              accountId?: unknown;
            };
            const name =
              typeof parsed.displayName === "string" && parsed.displayName.length > 0
                ? parsed.displayName
                : email;
            const accountId =
              typeof parsed.accountId === "string" && parsed.accountId.length > 0
                ? parsed.accountId
                : "";
            resolve({ displayName: name, accountId });
          } catch {
            // Verified (2xx) but unexpected body — fall back to the email, no id.
            resolve({ displayName: email, accountId: "" });
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(new Error(`Network error contacting Jira: ${err.message}`));
    });
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request to Jira timed out."));
    });
    req.end();
  });
}
