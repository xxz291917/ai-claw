import type { ChatEvent } from "../../chat/types.js";

export type OutputAction =
  | { type: "notify"; channel: string; card: Record<string, any> }
  | { type: "create_pr"; repo: string; branch: string; title: string; body: string }
  | { type: "update_task"; target: string; taskId: string; status: string; result?: string }
  | { type: "stream_chat"; sessionId: string; events: AsyncIterable<ChatEvent> };

export interface OutputAdapter {
  readonly target: string;
  supports(action: OutputAction): boolean;
  send(action: OutputAction): Promise<void>;
}

export class OutputBus {
  constructor(private adapters: OutputAdapter[]) {}

  async send(action: OutputAction): Promise<void> {
    for (const adapter of this.adapters) {
      if (adapter.supports(action)) {
        await adapter.send(action);
        return;
      }
    }
    console.warn(`[output-bus] No adapter for action: ${action.type}`);
  }
}
