import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import type Database from "better-sqlite3";
import type {
  WorkflowDefinition,
  WorkflowResult,
  StepResult,
  WorkflowStep,
} from "./types.js";
import { stepType } from "./types.js";

export type LlmHandler = (prompt: string) => Promise<string>;

export interface WorkflowEngineOptions {
  db: Database.Database;
  defaultTimeoutMs?: number;
  maxOutputChars?: number;
  llmHandler?: LlmHandler;
}

interface ExecutionContext {
  userId: string;
  sessionId: string;
}

export class WorkflowEngine {
  private db: Database.Database;
  private defaultTimeoutMs: number;
  private maxOutputChars: number;
  private llmHandler?: LlmHandler;

  constructor(opts: WorkflowEngineOptions) {
    this.db = opts.db;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.maxOutputChars = opts.maxOutputChars ?? 50_000;
    this.llmHandler = opts.llmHandler;
  }

  setLlmHandler(handler: LlmHandler): void {
    this.llmHandler = handler;
  }

  async run(
    definition: WorkflowDefinition,
    args: Record<string, string>,
    ctx: ExecutionContext,
  ): Promise<WorkflowResult> {
    // Validate required args and apply defaults
    const resolvedArgs: Record<string, string> = { ...args };
    for (const [name, def] of Object.entries(definition.args)) {
      if (resolvedArgs[name] === undefined) {
        if (def.default !== undefined) {
          resolvedArgs[name] = def.default;
        } else if (def.required) {
          return {
            status: "failed",
            failed_step: "",
            error: `Missing required argument: ${name}`,
            completed_steps: [],
          };
        }
      }
    }

    // Check for existing running workflow (paused is OK — user can have multiple paused)
    const running = this.db
      .prepare(
        "SELECT id FROM workflow_executions WHERE user_id = ? AND status = 'running' LIMIT 1",
      )
      .get(ctx.userId) as { id: string } | undefined;
    if (running) {
      return {
        status: "failed",
        failed_step: "",
        error: `Another workflow is already running (${running.id}). Wait for it to complete or cancel it first.`,
        completed_steps: [],
      };
    }

    const execId = "wf_" + randomBytes(8).toString("hex");
    this.dbInsert(execId, definition.name, ctx.userId, ctx.sessionId, resolvedArgs);
    this.dbStoreDefinition(execId, definition);

    return this.executeSteps(execId, definition, resolvedArgs, 0, [], ctx);
  }

  /** List active (running/paused) workflows for a user. */
  listByUser(userId: string): Array<{
    id: string;
    workflowName: string;
    status: string;
    currentStep: string | null;
    sessionId: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, workflow_name, status, current_step, session_id, created_at
         FROM workflow_executions
         WHERE user_id = ? AND status IN ('running', 'paused')
         ORDER BY created_at DESC`,
      )
      .all(userId) as any[];
    return rows.map((r) => ({
      id: r.id,
      workflowName: r.workflow_name,
      status: r.status,
      currentStep: r.current_step,
      sessionId: r.session_id,
      createdAt: r.created_at,
    }));
  }

  async resume(
    token: string,
    approve: boolean,
    userId: string,
  ): Promise<WorkflowResult> {
    const row = this.dbGet(token);
    if (!row) throw new Error(`Workflow execution not found: ${token}`);
    if (row.user_id !== userId) throw new Error("Unauthorized: userId mismatch");
    if (row.status !== "paused") throw new Error(`Workflow is not paused (status: ${row.status})`);

    const definition = this.dbGetDefinition(token);
    if (!definition) throw new Error("Workflow definition not found");

    const args: Record<string, string> = JSON.parse(row.args);
    const previousResults: StepResult[] = JSON.parse(row.step_results);
    const currentStepId = row.current_step;

    // Find the approval step index
    const approvalIdx = definition.steps.findIndex((s) => s.id === currentStepId);
    if (approvalIdx === -1) throw new Error(`Step not found: ${currentStepId}`);

    if (!approve) {
      // User rejected — fail the workflow
      const result: WorkflowResult = {
        status: "failed",
        failed_step: currentStepId!,
        error: "Approval denied by user",
        completed_steps: previousResults,
      };
      this.dbUpdate(token, "cancelled", currentStepId, previousResults, "Approval denied by user");
      return result;
    }

    // Add the approval step as completed
    const approvalResult: StepResult = {
      id: currentStepId!,
      ok: true,
      result: "approved",
    };
    const allResults = [...previousResults, approvalResult];

    // Continue from the step after the approval
    const ctx: ExecutionContext = { userId: row.user_id, sessionId: row.session_id };
    return this.executeSteps(token, definition, args, approvalIdx + 1, allResults, ctx);
  }

  private async executeSteps(
    execId: string,
    definition: WorkflowDefinition,
    args: Record<string, string>,
    startIdx: number,
    previousResults: StepResult[],
    ctx: ExecutionContext,
  ): Promise<WorkflowResult> {
    const results: StepResult[] = [...previousResults];

    for (let i = startIdx; i < definition.steps.length; i++) {
      const step = definition.steps[i];
      const type = stepType(step);

      this.dbUpdate(execId, "running", step.id, results, null);

      if (type === "approval") {
        const approvalStep = step as Extract<WorkflowStep, { approval: unknown }>;
        const prompt = this.substituteVars(approvalStep.approval.prompt, args, results);

        this.dbUpdate(execId, "paused", step.id, results, null);

        return {
          status: "needs_approval",
          prompt,
          token: execId,
          completed_steps: results,
        };
      }

      if (type === "llm") {
        const llmStep = step as Extract<WorkflowStep, { type: "llm" }>;
        if (!this.llmHandler) {
          const errorMsg = "No LLM handler configured";
          results.push({ id: step.id, ok: false, error: errorMsg });
          this.dbUpdate(execId, "failed", step.id, results, errorMsg);
          return {
            status: "failed",
            failed_step: step.id,
            error: errorMsg,
            completed_steps: results,
          };
        }
        const prompt = this.substituteVars(llmStep.prompt, args, results);
        try {
          const llmResult = await this.llmHandler(prompt);
          results.push({ id: step.id, ok: true, result: llmResult });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          results.push({ id: step.id, ok: false, error: errorMsg });
          this.dbUpdate(execId, "failed", step.id, results, errorMsg);
          return {
            status: "failed",
            failed_step: step.id,
            error: errorMsg,
            completed_steps: results,
          };
        }
        continue;
      }

      // Command step
      const cmdStep = step as Extract<WorkflowStep, { command: string }>;
      const command = this.substituteVars(cmdStep.command, args, results);
      const timeout = cmdStep.timeout ?? this.defaultTimeoutMs;

      try {
        const { stdout, stderr, exitCode } = await this.execCommand(command, timeout);
        const trimmedStdout = stdout.trim();

        if (exitCode !== 0) {
          const errorMsg = stderr.trim() || `Exit code: ${exitCode}`;
          results.push({ id: step.id, ok: false, stdout: trimmedStdout, error: errorMsg });
          this.dbUpdate(execId, "failed", step.id, results, errorMsg);
          return {
            status: "failed",
            failed_step: step.id,
            error: errorMsg,
            completed_steps: results,
          };
        }

        // Check expect
        if (cmdStep.expect !== undefined) {
          const expected = this.substituteVars(cmdStep.expect, args, results);
          if (!trimmedStdout.includes(expected.trim())) {
            const errorMsg = `Expected output to contain "${expected.trim()}" but got "${trimmedStdout}"`;
            results.push({ id: step.id, ok: false, stdout: trimmedStdout, error: errorMsg });
            this.dbUpdate(execId, "failed", step.id, results, errorMsg);
            return {
              status: "failed",
              failed_step: step.id,
              error: errorMsg,
              completed_steps: results,
            };
          }
        }

        results.push({ id: step.id, ok: true, stdout: trimmedStdout });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        results.push({ id: step.id, ok: false, error: errorMsg });
        this.dbUpdate(execId, "failed", step.id, results, errorMsg);
        return {
          status: "failed",
          failed_step: step.id,
          error: errorMsg,
          completed_steps: results,
        };
      }
    }

    this.dbUpdate(execId, "completed", null, results, null);
    return { status: "completed", steps: results };
  }

  private substituteVars(
    template: string,
    args: Record<string, string>,
    results: StepResult[],
  ): string {
    return template.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      // Check for step.stdout or step.result pattern
      const dotIdx = expr.indexOf(".");
      if (dotIdx !== -1) {
        const stepId = expr.slice(0, dotIdx);
        const field = expr.slice(dotIdx + 1);
        const stepResult = results.find((r) => r.id === stepId);
        if (stepResult) {
          if (field === "stdout") return stepResult.stdout ?? "";
          if (field === "result") return stepResult.result ?? "";
          if (field === "error") return stepResult.error ?? "";
        }
        return "";
      }
      // Check args
      if (expr in args) return args[expr];
      return "";
    });
  }

  private execCommand(
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = execFile(
        "/bin/sh",
        ["-c", command],
        {
          env: { ...process.env, TERM: "dumb", CUPS_SERVER: "" },
          timeout: timeoutMs,
          maxBuffer: this.maxOutputChars * 2,
        },
        (error, stdout, stderr) => {
          const exitCode = error ? (error as NodeJS.ErrnoException & { code?: number | string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? 1
            : (child.exitCode ?? 1)
            : 0;
          resolve({
            stdout: typeof stdout === "string" ? stdout.slice(0, this.maxOutputChars) : "",
            stderr: typeof stderr === "string" ? stderr.slice(0, this.maxOutputChars) : "",
            exitCode: typeof exitCode === "number" ? exitCode : 1,
          });
        },
      );
    });
  }

  // --- DB helpers ---

  private dbInsert(
    id: string,
    workflowName: string,
    userId: string,
    sessionId: string,
    args: Record<string, string>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO workflow_executions (id, workflow_name, user_id, session_id, status, args, step_results)
         VALUES (?, ?, ?, ?, 'running', ?, '[]')`,
      )
      .run(id, workflowName, userId, sessionId, JSON.stringify(args));
  }

  private dbUpdate(
    id: string,
    status: string,
    currentStep: string | null,
    stepResults: StepResult[],
    error: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE workflow_executions
         SET status = ?, current_step = ?, step_results = ?, error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(status, currentStep, JSON.stringify(stepResults), error, id);
  }

  private dbGet(id: string): Record<string, string> | undefined {
    return this.db
      .prepare("SELECT * FROM workflow_executions WHERE id = ?")
      .get(id) as Record<string, string> | undefined;
  }

  private dbStoreDefinition(execId: string, definition: WorkflowDefinition): void {
    // Store definition JSON in args field alongside user args, under __definition key
    const row = this.dbGet(execId);
    if (!row) return;
    const args = JSON.parse(row.args);
    args.__definition = JSON.stringify(definition);
    this.db
      .prepare("UPDATE workflow_executions SET args = ? WHERE id = ?")
      .run(JSON.stringify(args), execId);
  }

  private dbGetDefinition(execId: string): WorkflowDefinition | undefined {
    const row = this.dbGet(execId);
    if (!row) return undefined;
    const args = JSON.parse(row.args);
    if (!args.__definition) return undefined;
    return JSON.parse(args.__definition) as WorkflowDefinition;
  }
}
