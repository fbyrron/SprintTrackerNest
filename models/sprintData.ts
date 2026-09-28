import { Sprint } from "./sprint";
import { TicketSummary } from "./ticketSummary";
import { Milestone } from "./milestone";
import { ReleaseCycle } from "./releaseCycle";

export interface SprintData {
  sprints: Sprint[];
  ticketSummary: TicketSummary;
  milestones: Milestone[];
  releaseRoadmap: ReleaseCycle[];
}
