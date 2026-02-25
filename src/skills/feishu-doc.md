---
name: feishu-doc
description: "Feishu (Lark) document read/write operations. Use when user mentions Feishu docs, cloud docs, or docx links."
tags: [feishu, lark, documentation]
allowed-tools: Bash
requires-env: [LARK_APP_ID, LARK_APP_SECRET]
---

# Feishu Document Operations

Interact with Feishu documents via the Feishu Open API.

## Token Extraction

From URL `https://xxx.feishu.cn/docx/ABC123def` -> `doc_token` = `ABC123def`

## Authentication

All requests require a tenant access token:

```bash
# Get tenant access token
TOKEN=$(curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d '{"app_id": "'$LARK_APP_ID'", "app_secret": "'$LARK_APP_SECRET'"}' | jq -r '.tenant_access_token')
```

## Read Document

```bash
curl -s "https://open.feishu.cn/open-apis/docx/v1/documents/$DOC_TOKEN/raw_content" \
  -H "Authorization: Bearer $TOKEN"
```

Returns title, plain text content, block statistics.

## Write Document (Replace All)

Use markdown content. Supports: headings, lists, code blocks, quotes, links, bold/italic.

**Limitation:** Markdown tables are NOT supported.

## Append Content

```bash
curl -s -X POST "https://open.feishu.cn/open-apis/docx/v1/documents/$DOC_TOKEN/blocks/$DOC_TOKEN/children" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"children": [{"block_type": 2, "text": {"elements": [{"text_run": {"content": "New content"}}]}}]}'
```

## Create Document

```bash
curl -s -X POST "https://open.feishu.cn/open-apis/docx/v1/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "New Document", "folder_token": "fldcnXXX"}'
```

## List Blocks

```bash
curl -s "https://open.feishu.cn/open-apis/docx/v1/documents/$DOC_TOKEN/blocks" \
  -H "Authorization: Bearer $TOKEN"
```

Returns full block data including tables, images. Use this to read structured content.

## Reading Workflow

1. Read raw content first - get plain text + statistics
2. Check response for Table, Image, Code blocks
3. If structured content exists, use list blocks for full data

## Permissions

Required scopes: `docx:document`, `docx:document:readonly`, `drive:drive`
