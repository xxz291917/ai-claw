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
    - id: sysinfo
      command: echo "=== System ===" && uname -a && echo "=== Env ===" && env | sort
      output: file
    - id: confirm
      approval:
        prompt: "问候完成，系统信息已保存到 ${sysinfo.file}，确认继续？"
    - id: done
      command: echo "Workflow completed for ${name}. Sysinfo saved at ${sysinfo.file}"
---

# demo-wf

安全的演示工作流，用于测试 workflow 引擎功能。

## 流程

1. 打印问候语（短输出，存内存）
2. 收集系统信息（长输出，`output: file` 写入临时文件）
3. 暂停等待用户确认（审批提示中引用文件路径）
4. 打印完成信息

## 测试方式

对 AI 说：`执行 demo-wf 工作流，名字是 test`
