import { z } from "zod";
import type { UnifiedToolDef } from "../tools/types.js";
import type { WorkflowEngine } from "./engine.js";
import { parseWorkflowFromSkill } from "./parser.js";
import { scanSkillDirs } from "../skills/loader.js";
import { readFileSync } from "node:fs";

/**
 * Create run_workflow and resume_workflow tools.
 * Injected into buildToolSuite via extraTools.
 */
export function createWorkflowTools(
  engine: WorkflowEngine,
  skillsDirs: string[],
): UnifiedToolDef[] {
  // Scan for workflow-enabled skills to build description
  const allSkills = scanSkillDirs(skillsDirs);
  const workflowSkills = allSkills
    .filter((s) => {
      try {
        const content = readFileSync(s.filePath, "utf-8");
        return parseWorkflowFromSkill(content) !== null;
      } catch {
        return false;
      }
    })
    .map((s) => s.name);

  const workflowList =
    workflowSkills.length > 0
      ? `Available workflows: ${workflowSkills.join(", ")}`
      : "No workflow-enabled skills found";

  const runWorkflow: UnifiedToolDef = {
    name: "run_workflow",
    description:
      `Execute a deterministic workflow defined in a skill file. ` +
      `Command steps run as shell subprocesses without LLM. ` +
      `Approval steps pause and return a token for user confirmation. ` +
      workflowList,
    inputSchema: {
      workflow: z.string().describe("Skill name (e.g. 'hs-release')"),
      args: z.string().optional().describe("JSON string of workflow arguments"),
    },
    parameters: {
      type: "object",
      properties: {
        workflow: {
          type: "string",
          description: "Skill name (e.g. 'hs-release')",
        },
        args: {
          type: "string",
          description: "JSON string of workflow arguments",
        },
      },
      required: ["workflow"],
    },
    execute: async (input: { workflow: string; args?: string }, ctx) => {
      try {
        // Re-scan to pick up new skills at invocation time
        const skills = scanSkillDirs(skillsDirs);
        const skill = skills.find((s) => s.name === input.workflow);
        if (!skill) return `Error: Workflow "${input.workflow}" not found`;

        const content = readFileSync(skill.filePath, "utf-8");
        const definition = parseWorkflowFromSkill(content);
        if (!definition)
          return `Error: Skill "${input.workflow}" has no workflow definition`;

        const args = input.args ? JSON.parse(input.args) : {};
        const result = await engine.run(definition, args, ctx);
        return JSON.stringify(result, null, 2);
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };

  const resumeWorkflow: UnifiedToolDef = {
    name: "resume_workflow",
    description:
      "Resume a paused workflow after user approval. " +
      "Pass the token from a previous run_workflow result and the user's decision.",
    inputSchema: {
      token: z.string().describe("Resume token from needs_approval result"),
      approve: z.boolean().describe("true to continue, false to cancel"),
    },
    parameters: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Resume token from needs_approval result",
        },
        approve: {
          type: "boolean",
          description: "true to continue, false to cancel",
        },
      },
      required: ["token", "approve"],
    },
    execute: async (input: { token: string; approve: boolean }, ctx) => {
      try {
        const result = await engine.resume(
          input.token,
          input.approve,
          ctx.userId,
        );
        return JSON.stringify(result, null, 2);
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };

  const listWorkflows: UnifiedToolDef = {
    name: "list_workflows",
    description:
      "List active and paused workflows for the current user. " +
      "Use this to discover pending approval workflows that can be resumed.",
    inputSchema: {},
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_input: Record<string, never>, ctx) => {
      try {
        const workflows = engine.listByUser(ctx.userId);
        if (workflows.length === 0) return "No active workflows.";
        return JSON.stringify(workflows, null, 2);
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };

  return [runWorkflow, resumeWorkflow, listWorkflows];
}
