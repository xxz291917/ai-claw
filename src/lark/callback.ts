import type { Hono } from "hono";
import type { TaskStore } from "../tasks/store.js";

export type CallbackAction = "fix" | "merge" | "ignore" | "reject" | "view";

type OnAction = (
  taskId: string,
  action: CallbackAction,
) => void | Promise<void>;

export function larkCallback(
  app: Hono,
  store: TaskStore,
  onAction: OnAction,
): void {
  app.post("/callbacks/lark", async (c) => {
    const body = await c.req.json();

    // Lark card callback verification challenge
    if (body.challenge) {
      return c.json({ challenge: body.challenge });
    }

    // Extract action from card callback
    const action = body.action?.value as
      | { action?: CallbackAction; taskId?: string }
      | undefined;
    if (!action?.action || !action?.taskId) {
      return c.json({ msg: "ok" });
    }

    const task = store.getById(action.taskId);
    if (!task) {
      return c.json({ msg: "task not found" });
    }

    await onAction(action.taskId, action.action);

    return c.json({ msg: "ok" });
  });
}
