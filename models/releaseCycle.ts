export type CycleState = "completed" | "current" | "upcoming";

export interface ReleaseCycle {
  label: string;        // e.g. "2B"
  state: CycleState;    // completed | current | upcoming
}
