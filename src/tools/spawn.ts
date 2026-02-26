import { z } from "zod";
import type { UnifiedToolDef, ToolContext } from "./types.js";
import type { SubagentManager } from "../subagent/manager.js";

export function createSpawnTool(
  subagentManager: SubagentManager,
  defaultProvider: string,
): UnifiedToolDef {
  return {
    name: "spawn",
    description:
      "在后台启动一个子任务，不阻塞当前对话。适合耗时的研究、分析任务。完成后结果会自动写入当前会话。",
    inputSchema: {
      task: z.string().describe("子任务的详细描述，要足够具体以便独立执行"),
      provider: z
        .string()
        .optional()
        .describe("使用的 provider 名称，默认与当前对话相同"),
    },
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "子任务的详细描述，要足够具体以便独立执行",
        },
        provider: {
          type: "string",
          description: "使用的 provider 名称，默认与当前对话相同",
        },
      },
      required: ["task"],
    },
    execute: async (
      args: { task: string; provider?: string },
      ctx: ToolContext,
    ) => {
      const taskId = subagentManager.spawn({
        task: args.task,
        parentSessionId: ctx.sessionId,
        userId: ctx.userId,
        providerName: args.provider ?? defaultProvider,
      });
      return `后台任务已启动 (id=${taskId})，完成后会自动通知你。`;
    },
  };
}
