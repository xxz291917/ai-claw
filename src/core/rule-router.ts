import type { HubEvent } from "./hub-event.js";
import type { OutputAction } from "../adapters/output/types.js";

export type TaskPlan = {
  agent: string;
  skill?: string;
  inputs: Record<string, any>;
  outputs: OutputAction[];
  provider?: string;
};

export type Route = {
  match: (event: HubEvent) => boolean;
  plan: (event: HubEvent) => TaskPlan;
};

export class RuleRouter {
  constructor(private routes: Route[]) {}

  match(event: HubEvent): TaskPlan | null {
    for (const route of this.routes) {
      if (route.match(event)) {
        return route.plan(event);
      }
    }
    return null;
  }
}
