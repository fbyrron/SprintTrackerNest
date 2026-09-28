export type SprintState = "active" | "future" | "closed";

export interface Sprint {
  name: string;         // e.g. "HRT Apr27 2B"
  startDate: string;    // ISO date "YYYY-MM-DD", interpreted in America/Chicago
  endDate: string;      // ISO date "YYYY-MM-DD", inclusive last day
  state: SprintState;
}
