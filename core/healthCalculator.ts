// core/healthCalculator.ts
//
// Health delta and band resolution for SprintPulse.
//
// This module is part of the pure core: it MUST NOT import `vscode`.
// It takes two progress fractions in [0, 1] and reports whether ticket work is
// keeping pace with the sprint timeline, as a delta, a band, a color, and a
// human-readable label.

import type { HealthBand, HealthView } from "./types";

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

/** Round `value` to 2 decimal places. Module-private helper. */
function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Health delta: how far ticket progress leads (+) or trails (-) the timeline.
 *
 * Defined as `ticketProgress - timelineProgress`, rounded to 2 decimal places
 * (Requirement 4.1). Both inputs are fractions in [0, 1], so the raw difference
 * is in [-1, 1]; the result is clamped to [-1, 1] so rounding can never push it
 * outside that range (Requirements 12.1, 13). A positive delta means work is
 * ahead of the calendar; a negative delta means it is behind.
 */
export function healthDelta(ticketProgress: number, timelineProgress: number): number {
  const delta = roundTo2(ticketProgress - timelineProgress);
  return clamp(delta, -1, 1);
}

/**
 * Resolve the health band from a delta using the fixed threshold ladder.
 *
 * The four bands are disjoint, exhaustive, and ordered by severity, so every
 * real number maps to exactly one band — a total function (Requirement 4.6,
 * Property 12). The ladder is checked most-severe-first so a value exactly on a
 * negative threshold takes the more severe band: `-0.25` → `atRisk`,
 * `-0.10` → `behind`, `+0.10` → `ahead`, `0` → `onTrack`
 * (Requirements 4.2, 4.3, 4.4, 4.5).
 */
export function resolveHealthBand(delta: number): HealthBand {
  if (delta <= -0.25) {
    return "atRisk";
  }
  if (delta <= -0.1) {
    return "behind";
  }
  if (delta < 0.1) {
    return "onTrack";
  }
  return "ahead"; // delta >= 0.10
}

/** Fixed color for each band. Module-private helper. */
function colorForBand(band: HealthBand): HealthView["color"] {
  switch (band) {
    case "atRisk":
      return "red";
    case "behind":
      return "yellow";
    case "onTrack":
    case "ahead":
      return "green";
  }
}

/** Fixed human-readable label for each band. Module-private helper. */
function labelForBand(band: HealthBand): string {
  switch (band) {
    case "atRisk":
      return "At Risk";
    case "behind":
      return "Behind Schedule";
    case "onTrack":
      return "On Track";
    case "ahead":
      return "Ahead of Schedule";
  }
}

/**
 * Full health view: band, delta, color, and human label.
 *
 * Computes the delta once (Requirement 4.1), resolves the band from it
 * (Requirements 4.2-4.6), then attaches the band's fixed color and label. The
 * returned `delta` is the same value used to pick the band, so the view is
 * internally consistent.
 */
export function resolveHealth(ticketProgress: number, timelineProgress: number): HealthView {
  const delta = healthDelta(ticketProgress, timelineProgress);
  const band = resolveHealthBand(delta);
  return {
    band,
    delta,
    color: colorForBand(band),
    label: labelForBand(band),
  };
}
