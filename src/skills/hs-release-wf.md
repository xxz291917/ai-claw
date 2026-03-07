---
name: hs-release-wf
description: 标准发布流程（工作流版本）— 自动执行 git 检查、测试、打 tag、推送
tags: [release, workflow]
requires-bins: [git, npm]
workflow:
  args:
    version:
      required: true
      description: 发布版本号（如 1.2.0）
    branch:
      default: main
  steps:
    - id: check-branch
      command: git rev-parse --abbrev-ref HEAD
      expect: ${branch}
    - id: check-clean
      command: git status --porcelain
      expect: ""
    - id: test
      command: npm test
    - id: confirm-release
      approval:
        prompt: "分支: ${branch}, 测试通过, 确认发布 v${version}？"
    - id: tag
      command: git tag v${version}
    - id: push
      command: git push origin ${branch} --tags
  on-failure: "步骤 ${failed_step} 失败: ${error}"
---

# hs-release-wf

标准发布流程的工作流版本。使用 `run_workflow` 工具执行，命令步骤自动运行，仅在打 tag 前暂停确认。

## 使用方式

AI 会自动调用：
```json
{ "workflow": "hs-release-wf", "args": "{\"version\": \"1.2.0\"}" }
```
