// src/statusBar.ts
//
// The status bar surface for SprintPulse.
//
// Unlike the pure core, this module IS a UI-layer file: it imports `vscode`.
// Its job is narrow — own the single `StatusBarItem`, render the compact
// summary the engine already produced, and route a click to the sidebar
// command. It does NOT recompute any text (Requirement 17.2); the engine owns
// the wording of the normal states, and the caller (extension.ts, task 16)
// supplies the error texts exported below for the failure states.

import * as vscode from "vscode";
import type { SprintViewModel } from "../core/types";

/**
 * Command invoked when the status bar item is clicked.
 *
 * Binding this as the item's `command` is what satisfies Requirement 1.6 (a
 * click reveals the sidebar); the command itself is registered in
 * `extension.ts` (task 16), not here.
 */
export const OPEN_SIDEBAR_COMMAND = "sprintpulse.openSidebar";

/**
 * Status bar text for a malformed / unreadable data store (Requirement 15.1).
 *
 * Exported so `extension.ts` can render it directly when `loadSprintData`
 * throws a `SprintDataError` — the engine cannot produce a view model in that
 * case, so there is no `statusBarText` to read.
 */
export const SPRINT_DATA_UNREADABLE_TEXT = "🏃 Sprint data unreadable";

/**
 * Status bar text for a missing data file (ENOENT) (Requirement 15.2).
 *
 * Exported for the same reason as {@link SPRINT_DATA_UNREADABLE_TEXT}: there is
 * no view model to render when the file is absent, so the caller passes this
 * raw text to {@link renderStatusBarError}.
 */
export const NO_SPRINT_DATA_TEXT = "🏃 No sprint data";

/**
 * Status bar text for the not-connected / no-board state.
 *
 * Shown when Jira is not connected or no board id is set yet. Clicking it opens
 * the sidebar (and triggers a guarded fetch) so the user can connect. Keeps the
 * runner emoji for visual consistency with the active states.
 */
export const CONNECT_PROMPT_TEXT = "🏃 Connect here to view Sprint";

/**
 * Create and own the SprintPulse status bar item.
 *
 * The item is placed on the left, bound to {@link OPEN_SIDEBAR_COMMAND} so a
 * click reveals the sidebar (Requirement 1.6), and returned to the caller,
 * which is responsible for disposing it (typically via the extension's
 * subscriptions in task 16). The item is not shown until a render call runs, so
 * nothing appears before there is text to display.
 *
 * @param priority Optional alignment priority; higher numbers sit further left.
 */
export function createStatusBarItem(priority = 100): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
  item.command = OPEN_SIDEBAR_COMMAND;
  return item;
}

/**
 * Render the normal, view-model-driven status bar text.
 *
 * Sets `item.text` to `vm.statusBarText` verbatim and shows the item. The engine
 * has already formatted every normal state into that single string
 * (Requirement 17.2), so this covers:
 * - the active-sprint summary "🏃 <name> | <n>d left | <icon>"
 *   (Requirements 1.1-1.4, 1.8), and
 * - the no-active-sprint state "🏃 No active sprint" (Requirement 1.5).
 *
 * The click target is (re)bound here as well so an item that was previously
 * used for an error render is guaranteed to route to the sidebar
 * (Requirements 1.6, 15.1, 15.2).
 */
export function renderStatusBar(item: vscode.StatusBarItem, vm: SprintViewModel): void {
  item.text = vm.statusBarText;
  item.command = OPEN_SIDEBAR_COMMAND;
  item.show();
}

/**
 * Render a raw error/status message directly, without a view model.
 *
 * Used for the safe states that arise before a view model can be built, because
 * `loadSprintData` throws first (Requirements 15.1, 15.2). The caller passes one
 * of {@link SPRINT_DATA_UNREADABLE_TEXT} or {@link NO_SPRINT_DATA_TEXT} (or an
 * equivalent short message). The click target stays bound to the sidebar so the
 * user can still open the sidebar to read the detailed error card.
 */
export function renderStatusBarError(item: vscode.StatusBarItem, message: string): void {
  item.text = message;
  item.command = OPEN_SIDEBAR_COMMAND;
  item.show();
}
