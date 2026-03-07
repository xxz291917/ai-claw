---
name: demo-wf
description: 演示工作流 — 安全无副作用，用于测试 workflow 引擎
tags: [demo, workflow]
workflow:
  args:
    name:
      required: true
      description: 你的名字
  steps:
    - id: greet
      command: echo "Hello, ${name}!"
    - id: date
      command: date "+%Y-%m-%d %H:%M:%S"
    - id: confirm
      approval:
        prompt: "前两步已完成，确认继续？"
    - id: done
      command: echo "Workflow completed for ${name} at $(date +%H:%M:%S)"
---

# demo-wf

安全的演示工作流，用于测试 workflow 引擎功能。

## 流程

1. 打印问候语
2. 显示当前时间
3. 暂停等待用户确认
4. 打印完成信息

## 测试方式

对 AI 说：`执行 demo-wf 工作流，名字是 test`
