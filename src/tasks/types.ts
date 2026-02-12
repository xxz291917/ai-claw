/**
 * Fault-healing task states:
 *
 *   pending → analyzing → reported → fixing → pr_ready → merged → done
 *                ↓            ↓         ↓         ↓
 *              failed      ignored    failed    rejected
 */
export type TaskState =
  | "pending"
  | "analyzing"
  | "reported"
  | "fixing"
  | "pr_ready"
  | "merged"
  | "done"
  | "failed"
  | "ignored"
  | "rejected";

export type TaskEvent =
  | "analyze" // pending → analyzing
  | "report" // analyzing → reported
  | "fix" // reported → fixing
  | "pr_created" // fixing → pr_ready
  | "merge" // pr_ready → merged
  | "deploy_ok" // merged → done
  | "fail" // any active → failed
  | "ignore" // reported → ignored
  | "reject"; // pr_ready → rejected

export const transitions: Record<
  TaskEvent,
  { from: TaskState[]; to: TaskState }
> = {
  analyze: { from: ["pending"], to: "analyzing" },
  report: { from: ["analyzing"], to: "reported" },
  fix: { from: ["reported"], to: "fixing" },
  pr_created: { from: ["fixing"], to: "pr_ready" },
  merge: { from: ["pr_ready"], to: "merged" },
  deploy_ok: { from: ["merged"], to: "done" },
  fail: { from: ["pending", "analyzing", "fixing"], to: "failed" },
  ignore: { from: ["reported"], to: "ignored" },
  reject: { from: ["pr_ready"], to: "rejected" },
};

export type Task = {
  id: string;
  type: string;
  state: TaskState;
  sentryIssueId: string | null;
  sentryEventId: string | null;
  title: string;
  severity: string | null;
  analysis: string | null;
  prUrl: string | null;
  larkMessageId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
