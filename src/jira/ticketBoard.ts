// src/jira/ticketBoard.ts
//
// The ticket-board structure for the "Jira Tickets" view (id
// sprintpulse.roadmap).
//
// This is DELIBERATELY defined OUTSIDE core/types.ts. The pure core
// (SprintViewModel) is unchanged; the board columns flow to the webview on
// their own message channel ({type:"ticketBoard"}), alongside — not inside —
// the SprintViewModel.
//
// Shape:
//   - `columns` is the ORDERED list of the active sprint board's columns
//     (order taken from the board's column configuration). Each column lists
//     the connected user's own tickets (assignee = connected account) in that
//     column, as KEY + summary.
//   - `total` = count of the user's issues in the active sprint.
//   - `done`  = count of those whose statusCategory key === "done".
//     Together `done`/`total` drive the ticket progress bar (0 when total 0).

/** One board column plus the user's tickets currently sitting in it. */
export interface TicketBoardColumn {
  /** The column's display name from the board configuration (e.g. "In Progress"). */
  name: string;
  /** The connected user's tickets in this column, as key + summary. */
  tickets: { key: string; summary: string }[];
}

/** The board columns for the active sprint + progress-bar counts. */
export interface TicketBoardData {
  /** Board columns in configuration order (a trailing "Other" bucket may follow). */
  columns: TicketBoardColumn[];
  /** Count of the connected user's issues in the active sprint. */
  total: number;
  /** Count of those issues whose statusCategory key === "done". */
  done: number;
}
