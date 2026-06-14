# Ratel Vault — Obsidian Plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- Worker entry: `src/worker/index.ts` compiled to `worker.js` (CPU-intensive tasks).
- Required release artifacts: `main.js`, `worker.js`, `manifest.json`, and optional `styles.css`.

## Architecture

- **Agent = Model + Harness** — Ratel Vault is a Harness for Obsidian vault knowledge management.
- **Main thread**: Agent Loop, Context Manager, Hooks, Tools, Subagents, UI (Svelte), LLM calls (HTTP), Embedding calls (HTTP), ObsidianVault facade.
- **Worker thread**: vectra indexing, text chunking, vector computation (NO HTTP, NO Obsidian API).
- **No native modules** — vectra (pure JS) instead of LanceDB, JSON instead of sql.js.
- **No external service** — model API is the only network call.

## Environment & tooling

- Node.js 18+ (LTS recommended).
- Package manager: npm.
- Bundler: esbuild with Svelte plugin.
- UI: Svelte 5 (compiled to vanilla JS, no virtual DOM).
- Types: `obsidian` type definitions.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## File & folder conventions

```
src/
  main.ts           # Plugin entry point, lifecycle management
  settings.ts       # Settings interface and defaults
  types.ts          # TypeScript interfaces and types
  core/             # Agent Loop, Context Manager, Hooks
  ports/            # Port interfaces (zero implementation)
  adapters/         # Adapter implementations
    obsidian-vault.ts   # Obsidian API thin wrapper (TS)
    persistence-json.ts # Obsidian loadData/saveData
    vector-vectra.ts    # vectra wrapper
    llm-deepseek.ts     # DeepSeek (OpenAI compatible)
    llm-anthropic.ts    # Claude
  tools/            # Vault tools (search, read, create, etc.)
  hooks/            # Knowledge governance hooks
  subagents/        # Indexer, Librarian, Reviewer, Curator
  ui/               # Svelte views (Chat sidebar, panels)
  worker/           # Worker thread entry (indexing, chunking, vector)
  utils/            # Utility functions
```

- Keep `main.ts` minimal — only plugin lifecycle (onload, onunload, addCommand).
- Delegate all feature logic to separate modules.
- Worker code must NOT import `obsidian` API.

## Manifest rules

- `id`: `ratel-vault` (never change after release).
- `isDesktopOnly`: `true` (uses Node.js Worker Threads and file system APIs).
- `minAppVersion`: keep accurate when using newer Obsidian APIs.

## Key constraints

- **No native modules**: Use vectra (pure JS) instead of LanceDB. Use JSON (Obsidian loadData/saveData) instead of sql.js.
- **No `obsidian` import in Worker**: Worker communicates via `postMessage` only.
- **Worker does NOT make HTTP requests**: Embedding and LLM calls are on the main thread.
- **All Obsidian API access goes through ObsidianVault facade** (`adapters/obsidian-vault.ts`).
- **Single `main.js` + `worker.js`**: All main-thread code bundled into `main.js`, all worker code into `worker.js`.
- **Network calls**: Only model API (DeepSeek / Claude / Ollama). Must be documented in README.

## Performance

- Keep `onload` light — defer heavy work (indexing) to Worker.
- Debounce file system events before sending to Worker.
- Batch embedding API calls.

## Security & privacy

- Default to local/offline operation.
- Model API calls are the only network requests.
- No telemetry. No data collection.
- Vault contents are only sent to the configured model API endpoint.
- All index data stored in `.obsidian/plugins/ratel-vault/`.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json`.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version` (no `v` prefix).
- Attach `main.js`, `worker.js`, `manifest.json`, and `styles.css` to the release.

## Coding conventions

- TypeScript with `"strict": true`.
- `async/await` over promise chains.
- Use `this.register*` helpers for cleanup in Plugin class.
- Each file should have a single, well-defined responsibility.

## Superpowers (Engineering Methodology)

This project uses [Superpowers](https://github.com/obra/superpowers) skills for engineering discipline. Skills are in `.superpowers/`.

### Workflow (mandatory)

1. **brainstorming** — Before writing code, clarify what we're really building. Ask questions. Present design in sections.
2. **writing-plans** — Break work into bite-sized tasks (2-5 min each). Every task has exact file paths, complete code, verification steps.
3. **test-driven-development** — RED-GREEN-REFACTOR: write failing test → watch it fail → write minimal code → watch it pass → commit.
4. **subagent-driven-development** — Dispatch fresh subagent per task with two-stage review (spec compliance, then code quality).
5. **requesting-code-review** — Review against plan, report issues by severity. Critical issues block progress.
6. **systematic-debugging** — 4-phase root cause process. No guessing.
7. **verification-before-completion** — Ensure it's actually fixed before declaring done.

### Key rules

- **User instructions override skills** — If AGENTS.md says "don't use TDD" and a skill says "always TDD," follow the user.
- **Check for skills BEFORE any action** — Even a 1% chance a skill applies → read it first.
- **Skills are mandatory workflows, not suggestions** — When triggered, follow them.

### Spec & Plan Lifecycle (mandatory)

Every brainstorming session, spec, or plan must be tracked. This is non-negotiable — it keeps the project navigable.

**Canonical registry:** [`docs/superpowers/STATUS.md`](docs/superpowers/STATUS.md) is the single source of truth for all specs and plans in this project.

**Update rules:**

1. **brainstorming** skill finishes → create a new spec under `docs/superpowers/specs/` AND register it in `STATUS.md` (status: Active).
2. **writing-plans** skill finishes → create a new plan under `docs/superpowers/plans/` AND register it in `STATUS.md` (status: Pending), linking to the spec it implements.
3. **executing-plans** or **subagent-driven-development** starts → update `STATUS.md` to status: In Progress, set the branch name.
4. Plan execution completes → update `STATUS.md` to status: Completed with the merged commit / branch.
5. Spec/plan abandoned or superseded → move to the "Superseded / Archived" section with explanation.

**Commit convention:** Always update `STATUS.md` in the SAME commit as the file it tracks. Never leave the registry out of sync.

**Spec vs Plan distinction:**
- **Spec** = WHAT we're building (design, architecture, requirements). Lives in `specs/`.
- **Plan** = HOW we're building it (tasks, files, tests). Lives in `plans/`.
- A spec can have multiple plans (e.g., an implementation plan and a separate test plan).
