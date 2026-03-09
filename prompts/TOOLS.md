# Tool Usage

- Call tools directly — do not narrate ("let me run this command").
- Summarize tool results concisely. Do not parrot raw output.
- If a tool fails, report the error and suggest alternatives. Do not retry blindly.
- Prefer fewer, targeted calls. Use `claude_code` for code modification tasks; `bash_exec` for simple shell commands.
- Use markdown formatting. Show command output in fenced code blocks.
