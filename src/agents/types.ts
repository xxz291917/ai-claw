export type AgentEvent =
  | { type: "thinking"; content: string }
  | { type: "tool_call"; tool: string; input: Record<string, any> }
  | { type: "tool_result"; tool: string; output: string }
  | { type: "result"; content: string; artifacts?: Artifact[] }
  | { type: "error"; message: string };

export type Artifact = {
  kind: "pr" | "document" | "analysis" | "patch";
  data: Record<string, any>;
};

export type TaskExecution = {
  taskId: string;
  skill?: string;
  inputs: Record<string, any>;
  provider: string;
  tools?: string[];
};

export interface SubAgent {
  readonly name: string;
  readonly description: string;
  execute(task: TaskExecution): AsyncIterable<AgentEvent>;
}
