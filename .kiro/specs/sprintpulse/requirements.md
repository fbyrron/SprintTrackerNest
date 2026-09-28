# Requirements Document

## Introduction

SprintPulse is a VS Code extension that shows a live sprint HUD inside the IDE. It answers, in a few seconds, the questions a developer usually opens Jira or Confluence for: what sprint am I in, how many business days are left, am I on track, what sprint comes next, and when the release milestones fall.

The MVP reads a local JSON file (`storage/sprintData.json`). There is no Jira, Confluence, or network integration. A status bar widget shows a compact summary; clicking it opens a webview sidebar with six sections: current sprint, ticket progress, sprint health, next sprint, release roadmap, and upcoming milestones.

All "today" and date-difference math runs in America/Chicago (Central Time). Business days exclude Saturday and Sunday. These requirements are derived from the approved design document and are written so that each of the design's 20 correctness properties can be traced back to one or more acceptance criteria.

## Glossary

- **SprintPulse**: The VS Code extension as a whole.
- **Status_Bar_Widget**: The VS Code status bar item that renders the compact sprint summary and routes a click to the sidebar.
- **Sidebar**: The webview view that renders the six detail sections.
- **Sprint_Engine**: The pure core module that loads data, selects the active and next sprint, invokes the calculators, and assembles the view model.
- **Business_Day_Calculator**: The pure core module that counts total, elapsed, and remaining business days and computes timeline progress in Central Time.
- **Health_Calculator**: The pure core module that computes the health delta and resolves the health band, color, and label.
- **Data_Loader**: The `loadSprintData` routine that parses and validates `storage/sprintData.json`.
- **Sprint_Data**: The parsed data store containing `sprints`, `ticketSummary`, `milestones`, and `releaseRoadmap`.
- **Active_Sprint**: The single sprint whose `state` is `"active"`, or, absent that, the sprint whose date window contains today.
- **Next_Sprint**: The earliest sprint whose `startDate` is on or after the Active_Sprint's `endDate`.
- **Business Day**: A calendar day that is Monday through Friday (Saturday and Sunday are excluded).
- **Central Time**: The America/Chicago time zone, used for "today" and all date math.
- **Calendar Date**: A time-zone-independent year/month/day value with no time-of-day component.
- **Timeline Progress**: Elapsed business days divided by total business days, in `[0, 1]`.
- **Ticket Progress**: Done tickets divided by total tickets, in `[0, 1]`.
- **Health Delta**: Ticket Progress minus Timeline Progress, in `[-1, 1]`.
- **Health Band**: One of `atRisk`, `behind`, `onTrack`, `ahead`.
- **View_Model**: The single computed object both the Status_Bar_Widget and Sidebar render.

## Requirements

### Requirement 1: Status Bar Widget Summary

**User Story:** As a developer, I want a compact sprint summary in the status bar, so that I can see my sprint status without opening any panel.

#### Acceptance Criteria

1. WHILE an Active_Sprint exists, THE Status_Bar_Widget SHALL display text in the format "🏃 <sprintName> | <remaining>d left | <healthIcon>", where `<sprintName>` is truncated to a maximum of 30 characters (appending "…" when truncated), `<remaining>` is the remaining business days as a non-negative integer from 0 to 999, and `<healthIcon>` is the icon derived from the Health Band.
2. WHERE the Health Band is `ahead` or `onTrack`, THE Status_Bar_Widget SHALL use the health icon "✅".
3. WHERE the Health Band is `behind`, THE Status_Bar_Widget SHALL use the health icon "⚠".
4. WHERE the Health Band is `atRisk`, THE Status_Bar_Widget SHALL use the health icon "🔴".
5. IF no Active_Sprint exists, THEN THE Status_Bar_Widget SHALL display the text "🏃 No active sprint".
6. WHEN the developer clicks the Status_Bar_Widget, THE SprintPulse SHALL reveal the Sidebar via the `sprintpulse.openSidebar` command within 500 milliseconds of the click.
7. IF the `sprintpulse.openSidebar` command fails to execute, THEN THE SprintPulse SHALL display an error notification indicating the Sidebar could not be opened, and THE Status_Bar_Widget SHALL retain its current displayed text.
8. WHILE an Active_Sprint exists AND the remaining business days equals 0, THE Status_Bar_Widget SHALL display "0d left" in the remaining-days segment.

### Requirement 2: Current Sprint Section

**User Story:** As a developer, I want to see my current sprint details, so that I know its name, dates, and how far along it is.

#### Acceptance Criteria

1. WHILE an Active_Sprint exists, THE Sidebar SHALL display the Active_Sprint name, start date, and end date, where dates are shown in the user's locale date format.
2. WHILE an Active_Sprint exists AND the Active_Sprint name exceeds 60 characters, THE Sidebar SHALL truncate the displayed name to 60 characters.
3. WHILE an Active_Sprint exists, THE Sidebar SHALL display the count of remaining business days for the Active_Sprint, counting Monday through Friday from the current date up to and including the end date, as an integer of 0 or greater.
4. WHILE an Active_Sprint exists AND the current date is after the end date, THE Sidebar SHALL display the remaining business days as 0.
5. WHILE an Active_Sprint exists, THE Sidebar SHALL display the Timeline Progress as an integer percentage from 0 to 100, calculated as elapsed business days divided by total business days, together with a visual progress bar whose filled width matches the Timeline Progress percentage.
6. IF no Active_Sprint exists, THEN THE Sidebar SHALL hide the current sprint section.

### Requirement 3: Ticket Progress Section

**User Story:** As a developer, I want to see ticket completion for my sprint, so that I know how much work is done versus remaining.

#### Acceptance Criteria

1. WHEN the Sprint_Data ticket summary is available, THE Sidebar SHALL display the done, in-progress, blocked, and total ticket counts, each shown as a non-negative integer.
2. WHEN the Sprint_Data ticket summary is available, THE Sidebar SHALL display the Ticket Progress as a percentage, calculated as (done count / total count) × 100 rounded to the nearest whole number and constrained to the range 0 to 100.
3. WHEN the Ticket Progress percentage is displayed, THE Sidebar SHALL render a visual progress bar whose filled width equals the Ticket Progress percentage of the bar's total width.
4. IF the total ticket count is 0, THEN THE Sidebar SHALL display a Ticket Progress of 0 percent, an empty progress bar, and counts of 0 for done, in-progress, and blocked.
5. IF the Sprint_Data ticket summary is unavailable or cannot be retrieved, THEN THE Sidebar SHALL display an error indication in the Ticket Progress section and SHALL retain any previously displayed counts.

### Requirement 4: Sprint Health Section

**User Story:** As a developer, I want to see whether my sprint is on track, so that I can react early if ticket progress trails the timeline.

#### Acceptance Criteria

1. WHILE an Active_Sprint exists, THE Health_Calculator SHALL compute the Health Delta as Ticket Progress minus Timeline Progress, where both inputs are in the range [0, 1] and the resulting Delta is rounded to 2 decimal places.
2. IF the Health Delta is less than or equal to -0.25, THEN THE Health_Calculator SHALL resolve the Health Band to `atRisk` with color red and label "At Risk".
3. IF the Health Delta is greater than -0.25 and less than or equal to -0.10, THEN THE Health_Calculator SHALL resolve the Health Band to `behind` with color yellow and label "Behind Schedule".
4. IF the Health Delta is greater than -0.10 and less than 0.10, THEN THE Health_Calculator SHALL resolve the Health Band to `onTrack` with color green and label "On Track".
5. IF the Health Delta is greater than or equal to 0.10, THEN THE Health_Calculator SHALL resolve the Health Band to `ahead` with color green and label "Ahead of Schedule".
6. THE Health_Calculator SHALL resolve every Health Delta in the range [-1, 1] to exactly one Health Band.
7. WHILE an Active_Sprint exists, THE Sidebar SHALL display the Health Band label with its associated color and a distinct icon per band.
8. IF no Active_Sprint exists, THEN THE Sidebar SHALL hide the sprint health section.
9. IF Ticket Progress or Timeline Progress is unavailable, THEN THE Sidebar SHALL display an indication that sprint health cannot be computed and SHALL NOT display a Health Band label.

### Requirement 5: Next Sprint Section

**User Story:** As a developer, I want to see which sprint comes next, so that I can anticipate upcoming work.

#### Acceptance Criteria

1. THE Sprint_Engine SHALL select as the Next_Sprint the sprint with the earliest `startDate` among all sprints whose `startDate` is on or after the Active_Sprint's `endDate`.
2. IF two or more candidate sprints share the same earliest `startDate`, THEN THE Sprint_Engine SHALL select the one with the lexicographically smallest sprint name as the Next_Sprint.
3. WHERE a Next_Sprint exists, THE Sidebar SHALL display the Next_Sprint name and start date.
4. IF the Next_Sprint name is empty or exceeds 100 characters, THEN THE Sidebar SHALL display the name truncated to 100 characters.
5. IF no Next_Sprint exists, THEN THE Sidebar SHALL display a message indicating that no next sprint is scheduled.
6. IF the Active_Sprint's `endDate` is missing or invalid, THEN THE Sidebar SHALL display a message indicating that the next sprint cannot be determined and SHALL NOT display a Next_Sprint name or start date.

### Requirement 6: Release Roadmap Section

**User Story:** As a developer, I want to see the release roadmap, so that I understand which cycles are done, current, and upcoming.

#### Acceptance Criteria

1. WHEN the Sidebar renders the Release Roadmap section, THE Sidebar SHALL display every release cycle present in the Sprint_Data release roadmap, in the order the cycles appear in the Sprint_Data release roadmap.
2. WHERE a release cycle state is `completed`, THE Sidebar SHALL render the cycle with the completed indicator (✓).
3. WHERE a release cycle state is `current`, THE Sidebar SHALL render the cycle with the current indicator (►).
4. WHERE a release cycle state is `upcoming`, THE Sidebar SHALL render the cycle with the upcoming indicator.
5. IF a release cycle has a state value other than `completed`, `current`, or `upcoming`, THEN THE Sidebar SHALL render the cycle with the upcoming indicator and display an indication that the state is unrecognized.
6. IF the Sprint_Data release roadmap contains zero release cycles, THEN THE Sidebar SHALL display an empty-state message indicating that no release cycles are available.

### Requirement 7: Upcoming Milestones Section

**User Story:** As a developer, I want to see upcoming release milestones, so that I know what deadlines are ahead.

#### Acceptance Criteria

1. THE Sprint_Engine SHALL include in the upcoming milestones only milestones whose date is on or after the current date in Central Time (America/Chicago), where the comparison uses calendar date only and excludes time-of-day.
2. THE Sprint_Engine SHALL sort the upcoming milestones in ascending order by date, and for milestones sharing the same date SHALL order them alphabetically by milestone name (case-insensitive, ascending).
3. WHEN the upcoming milestones list contains at least one milestone, THE Sidebar SHALL display each milestone's name and date, with date formatted as an ISO 8601 calendar date (YYYY-MM-DD).
4. WHEN the upcoming milestones list contains zero milestones, THE Sidebar SHALL display a message indicating that no upcoming milestones exist.
5. IF a milestone record is missing a name or a valid date, THEN THE Sprint_Engine SHALL exclude that milestone from the upcoming milestones list and retain all remaining valid milestones.

### Requirement 8: Business Day Counting

**User Story:** As a developer, I want sprint counts to reflect working days, so that "days left" matches how the team actually plans.

#### Acceptance Criteria

1. THE Business_Day_Calculator SHALL count only Monday through Friday as business days and SHALL exclude Saturday and Sunday.
2. WHEN counting business days between a start Calendar Date and an end Calendar Date where the end date is on or after the start date, THE Business_Day_Calculator SHALL include both the start date and the end date in the inclusive range.
3. THE Business_Day_Calculator SHALL return a business day count that is greater than or equal to 0 and less than or equal to the total calendar days in the inclusive range.
4. IF the start date or the end date is null, THEN THE Business_Day_Calculator SHALL return a business day count of 0 and SHALL provide an indication that an invalid date input was supplied, without altering either input date.
5. IF the end date is earlier than the start date, THEN THE Business_Day_Calculator SHALL return a business day count of 0.
6. WHEN the start date and the end date are the same Calendar Date and that date is Monday through Friday, THE Business_Day_Calculator SHALL return a business day count of 1, and WHEN that date is Saturday or Sunday, THE Business_Day_Calculator SHALL return a business day count of 0.

### Requirement 9: Elapsed and Remaining Business Days

**User Story:** As a developer, I want accurate elapsed and remaining day counts, so that the sprint progress I see is trustworthy.

#### Acceptance Criteria

1. THE Business_Day_Calculator SHALL return elapsed business days as an integer in the range from 0 to the total business days of the sprint, inclusive, clamping any computed value below 0 to 0 and any computed value above the total to the total.
2. THE Business_Day_Calculator SHALL return remaining business days as an integer equal to the total business days of the sprint minus the elapsed business days.
3. THE Business_Day_Calculator SHALL ensure that elapsed business days plus remaining business days equals the total business days of the sprint.
4. WHEN today advances from an earlier Calendar Date to a later Calendar Date within the same sprint, THE Business_Day_Calculator SHALL return an elapsed business day count that is greater than or equal to the elapsed business day count returned for the earlier Calendar Date.
5. IF today is earlier than the sprint start date, THEN THE Business_Day_Calculator SHALL return elapsed business days of 0 and remaining business days equal to the total business days of the sprint.
6. IF today is on or after the sprint end date, THEN THE Business_Day_Calculator SHALL return elapsed business days equal to the total business days of the sprint and remaining business days of 0.
7. IF the total business days of the sprint is 0, THEN THE Business_Day_Calculator SHALL return elapsed business days of 0 and remaining business days of 0 without raising an error.

### Requirement 10: Timeline Progress Calculation

**User Story:** As a developer, I want timeline progress computed from business days, so that the progress bar reflects real working time.

#### Acceptance Criteria

1. THE Business_Day_Calculator SHALL compute Timeline Progress as elapsed business days divided by total business days.
2. THE Business_Day_Calculator SHALL return a Timeline Progress value in the range from 0 to 1, inclusive.
3. IF the total business days of the sprint equals 0, THEN THE Business_Day_Calculator SHALL return a Timeline Progress of 0.

### Requirement 11: Ticket Progress Calculation

**User Story:** As a developer, I want ticket progress computed from the ticket summary, so that the completion bar is accurate.

#### Acceptance Criteria

1. THE Sprint_Engine SHALL compute Ticket Progress as done tickets divided by total tickets.
2. THE Sprint_Engine SHALL return a Ticket Progress value in the range from 0 to 1, inclusive.
3. IF the total ticket count equals 0, THEN THE Sprint_Engine SHALL return a Ticket Progress of 0.

### Requirement 12: Health Delta and Band Ordering

**User Story:** As a developer, I want the health band to move consistently with progress, so that lower progress never shows a healthier status.

#### Acceptance Criteria

1. THE Health_Calculator SHALL return a Health Delta in the range from -1 to 1, inclusive, for Ticket Progress and Timeline Progress values in the range from 0 to 1.
2. WHEN comparing two Health Delta values where the first is less than or equal to the second, THE Health_Calculator SHALL resolve the first delta to a Health Band whose severity is greater than or equal to that of the second, where severity order is atRisk greater than behind greater than onTrack greater than ahead.
3. THE Health_Calculator SHALL resolve a Health Delta of exactly -0.25 to the `atRisk` band.
4. THE Health_Calculator SHALL resolve a Health Delta of exactly -0.10 to the `behind` band.
5. THE Health_Calculator SHALL resolve a Health Delta of exactly 0 to the `onTrack` band.
6. THE Health_Calculator SHALL resolve a Health Delta of exactly 0.10 to the `ahead` band.

### Requirement 13: Central Time and DST-Safe Date Math

**User Story:** As a developer, I want all date math in Central Time, so that counts are correct regardless of my machine's time zone or daylight saving changes.

#### Acceptance Criteria

1. THE Business_Day_Calculator SHALL evaluate today and all date differences using the America/Chicago time zone.
2. WHEN converting a fixed instant to a Calendar Date, THE Business_Day_Calculator SHALL produce the same Calendar Date and the same downstream counts regardless of the host machine's local time zone.
3. WHEN counting business days across a United States daylight saving time transition, THE Business_Day_Calculator SHALL produce a count equal to the count computed on plain Calendar Dates, without dropping or double-counting any day.

### Requirement 14: Data Loading and Validation

**User Story:** As a developer, I want the extension to read and validate my sprint data file, so that I can trust the numbers or get a clear error.

#### Acceptance Criteria

1. THE Data_Loader SHALL read and parse the JSON data store from `storage/sprintData.json`.
2. WHEN the JSON is well formed and valid, THE Data_Loader SHALL return a Sprint_Data object containing `sprints`, `ticketSummary`, `milestones`, and `releaseRoadmap`.
3. THE Data_Loader SHALL accept a `startDate`, `endDate`, or milestone `date` only when it matches the pattern `^\d{4}-\d{2}-\d{2}$`.
4. THE Data_Loader SHALL require that each sprint has an `endDate` that is on or after its `startDate`.
5. THE Data_Loader SHALL require that at most one sprint has `state` equal to `"active"`.
6. THE Data_Loader SHALL require that at most one release cycle has `state` equal to `"current"`.
7. THE Data_Loader SHALL require that the `done`, `inProgress`, `blocked`, and `total` ticket counts are each greater than or equal to 0.

### Requirement 15: Error Handling and Safe States

**User Story:** As a developer, I want the extension to fail safely, so that a bad data file never crashes the IDE or leaves a blank panel.

#### Acceptance Criteria

1. IF the JSON in the data store cannot be parsed, THEN THE SprintPulse SHALL display "🏃 Sprint data unreadable" in the Status_Bar_Widget and an error card with the parse message in the Sidebar.
2. IF the data store file is missing, THEN THE SprintPulse SHALL display "🏃 No sprint data" in the Status_Bar_Widget and a prompt to create `storage/sprintData.json` in the Sidebar.
3. IF a required top-level field (`sprints`, `ticketSummary`, `milestones`, or `releaseRoadmap`) is absent, THEN THE Data_Loader SHALL reject the data and THE Sidebar SHALL display an error card naming the missing field.
4. IF a date fails the `^\d{4}-\d{2}-\d{2}$` format or a sprint has `endDate` earlier than `startDate`, THEN THE Data_Loader SHALL reject the data and THE Sidebar SHALL display an error card naming the offending sprint or milestone and value.
5. IF more than one sprint has `state` equal to `"active"`, THEN THE Data_Loader SHALL reject the data and THE Sidebar SHALL display an error card explaining the ambiguous state.
6. IF the webview messaging handshake drops the `ready` message, THEN THE Sidebar SHALL re-request the View_Model on the next reveal without leaving an empty panel.

### Requirement 16: Active Sprint Selection and No-Active-Sprint State

**User Story:** As a developer, I want the extension to pick the right active sprint, so that the HUD reflects the sprint I am actually in.

#### Acceptance Criteria

1. WHEN a sprint has `state` equal to `"active"`, THE Sprint_Engine SHALL select that sprint as the Active_Sprint.
2. IF no sprint has `state` equal to `"active"`, THEN THE Sprint_Engine SHALL select as the Active_Sprint the sprint whose date window contains today, if one exists.
3. IF no Active_Sprint can be selected, THEN THE Sprint_Engine SHALL set the timeline view and the health view to null and SHALL set the status bar text to the no-active-sprint state.

### Requirement 17: View Model Composition

**User Story:** As a developer, I want the status bar and sidebar to show the same computed data, so that the two views never disagree.

#### Acceptance Criteria

1. THE Sprint_Engine SHALL compose a single View_Model containing the current sprint, timeline view, ticket view, health view, next sprint, roadmap, upcoming milestones, and status bar text.
2. THE Status_Bar_Widget and THE Sidebar SHALL render from the same View_Model without recomputing any value.
3. WHEN the Sidebar sends a `ready` or `refresh` message, THE SprintPulse SHALL send the current View_Model to the Sidebar as a `viewModel` message.

### Requirement 18: Success Criteria

**User Story:** As a developer, I want to see my sprint status at a glance in the IDE, so that I do not have to leave my editor to check Jira or Confluence.

#### Acceptance Criteria

1. WHERE valid Sprint_Data with an Active_Sprint is loaded, THE SprintPulse SHALL let the developer see the current sprint, timeline progress, business days remaining, ticket completion, sprint health, next sprint, and upcoming milestones within the IDE.

## Non-Goals (Out of Scope for MVP)

The following are explicitly out of scope for the MVP. No requirements are written for them.

- AI features of any kind.
- Jira, Confluence, Teams, or GitLab integration.
- Story point tracking.
- Burndown charts.
- Notifications.
- Historical analytics or sprint history.
- Custom holidays (the design leaves a seam, but the MVP counts only weekends as non-business days).
