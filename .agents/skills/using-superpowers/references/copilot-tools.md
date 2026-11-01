# Copilot CLI Tool Mapping

Skills use DSH tool names. When you encounter these in a skill, use your platform equivalent:

| Skill references | Copilot CLI equivalent |
|-----------------|----------------------|
| `read` (file reading) | `view` |
| `write` (file creation) | `create` |
| `edit` (file editing) | `edit` |
| `bash` (run commands) | `bash` |
| `grep` (search file content) | `grep` |
| `glob` (search files by name) | `glob` |
| `skill` tool (invoke a skill) | `skill` |
| `web_fetch` | `web_fetch` |
| `subagent` tool (dispatch subagent) | `task` with `agent_type: "general-purpose"` or `"explore"` |
| Multiple `subagent` calls (parallel) | Multiple `task` calls |
| Subagent status/output | `read_agent`, `list_agents` |
| `todo_write` (task tracking) | `sql` with built-in `todos` table |
| `web_search` | No equivalent — use `web_fetch` with a search engine URL |
| Plan mode (`/plan` command) / `exit_plan_mode` | No equivalent — stay in the main session |

## Async shell sessions

Copilot CLI supports persistent async shell sessions, which have no direct DSH equivalent:

| Tool | Purpose |
|------|---------|
| `bash` with `async: true` | Start a long-running command in the background |
| `write_bash` | Send input to a running async session |
| `read_bash` | Read output from an async session |
| `stop_bash` | Terminate an async session |
| `list_bash` | List all active shell sessions |

## Additional Copilot CLI tools

| Tool | Purpose |
|------|---------|
| `store_memory` | Persist facts about the codebase for future sessions |
| `report_intent` | Update the UI status line with current intent |
| `sql` | Query the session's SQLite database (todos, metadata) |
| `fetch_copilot_cli_documentation` | Look up Copilot CLI documentation |
| GitHub MCP tools (`github-mcp-server-*`) | Native GitHub API access (issues, PRs, code search) |
