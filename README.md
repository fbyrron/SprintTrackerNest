# SprintTrackerNest

A live sprint HUD inside VS Code and Kiro. Connect your Jira account, point it at a
scrum board, and see your current sprint, business days left, sprint health, your
tickets grouped by board column, and the next sprint — without leaving the editor.

## Features

- Current sprint with date range, business-day countdown, and health badge
- Your Jira tickets for the active sprint, grouped by the board's real columns
- Next sprint and an "Open Board" link (filtered to you)
- Status bar summary: sprint name, days left, health

## Setup

1. Open the SprintTrackerNest panel (rocket icon in the activity bar).
2. In the Settings view, click **Connect Jira** and enter:
   - your Jira site (e.g. https://your-domain.atlassian.net)
   - your Atlassian account email
   - a Jira API token (create one at https://id.atlassian.com/manage-profile/security/api-tokens)
3. Click **Set Scrum Board** and enter your board ID (the number in the board URL).
4. The HUD populates. Use the refresh icon to pull fresh data.

Your API token is stored in VS Code SecretStorage (OS-encrypted) and never written to
disk or logs.

## Commands

- SprintTrackerNest: Connect Jira
- SprintTrackerNest: Disconnect Jira
- SprintTrackerNest: Set Scrum Board ID
- Refresh