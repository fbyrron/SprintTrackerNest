# Implementation Plan: SprintPulse

## Overview

This plan builds the SprintPulse VS Code extension bottom-up: scaffold and manifest first, then data models, then the pure computational core (business days, health, engine) with unit and property-based tests, then data loading and validation, then the UI surfaces (status bar, webview sidebar), then extension wiring, and finally integration tests and sample data.

The pure core (`core/`) has no `vscode` import so it can be tested directly with fast-check. The 20 correctness properties from the design are turned into property-based tests placed next to the code they validate, so invariant breaks surface early. Timezone properties (16, 17) are run under multiple `TZ` values.

Each task references the requirement/acceptance-criteria numbers it implements and, where relevant, the correctness property numbers it must satisfy.

## Tasks

- [x] 1. Scaffold project and extension manifest
  - Create `package.json` with the extension manifest: `engines.vscode`, `main` entry, `activationEvents`, and `contributes` declaring the `sprintpulse.openSidebar` command and a webview view (`sprintpulse` view in a sidebar container)
  - Add dev dependencies: `typescript`, `@types/vscode`, `@types/node`, `fast-check`, `@vscode/test-electron`, and a test runner (`mocha` + `@types/mocha`)
  - Create `tsconfig.json` targeting the VS Code Node runtime with `strict` enabled and `outDir` set for compiled output
  - Create the directory layout: `models/`, `core/`, `src/`, `webview/`, `storage/`, and a `test/` tree
  - Add npm scripts for `compile`, `test` (unit + property), and `test:integration`
  - _Requirements: 18.1_

- [x] 2. Define data models and view-model types
  - [x] 2.1 Create entity model files
    - `models/sprint.ts` (`SprintState`, `Sprint`), `models/ticketSummary.ts` (`TicketSummary`), `models/milestone.ts` (`Milestone`), `models/releaseCycle.ts` (`CycleState`, `ReleaseCycle`)
    - Define the `SprintData` interface aggregating `sprints`, `ticketSummary`, `milestones`, `releaseRoadmap`
    - _Requirements: 14.2_

  - [x] 2.2 Define view-model and core output types
    - Define `HealthBand`, `TimelineView`, `TicketView`, `HealthView`, and `SprintViewModel` (in `core/sprintEngine.ts` or a shared `core/types.ts`)
    - _Requirements: 17.1_

- [x] 3. Implement Central-Time calendar-date primitives
  - [x] 3.1 Implement calendar-date helpers in `core/businessDays.ts`
    - `CalendarDate` interface; `toCentralDate(instant)` using `Intl.DateTimeFormat({ timeZone: "America/Chicago" })`; `parseIsoDate(iso)`; `compareDates(a, b)`; `isWeekend(date)`; and an internal `nextCalendarDay(date)` pure increment
    - Ensure weekday derivation is zone-free so results do not depend on host `TZ`
    - _Requirements: 13.1, 13.2, 13.3_

  - [ ]* 3.2 Write property tests for zone-stable and DST-safe date math
    - **Property 16: Zone-stable date math** — for a fixed instant, `toCentralDate` and downstream counts are identical under any host `TZ`
    - **Property 17: DST-safe day count** — counts across US spring-forward / fall-back equal plain calendar-date counts, no day dropped or doubled
    - Run this suite under multiple `TZ` values (e.g. `UTC`, `America/Los_Angeles`, `Asia/Tokyo`, `Pacific/Kiritimati`)
    - **Validates: Requirements 13.1, 13.2, 13.3**

- [x] 4. Implement business-day counting
  - [x] 4.1 Implement `countBusinessDays(start, end)` in `core/businessDays.ts`
    - Count Mon–Fri inclusive of both endpoints; return 0 when `end < start`; handle null inputs by returning 0 with an invalid-input indication without mutating inputs
    - Same-day: 1 on a weekday, 0 on a weekend
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [ ]* 4.2 Write property tests for business-day counting
    - **Property 1: Non-negative** — `countBusinessDays(start, end) >= 0` — **Validates: Requirements 8.3**
    - **Property 2: Bounded by span** — count `<=` total calendar days in inclusive range — **Validates: Requirements 8.3**
    - **Property 3: Empty when reversed** — `end < start` ⇒ count `=== 0` — **Validates: Requirements 8.5**

  - [ ]* 4.3 Write unit tests for business-day edge cases
    - Same-day weekday (1) and weekend (0); null start/end (0 + invalid indication); single-week and multi-week spans
    - _Requirements: 8.1, 8.4, 8.6_

- [x] 5. Implement elapsed, remaining, and timeline progress
  - [x] 5.1 Implement `totalBusinessDays`, `elapsedBusinessDays`, `remainingBusinessDays`, `timelineProgress` in `core/businessDays.ts`
    - Clamp elapsed to `[0, total]`; `remaining = total - elapsed`; before start ⇒ elapsed 0, remaining total; on/after end ⇒ elapsed total, remaining 0; total 0 ⇒ elapsed 0 / remaining 0 with no error
    - `timelineProgress = elapsed / total` in `[0, 1]`; guard `total === 0` ⇒ 0 (no division by zero)
    - _Requirements: 9.1, 9.2, 9.3, 9.5, 9.6, 9.7, 10.1, 10.2, 10.3_

  - [ ]* 5.2 Write property tests for elapsed/remaining invariants
    - **Property 4: Elapsed within total** — `0 <= elapsed <= total` — **Validates: Requirements 9.1**
    - **Property 5: Elapsed + remaining = total** — **Validates: Requirements 9.2, 9.3**
    - **Property 6: Elapsed monotone in time** — `t1 <= t2` ⇒ `elapsed(t1) <= elapsed(t2)` — **Validates: Requirements 9.4**
    - **Property 7: Boundary behavior** — before start ⇒ elapsed 0; on/after end ⇒ elapsed total — **Validates: Requirements 9.5, 9.6**

  - [ ]* 5.3 Write property tests for timeline progress
    - **Property 8: Timeline progress in range** — `0 <= timelineProgress <= 1` — **Validates: Requirements 10.2**
    - **Property 9: Zero-total safe** — `total === 0` ⇒ `timelineProgress === 0` — **Validates: Requirements 9.7, 10.3**

- [x] 6. Checkpoint - Business-day core
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement health calculator
  - [x] 7.1 Implement `healthDelta`, `resolveHealthBand`, `resolveHealth` in `core/healthCalculator.ts`
    - `healthDelta = ticketProgress - timelineProgress`, rounded to 2 decimals, in `[-1, 1]`
    - Threshold ladder: `delta <= -0.25` ⇒ atRisk/red/"At Risk"; `-0.25 < delta <= -0.10` ⇒ behind/yellow/"Behind Schedule"; `-0.10 < delta < 0.10` ⇒ onTrack/green/"On Track"; `delta >= 0.10` ⇒ ahead/green/"Ahead of Schedule"
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 12.1_

  - [ ]* 7.2 Write property tests for health band totality and delta
    - **Property 12: Band is a total function** — every `delta in [-1, 1]` maps to exactly one of four bands — **Validates: Requirements 4.6**
    - **Property 13: Delta range** — `healthDelta(tp, tl) in [-1, 1]` for `tp, tl in [0, 1]` — **Validates: Requirements 12.1**

  - [ ]* 7.3 Write property test for monotone severity
    - **Property 14: Monotone severity** — `delta1 <= delta2` ⇒ `severity(band(delta1)) >= severity(band(delta2))`, order `atRisk > behind > onTrack > ahead` — **Validates: Requirements 12.2**

  - [ ]* 7.4 Write property/unit test for threshold placement
    - **Property 15: Threshold placement** — `resolveHealthBand(-0.25) === "atRisk"`, `(-0.10) === "behind"`, `(0.10) === "ahead"`, `(0) === "onTrack"` — **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 12.3, 12.4, 12.5, 12.6**

- [x] 8. Implement ticket view and progress
  - [x] 8.1 Implement `buildTicketView(ticketSummary)` in `core/sprintEngine.ts`
    - Carry done/inProgress/blocked/total; `ticketProgress = done / total` in `[0, 1]`; guard `total === 0` ⇒ progress 0 with counts of 0
    - _Requirements: 11.1, 11.2, 11.3, 3.1, 3.2, 3.4_

  - [ ]* 8.2 Write property tests for ticket progress
    - **Property 10: Ticket progress in range** — `0 <= ticketProgress <= 1` — **Validates: Requirements 11.2**
    - **Property 11: Zero-total safe** — `total === 0` ⇒ `ticketProgress === 0` — **Validates: Requirements 11.3**

- [x] 9. Implement sprint selection and milestone filtering
  - [x] 9.1 Implement `pickActiveSprint` and `pickNextSprint` in `core/sprintEngine.ts`
    - Active: `state === "active"`, else the sprint whose date window contains today, else null
    - Next: earliest `startDate` on/after active's `endDate`; tie broken by lexicographically smallest name; handle missing/invalid active `endDate`
    - _Requirements: 5.1, 5.2, 16.1, 16.2, 16.3_

  - [x] 9.2 Implement `upcomingMilestones` in `core/sprintEngine.ts`
    - Keep milestones with `date >= today` (calendar date only, Central Time); sort ascending by date, then case-insensitive ascending by name; drop records missing a name or a valid date
    - _Requirements: 7.1, 7.2, 7.5_

  - [ ]* 9.3 Write property tests for next sprint and milestones
    - **Property 19: Next sprint follows current** — if both exist, `nextSprint.startDate >= currentSprint.endDate` — **Validates: Requirements 5.1**
    - **Property 20: Milestones upcoming and sorted** — every `vm.milestones` entry has `date >= today` and the list is ascending by date — **Validates: Requirements 7.1, 7.2**

  - [ ]* 9.4 Write unit tests for selection edge cases
    - No active sprint; tie-break on next sprint; missing/invalid active `endDate`; milestone same-date name ordering; milestones missing name/date excluded
    - _Requirements: 5.2, 5.6, 7.5, 16.2, 16.3_

- [x] 10. Compose the view model
  - [x] 10.1 Implement `buildViewModel(data, now)` in `core/sprintEngine.ts`
    - Compute today via `toCentralDate`; assemble currentSprint, timeline, tickets, health, nextSprint, roadmap, upcoming milestones, and `statusBarText`
    - When no active sprint: `timeline === null`, `health === null`, status text is the no-active-sprint state
    - Format status text `"🏃 <name> | <remaining>d left | <healthIcon>"` with health icon mapped from band (ahead/onTrack ⇒ ✅, behind ⇒ ⚠, atRisk ⇒ 🔴)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.8, 4.7, 17.1, 17.2, 18.1_

  - [ ]* 10.2 Write property test for no-active-sprint null views
    - **Property 18: No active sprint yields null views** — `pickActiveSprint` null ⇒ `timeline === null`, `health === null`, status text reflects no-sprint state — **Validates: Requirements 16.3**

  - [ ]* 10.3 Write unit tests for view-model composition
    - Status bar text formatting and name truncation to 30 chars with "…"; remaining "0d left"; single view model rendered by both surfaces without recompute
    - _Requirements: 1.1, 1.8, 17.1, 17.2_

- [x] 11. Checkpoint - Pure core complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement data loader and validation
  - [x] 12.1 Implement `loadSprintData(raw)` in `core/sprintEngine.ts`
    - Parse JSON; on parse failure throw a typed `SprintDataError` carrying the parse message
    - Validate: required top-level fields present; dates match `^\d{4}-\d{2}-\d{2}$`; each sprint `endDate >= startDate`; at most one `state === "active"` sprint; at most one `state === "current"` cycle; ticket counts `>= 0`
    - Reject with typed errors that name the offending field/sprint/milestone and value
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 15.3, 15.4, 15.5_

  - [ ]* 12.2 Write unit tests for loader validation and rejection paths
    - Well-formed data returns `SprintData`; malformed JSON throws with message; missing required field named; bad date format / `endDate < startDate` named; more than one active sprint rejected; negative ticket count rejected
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.7, 15.3, 15.4, 15.5_

- [x] 13. Implement the status bar surface
  - [x] 13.1 Implement `src/statusBar.ts`
    - Create/own the `StatusBarItem`; `renderStatusBar(item, vm)` sets text from `vm.statusBarText`; set item command to `sprintpulse.openSidebar`
    - Handle the no-active-sprint and error states ("🏃 No active sprint", "🏃 Sprint data unreadable", "🏃 No sprint data")
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 15.1, 15.2_

  - [ ]* 13.2 Write unit tests for status bar rendering
    - Text and icon per band; no-active-sprint text; error-state texts; command binding is `sprintpulse.openSidebar`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 15.1, 15.2_

- [x] 14. Build the webview sidebar assets
  - [x] 14.1 Create `webview/sidebar.html` and `webview/sidebar.css`
    - Six sections: current sprint, ticket progress, sprint health, next sprint, release roadmap, upcoming milestones; progress-bar and health-color styling
    - _Requirements: 2.1, 2.5, 3.3, 4.7, 5.3, 6.1, 7.3_

  - [x] 14.2 Implement `webview/sidebar.js` rendering and messaging
    - On load post `{type:"ready"}`; on `{type:"viewModel"}` render all six sections from the single payload; provide a refresh affordance that posts `{type:"refresh"}`
    - Current sprint: name (truncate 60), dates in locale format, remaining business days, timeline progress bar; hide when no active sprint
    - Tickets: done/inProgress/blocked/total, percentage, filled bar; total 0 ⇒ 0% empty bar; error indication retaining prior counts
    - Health: label + color + icon; hide when no active sprint; show "cannot compute" when progress unavailable
    - Next sprint: name (truncate 100) + start date; "no next sprint" and "cannot be determined" messages
    - Roadmap: render every cycle in order with ✓ / ► / upcoming indicator; unknown state ⇒ upcoming indicator + unrecognized note; empty ⇒ empty-state message
    - Milestones: name + ISO date; empty ⇒ empty-state message
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 4.7, 4.8, 4.9, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.3, 7.4, 17.3_

- [x] 15. Implement the sidebar provider and messaging host
  - [x] 15.1 Implement `src/sidebar.ts`
    - `WebviewViewProvider` that loads the webview assets; wrap `postMessage` in try/catch; on `ready`/`refresh` send `{type:"viewModel", payload}`; re-request the view model on next reveal if a `ready` handshake drops
    - _Requirements: 15.6, 17.2, 17.3_

  - [ ]* 15.2 Write unit/host tests for messaging
    - `ready` ⇒ `viewModel` sent; `refresh` ⇒ `viewModel` re-sent; dropped `ready` recovered on next reveal without an empty panel
    - _Requirements: 15.6, 17.3_

- [x] 16. Wire up extension activation
  - [x] 16.1 Implement `src/extension.ts`
    - `activate`: read `storage/sprintData.json` (detect ENOENT ⇒ "no sprint data" state), call `loadSprintData` (catch `SprintDataError` ⇒ "unreadable" state), `buildViewModel(now)`, render status bar, register the `sprintpulse.openSidebar` command and the sidebar provider, and push the view model to both surfaces
    - Register a file watcher on `storage/sprintData.json` that recomputes and re-pushes the view model on change; `deactivate` disposes resources
    - Handle `openSidebar` command failure with an error notification while the status bar retains its text
    - _Requirements: 1.6, 1.7, 15.1, 15.2, 17.1, 17.2, 18.1_

- [x] 17. Checkpoint - Extension wired
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. Integration tests and sample data
  - [x] 18.1 Create `storage/sprintData.json` sample data
    - Use the design's example (sprints with one active, ticketSummary, milestones, releaseRoadmap) so the extension renders a full HUD on activation
    - _Requirements: 14.2, 18.1_

  - [ ]* 18.2 Write integration tests with `@vscode/test-electron`
    - Extension activates; `sprintpulse.openSidebar` command is registered; status bar text renders; `ready → viewModel` handshake completes
    - _Requirements: 1.6, 17.2, 17.3, 18.1_

  - [ ]* 18.3 Manual VS Code UI verification
    - Launch the Extension Development Host, confirm the status bar summary, click it to reveal the sidebar, and visually check all six sections render
    - _Requirements: 1.6, 18.1_

- [x] 19. Final checkpoint - Full suite
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests and manual verification) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement/acceptance-criteria numbers for traceability; property test tasks also name the correctness property (Property N) they validate.
- Property tests for the timezone properties (16, 17) must run under multiple `TZ` values to prove zone stability and DST safety.
- Checkpoints provide incremental validation at natural boundaries (business-day core, full pure core, extension wiring, full suite).
- Division-by-zero guards, error-handling paths, and no-active-sprint handling are encoded as testable tasks rather than left implicit.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.2"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2", "4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "7.1", "8.1"] },
    { "id": 6, "tasks": ["7.2", "7.3", "7.4", "8.2", "9.1", "9.2"] },
    { "id": 7, "tasks": ["9.3", "9.4", "10.1"] },
    { "id": 8, "tasks": ["10.2", "10.3", "12.1"] },
    { "id": 9, "tasks": ["12.2", "13.1", "14.1", "15.1"] },
    { "id": 10, "tasks": ["13.2", "14.2", "15.2", "16.1"] },
    { "id": 11, "tasks": ["18.1"] },
    { "id": 12, "tasks": ["18.2", "18.3"] }
  ]
}
```
