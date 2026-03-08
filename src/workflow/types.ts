/** Workflow argument definition from frontmatter */
export type WorkflowArgDef = {
  required?: boolean;
  default?: string;
  description?: string;
};

/** A single step in a workflow definition */
export type WorkflowStep =
  | { id: string; command: string; expect?: string; timeout?: number; output?: string }
  | { id: string; type: "llm"; prompt: string }
  | { id: string; approval: { prompt: string; goto?: string; max_revisions?: number } };

/** Parsed workflow definition from skill frontmatter */
export type WorkflowDefinition = {
  name: string;
  args: Record<string, WorkflowArgDef>;
  steps: WorkflowStep[];
  onFailure?: string;
};

/** Result of a completed step */
export type StepResult = {
  id: string;
  ok: boolean;
  stdout?: string;
  result?: string;
  error?: string;
  file?: string;
  revision?: number;
};

/** Persisted execution state */
export type WorkflowExecution = {
  id: string;
  workflowName: string;
  userId: string;
  sessionId: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  args: Record<string, string>;
  currentStep: string | null;
  stepResults: StepResult[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Return value from engine.run() and engine.resume() */
export type WorkflowResult =
  | { status: "completed"; steps: StepResult[] }
  | { status: "needs_approval"; prompt: string; token: string; completed_steps: StepResult[]; revision?: number; max_revisions?: number }
  | { status: "failed"; failed_step: string; error: string; completed_steps: StepResult[] };

/** Helper to classify step type */
export function stepType(step: WorkflowStep): "command" | "llm" | "approval" {
  if ("approval" in step) return "approval";
  if ("type" in step && step.type === "llm") return "llm";
  return "command";
}
