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
    - id: sysinfo
      command: echo "=== System ===" && uname -a && echo "=== Env ===" && env | sort
      output: file
    - id: greet
      type: llm
      prompt: "为用户 ${name} 生成一句问候语。上一轮反馈：${review.result}。如果没有反馈则自由发挥。只输出问候语文本。"
    - id: review
      approval:
        prompt: "问候语：「${greet.result}」\n系统信息已保存到 ${sysinfo.file}。\n请审阅：approve 通过，revise 修改（附反馈），reject 取消。"
        goto: greet
    - id: done
      command: echo "最终问候语：${greet.result}. Sysinfo at ${sysinfo.file}"
---

# demo-wf

安全的演示工作流，用于测试 workflow 引擎功能（含 goto 迭代循环）。

## 流程

1. 收集系统信息（长输出，`output: file` 写入临时文件）
2. LLM 生成问候语（参考上一轮反馈）
3. 暂停等待用户审阅（支持 revise 跳回步骤 2 重新生成）
4. 输出最终结果

## 测试方式

对 AI 说：`执行 demo-wf 工作流，名字是 test`

审批时可以：
- approve → 通过，继续执行最后一步
- revise + 反馈「改为中文」→ 跳回 LLM 重新生成，可反复迭代
- reject → 工作流失败
