// src/jira/client.ts
//
// Jira Agile REST client for SprintTrackerNest.
//
// Host-side (Node) module. Uses Node's built-in `https` directly (desktop-only,
// no fetch/polyfill assumptions). Its single job is to turn a board id into the
// SAME `SprintData` shape the pure core already consumes via
// `loadSprintData` / `buildViewModel` — it does NOT recompute business values
// and does NOT change core types.
//
// All network calls happen here in the host; the webview never makes requests.

import * as vscode from "vscode";
import * as https from "https";
import { URL } from "url";

import type { SprintData } from "../../models/sprintData";
import type { Sprint, SprintState } from "../../models/sprint";
import type { TicketSummary } from "../../models/ticketSummary";
import type { ReleaseCycle, CycleState } from "../../models/releaseCycle";
import type { TicketBoardData, TicketBoardColumn } from "./ticketBoard";
import { JiraAuth, basicAuthHeader } from "./auth";

/**
 * Typed error for any Jira client failure (network, HTTP, or missing creds).
 *
 * The extension host maps this to the existing "unreadable" sidebar/status-bar
 * error state by rendering its `message`. Keeping it a real `Error` subclass
 * lets the host `instanceof JiraClientError` if it wants to distinguish it.
 */
export class JiraClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraClientError";
    Object.setPrototypeOf(this, JiraClientError.prototype);
  }
}

/** The result of a successful board fetch. */
export interface BoardFetchResult {
  readonly sprintData: SprintData;
  readonly projectKey: string | null;
  readonly fetchedAt: Date;
  /**
   * The active sprint's board columns with the connected user's own tickets,
   * plus the done/total counts for the ticket progress bar. Flows to the
   * webview OUTSIDE the SprintViewModel (see `src/jira/ticketBoard.ts`).
   */
  readonly ticketBoard: TicketBoardData;
}

/** An ordered board column plus the set of status ids that map into it. */
interface BoardColumn {
  readonly name: string;
  /** Status ids (as strings) that Jira routes into this column. */
  readonly statusIds: ReadonlySet<string>;
}

/** A raw Jira sprint (subset of fields we consume). */
interface JiraSprint {
  id: number;
  name?: string;
  state?: string; // "active" | "closed" | "future"
  startDate?: string; // ISO datetime
  endDate?: string; // ISO datetime
  originBoardId?: number; // the board this sprint was created on
}

/** A raw Jira issue (subset of fields we consume). */
interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string;
    status?: {
      id?: string;
      name?: string;
      statusCategory?: { key?: string };
    };
    assignee?: {
      accountId?: string;
    } | null;
  };
}

/**
 * Client wrapper over the Jira Agile REST API.
 *
 * Construct with a shared {@link JiraAuth}. All calls resolve creds on demand
 * and never cache/log the token.
 */
export class JiraClient {
  constructor(private readonly auth: JiraAuth) {}

  /**
   * Run the "set board id" flow: prompt, validate a positive integer, store it.
   * Requires being connected first; otherwise prompts the user to connect.
   *
   * Returns the stored board id string on success, or null when cancelled /
   * not connected / invalid.
   */
  public async setBoardIdFlow(): Promise<string | null> {
    if (!this.auth.isConnected()) {
      void vscode.window.showInformationMessage(
        "SprintTrackerNest: connect to Jira first, then set a board ID."
      );
      return null;
    }

    const raw = await vscode.window.showInputBox({
      prompt: "Jira board ID",
      placeHolder: "4069",
      ignoreFocusOut: true,
      validateInput: (value) =>
        isPositiveInteger(value.trim())
          ? null
          : "Enter a positive whole number (e.g. 4069).",
    });
    if (raw === undefined) {
      return null; // cancelled
    }

    const boardId = raw.trim();
    if (!isPositiveInteger(boardId)) {
      void vscode.window.showErrorMessage(
        "SprintTrackerNest: the board ID must be a positive whole number."
      );
      return null;
    }

    await this.auth.setBoardId(boardId);
    return boardId;
  }

  /**
   * Fetch sprints + active-sprint issues + the project key for `boardId`, and
   * map them into a `SprintData` object plus the resolved project key.
   *
   * Throws {@link JiraClientError} on any credential/network/HTTP failure.
   */
  public async fetchBoardData(boardId: string): Promise<BoardFetchResult> {
    const creds = await this.auth.getCreds();
    if (creds === null) {
      throw new JiraClientError("Not connected to Jira. Connect first, then refresh.");
    }
    const { site, email, token } = creds;

    // 1) All sprints on the board (paginated; we page through `values`).
    const allSprints = await this.fetchAllSprints(site, email, token, boardId);

    // 1a) A board's filter can surface sprints that ORIGINATE on OTHER boards
    // (issues from this project that happen to sit in another team's sprint).
    // Those foreign sprints show as "active" too, which would make several
    // sprints active at once. Keep only sprints whose originBoardId matches the
    // board we're tracking, so the current sprint + roadmap reflect THIS board.
    const boardIdNum = Number(boardId);
    const ownSprints = allSprints.filter(
      (s) => typeof s.originBoardId === "number" && s.originBoardId === boardIdNum
    );
    // Fallback: if origin data is missing/unusable and nothing matched, keep all
    // sprints but demote extra actives below so validation still passes.
    const sprints = ownSprints.length > 0 ? ownSprints : allSprints;

    // 2) The active sprint. Normally exactly one remains after the board filter.
    // If more than one is still active (fallback path), choose the one ending
    // soonest � the nearest deadline is what a countdown HUD should track.
    const activeCandidates = sprints.filter(
      (s) => normalizeSprintState(s.state) === "active"
    );
    const activeRaw =
      activeCandidates.length === 0
        ? null
        : activeCandidates
            .slice()
            .sort((a, b) => (isoDatePortion(a.endDate) ?? "") .localeCompare(isoDatePortion(b.endDate) ?? ""))[0];

    // 3) The connected user's account id (server-side assignee filter). We
    // self-heal it first: older connects may have stored none, in which case
    // ensureAccountId() fetches it once from `myself`. Even if it is still null
    // (Jira omitted it / not resolvable), fetchMyActiveSprintIssues falls back
    // to `currentUser()`, which Jira resolves to the token's own user.
    const accountId = await this.auth.ensureAccountId();

    // 4) Board column configuration (ordered column names + their status ids).
    // Non-fatal: if it fails we fall back to grouping everything into "Other".
    const columns = await this.fetchBoardColumns(site, email, token, boardId);

    // 5) Issues for the active sprint, assignee-filtered to the connected user
    // SERVER-SIDE via the platform /search JQL. No active sprint ⇒ empty board
    // + zero counts.
    let ticketSummary: TicketSummary = { done: 0, inProgress: 0, blocked: 0, total: 0 };
    let ticketBoard: TicketBoardData = { columns: [], total: 0, done: 0 };
    if (activeRaw !== null) {
      const issues = await this.fetchMyActiveSprintIssues(
        site,
        email,
        token,
        activeRaw.id,
        accountId
      );
      // Ticket counts reflect the server-side assignee-filtered issues (the
      // user's own tickets), so the status bar + core mirror the user too.
      ticketSummary = summarizeIssues(issues);
      ticketBoard = buildTicketBoard(issues, columns);
    } else {
      ticketBoard = buildTicketBoard([], columns);
    }

    // 6) Project key for the Open Board URL.
    const projectKey = await this.fetchProjectKey(site, email, token, boardId);

    // 7) Map raw sprints → core Sprint[] and a date-ordered release roadmap.
    // Only the chosen active sprint keeps state "active"; any other still-active
    // sprint (fallback path) is demoted so the core validator sees exactly one
    // active sprint (Requirement 14.5).
    const chosenActiveId = activeRaw?.id ?? null;
    const mappedSprints = sprints
      .map((raw) => {
        const mapped = mapSprint(raw);
        if (mapped !== null && mapped.state === "active" && raw.id !== chosenActiveId) {
          return { ...mapped, state: "closed" as const };
        }
        return mapped;
      })
      .filter((s): s is Sprint => s !== null);

    const releaseRoadmap = buildRoadmap(sprints, chosenActiveId);

    const sprintData: SprintData = {
      sprints: mappedSprints,
      ticketSummary,
      milestones: [], // removed feature — always empty
      releaseRoadmap,
    };

    return { sprintData, projectKey, fetchedAt: new Date(), ticketBoard };
  }

  /**
   * Compute the Open Board URL from the site, project key, and board id, or
   * null when either the project key or board id is missing.
   *
   * When a connected account id is available the URL is assignee-filtered to
   * the user's own tickets (`?assignee=<accountId>`); otherwise it stays
   * unfiltered.
   */
  public buildBoardUrl(): string | null {
    const site = this.auth.getSite();
    const projectKey = this.auth.getProjectKey();
    const boardId = this.auth.getBoardId();
    if (site === null || projectKey === null || boardId === null) {
      return null;
    }
    const base = `${site}/jira/software/c/projects/${projectKey}/boards/${boardId}`;
    const accountId = this.auth.getAccountId();
    return accountId === null
      ? base
      : `${base}?assignee=${encodeURIComponent(accountId)}`;
  }

  // ---- REST calls --------------------------------------------------------

  /** Page through `GET /rest/agile/1.0/board/<id>/sprint`. */
  private async fetchAllSprints(
    site: string,
    email: string,
    token: string,
    boardId: string
  ): Promise<JiraSprint[]> {
    const all: JiraSprint[] = [];
    let startAt = 0;
    const maxResults = 50;
    // Guard against runaway loops; boards rarely have thousands of sprints.
    for (let page = 0; page < 100; page++) {
      // Plain sprint call. NOTE: do NOT add a `state` filter param here � some
      // Jira Cloud instances reject it with a misleading HTTP 400 "The board
      // does not support sprints" even on real scrum boards. We fetch all
      // sprints and classify them client-side instead.
      const path = `/rest/agile/1.0/board/${encodeURIComponent(
        boardId
      )}/sprint?startAt=${startAt}&maxResults=${maxResults}`;
      const body = await requestJson(site, email, token, path);
      const values = Array.isArray((body as { values?: unknown }).values)
        ? ((body as { values: JiraSprint[] }).values)
        : [];
      all.push(...values);
      const isLast = (body as { isLast?: boolean }).isLast === true;
      if (isLast || values.length === 0) {
        break;
      }
      startAt += values.length;
    }
    return all;
  }

  /**
   * Fetch the connected user's tickets for the active sprint using the Jira
   * PLATFORM search endpoint `GET /rest/api/3/search/jql`, which HONORS the JQL
   * assignee filter (the Agile `/sprint/<id>/issue` endpoint does not — it
   * ignored the jql param and returned the whole board across ~50 pages).
   *
   * This replaces the REMOVED `GET /rest/api/3/search` endpoint (Jira now
   * returns HTTP 410 "migrate to /rest/api/3/search/jql" for it).
   *
   * JQL: `sprint = <sprintId> AND assignee = <who>` where:
   *   - `who` = `"<accountId>"` (quoted) when `accountId` is a non-empty string.
   *   - `who` = `currentUser()` when `accountId` is null/empty — Jira resolves
   *     it server-side to the token's own user (the SELF-HEAL path). This filters
   *     to the connected user even without a stored accountId.
   *
   * Query params: `jql=<encoded>`, `fields=status,summary,assignee` (REQUIRED —
   * the new endpoint defaults to `fields=id` only, so we MUST pass the fields
   * explicitly), and `maxResults=100`.
   *
   * Pagination uses a token, NOT `startAt`/`total` (both gone on this endpoint).
   * The first request sends NO `nextPageToken`; each response returns a
   * `nextPageToken` (string) when more pages exist and omits it (or sets
   * `isLast=true`) on the last page. Each subsequent request passes
   * `&nextPageToken=<the token from the previous response>`. The loop stops
   * when the response has no `nextPageToken` or returns zero issues, with a
   * bounded guard against runaway loops. This returns only the user's tickets —
   * usually one small page instead of thousands. The token stays in the
   * Authorization header only; the JQL (no secrets) goes in the query string.
   */
  private async fetchMyActiveSprintIssues(
    site: string,
    email: string,
    token: string,
    sprintId: number,
    accountId: string | null
  ): Promise<JiraIssue[]> {
    const assigneeClause =
      accountId !== null && accountId.length > 0
        ? `assignee = "${accountId}"`
        : `assignee = currentUser()`;
    const jql = `sprint = ${sprintId} AND ${assigneeClause}`;
    const encodedJql = encodeURIComponent(jql);

    const all: JiraIssue[] = [];
    let nextPageToken: string | null = null;
    const maxResults = 100;
    // Bounded loop: the assignee filter keeps the result set small (usually one
    // page). The guard prevents a runaway if the token is ever inconsistent.
    for (let page = 0; page < 100; page++) {
      // First request has NO nextPageToken; later requests carry the token
      // returned by the previous response.
      const tokenParam =
        nextPageToken !== null
          ? `&nextPageToken=${encodeURIComponent(nextPageToken)}`
          : "";
      const path = `/rest/api/3/search/jql?jql=${encodedJql}&fields=status,summary,assignee&maxResults=${maxResults}${tokenParam}`;
      const body = await requestJson(site, email, token, path);
      const issues = Array.isArray((body as { issues?: unknown }).issues)
        ? (body as { issues: JiraIssue[] }).issues
        : [];
      all.push(...issues);

      // The response returns a nextPageToken (string) only when more pages
      // exist; it is omitted (or isLast=true) on the last page.
      const rawToken = (body as { nextPageToken?: unknown }).nextPageToken;
      const isLast = (body as { isLast?: boolean }).isLast === true;
      nextPageToken =
        typeof rawToken === "string" && rawToken.length > 0 ? rawToken : null;

      // Stop when there is no further page or this page was empty.
      if (nextPageToken === null || isLast || issues.length === 0) {
        break;
      }
    }
    return all;
  }

  /**
   * Fetch the board's column configuration via
   * `GET /rest/agile/1.0/board/<id>/configuration`.
   *
   * The response has `columnConfig.columns: [{ name, statuses: [{ id }] }]`.
   * We build an ORDERED list of columns, each with the set of status ids that
   * route into it — this gives the real column names + order (To Do, In
   * Progress, Blocked, In Test, Done, …).
   *
   * Non-fatal: on any failure (or an unexpected shape) we return an empty list
   * so grouping falls back to a single trailing "Other" bucket.
   */
  private async fetchBoardColumns(
    site: string,
    email: string,
    token: string,
    boardId: string
  ): Promise<BoardColumn[]> {
    const path = `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/configuration`;
    try {
      const body = await requestJson(site, email, token, path);
      return parseBoardColumns(body);
    } catch {
      // Non-fatal: without column config we group everything into "Other".
      return [];
    }
  }

  /** Resolve the board's project key via `GET /rest/agile/1.0/board/<id>`. */
  private async fetchProjectKey(
    site: string,
    email: string,
    token: string,
    boardId: string
  ): Promise<string | null> {
    const path = `/rest/agile/1.0/board/${encodeURIComponent(boardId)}`;
    try {
      const body = await requestJson(site, email, token, path);
      const location = (body as { location?: { projectKey?: unknown } }).location;
      const key = location?.projectKey;
      if (typeof key === "string" && key.length > 0) {
        await this.auth.setProjectKey(key);
        return key;
      }
    } catch {
      // Non-fatal: without a project key the Open Board block stays hidden.
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers (pure — no vscode / no network)
// ---------------------------------------------------------------------------

/** True when `value` is a base-10 string of a positive integer (no sign/dot). */
export function isPositiveInteger(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

/** Normalize a Jira sprint state string to the core {@link SprintState}. */
function normalizeSprintState(state: string | undefined): SprintState {
  switch ((state ?? "").toLowerCase()) {
    case "active":
      return "active";
    case "closed":
      return "closed";
    default:
      return "future";
  }
}

/**
 * Take the calendar-date portion of a Jira ISO datetime in a zone-stable way.
 *
 * Jira returns e.g. "2026-04-27T00:00:00.000Z". We take the leading
 * "YYYY-MM-DD" literally rather than constructing a Date (which would shift the
 * day across time zones). Returns null when no valid date prefix is present.
 */
export function isoDatePortion(datetime: string | undefined): string | null {
  if (typeof datetime !== "string") {
    return null;
  }
  const match = datetime.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Map one raw Jira sprint to a core {@link Sprint}, or null when it lacks the
 * fields the core validator requires (name + valid start/end dates).
 *
 * The core's `loadSprintData` rejects sprints without valid YYYY-MM-DD dates,
 * so we drop sprints missing either date rather than emit an invalid record.
 */
export function mapSprint(raw: JiraSprint): Sprint | null {
  const name = typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name : null;
  const startDate = isoDatePortion(raw.startDate);
  const endDate = isoDatePortion(raw.endDate);
  if (name === null || startDate === null || endDate === null) {
    return null;
  }
  // Core requires endDate >= startDate; skip inverted windows defensively.
  if (endDate < startDate) {
    return null;
  }
  return { name, startDate, endDate, state: normalizeSprintState(raw.state) };
}

/**
 * Summarize issues into ticket counts.
 *
 * Mapping rules:
 *   - status name (case-insensitive) contains "block" → blocked
 *   - else statusCategory key "done" → done
 *   - else statusCategory key "indeterminate" (In Progress/In Test/…) → inProgress
 *   - total = all issues
 * Blocked takes precedence so a blocked-but-in-progress ticket counts as blocked.
 */
export function summarizeIssues(issues: JiraIssue[]): TicketSummary {
  let done = 0;
  let inProgress = 0;
  let blocked = 0;
  for (const issue of issues) {
    const status = issue.fields?.status;
    const name = (status?.name ?? "").toLowerCase();
    const category = (status?.statusCategory?.key ?? "").toLowerCase();
    if (name.includes("block")) {
      blocked += 1;
    } else if (category === "done") {
      done += 1;
    } else if (category === "indeterminate") {
      inProgress += 1;
    }
    // "new" (To Do) and anything else count only toward total.
  }
  return { done, inProgress, blocked, total: issues.length };
}

/**
 * Parse a board `configuration` response into an ordered list of columns.
 *
 * Expects `columnConfig.columns: [{ name, statuses: [{ id }] }]`. Each column
 * keeps its display name + the set of status ids (as strings) that route into
 * it, in the order Jira returned them. Malformed/empty input ⇒ an empty list.
 */
export function parseBoardColumns(body: unknown): BoardColumn[] {
  const columnConfig = (body as { columnConfig?: { columns?: unknown } })
    ?.columnConfig;
  const rawColumns = Array.isArray(columnConfig?.columns)
    ? (columnConfig?.columns as unknown[])
    : [];
  const columns: BoardColumn[] = [];
  for (const raw of rawColumns) {
    const col = raw as { name?: unknown; statuses?: unknown };
    const name =
      typeof col.name === "string" && col.name.trim().length > 0
        ? col.name
        : "";
    if (name.length === 0) {
      continue;
    }
    const statusIds = new Set<string>();
    const statuses = Array.isArray(col.statuses) ? (col.statuses as unknown[]) : [];
    for (const s of statuses) {
      const id = (s as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) {
        statusIds.add(id);
      } else if (typeof id === "number") {
        statusIds.add(String(id));
      }
    }
    columns.push({ name, statusIds });
  }
  return columns;
}

/**
 * Group the connected user's issues into the board's ordered columns and
 * compute the done/total counts for the progress bar.
 *
 * Rules:
 *   - Column order is preserved from the board configuration.
 *   - An issue is placed in the FIRST column whose status-id set contains the
 *     issue's status id.
 *   - An issue whose status id matches NO column goes into a trailing "Other"
 *     bucket — which is appended ONLY when it is non-empty.
 *   - `total` = number of issues; `done` = those with statusCategory key
 *     "done".
 *
 * Issues carry `key` (issue.key) and `summary` (issue.fields.summary).
 */
export function buildTicketBoard(
  issues: JiraIssue[],
  columns: BoardColumn[]
): TicketBoardData {
  // One bucket per configured column, in order, plus a lazily-used "Other".
  const buckets: TicketBoardColumn[] = columns.map((c) => ({
    name: c.name,
    tickets: [],
  }));
  const other: TicketBoardColumn = { name: "Other", tickets: [] };

  let done = 0;
  for (const issue of issues) {
    const key = typeof issue.key === "string" ? issue.key : "";
    const summary =
      typeof issue.fields?.summary === "string" ? issue.fields.summary : "";
    const statusId = issue.fields?.status?.id ?? "";
    const categoryKey = (
      issue.fields?.status?.statusCategory?.key ?? ""
    ).toLowerCase();
    if (categoryKey === "done") {
      done += 1;
    }

    const ticket = { key, summary };
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      if (statusId.length > 0 && columns[i].statusIds.has(statusId)) {
        buckets[i].tickets.push(ticket);
        placed = true;
        break;
      }
    }
    if (!placed) {
      other.tickets.push(ticket);
    }
  }

  const resultColumns = other.tickets.length > 0 ? [...buckets, other] : buckets;
  return { columns: resultColumns, total: issues.length, done };
}

/**
 * Derive a release roadmap from sprints in start-date order: each sprint maps to
 * a release cycle — closed → completed, active → current, future → upcoming.
 *
 * The core validator allows at most one "current" cycle. Jira allows at most
 * one active sprint per board, so at most one "current" cycle results; as a
 * defensive measure any second active sprint is demoted to "upcoming".
 */
export function buildRoadmap(
  sprints: JiraSprint[],
  chosenActiveId: number | null = null
): ReleaseCycle[] {
  const ordered = sprints
    .filter((s) => typeof s.name === "string" && s.name.trim().length > 0)
    .slice()
    .sort((a, b) => {
      const da = isoDatePortion(a.startDate) ?? "";
      const db = isoDatePortion(b.startDate) ?? "";
      if (da === db) {
        return (a.name ?? "").localeCompare(b.name ?? "");
      }
      // Sprints without a start date sort last.
      if (da === "") {
        return 1;
      }
      if (db === "") {
        return -1;
      }
      return da < db ? -1 : 1;
    });

  let currentUsed = false;
  return ordered.map((s) => {
    const state = normalizeSprintState(s.state);
    // The chosen active sprint (this board's own active sprint) is THE current
    // cycle. When no chosen id is supplied, fall back to the first active one.
    const isChosen =
      chosenActiveId !== null ? s.id === chosenActiveId : state === "active";
    let cycleState: CycleState;
    if (state === "active" && isChosen && !currentUsed) {
      cycleState = "current";
      currentUsed = true;
    } else if (state === "closed") {
      cycleState = "completed";
    } else if (state === "active") {
      // A still-active but non-chosen sprint: it has started, so show completed
      // rather than upcoming, and never a second "current".
      cycleState = "completed";
    } else {
      cycleState = "upcoming";
    }
    return { label: (s.name as string), state: cycleState };
  });
}

// ---------------------------------------------------------------------------
// Error-body extraction (pure — no vscode / no network)
// ---------------------------------------------------------------------------

/** Max length of a raw error detail we surface, to keep messages readable. */
const MAX_ERROR_DETAIL_LEN = 300;

/**
 * Extract a human-readable detail string from a Jira error response body.
 *
 * Jira error bodies are JSON with `errorMessages: string[]` and/or an
 * `errors: {}` object. We prefer `errorMessages` (joined), fall back to the
 * values of `errors`, and finally to the raw text. The result is trimmed and
 * capped to ~300 chars. Returns "" when there is nothing useful. The token is
 * never part of a response body, so it can never leak here.
 */
export function extractJiraErrorDetail(raw: string): string {
  const text = (raw ?? "").trim();
  if (text.length === 0) {
    return "";
  }
  try {
    const parsed = JSON.parse(text) as {
      errorMessages?: unknown;
      errors?: unknown;
    };
    if (Array.isArray(parsed.errorMessages) && parsed.errorMessages.length > 0) {
      const joined = parsed.errorMessages
        .filter((m): m is string => typeof m === "string" && m.length > 0)
        .join(" ");
      if (joined.length > 0) {
        return cap(joined);
      }
    }
    if (
      parsed.errors !== null &&
      typeof parsed.errors === "object" &&
      Object.keys(parsed.errors as Record<string, unknown>).length > 0
    ) {
      const joined = Object.values(parsed.errors as Record<string, unknown>)
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .filter((v) => v.length > 0)
        .join(" ");
      if (joined.length > 0) {
        return cap(joined);
      }
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return cap(text);
}

/** Trim and cap a detail string to {@link MAX_ERROR_DETAIL_LEN} chars. */
function cap(s: string): string {
  const t = s.trim();
  return t.length > MAX_ERROR_DETAIL_LEN ? `${t.slice(0, MAX_ERROR_DETAIL_LEN)}…` : t;
}

/** Append an extracted detail to a friendly message when one is present. */
function appendDetail(friendly: string, detail: string): string {
  return detail.length > 0 ? `${friendly} ${detail}` : friendly;
}

// ---------------------------------------------------------------------------
// Low-level HTTPS JSON request
// ---------------------------------------------------------------------------

/** Per-attempt request timeout (ms). Applies to EACH retry attempt. */
const REQUEST_TIMEOUT_MS = 20000;

/** Total attempts (1 initial + 2 retries) for transient failures. */
const MAX_ATTEMPTS = 3;

/** Backoff before attempt N (index 0 = before the first retry). */
const RETRY_BACKOFF_MS = [300, 700];

/** HTTP status codes worth retrying (transient/server-side). */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * A transient failure the retry loop should swallow and retry. Carries a
 * pre-built final {@link JiraClientError} to reject with if all attempts are
 * exhausted, so the FINAL failure preserves the existing messages (including
 * the Jira error-body detail). Never reaches a caller.
 */
class TransientRequestError extends Error {
  constructor(readonly finalError: JiraClientError) {
    super(finalError.message);
    this.name = "TransientRequestError";
    Object.setPrototypeOf(this, TransientRequestError.prototype);
  }
}

/** Sleep helper for the retry backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Issue an authenticated GET and parse the JSON body, retrying transient
 * failures.
 *
 * Retry policy: on a NETWORK error (request `error` event, e.g. ECONNRESET /
 * ETIMEDOUT / a per-attempt timeout) or an HTTP 429/502/503/504, retry up to
 * two more times (3 attempts total) with a short backoff (300ms, then 700ms).
 * Deterministic failures are NOT retried: any 4xx other than 429, and a
 * successful (2xx) response whose body is not valid JSON. Each attempt keeps
 * the 20s timeout. The FINAL failure preserves the existing error messages
 * (including the Jira error-body extraction). The token is never logged.
 */
async function requestJson(
  site: string,
  email: string,
  token: string,
  path: string
): Promise<unknown> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await requestJsonOnce(site, email, token, path);
    } catch (error) {
      if (error instanceof TransientRequestError && attempt < MAX_ATTEMPTS - 1) {
        await delay(RETRY_BACKOFF_MS[attempt] ?? 0);
        continue; // retry
      }
      // Exhausted retries, or a deterministic (non-transient) failure: surface
      // the real JiraClientError with its preserved message.
      if (error instanceof TransientRequestError) {
        throw error.finalError;
      }
      throw error;
    }
  }
  // Unreachable: the loop either returns or throws. Guards the type checker.
  throw new JiraClientError("Network error contacting Jira: request failed.");
}

/**
 * A single request attempt.
 *
 * Resolves with the parsed JSON on 2xx. Rejects with a {@link JiraClientError}
 * for deterministic failures (401/403, 404, other non-retryable non-2xx, and a
 * 2xx-but-unparseable body). Rejects with a {@link TransientRequestError}
 * (wrapping the final JiraClientError) for retryable failures: a network error,
 * a per-attempt timeout, or a 429/502/503/504 response.
 */
function requestJsonOnce(
  site: string,
  email: string,
  token: string,
  path: string
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(site + path);
    } catch {
      reject(new JiraClientError(`"${site}" is not a valid Jira site URL.`));
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
          const raw = Buffer.concat(chunks).toString("utf8");

          if (status < 200 || status >= 300) {
            // Pull Jira's real error detail out of the body so the caller can
            // see WHY (e.g. a 400) happened. Never includes the token.
            const detail = extractJiraErrorDetail(raw);
            if (status === 401 || status === 403) {
              reject(
                new JiraClientError(
                  appendDetail(
                    "Jira rejected the credentials (401/403). Reconnect and try again.",
                    detail
                  )
                )
              );
              return;
            }
            if (status === 404) {
              reject(
                new JiraClientError(
                  appendDetail(
                    "Jira returned 404 — check the board ID exists and you have access.",
                    detail
                  )
                )
              );
              return;
            }
            const httpError = new JiraClientError(
              `Jira returned HTTP ${status}${detail ? `: ${detail}` : "."}`
            );
            // 429/502/503/504 are transient ⇒ let the caller retry. All other
            // non-2xx (e.g. 400) are deterministic ⇒ surface immediately.
            if (RETRYABLE_STATUSES.has(status)) {
              reject(new TransientRequestError(httpError));
            } else {
              reject(httpError);
            }
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch {
            // Successful-but-unparseable body is NOT retried (deterministic).
            reject(new JiraClientError("Jira returned a response that was not valid JSON."));
          }
        });
      }
    );

    req.on("error", (err) => {
      // Network-level failure (e.g. ECONNRESET, ETIMEDOUT) ⇒ transient/retry.
      reject(
        new TransientRequestError(
          new JiraClientError(`Network error contacting Jira: ${err.message}`)
        )
      );
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      // Per-attempt timeout ⇒ transient/retry. Destroying the request fires the
      // 'error' handler above with this error, so we don't reject twice here.
      req.destroy(new JiraClientError("Request to Jira timed out."));
    });
    req.end();
  });
}
