import { Sprint } from "../models/sprint";
import { ReleaseCycle } from "../models/releaseCycle";
import { Milestone } from "../models/milestone";

export type HealthBand = "ahead" | "onTrack" | "behind" | "atRisk";

export interface TimelineView {
  totalBusinessDays: number;
  elapsedBusinessDays: number;
  remainingBusinessDays: number;
  timelineProgress: number;   // in [0, 1]
}

export interface TicketView {
  done: number;
  inProgress: number;
  blocked: number;
  total: number;
  ticketProgress: number;     // in [0, 1]; 0 when total === 0
}

export interface HealthView {
  band: HealthBand;
  delta: number;              // ticketProgress - timelineProgress, in [-1, 1]
  color: "green" | "yellow" | "red";
  label: string;              // "On Track", "Behind Schedule", ...
}

export interface SprintViewModel {
  currentSprint: Sprint | null;
  timeline: TimelineView | null;   // null when no active sprint
  tickets: TicketView;
  health: HealthView | null;       // null when no active sprint
  nextSprint: Sprint | null;
  roadmap: ReleaseCycle[];
  milestones: Milestone[];         // upcoming only, sorted ascending by date
  statusBarText: string;           // e.g. "🏃 HRT Apr27 2B | 8d left | ✅"
}
