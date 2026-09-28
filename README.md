# SprintTrackerNest

#### Video Demo: TODO — paste YouTube URL here

#### Description

SprintTrackerNest is a Visual Studio Code extension that puts a live
"sprint HUD" right inside the editor. Instead of switching to a browser and
digging through Jira every time I want to know how a sprint is going, I connect
the extension to my Jira account once, point it at a scrum board, and the sidebar
and status bar always show the answer: which sprint is active, how many business
days are left, whether the team is on track, and my own tickets grouped by the
board's real columns.

I built this because I live in the editor all day and the constant context switch
to Jira was breaking my focus. A small, always-visible summary solves a real,
daily problem for me.

## What it does

- **Current Sprint view** — the active sprint's name, its date range, a
  business-day countdown (weekends excluded), a timeline progress bar, and a
  colored health badge (On Track / Behind / At Risk / Ahead).
- **Jira Tickets view** — my own tickets for the active sprint, grouped into the
  board's actual columns (To Do, In Progress, Done, etc.), plus a done/total
  progress bar.
- **Settings view** — connect/disconnect Jira and set the scrum board ID.
- **Status bar** — a one-line summary (`sprint | Nd left | health icon`) that is
  visible even when the sidebar is closed.

The "health" idea is the core of the project: it compares how much of the sprint
*timeline* has elapsed against how many *tickets* are done. If work is keeping
pace with the calendar the badge is green; if tickets lag the calendar it turns
yellow or red. That comparison is a small piece of real logic, not just a data
dump.

## How the code is organized

I split the project into a **pure core** (no editor dependencies) and a **host
layer** (the parts that talk to VS Code and Jira). This separation was a
deliberate design choice: all the tricky date and health math lives in plain
functions I can reason about on their own, and the messy I/O (network, secret
storage, webviews) stays at the edges.

### `core/` — pure business logic (no `vscode` import)

- **`businessDays.ts`** — the date engine. It converts an instant into a calendar
  date in a fixed timezone (America/Chicago) so the countdown never shifts with
  the machine's local time, counts business days (Mon–Fri) inclusive of both
  endpoints, and computes elapsed/remaining days and timeline progress. It
  handles reversed ranges, leap years, and month rollovers.
- **`healthCalculator.ts`** — turns two progress fractions (tickets vs. timeline)
  into a health band, a signed delta, a color, and a label using a fixed
  threshold ladder.
- **`sprintEngine.ts`** — the largest core file. It validates the raw sprint data,
  picks the active and next sprint, filters upcoming milestones, and assembles
  the single view model that every UI surface renders. Validation lives here so
  everything downstream can assume clean data.
- **`types.ts`** — the shared TypeScript interfaces for the view model.

### `models/` — the data shapes

Small interface files (`sprint.ts`, `ticketSummary.ts`, `milestone.ts`,
`releaseCycle.ts`, `sprintData.ts`) that describe the sprint data the core
consumes. Keeping them separate keeps the imports clean.

### `src/` — the host layer (imports `vscode`)

- **`extension.ts`** — the entry point. It activates the extension, registers the
  commands and the three webview views, and pushes one computed view model to
  all surfaces. It also caches the last successful fetch so startup is never
  blank.
- **`sidebar.ts`** — a single reusable webview provider that powers all three
  views, parameterized by which HTML file to load and which messages it may send.
- **`statusBar.ts`** — renders the status bar summary.
- **`jira/auth.ts`** — the connect/disconnect flow and credential storage. The
  Jira API token is stored only in VS Code's encrypted SecretStorage, never on
  disk or in logs. The site, email, board ID, and project key go in non-secret
  global state.
- **`jira/client.ts`** — the Jira REST client. It uses Node's built-in `https` to
  fetch sprints, the board's column configuration, and my own tickets (filtered
  server-side with JQL), then maps all of it into the exact shape the pure core
  already understands. It retries transient network and server errors with
  backoff.
- **`jira/ticketBoard.ts`** — the ticket-board structure that flows to the
  webview alongside (not inside) the core view model.

### `webview/` — the UI

The HTML, JavaScript, and CSS for the three views (`currentSprint`, `roadmap`,
`settings`). The webview scripts only receive a finished view model and render
it; they never do any business calculation.

### Config

`package.json` declares the commands, views, and activity-bar container.
`tsconfig.json` configures the TypeScript build. `.vscodeignore` keeps the
packaged extension lean (source and specs excluded, compiled output included).

## Design decisions I debated

- **Pure core vs. host layer.** I could have put the date math directly in the
  extension code, but isolating it made the logic far easier to trust and reason
  about, and it keeps `vscode` out of the parts that only do math.
- **Fixed timezone for "today".** A sprint countdown that changes depending on
  the developer's laptop timezone would be confusing, so I anchor all date math
  to one zone.
- **Secret storage for the token.** An API token is a credential, so it goes in
  the OS-encrypted SecretStorage rather than a settings file that could be
  committed by accident.
- **Server-side ticket filtering.** Early on the ticket fetch pulled the whole
  board across many pages. I moved the "assigned to me" filter into the Jira
  query so it returns only my tickets in a single small response.

## Tech used

- **TypeScript** — all source code.
- **VS Code Extension API** — commands, webview views, status bar, SecretStorage,
  global state.
- **Node.js `https`** — direct calls to the Jira Cloud REST API (Agile + Platform).
- **Jira Cloud REST API** — sprints, board configuration, and issue search (JQL).
- **@vscode/vsce** — packaging the extension into a `.vsix`.
- **HTML / CSS / JavaScript** — the three webview panels.
- **Git / GitHub** — version control.

## Lessons from CS50x that I applied

- **Data structures & abstraction (Week 5 / general).** The clean split between a
  pure core and an I/O host layer is the same "keep the messy parts at the edges"
  discipline the course pushed.
- **Working with APIs and JSON (the web track).** Fetching, parsing, and
  validating JSON from a remote API — and handling the error cases — comes
  straight from the Flask/API material.
- **Defensive validation.** CS50 hammered on checking input before trusting it;
  `loadSprintData` rejects malformed data with specific messages instead of
  crashing later.
- **Correctness on edge cases.** The business-day counter handles weekends,
  reversed ranges, and leap years — the kind of edge-case thinking the problem
  sets trained.
- **Separation of logic and presentation.** Like keeping SQL/logic out of the
  templates, the webviews here only render a finished view model.

## AI usage disclosure

Per CS50's policy on the final project, I used AI-based tools as a helper while
building this (for scaffolding, refactoring, and debugging). The design decisions,
the problem this solves, and the integration work are my own, and I reviewed and
understand the code in this repository.

## Setup

1. Open the SprintTrackerNest panel (rocket icon in the activity bar).
2. In the Settings view, click **Connect Jira** and enter your Jira site, your
   Atlassian account email, and a Jira API token (create one at
   https://id.atlassian.com/manage-profile/security/api-tokens).
3. Click **Set Scrum Board** and enter your board ID (the number in the board URL).
4. The HUD populates. Use the refresh icon to pull fresh data.

Your API token is stored in VS Code SecretStorage (OS-encrypted) and is never
written to disk or logs.
