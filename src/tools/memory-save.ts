/**
 * Per-request tool that lets the LLM proactively save information
 * about the user to long-term memory.
 *
 * Created per-request (not at startup) because it needs userId + sessionId
 * baked into the closure.
 *
 * Dedup: before saving, FTS5-searches for similar existing memories and
 * returns hints so the LLM can use memory_delete to clean up duplicates.
 */

import type { MemoryManager } from "../memory/manager.js";
import type { MemoryCategory } from "../memory/types.js";
import type { RequestTool } from "../chat/types.js";

const VALID_CATEGORIES: readonly MemoryCategory[] = [
  "preference",
  "decision",
  "fact",
  "todo",
];

export function createMemorySaveTool(
  memoryManager: MemoryManager,
  userId: string,
  sessionId: string,
): RequestTool {
  return {
    name: "memory_save",
    description:
      "Save information about the user to long-term memory. " +
      "Use this proactively when the user shares preferences, decisions, important facts, or TODO items. " +
      "Saved memories will be recalled in future conversations. " +
      "The tool will report similar existing memories — use memory_delete to remove duplicates.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...VALID_CATEGORIES],
          description:
            "Category: preference (likes/dislikes), decision (choices made), fact (personal info), todo (action items)",
        },
        key: {
          type: "string",
          description:
            "Short label for this memory (e.g. 'name', 'preferred_language', 'deploy_method')",
        },
        value: {
          type: "string",
          description: "The actual information to remember",
        },
      },
      required: ["category", "key", "value"],
    },
    handler: async (args: {
      category: string;
      key: string;
      value: string;
    }) => {
      if (!VALID_CATEGORIES.includes(args.category as MemoryCategory)) {
        return `Error: invalid category "${args.category}". Must be one of: ${VALID_CATEGORIES.join(", ")}`;
      }
      if (!args.key || !args.value) {
        return "Error: key and value are required";
      }

      // Search for similar existing memories before saving (dedup)
      let candidates: Array<{ id: number; category: string; key: string; value: string }> = [];
      try {
        const similar = memoryManager.search(userId, `${args.key} ${args.value}`, 5);
        // Filter out exact (category, key) match — upsert handles that
        candidates = similar
          .filter((m) => !(m.category === args.category && m.key === args.key))
          .slice(0, 3);
      } catch {
        // Best-effort — don't block save on search failure
      }

      // Save (upsert on exact category+key match)
      memoryManager.save(
        userId,
        [
          {
            category: args.category as MemoryCategory,
            key: args.key,
            value: args.value,
          },
        ],
        sessionId,
      );

      let result = `Saved to memory: [${args.category}] ${args.key} = ${args.value}`;

      if (candidates.length > 0) {
        const hints = candidates
          .map((m) => `  - id=${m.id} [${m.category}] ${m.key}: ${m.value}`)
          .join("\n");
        result +=
          `\n\nNote: found similar existing memories that may be duplicates:\n${hints}` +
          `\nIf any are duplicates of the memory just saved, use memory_delete to remove them.`;
      }

      return result;
    },
  };
}
