/**
 * Tool that lets the LLM delete outdated or duplicate memories.
 */

import { z } from "zod";
import type { MemoryManager } from "../memory/manager.js";
import type { UnifiedToolDef, ToolContext } from "./types.js";

export function createMemoryDeleteTool(
  memoryManager: MemoryManager,
): UnifiedToolDef {
  return {
    name: "memory_delete",
    description:
      "Delete a memory by its ID. Use this to remove outdated or duplicate memories. " +
      "Only memories belonging to the current user can be deleted. " +
      "You can find memory IDs from memory_list results, memory_save dedup hints, or from the memory context injected at conversation start.",
    inputSchema: {
      id: z.number().describe("The numeric ID of the memory to delete"),
      reason: z.string().optional().describe(
        "Brief reason for deletion (e.g. 'duplicate of id=5', 'outdated')",
      ),
    },
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The numeric ID of the memory to delete",
        },
        reason: {
          type: "string",
          description:
            "Brief reason for deletion (e.g. 'duplicate of id=5', 'outdated')",
        },
      },
      required: ["id"],
    },
    execute: async (
      args: { id: number; reason?: string },
      ctx: ToolContext,
    ) => {
      if (!args.id || typeof args.id !== "number") {
        return "Error: id (number) is required";
      }

      const deleted = memoryManager.removeByUser(args.id, ctx.userId);
      if (!deleted) {
        return `Error: memory id=${args.id} not found or does not belong to this user`;
      }

      const reasonText = args.reason ? ` (${args.reason})` : "";
      return `Deleted memory id=${args.id}${reasonText}`;
    },
  };
}
