import type { Route } from "../core/rule-router.js";

/**
 * Route definitions for the Fault Healing Pipeline.
 *
 * Two entry points, one agent ("fault-healing"), differentiated by skill:
 * - sentry.issue_alert → skill "analysis" (run AI analysis)
 * - lark.card_action   → skill "action"   (handle human approval/rejection)
 */
export const faultHealingRoutes: Route[] = [
  {
    match: (e) => e.type === "sentry.issue_alert",
    plan: (e) => ({
      agent: "fault-healing",
      skill: "analysis",
      inputs: {
        taskId: e.payload.taskId as string,
        issueId: e.payload.issueId as string,
      },
      outputs: [], // Lark notifications handled internally by workflow for now
    }),
  },
  {
    match: (e) => e.type === "lark.card_action" && !!e.payload.taskId,
    plan: (e) => ({
      agent: "fault-healing",
      skill: "action",
      inputs: {
        taskId: e.payload.taskId as string,
        action: e.payload.action as string,
      },
      outputs: [],
    }),
  },
];
