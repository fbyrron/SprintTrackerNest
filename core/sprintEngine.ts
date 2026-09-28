// core/sprintEngine.ts
//
// View-model assembly for SprintPulse.
//
// This module is part of the pure core: it MUST NOT import `vscode`.
// It turns raw sprint inputs into the shapes the UI renders.

import type { TicketSummary } from "../models/ticketSummary";
import type { HealthBand, HealthView, TicketView, TimelineView, SprintViewModel } from "./types";
import { resolveHealth } from "./healthCalculator";

/**
 * Build the ticket view from a raw ticket summary.
 *
 * Carries `done`, `inProgress`, `blocked`, and `total` through unchanged, and
 * derives `ticketProgress = done / total` (Requirement 11.1). The result is a
 * fraction in [0, 1] because `done` is at most `total` (Requirement 11.2).
 *
 * Guards `total === 0` by returning `ticketProgress` 0 with all counts of 0, so
 * there is no division by zero and no NaN (Requirements 11.3, 3.1, 3.2, 3.4).
 */
export function buildTicketView(ticketSummary: TicketSummary): TicketView {
  // Requirements 11.3, 3.4: empty summary ⇒ progress 0 and zeroed counts.
  if (ticketSummary.total === 0) {
    return {
      done: 0,
      inProgress: 0,
      blocked: 0,
      total: 0,
      ticketProgress: 0,
    };
  }

  // Requirements 3.1, 3.2, 11.1: carry counts through and derive progress.
  return {
    done: ticketSummary.done,
    inProgress: ticketSummary.inProgress,
    blocked: ticketSummary.blocked,
    total: ticketSummary.total,
    ticketProgress: ticketSummary.done / ticketSummary.total,
  };
}

// ---------------------------------------------------------------------------
// Sprint selection and milestone filtering (task 9.1, 9.2)
// ---------------------------------------------------------------------------

import type { Sprint } from "../models/sprint";
import type { Milestone } from "../models/milestone";
import type { SprintData } from "../models/sprintData";
import {
  parseIsoDate,
  compareDates,
  toCentralDate,
  totalBusinessDays,
  elapsedBusinessDays,
  remainingBusinessDays,
  timelineProgress,
  type CalendarDate,
} from "./businessDays";

/** Matches a strict ISO calendar date "YYYY-MM-DD". Module-private. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `iso` is a "YYYY-MM-DD" string that parses to a real calendar date.
 *
 * Rejects the wrong shape (bad pattern) and impossible dates (e.g. month 13 or
 * "2024-02-30") by round-tripping the parsed parts back to compare. Module-
 * private guard used before any `parseIsoDate` + `compareDates` window check so
 * selection never throws or compares against NaN fields.
 */
function isValidIsoDate(iso: string | null | undefined): boolean {
  if (iso == null || !ISO_DATE_PATTERN.test(iso)) {
    return false;
  }
  const { year, month, day } = parseIsoDate(iso);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  // Reject days that overflow the month (handles leap years correctly).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Select the active sprint for `today`, or null if none applies.
 *
 * - Requirement 16.1: if any sprint has `state === "active"`, return the first
 *   such sprint in array order.
 * - Requirement 16.2: otherwise return the first sprint (array order) whose
 *   inclusive date window contains `today`
 *   (`startDate <= today <= endDate`, compared as calendar dates). Sprints with
 *   a missing or unparseable `startDate`/`endDate` are skipped rather than
 *   throwing.
 * - Requirements 5.2, 16.3: if neither rule matches, return null.
 */
export function pickActiveSprint(data: SprintData, today: CalendarDate): Sprint | null {
  // Requirement 16.1: an explicitly active sprint wins.
  for (const sprint of data.sprints) {
    if (sprint.state === "active") {
      return sprint;
    }
  }

  // Requirement 16.2: fall back to the first sprint whose window holds today.
  for (const sprint of data.sprints) {
    // Skip sprints we cannot safely place on the calendar.
    if (!isValidIsoDate(sprint.startDate) || !isValidIsoDate(sprint.endDate)) {
      continue;
    }
    const start = parseIsoDate(sprint.startDate);
    const end = parseIsoDate(sprint.endDate);
    if (compareDates(start, today) <= 0 && compareDates(today, end) <= 0) {
      return sprint;
    }
  }

  // Requirements 5.2, 16.3: nothing active and nothing contains today.
  return null;
}

/**
 * Select the sprint that follows `active`, or null if none can be determined.
 *
 * - Requirement 5.1: the next sprint is the one with the earliest `startDate`
 *   among all sprints whose `startDate` is on or after `active.endDate`.
 * - Requirement 5.2: ties on the earliest `startDate` are broken by the
 *   lexicographically smallest sprint `name` (plain code-unit `<` comparison).
 * - Requirement 5.6: if `active` is null, or its `endDate` is missing/invalid,
 *   return null (the sidebar's "cannot be determined" state).
 *
 * The active sprint is excluded from candidates, and any candidate whose
 * `startDate` is missing/invalid is skipped rather than throwing.
 */
export function pickNextSprint(data: SprintData, active: Sprint | null): Sprint | null {
  // Requirement 5.6: no active sprint or unusable end date ⇒ cannot determine.
  if (active === null || !isValidIsoDate(active.endDate)) {
    return null;
  }

  const activeEnd = parseIsoDate(active.endDate);
  let best: Sprint | null = null;
  let bestStart: CalendarDate | null = null;

  for (const sprint of data.sprints) {
    // Exclude the active sprint itself from the candidate set.
    if (sprint === active) {
      continue;
    }
    // Skip candidates we cannot place on the calendar.
    if (!isValidIsoDate(sprint.startDate)) {
      continue;
    }
    const start = parseIsoDate(sprint.startDate);

    // Requirement 5.1: candidate must start on or after the active end date.
    if (compareDates(start, activeEnd) < 0) {
      continue;
    }

    if (best === null || bestStart === null) {
      best = sprint;
      bestStart = start;
      continue;
    }

    const startCompare = compareDates(start, bestStart);
    if (startCompare < 0) {
      // Earlier start date wins (Requirement 5.1).
      best = sprint;
      bestStart = start;
    } else if (startCompare === 0 && sprint.name < best.name) {
      // Requirement 5.2: tie on start date broken by smallest name.
      best = sprint;
      bestStart = start;
    }
  }

  return best;
}

/**
 * Upcoming milestones on or after `today`, sorted for display.
 *
 * - Requirement 7.5: drop any milestone missing a name (absent, empty, or
 *   whitespace-only) or missing a valid "YYYY-MM-DD" date that parses to a real
 *   calendar date.
 * - Requirement 7.1: keep only milestones whose `date` is on or after `today`
 *   (calendar-date comparison).
 * - Requirement 7.2: sort ascending by date; equal dates are ordered by name
 *   case-insensitively ascending. The input array is not mutated — a copy is
 *   sorted and returned.
 */
export function upcomingMilestones(data: SprintData, today: CalendarDate): Milestone[] {
  // Requirements 7.5, 7.1: keep only well-formed, upcoming milestones.
  const kept = data.milestones.filter((milestone) => {
    if (milestone.name == null || milestone.name.trim() === "") {
      return false;
    }
    if (!isValidIsoDate(milestone.date)) {
      return false;
    }
    return compareDates(parseIsoDate(milestone.date), today) >= 0;
  });

  // Requirement 7.2: sort a copy — never mutate the caller's array.
  return kept.slice().sort((a, b) => {
    const dateCompare = compareDates(parseIsoDate(a.date), parseIsoDate(b.date));
    if (dateCompare !== 0) {
      return dateCompare;
    }
    // Equal dates: case-insensitive ascending by name.
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    if (aName < bName) {
      return -1;
    }
    if (aName > bName) {
      return 1;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// View-model composition (task 10.1)
// ---------------------------------------------------------------------------

/** Status bar text shown when no sprint is active (Requirement 1.5). */
const NO_ACTIVE_SPRINT_TEXT = "🏃 No active sprint";

/** Maximum length of the sprint name in the status bar before truncation. */
const STATUS_BAR_NAME_MAX = 30;

/**
 * The health icon for a band as shown in the status bar.
 *
 * - `ahead`/`onTrack` ⇒ "✅" (Requirement 1.2)
 * - `behind` ⇒ "⚠" (Requirement 1.3)
 * - `atRisk` ⇒ "🔴" (Requirement 1.4)
 */
function healthIcon(band: HealthBand): string {
  switch (band) {
    case "behind":
      return "⚠";
    case "atRisk":
      return "🔴";
    case "onTrack":
    case "ahead":
      return "✅";
  }
}

/**
 * Truncate `name` to at most `STATUS_BAR_NAME_MAX` characters for the status bar.
 *
 * Requirement 1.1: when the name exceeds the limit it is cut to the limit and an
 * ellipsis "…" is appended in place of the trailing character, so the rendered
 * text never exceeds `STATUS_BAR_NAME_MAX` characters. Shorter names pass
 * through unchanged.
 */
function truncateStatusName(name: string): string {
  if (name.length <= STATUS_BAR_NAME_MAX) {
    return name;
  }
  return name.slice(0, STATUS_BAR_NAME_MAX - 1) + "…";
}

/**
 * Format the active-sprint status bar text.
 *
 * Requirement 1.1: `"🏃 <name> | <remaining>d left | <healthIcon>"`, where the
 * name is truncated to 30 chars, `<remaining>` is the remaining business days as
 * a non-negative integer, and the icon is derived from the health band.
 * Requirement 1.8: a remaining count of 0 renders as "0d left".
 */
function formatStatusBarText(name: string, remaining: number, band: HealthBand): string {
  const safeRemaining = Math.max(0, Math.trunc(remaining));
  return `🏃 ${truncateStatusName(name)} | ${safeRemaining}d left | ${healthIcon(band)}`;
}

/**
 * Compose the single view model both UI surfaces render (Requirement 17.1).
 *
 * Steps mirror the design's `buildViewModel` algorithm:
 * 1. Derive today from `now` in Central Time via `toCentralDate` (Requirement 13.1).
 * 2. Pick the active sprint and build the ticket view (always present).
 * 3. When no sprint is active: `timeline` and `health` are null and the status
 *    text is the no-active-sprint state (Requirements 1.5, 16.3, Property 18).
 * 4. When a sprint is active: compute timeline counts and progress, resolve
 *    health from ticket vs. timeline progress, and format the status bar text
 *    (Requirements 1.1-1.4, 1.8, 4.7).
 * 5. Attach next sprint, roadmap (as-is), and upcoming milestones.
 *
 * The result is the same object both surfaces render without recomputing
 * (Requirement 17.2), and it carries everything the success criteria require
 * (Requirement 18.1).
 */
export function buildViewModel(data: SprintData, now: Date): SprintViewModel {
  // Requirement 13.1: evaluate "today" in Central Time.
  const today = toCentralDate(now);

  const active = pickActiveSprint(data, today);

  // Ticket view is independent of the active sprint and always present.
  const tickets = buildTicketView(data.ticketSummary);

  let timeline: TimelineView | null;
  let health: HealthView | null;
  let statusBarText: string;

  if (active === null) {
    // Requirements 16.3, 1.5, Property 18: no active sprint ⇒ null views.
    timeline = null;
    health = null;
    statusBarText = NO_ACTIVE_SPRINT_TEXT;
  } else {
    // Timeline counts and progress for the active sprint.
    const total = totalBusinessDays(active);
    const elapsed = elapsedBusinessDays(active, today);
    const remaining = remainingBusinessDays(active, today);
    const tlProgress = timelineProgress(active, today);

    timeline = {
      totalBusinessDays: total,
      elapsedBusinessDays: elapsed,
      remainingBusinessDays: remaining,
      timelineProgress: tlProgress,
    };

    // Requirement 4.7: resolve health from ticket vs. timeline progress.
    health = resolveHealth(tickets.ticketProgress, tlProgress);

    // Requirements 1.1-1.4, 1.8: format the compact status bar summary.
    statusBarText = formatStatusBarText(active.name, remaining, health.band);
  }

  return {
    currentSprint: active,
    timeline,
    tickets,
    health,
    nextSprint: pickNextSprint(data, active),
    roadmap: data.releaseRoadmap,
    milestones: upcomingMilestones(data, today),
    statusBarText,
  };
}

// ---------------------------------------------------------------------------
// Data loading and validation (task 12.1)
// ---------------------------------------------------------------------------

import type { Sprint as SprintModel, SprintState } from "../models/sprint";
import type { TicketSummary as TicketSummaryModel } from "../models/ticketSummary";
import type { Milestone as MilestoneModel } from "../models/milestone";
import type { ReleaseCycle as ReleaseCycleModel, CycleState } from "../models/releaseCycle";

/**
 * Typed error thrown by {@link loadSprintData} for any malformed or invalid
 * data store.
 *
 * It is a real `Error` subclass so callers can `instanceof SprintDataError`
 * to distinguish a data problem (rendered as the "unreadable" safe state, per
 * Requirement 15.1) from an unexpected host error. The `message` always names
 * the offending field, sprint, milestone, or the raw parse message so the
 * sidebar error card can surface a specific, actionable reason
 * (Requirements 15.3, 15.4, 15.5).
 */
export class SprintDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SprintDataError";
    // Restore the prototype chain for `instanceof` when compiled to older
    // targets (TypeScript's documented Error-subclassing caveat).
    Object.setPrototypeOf(this, SprintDataError.prototype);
  }
}

/** The four required top-level fields of a data store (Requirement 15.3). */
const REQUIRED_TOP_LEVEL_FIELDS = [
  "sprints",
  "ticketSummary",
  "milestones",
  "releaseRoadmap",
] as const;

/** True when `value` is a non-null, non-array plain object. Module-private. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when `date` is a string matching the strict `^\d{4}-\d{2}-\d{2}$` shape.
 *
 * Requirement 14.3 defines validity purely by this pattern, so this check does
 * not attempt to reject impossible calendar dates (that stricter round-trip
 * lives in the selection helpers). Module-private to the loader.
 */
function matchesIsoPattern(date: unknown): date is string {
  return typeof date === "string" && ISO_DATE_PATTERN.test(date);
}

/**
 * Load and validate the JSON data store, returning a typed {@link SprintData}.
 *
 * Faithful to the design's "validation lives in `loadSprintData`" principle:
 * everything downstream in the pure core may assume well-formed data.
 *
 * Steps:
 * 1. Parse `raw`. On a `JSON.parse` throw, wrap the parse message in a
 *    {@link SprintDataError} (Requirements 14.1, 15.1).
 * 2. Require the parsed value to be an object and every required top-level
 *    field to be present (Requirements 14.2, 15.3).
 * 3. Validate the shape and contents of each collection, rejecting with a
 *    message that names the offending sprint / milestone / field and value:
 *    - every sprint/milestone date matches `^\d{4}-\d{2}-\d{2}$`
 *      (Requirements 14.3, 15.4);
 *    - each sprint `endDate >= startDate` (Requirements 14.4, 15.4);
 *    - at most one sprint has `state === "active"` (Requirements 14.5, 15.5);
 *    - at most one release cycle has `state === "current"` (Requirement 14.6);
 *    - every ticket count is `>= 0` (Requirement 14.7).
 * 4. Return a normalized `SprintData` object carrying `sprints`,
 *    `ticketSummary`, `milestones`, and `releaseRoadmap` (Requirement 14.2).
 *
 * @throws {SprintDataError} for any parse failure or validation violation.
 */
export function loadSprintData(raw: string): SprintData {
  // Requirements 14.1, 15.1: parse failure is a typed error carrying the message.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : String(error);
    throw new SprintDataError(`Sprint data is not valid JSON: ${parseMessage}`);
  }

  // Requirement 15.3: the document itself must be an object.
  if (!isRecord(parsed)) {
    throw new SprintDataError(
      `Sprint data must be a JSON object, but got ${describeType(parsed)}.`
    );
  }

  // Requirement 15.3: every required top-level field must be present.
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(field in parsed) || parsed[field] === undefined) {
      throw new SprintDataError(`Required field "${field}" is missing from the sprint data.`);
    }
  }

  const sprints = validateSprints(parsed.sprints);
  const ticketSummary = validateTicketSummary(parsed.ticketSummary);
  const milestones = validateMilestones(parsed.milestones);
  const releaseRoadmap = validateReleaseRoadmap(parsed.releaseRoadmap);

  // Requirement 14.2: return the aggregated, validated data store.
  return { sprints, ticketSummary, milestones, releaseRoadmap };
}

/** Human-readable type label for error messages. Module-private. */
function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return `a ${typeof value}`;
}

/**
 * Validate the `sprints` collection.
 *
 * Rejects when it is not an array, when any entry is malformed, when a date
 * fails the ISO pattern, when `endDate < startDate`, or when more than one
 * sprint is `"active"` (Requirements 14.3, 14.4, 14.5, 15.4, 15.5).
 */
function validateSprints(value: unknown): SprintModel[] {
  if (!Array.isArray(value)) {
    throw new SprintDataError(`Field "sprints" must be an array, but got ${describeType(value)}.`);
  }

  const sprints: SprintModel[] = [];
  let activeCount = 0;

  value.forEach((entry, index) => {
    const label = `sprints[${index}]`;
    if (!isRecord(entry)) {
      throw new SprintDataError(`${label} must be an object, but got ${describeType(entry)}.`);
    }

    const name = entry.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new SprintDataError(`${label} is missing a valid "name".`);
    }

    const identifier = `sprint "${name}"`;

    if (!matchesIsoPattern(entry.startDate)) {
      throw new SprintDataError(
        `${identifier} has an invalid startDate: ${JSON.stringify(entry.startDate)} does not match YYYY-MM-DD.`
      );
    }
    if (!matchesIsoPattern(entry.endDate)) {
      throw new SprintDataError(
        `${identifier} has an invalid endDate: ${JSON.stringify(entry.endDate)} does not match YYYY-MM-DD.`
      );
    }

    // Requirement 14.4 / 15.4: endDate must be on or after startDate.
    if (compareDates(parseIsoDate(entry.endDate), parseIsoDate(entry.startDate)) < 0) {
      throw new SprintDataError(
        `${identifier} has endDate ${entry.endDate} earlier than startDate ${entry.startDate}.`
      );
    }

    const state = entry.state;
    if (!isSprintState(state)) {
      throw new SprintDataError(
        `${identifier} has an invalid state: ${JSON.stringify(state)} (expected "active", "future", or "closed").`
      );
    }
    if (state === "active") {
      activeCount += 1;
    }

    sprints.push({ name, startDate: entry.startDate, endDate: entry.endDate, state });
  });

  // Requirement 14.5 / 15.5: at most one active sprint.
  if (activeCount > 1) {
    throw new SprintDataError(
      `Ambiguous sprint state: ${activeCount} sprints are marked "active", but at most one is allowed.`
    );
  }

  return sprints;
}

/** True when `value` is one of the known {@link SprintState} literals. */
function isSprintState(value: unknown): value is SprintState {
  return value === "active" || value === "future" || value === "closed";
}

/**
 * Validate the `ticketSummary` object.
 *
 * Requires an object with numeric `done`, `inProgress`, `blocked`, and `total`
 * counts that are each `>= 0` (Requirement 14.7).
 */
function validateTicketSummary(value: unknown): TicketSummaryModel {
  if (!isRecord(value)) {
    throw new SprintDataError(
      `Field "ticketSummary" must be an object, but got ${describeType(value)}.`
    );
  }

  const counts: Array<keyof TicketSummaryModel> = ["done", "inProgress", "blocked", "total"];
  for (const key of counts) {
    const count = value[key];
    if (typeof count !== "number" || !Number.isFinite(count)) {
      throw new SprintDataError(
        `ticketSummary.${key} must be a number, but got ${JSON.stringify(count)}.`
      );
    }
    // Requirement 14.7: counts must be non-negative.
    if (count < 0) {
      throw new SprintDataError(`ticketSummary.${key} must be >= 0, but got ${count}.`);
    }
  }

  return {
    done: value.done as number,
    inProgress: value.inProgress as number,
    blocked: value.blocked as number,
    total: value.total as number,
  };
}

/**
 * Validate the `milestones` collection.
 *
 * Rejects a non-array, any malformed entry, or any milestone whose `date` fails
 * the ISO pattern, naming the offending milestone and value
 * (Requirements 14.3, 15.4).
 */
function validateMilestones(value: unknown): MilestoneModel[] {
  if (!Array.isArray(value)) {
    throw new SprintDataError(
      `Field "milestones" must be an array, but got ${describeType(value)}.`
    );
  }

  return value.map((entry, index) => {
    const label = `milestones[${index}]`;
    if (!isRecord(entry)) {
      throw new SprintDataError(`${label} must be an object, but got ${describeType(entry)}.`);
    }

    const name = entry.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new SprintDataError(`${label} is missing a valid "name".`);
    }

    if (!matchesIsoPattern(entry.date)) {
      throw new SprintDataError(
        `Milestone "${name}" has an invalid date: ${JSON.stringify(entry.date)} does not match YYYY-MM-DD.`
      );
    }

    return { name, date: entry.date };
  });
}

/**
 * Validate the `releaseRoadmap` collection.
 *
 * Rejects a non-array, any malformed entry, or more than one cycle in the
 * `"current"` state (Requirement 14.6).
 */
function validateReleaseRoadmap(value: unknown): ReleaseCycleModel[] {
  if (!Array.isArray(value)) {
    throw new SprintDataError(
      `Field "releaseRoadmap" must be an array, but got ${describeType(value)}.`
    );
  }

  const cycles: ReleaseCycleModel[] = [];
  let currentCount = 0;

  value.forEach((entry, index) => {
    const label = `releaseRoadmap[${index}]`;
    if (!isRecord(entry)) {
      throw new SprintDataError(`${label} must be an object, but got ${describeType(entry)}.`);
    }

    const cycleLabel = entry.label;
    if (typeof cycleLabel !== "string" || cycleLabel.trim() === "") {
      throw new SprintDataError(`${label} is missing a valid "label".`);
    }

    const state = entry.state;
    if (!isCycleState(state)) {
      throw new SprintDataError(
        `Release cycle "${cycleLabel}" has an invalid state: ${JSON.stringify(state)} (expected "completed", "current", or "upcoming").`
      );
    }
    if (state === "current") {
      currentCount += 1;
    }

    cycles.push({ label: cycleLabel, state });
  });

  // Requirement 14.6: at most one release cycle is "current".
  if (currentCount > 1) {
    throw new SprintDataError(
      `Ambiguous roadmap state: ${currentCount} release cycles are marked "current", but at most one is allowed.`
    );
  }

  return cycles;
}

/** True when `value` is one of the known {@link CycleState} literals. */
function isCycleState(value: unknown): value is CycleState {
  return value === "completed" || value === "current" || value === "upcoming";
}
