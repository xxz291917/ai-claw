---
name: memory-organizer
description: "整理和清理用户记忆：合并重复、删除过时条目、修正分类。Use when user asks to organize, tidy, or clean up their memories."
tags: [memory, cleanup, organization]
allowed-tools: memory_list, memory_save, memory_delete
---

# Memory Organizer

整理和清理用户的长期记忆。

## 触发条件

用户说以下类似内容时使用此技能：
- "整理记忆" / "清理记忆" / "整理一下我的记忆"
- "organize my memories" / "clean up memories"
- "我的记忆是不是有重复？"
- "查看我的记忆"

## 工作流程

严格按以下步骤执行，每步完成后向用户报告进展。

### 第 1 步：加载全部记忆

调用 `memory_list()` 获取完整记忆列表。如果没有记忆，告知用户并停止。

### 第 2 步：分析问题

逐条审查，识别以下问题：

1. **重复条目** — 相同信息存储在不同 key 下
   - 例：`name=Alice` 和 `姓名=Alice` 是重复
2. **语义重复** — 不同表述但含义相同的条目
3. **过时条目** — 被更新的条目取代的旧条目（对比 updated 时间戳）
4. **分类不当** — 条目放在错误的 category 下：
   - `preference`: 用户偏好、喜好、风格选择
   - `decision`: 架构或项目决策及理由
   - `fact`: 客观的个人或项目信息
   - `todo`: 待办事项、待处理任务
5. **模糊低质** — key 过于笼统（如 "note"、"info"）或 value 缺少上下文
6. **可合并条目** — 多条记忆可以整合为一条

### 第 3 步：展示整理方案

在执行任何修改之前，向用户展示方案摘要：

```
## 发现的问题

### 重复条目 (N 组)
- id=3 [fact] name: Alice ← 保留
- id=7 [fact] 姓名: Alice ← 删除 (重复)

### 分类错误 (N 条)
- id=12 [fact] 喜欢用 VS Code → 应为 [preference]

### 过时条目 (N 条)
- id=5 [decision] 部署方式: Docker ← 已被 id=15 替代

### 建议合并 (N 组)
- id=8 + id=9 → 合并为一条

### 模糊低质 (N 条)
- id=20 [fact] info: 一些信息 ← 建议删除或改写
```

### 第 4 步：等待用户确认

问用户：**"是否按以上方案整理？你也可以指定只执行部分操作。"**

**在用户确认之前不得执行任何修改操作。**

### 第 5 步：执行修改

按以下顺序操作（避免 ID 冲突）：

1. **删除**重复和过时条目 — `memory_delete(id, reason)`
2. **保存**重新分类或合并后的条目 — `memory_save(category, key, value)`
   - 相同 category + key 会自动 upsert（更新已有条目）
   - 合并操作：先保存合并后的条目，再删除原始条目

### 第 6 步：汇报结果

总结执行情况：
- 删除了 N 条重复
- 重新分类了 N 条
- 合并了 N 组
- 删除了 N 条过时/低质条目
- 当前记忆总数：M 条

## 规则

- **必须**先展示方案并等待用户确认，才能修改
- 保持用户的语言习惯 — 中文记忆保持中文，英文保持英文
- 对拿不准是否重复的条目，询问用户
- 不要删除某条信息的唯一记录
- 如果记忆条目很多（100+），按 category 分批处理
