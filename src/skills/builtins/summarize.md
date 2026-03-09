---
name: summarize
description: "Summarize or extract text/transcripts from URLs, podcasts, and local files. Use when asked to summarize a link, article, or video."
tags: [summarization, content, youtube]
allowed-tools: bash_exec
---

# Summarize

Fast CLI to summarize URLs, local files, and YouTube links.

## When to use

Use this skill when the user asks:

- "summarize this URL/article"
- "what's this link/video about?"
- "transcribe this YouTube/video"

## Quick start

```bash
summarize "https://example.com" --model google/gemini-3-flash-preview
summarize "/path/to/file.pdf" --model google/gemini-3-flash-preview
summarize "https://youtu.be/VIDEO_ID" --youtube auto
```

## YouTube: summary vs transcript

Best-effort transcript (URLs only):

```bash
summarize "https://youtu.be/VIDEO_ID" --youtube auto --extract-only
```

If the transcript is huge, return a tight summary first, then ask which section to expand.

## Model + keys

Set the API key for your chosen provider:

- OpenAI: `OPENAI_API_KEY`
- Anthropic: `ANTHROPIC_API_KEY`
- Google: `GEMINI_API_KEY`

Default model is `google/gemini-3-flash-preview` if none is set.

## Useful flags

- `--length short|medium|long|xl|xxl|<chars>`
- `--max-output-tokens <count>`
- `--extract-only` (URLs only, get raw text without summarizing)
- `--json` (machine-readable output)
- `--firecrawl auto|off|always` (fallback extraction)
- `--youtube auto` (auto-detect YouTube transcripts)

## Install

```bash
brew install steipete/tap/summarize
```
