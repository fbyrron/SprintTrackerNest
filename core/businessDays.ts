// core/businessDays.ts
//
// Central-Time calendar-date primitives for SprintPulse.
//
// This module is part of the pure core: it MUST NOT import `vscode`.
// All "today" and date-difference math is evaluated in America/Chicago so no
// calculation depends on the host machine's local timezone.

/** A timezone-independent calendar date (no time-of-day). */
export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
}

/**
 * Convert an instant to the calendar date it falls on in America/Chicago.
 *
 * Implemented with `Intl.DateTimeFormat({ timeZone: "America/Chicago" })` so it
 * is correct across DST transitions and independent of the host `TZ`.
 */
export function toCentralDate(instant: Date): CalendarDate {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  let year = NaN;
  let month = NaN;
  let day = NaN;

  for (const part of formatter.formatToParts(instant)) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      default:
        break;
    }
  }

  return { year, month, day };
}

/** Parse an ISO "YYYY-MM-DD" string into a CalendarDate (no zone conversion). */
export function parseIsoDate(iso: string): CalendarDate {
  const [yearStr, monthStr, dayStr] = iso.split("-");
  return {
    year: Number(yearStr),
    month: Number(monthStr),
    day: Number(dayStr),
  };
}

/** Compare two calendar dates. Returns -1 if a < b, 0 if equal, 1 if a > b. */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  if (a.year !== b.year) {
    return a.year < b.year ? -1 : 1;
  }
  if (a.month !== b.month) {
    return a.month < b.month ? -1 : 1;
  }
  if (a.day !== b.day) {
    return a.day < b.day ? -1 : 1;
  }
  return 0;
}

/**
 * True if the date is Saturday or Sunday.
 *
 * The weekday is derived zone-free by constructing the date in UTC, so the
 * result never shifts with the host `TZ`. `Date.UTC` + `getUTCDay` gives a
 * timezone-independent day-of-week (0 = Sunday ... 6 = Saturday).
 */
export function isWeekend(date: CalendarDate): boolean {
  const dayOfWeek = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

/**
 * Pure calendar increment: return the next calendar day.
 *
 * Rolls over month and year boundaries and handles leap years. No timezone is
 * involved. Module-private helper used by business-day counting.
 */
function nextCalendarDay(date: CalendarDate): CalendarDate {
  const daysInMonth = daysInCalendarMonth(date.year, date.month);

  if (date.day < daysInMonth) {
    return { year: date.year, month: date.month, day: date.day + 1 };
  }

  if (date.month < 12) {
    return { year: date.year, month: date.month + 1, day: 1 };
  }

  return { year: date.year + 1, month: 1, day: 1 };
}

/** Number of days in a given calendar month, accounting for leap years. */
function daysInCalendarMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  // Apr, Jun, Sep, Nov have 30 days; all others have 31.
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

/** Gregorian leap-year rule. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// ---------------------------------------------------------------------------
// Business-day counting (task 4.1)
// ---------------------------------------------------------------------------

/**
 * True when both endpoints are usable CalendarDate values (not null/undefined).
 *
 * Invalid-input indication for `countBusinessDays` (Requirement 8.4):
 * `countBusinessDays` must keep its `: number` contract and never throw, so a
 * null/undefined `start` or `end` simply yields a count of 0. This exported,
 * side-effect-free predicate is the paired "invalid input was supplied" signal
 * that downstream callers (elapsed/remaining in task 5) can check to tell a
 * genuine 0 apart from a 0 caused by missing inputs. It reads its arguments
 * only and mutates nothing.
 */
export function hasValidDateInputs(
  start: CalendarDate | null | undefined,
  end: CalendarDate | null | undefined
): boolean {
  return start != null && end != null;
}

/**
 * Count business days (Mon-Fri) in [start, end] inclusive of both endpoints.
 *
 * - Returns 0 when `end < start` (Requirement 8.5).
 * - Same-day range returns 1 on a weekday and 0 on a weekend (Requirement 8.6).
 * - If `start` or `end` is null/undefined, returns 0 without mutating either
 *   input (Requirement 8.4). Callers detect this case via `hasValidDateInputs`.
 *   The function never throws for null inputs.
 *
 * The count is always >= 0 and <= the calendar days in the inclusive range
 * (Requirement 8.3), because each calendar day contributes at most 1.
 */
export function countBusinessDays(
  start: CalendarDate | null | undefined,
  end: CalendarDate | null | undefined
): number {
  // Requirement 8.4: null/undefined input yields 0 with no mutation or throw.
  if (!hasValidDateInputs(start, end)) {
    return 0;
  }

  // After the guard above, both endpoints are non-null CalendarDate values.
  const from = start as CalendarDate;
  const to = end as CalendarDate;

  // Requirement 8.5: reversed range contributes no business days.
  if (compareDates(to, from) < 0) {
    return 0;
  }

  let count = 0;
  let cursor: CalendarDate = from;

  // INVARIANT: at the top of each iteration, `count` equals the number of
  // business days in [start, cursor - 1 day].
  while (compareDates(cursor, to) <= 0) {
    if (!isWeekend(cursor)) {
      count += 1;
    }
    cursor = nextCalendarDay(cursor);
  }

  return count;
}

// ---------------------------------------------------------------------------
// Elapsed, remaining, and timeline progress (task 5.1)
// ---------------------------------------------------------------------------

import type { Sprint } from "../models/sprint";

/** Clamp `value` into the inclusive range [min, max]. Module-private helper. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Total business days in the sprint, inclusive of both start and end.
 *
 * Delegates to `countBusinessDays` after parsing the sprint's ISO dates, so a
 * reversed or degenerate range naturally yields 0 (Requirement 9.7).
 */
export function totalBusinessDays(sprint: Sprint): number {
  return countBusinessDays(
    parseIsoDate(sprint.startDate),
    parseIsoDate(sprint.endDate)
  );
}

/**
 * Business days already elapsed as of `today`, clamped to [0, total].
 *
 * - Before the sprint starts (`today < startDate`) ⇒ 0 (Requirement 9.5).
 * - On or after the last day (`today >= endDate`) ⇒ total (Requirement 9.6),
 *   which correctly treats the inclusive last day as fully elapsed.
 * - Otherwise `today` is strictly inside the window: count business days from
 *   `startDate` through `today` inclusive, then clamp to [0, total]
 *   (Requirement 9.1).
 * - When `total === 0` every path yields 0 with no error (Requirement 9.7).
 */
export function elapsedBusinessDays(sprint: Sprint, today: CalendarDate): number {
  const total = totalBusinessDays(sprint);
  const start = parseIsoDate(sprint.startDate);
  const end = parseIsoDate(sprint.endDate);

  // Requirement 9.5: sprint has not started yet.
  if (compareDates(today, start) < 0) {
    return 0;
  }

  // Requirement 9.6: on or past the inclusive last day, all of it has elapsed.
  if (compareDates(today, end) >= 0) {
    return total;
  }

  // Requirement 9.1: strictly inside the window — count start..today inclusive.
  const elapsed = countBusinessDays(start, today);
  return clamp(elapsed, 0, total);
}

/**
 * Business days remaining as of `today`, clamped to [0, total].
 *
 * Defined as `total - elapsed`, so `elapsed + remaining === total` always holds
 * (Requirements 9.2, 9.3). Before start ⇒ remaining === total (Requirement 9.5);
 * on or after end ⇒ remaining === 0 (Requirement 9.6). When `total === 0` this
 * yields 0 with no error (Requirement 9.7).
 */
export function remainingBusinessDays(sprint: Sprint, today: CalendarDate): number {
  const total = totalBusinessDays(sprint);
  const elapsed = elapsedBusinessDays(sprint, today);
  return clamp(total - elapsed, 0, total);
}

/**
 * Fraction of the sprint timeline elapsed as of `today`, in [0, 1].
 *
 * Defined as `elapsed / total`. Guards `total === 0` by returning 0 so there is
 * no division by zero and no NaN (Requirements 9.7, 10.3). The result is clamped
 * to [0, 1] because `elapsed` is itself clamped to [0, total]
 * (Requirements 10.1, 10.2).
 */
export function timelineProgress(sprint: Sprint, today: CalendarDate): number {
  const total = totalBusinessDays(sprint);
  if (total === 0) {
    return 0;
  }
  const elapsed = elapsedBusinessDays(sprint, today);
  return clamp(elapsed / total, 0, 1);
}
