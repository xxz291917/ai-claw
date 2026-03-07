import { describe, it, expect } from "vitest";
import { parseWorkflowFromSkill } from "../../src/workflow/parser.js";

const SKILL_CONTENT = `---
name: test-release
description: Test release workflow
tags: [release]
requires-bins: [git]
workflow:
  args:
    version:
      required: true
    branch:
      default: main
  steps:
    - id: check
      command: git status --porcelain
      expect: ""
    - id: confirm
      approval:
        prompt: "确认发布 v\${version}？"
    - id: tag
      command: git tag v\${version}
  on-failure: "步骤 \${failed_step} 失败: \${error}"
---

# Test Release

This is the skill body.
`;

const LLM_SKILL_CONTENT = `---
name: test-llm
description: LLM workflow
workflow:
  args:
    issue:
      required: true
  steps:
    - id: gather
      command: gh issue view \${issue} --json title,body
    - id: analyze
      type: llm
      prompt: |
        分析这个 issue：
        \${gather.stdout}
---
# LLM Test
`;

describe("parseWorkflowFromSkill", () => {
  it("returns null for skills without workflow field", () => {
    const content = "---\nname: simple\ndescription: no workflow\n---\n# Simple";
    expect(parseWorkflowFromSkill(content)).toBeNull();
  });

  it("returns null for content without frontmatter", () => {
    expect(parseWorkflowFromSkill("# Just markdown")).toBeNull();
  });

  it("parses workflow definition from frontmatter", () => {
    const wf = parseWorkflowFromSkill(SKILL_CONTENT);
    expect(wf).not.toBeNull();
    expect(wf!.name).toBe("test-release");
    expect(wf!.args.version.required).toBe(true);
    expect(wf!.args.branch.default).toBe("main");
    expect(wf!.steps).toHaveLength(3);
  });

  it("parses command steps with expect", () => {
    const wf = parseWorkflowFromSkill(SKILL_CONTENT)!;
    expect(wf.steps[0]).toEqual({ id: "check", command: "git status --porcelain", expect: "" });
  });

  it("parses approval steps", () => {
    const wf = parseWorkflowFromSkill(SKILL_CONTENT)!;
    expect(wf.steps[1]).toEqual({ id: "confirm", approval: { prompt: "确认发布 v${version}？" } });
  });

  it("parses command steps with variable references", () => {
    const wf = parseWorkflowFromSkill(SKILL_CONTENT)!;
    expect(wf.steps[2]).toEqual({ id: "tag", command: "git tag v${version}" });
  });

  it("parses on-failure template", () => {
    const wf = parseWorkflowFromSkill(SKILL_CONTENT)!;
    expect(wf.onFailure).toBe("步骤 ${failed_step} 失败: ${error}");
  });

  it("parses llm steps with multi-line prompt", () => {
    const wf = parseWorkflowFromSkill(LLM_SKILL_CONTENT);
    expect(wf).not.toBeNull();
    expect(wf!.steps).toHaveLength(2);
    const llmStep = wf!.steps[1] as { id: string; type: "llm"; prompt: string };
    expect(llmStep.type).toBe("llm");
    expect(llmStep.prompt).toContain("分析这个 issue");
    expect(llmStep.prompt).toContain("${gather.stdout}");
  });
});
