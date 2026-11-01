# DSH Tool Reference

These skills now use **DSH tool names** directly. This file records the DSH tools they rely on and the semantics that matter when following a skill, so the naming stays consistent across the skill set.

## Tools used by the skills

| DSH tool | Purpose |
|----------|---------|
| `read` | Read a text file; returns line-numbered content. |
| `write` | Create or fully replace a UTF-8 text file. |
| `edit` | Targeted string replacement in an existing file. |
| `str_replace_editor` | Literal old/new string swap when `edit` does not fit. |
| `glob` | Find files by path pattern. |
| `grep` | Search file contents with a regular expression. |
| `bash` | Run a shell command. `pwsh` covers Windows-only shells. |
| `run_code` | Execute code when a script is more direct than a shell one-liner. |
| `todo_write` | Checklist / task tracking for multi-step skill flows. |
| `subagent` | Dispatch a subagent with a self-contained prompt and collect its result. |
| `send_message` | Continue an existing subagent's conversation with new instructions. |
| `interrupt_agent` | Stop a running subagent. |
| `list_agents` | List the subagents started in this session. |
| `skill` | Invoke a skill and load its content. |
| `ask_user_question` | Ask the user a structured question. |
| `web_search` | Search the web. |
| `web_fetch` | Fetch and decode a specific URL. |
| `exit_plan_mode` | Present the proposed plan and leave plan mode. |
| `job_*` | Background job control (`job_list`, `job_output`, `job_kill`). |

## Subagent semantics

`subagent` takes a self-contained prompt and returns the child's final result. The child does **not** inherit the parent's conversation history, so the caller must supply every piece of context the child needs.

There is no agent-type argument. The role described in a prompt template (for example "you are a Senior Code Reviewer") belongs in the prompt text, not in a tool argument.

## Plan mode

DSH has no separate "enter plan mode" tool. Enter plan mode with the `/plan` command, then leave it by calling `exit_plan_mode` with the proposed plan. A skill step that describes entering plan mode should be read as "enter plan mode via `/plan`", and the step that submits the plan should be read as "call `exit_plan_mode`".

## Skill discovery roots

DSH discovers skills from these roots, in priority order:

| Root | Scope |
|------|-------|
| `.dsh/skills/` | project (DSH-specific) |
| `.agents/skills/` | project (cross-agent) |
| `~/.dsh/skills/` | user (DSH-specific) |
| `~/.agents/skills/` | user (cross-agent) |

Each skill lives in `<root>/<skill-name>/SKILL.md` with YAML frontmatter carrying at least a `name` matching `^[a-z][a-z0-9-]{0,63}$` and a non-empty `description`.

The project instruction file is `AGENTS.md`; the user-level equivalent is `~/.dsh/AGENTS.md`.
