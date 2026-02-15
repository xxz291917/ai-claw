// src/adapters/output/lark.ts
import type { OutputAdapter, OutputAction } from "./types.js";

type LarkOutputDeps = {
  sendCard: (card: Record<string, any>) => Promise<string | null>;
};

export class LarkOutputAdapter implements OutputAdapter {
  readonly target = "lark";

  constructor(private deps: LarkOutputDeps) {}

  supports(action: OutputAction): boolean {
    return action.type === "notify" && (action as any).channel === "lark";
  }

  async send(action: OutputAction): Promise<void> {
    if (action.type === "notify") {
      await this.deps.sendCard(action.card);
    }
  }
}
