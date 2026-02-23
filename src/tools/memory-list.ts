/**
 * Per-request tool that lists ALL memories for the current user.
 *
 * Used by the memory-organizer skill to give the LLM a full picture
 * before cleanup operations. Also useful for general memory inspection.
 */

import type { MemoryManager } from "../memory/manager.js";
import type { RequestTool } from "../chat/types.js";

const MAX_ITEMS = 200;

export function createMemoryListTool(
  memoryManager: MemoryManager,
  userId: string,
): RequestTool {
  return {
    name: "memory_list",
    description:
      "List all memories stored for the current user. " +
      "Returns memories grouped by category with IDs, keys, values, and timestamps. " +
      "Use this to review the user's memory before organizing or cleaning up.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["preference", "decision", "fact", "todo"],
          description:
            "Optional: filter by category. If omitted, returns all categories.",
        },
      },
      required: [],
    },
    handler: async (args: { category?: string }) => {
      let items = memoryManager.getByUser(userId);
      const totalCount = items.length;

      if (totalCount === 0) {
        return "No memories found for this user.";
      }

      // Optional category filter
      if (args.category) {
        items = items.filter((m) => m.category === args.category);
        if (items.length === 0) {
          return `No memories found in category "${args.category}". Total memories: ${totalCount}.`;
        }
      }

      const truncated = items.length > MAX_ITEMS;
      const display = items.slice(0, MAX_ITEMS);

      // Group by category for readability
      const grouped = new Map<string, typeof display>();
      for (const m of display) {
        const list = grouped.get(m.category) ?? [];
        list.push(m);
        grouped.set(m.category, list);
      }

      const sections: string[] = [];
      for (const [category, memories] of grouped) {
        const lines = memories.map(
          (m) =>
            `  - id=${m.id} | ${m.key}: ${m.value} | updated=${m.updatedAt}`,
        );
        sections.push(`[${category}] (${memories.length})\n${lines.join("\n")}`);
      }

      let result = `Total memories: ${totalCount}`;
      if (truncated) {
        result += ` (showing first ${MAX_ITEMS})`;
      }
      result += "\n\n" + sections.join("\n\n");

      return result;
    },
  };
}
