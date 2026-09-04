# saga-mcp

[![npm](https://img.shields.io/npm/v/saga-mcp)](https://www.npmjs.com/package/saga-mcp)
[![npm downloads](https://img.shields.io/npm/dm/saga-mcp)](https://www.npmjs.com/package/saga-mcp)
[![license](https://img.shields.io/npm/l/saga-mcp)](https://github.com/spranab/saga-mcp/blob/master/LICENSE)
[![IdeaCred](https://ideacred.com/api/badge/spranab/saga-mcp)](https://ideacred.com/profile/spranab)

Your coding agent loses the plan between sessions. You come back tomorrow and
it has no idea which of the five things you agreed on are done, which one is
blocked on which, or why you rejected the second approach — because the plan
lived in the context window, or in a `TODO.md` nobody updates.

saga-mcp gives the agent a real tracker instead: a SQLite file in your project
holding projects, epics, tasks, subtasks, dependencies, comments, notes and
decisions, exposed as 35 MCP tools. The agent writes to it as it works and
reads the dashboard when it comes back. No accounts, no external service, no
network calls — the database is a file you own.

## Install (60 seconds)

Claude Code — add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "saga": {
      "command": "npx",
      "args": ["-y", "saga-mcp"],
      "env": { "DB_PATH": "/absolute/path/to/your/project/.tracker.db" }
    }
  }
}
```

Restart the client. `DB_PATH` is the only setting; the file and schema are
created on first use.

## What it looks like

**You:** "Set up tracking for the e-commerce API and plan out auth."

```
tracker_init({ project_name: "E-Commerce API" })
epic_create({ project_id: 1, name: "Authentication", priority: "high" })
task_create({ epic_id: 1, title: "Design auth schema", priority: "critical" })
task_create({ epic_id: 1, title: "Implement JWT auth", depends_on: [1] })
task_create({ epic_id: 1, title: "Add OAuth2 Google login", depends_on: [2] })
```

Tasks 2 and 3 come back **blocked** — their dependencies aren't done. Finish
task 1 and task 2 unblocks itself.

**Next session, you:** "Where were we?"

```
tracker_dashboard({})
→ "E-Commerce API: 5 tasks across 2 epics. 40% complete.
   Active: Authentication (2/3 done). Next up: Product Catalog (2 tasks).
   1 blocked task(s)."
```

Plus the structured data behind it: stats, epics, blocked and overdue tasks,
recent activity, notes.

## Features

- **Full hierarchy**: Projects > Epics > Tasks > Subtasks
- **Task dependencies**: Express sequencing with auto-block/unblock when deps are met
- **Description lock**: Stop agents rewriting a task's spec when they meant to leave a comment
- **Subtask ordering & dependencies**: Explicit order, and checklist items that wait on siblings
- **Comments**: Threaded discussions on tasks — leave breadcrumbs across sessions, with reversible soft-delete
- **Web UI**: `saga-web` serves a local dashboard for browsing *and* editing the same database
- **Templates**: Reusable task sets with `{variable}` substitution
- **Dashboard**: One tool call gives full overview with natural language summary
- **SQLite**: Self-contained `.tracker.db` file per project — zero setup, no external database
- **Activity log**: Every mutation is automatically tracked with old/new values
- **Notes system**: Decisions, context, meeting notes, blockers — all searchable
- **Batch operations**: Create multiple subtasks or update multiple tasks in one call
- **35 focused tools**: With MCP safety annotations on every tool
- **Import/export**: Full project backup and migration as JSON (with dependencies and comments)
- **Source references**: Link tasks to specific code locations
- **Auto time tracking**: Hours computed automatically from activity log
- **Cross-platform**: Works on macOS, Windows, and Linux

## Other clients

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "saga": {
      "command": "npx",
      "args": ["-y", "saga-mcp"],
      "env": {
        "DB_PATH": "/absolute/path/to/your/project/.tracker.db"
      }
    }
  }
}
```

### With Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "saga": {
      "command": "npx",
      "args": ["-y", "saga-mcp"],
      "env": {
        "DB_PATH": "/absolute/path/to/your/project/.tracker.db"
      }
    }
  }
}
```

### Manual install

```bash
npm install -g saga-mcp
DB_PATH=./my-project/.tracker.db saga-mcp
```

## Configuration

saga-mcp requires a single environment variable:

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PATH` | Yes | Absolute path to the `.tracker.db` SQLite file. The file and schema are auto-created on first use. |
| `SAGA_PROJECT` | No | Scope every tool to one project, by id or name. Set this per repo when several repos share one database. Unset, tools read across the whole file. |
| `SAGA_TOOLS` | No | `full` (default) lists all 33 tools. `core` lists only the 12 an ordinary tracking session needs, cutting ~3,300 tokens of context per session. Tools left off the list still work if called by name. |

No API keys, no accounts, no external services. Everything is stored locally in the SQLite file you specify.

### Token cost

The tool list is context every session pays before any work happens, and list responses are
context it pays again on every call. Both are kept deliberately small:

- Responses are compact JSON — no pretty-print indentation, which measured 20-27% of every response
- `task_list` rows omit nulls and `metadata`, and truncate descriptions to 120 characters
  (call `task_get` for a task's full text) — 19-39% smaller depending on how long your descriptions run
- `activity_log` omits null columns and the row id (no tool takes one) — about 27% smaller
- `tracker_search` returns previews rather than whole records — about 47% smaller; follow up with
  `task_get` or `note_list` for the full text
- `SAGA_TOOLS=core` drops the listed tool surface from ~6,000 to ~2,700 tokens

`note_list` deliberately keeps full note content — it is the retrieval tool, not a preview.

Set `SAGA_TOOLS=core` when an agent only tracks work; leave it unset when you want templates,
import/export, session diffs and the rest discoverable.

## Tools

### Getting Started

| Tool | Description | Annotations |
|------|-------------|-------------|
| `tracker_init` | Initialize tracker and create first project | `readOnly: false`, `idempotent: true` |
| `tracker_dashboard` | Full project overview with natural language summary | `readOnly: true` |

### Projects

| Tool | Description | Annotations |
|------|-------------|-------------|
| `project_create` | Create a new project | `readOnly: false` |
| `project_list` | List projects with completion stats | `readOnly: true` |
| `project_update` | Update project (archive to soft-delete) | `readOnly: false`, `idempotent: true` |

### Epics

| Tool | Description | Annotations |
|------|-------------|-------------|
| `epic_create` | Create an epic within a project | `readOnly: false` |
| `epic_list` | List epics with task counts | `readOnly: true` |
| `epic_update` | Update an epic | `readOnly: false`, `idempotent: true` |

### Tasks

| Tool | Description | Annotations |
|------|-------------|-------------|
| `task_create` | Create a task with optional dependencies | `readOnly: false` |
| `task_list` | List/filter tasks with dependency info | `readOnly: true` |
| `task_get` | Get task with subtasks, notes, comments, and dependencies | `readOnly: true` |
| `task_update` | Update task (auto-logs, auto-blocks/unblocks) | `readOnly: false`, `idempotent: true` |
| `task_lock_description` | Lock/unlock a description so agents can't rewrite it | `readOnly: false`, `idempotent: true` |
| `task_batch_update` | Update multiple tasks at once | `readOnly: false`, `idempotent: true` |

### Subtasks

| Tool | Description | Annotations |
|------|-------------|-------------|
| `subtask_create` | Create subtask(s) — supports batch | `readOnly: false` |
| `subtask_update` | Update title/status/position; `depends_on` and `blocks` set ordering | `readOnly: false`, `idempotent: true` |
| `subtask_reorder` | Set the order of a task's subtasks in one call | `readOnly: false`, `idempotent: true` |
| `subtask_delete` | Delete subtask(s) — supports batch | `destructive: true`, `idempotent: true` |

### Comments

| Tool | Description | Annotations |
|------|-------------|-------------|
| `comment_add` | Add a comment to a task (threaded discussion) | `readOnly: false` |
| `comment_list` | List comments on a task (removed ones hidden unless `include_deleted`) | `readOnly: true` |
| `comment_delete` | Remove a comment — soft delete, row kept for audit | `readOnly: false`, `idempotent: true` |
| `comment_restore` | Restore a removed comment | `readOnly: false`, `idempotent: true` |

### Templates

| Tool | Description | Annotations |
|------|-------------|-------------|
| `template_create` | Create a reusable task template with `{variable}` placeholders | `readOnly: false` |
| `template_list` | List available templates | `readOnly: true` |
| `template_apply` | Apply template to create tasks with variable substitution | `readOnly: false` |
| `template_delete` | Delete a template | `destructive: true`, `idempotent: true` |

### Notes

| Tool | Description | Annotations |
|------|-------------|-------------|
| `note_save` | Create or update a note (upsert) | `readOnly: false` |
| `note_list` | List notes with filters | `readOnly: true` |
| `note_search` | Full-text search across notes | `readOnly: true` |
| `note_delete` | Delete a note | `destructive: true`, `idempotent: true` |

### Intelligence

| Tool | Description | Annotations |
|------|-------------|-------------|
| `tracker_search` | Cross-entity search (projects, epics, tasks, notes) | `readOnly: true` |
| `activity_log` | View change history with filters | `readOnly: true` |
| `tracker_session_diff` | Show what changed since a given timestamp — call at session start | `readOnly: true` |

### Import / Export

| Tool | Description | Annotations |
|------|-------------|-------------|
| `tracker_export` | Export full project as nested JSON (includes dependencies and comments) | `readOnly: true` |
| `tracker_import` | Import project from JSON (matching export format) | `readOnly: false` |

## Usage Examples

### Example 1: Starting a project with dependencies

**User prompt:** "Set up tracking for my new e-commerce API project"

**Tool calls:**
```
tracker_init({ project_name: "E-Commerce API", project_description: "REST API for online store" })
epic_create({ project_id: 1, name: "Authentication", priority: "high" })
task_create({ epic_id: 1, title: "Design auth schema", priority: "critical" })
task_create({ epic_id: 1, title: "Implement JWT auth", priority: "high", depends_on: [1] })
task_create({ epic_id: 1, title: "Add OAuth2 Google login", priority: "medium", depends_on: [2] })
```

**Result:** Task 2 and 3 are auto-blocked because their dependencies aren't done yet. When task 1 is marked done, task 2 auto-unblocks.

### Example 2: Resuming work with dashboard summary

**Tool calls:**
```
tracker_dashboard({})
```

**Response includes a natural language summary:**
```
"E-Commerce API: 5 tasks across 2 epics. 40% complete. Active: Authentication (2/3 done). Next up: Product Catalog (2 tasks). 1 blocked task(s)."
```

Plus the full structured data (stats, epics, blocked tasks, overdue tasks, activity, notes).

### Example 3: Using templates for repeated workflows

**Create a template:**
```
template_create({
  name: "feature_workflow",
  description: "Standard feature implementation",
  tasks: [
    { "title": "Design {feature} API", "priority": "critical", "estimated_hours": 2 },
    { "title": "Implement {feature}", "priority": "high", "estimated_hours": 8 },
    { "title": "Write tests for {feature}", "priority": "high", "estimated_hours": 4 },
    { "title": "Document {feature}", "priority": "medium", "estimated_hours": 1 }
  ]
})
```

**Apply it:**
```
template_apply({ template_id: 1, epic_id: 2, variables: { "feature": "user auth" } })
```

Creates 4 tasks: "Design user auth API", "Implement user auth", "Write tests for user auth", "Document user auth".

### Example 4: Task comments as decision trail

```
comment_add({ task_id: 5, content: "Investigated root cause: CORS headers missing on preflight" })
comment_add({ task_id: 5, content: "Fixed by adding OPTIONS handler. Tested with curl." })
task_update({ id: 5, status: "done" })
```

Comments persist across sessions — next time an agent calls `task_get(5)`, it sees the full discussion thread.

If a comment turns out to be wrong, retract it without losing the trail:

```
comment_delete({ id: 12, reason: "Root cause was wrong — it was a proxy timeout", deleted_by: "pranab" })
```

The row stays in the database and in the activity log. `comment_list` and `task_get` skip it,
`comment_list({ task_id: 5, include_deleted: true })` shows it with its reason, and
`comment_restore({ id: 12 })` brings it back. Nothing an agent removes is unrecoverable.

## One database, many projects

saga-mcp works either way: a `.tracker.db` per repo (portable, keeps unrelated work apart),
or one shared database that every repo points at.

The shared setup needs one extra thing. `projects` is the top-level table, so a shared file holds
several projects — but `task_list`, `note_list`, `activity_log` and `tracker_search` read across
the whole file unless told otherwise. An agent in repo B would see repo A's tasks. Set
`SAGA_PROJECT` per repo and each agent sees only its own:

```json
{
  "mcpServers": {
    "saga": {
      "command": "npx",
      "args": ["-y", "saga-mcp"],
      "env": {
        "DB_PATH": "/Users/you/saga/central.tracker.db",
        "SAGA_PROJECT": "Payments platform"
      }
    }
  }
}
```

`SAGA_PROJECT` takes a project id or a project name (case-insensitive), and fails on startup with
the list of real projects if it matches neither. Every scoped tool also accepts an explicit
`project_id` argument, which wins over the environment variable.

| Setup | What to set | Result |
|-------|-------------|--------|
| One database per repo | `DB_PATH` | Nothing to scope — one project per file |
| Shared database, per-repo agents | `DB_PATH` + `SAGA_PROJECT` | Each agent sees only its project |
| Shared database, one agent over everything | `DB_PATH` | Tools read across all projects |

With neither `SAGA_PROJECT` nor a `project_id`, `tracker_dashboard` falls back to the first project
in the file and says so — the response carries `other_projects` and the summary explains that the
project was a guess, rather than silently reporting on the wrong repo.

The web UI is unaffected either way: its project switcher lists every project in the database, and
each tab is scoped to the selected one.

## Keeping agents on the rails

Two guards for the ways an agent goes wrong on a long task.

**A locked description.** Agents sometimes rewrite a task's description to record progress, when
they meant to add a comment — and the spec you agreed on is gone. Lock it and `task_update` refuses:

```
task_lock_description({ id: 12 })
task_update({ id: 12, description: "..." })
  -> Task 12's description is locked and was not changed. Record progress with
     comment_add instead, or unlock it in the web UI if the description is genuinely wrong.
```

Everything else about the task stays editable — the point is to protect the spec, not freeze the
task. The lock cannot be cleared as a side effect of an ordinary `task_update`; it takes a
deliberate `task_lock_description` call or the lock toggle in the web UI, and both are logged.

This is a guard against confusion, not an adversarial control: an agent that is told to unlock
still can. It turns a silent overwrite into a visible, reversible decision.

**Subtask order and dependencies.** New subtasks are appended in order rather than all landing at
position 0, `subtask_reorder` sets the order in one call (or drag them in the UI), and a subtask
can wait on its siblings:

```
subtask_update({ id: 8, depends_on: [5, 6] })    # 8 waits for 5 and 6
subtask_update({ id: 4, blocks: [5, 6, 7, 8] })  # a bug that holds up the rest
```

Reads carry `depends_on` and `blocked`, and the block is **enforced on write**: starting or
finishing a subtask whose prerequisites are unmet is refused, and so is completing a task whose
checklist is still open.

```
subtask_update({ id: 8, status: "in_progress" })
  -> Subtask 8 cannot be started — it waits on #5 'write the parser' (todo).
     Finish those first, or pass force: true to override deliberately (the override is logged).
```

`force: true` is the way past, for when a person has decided the blocker no longer applies. It
works on `subtask_update`, `task_update` and `task_batch_update`, and every override is written to
the activity log naming what was skipped. The web UI asks for confirmation and then sends it.

The distinction that matters is between an agent quietly ignoring a blocker and someone choosing
to override one. Dependencies stay
within one task — a checklist item waiting on something under a *different* task is a task-level
dependency, and `task_update depends_on` already models that. Cycles are refused with the loop
spelled out.

## Web UI

Everything above is agent-facing. `saga-web` puts the same database in a browser — for the times
when reviewing a spec an agent just wrote, or fixing one field by hand, is faster than another prompt.

```bash
npx -p saga-mcp saga-web ./.tracker.db --open
```

Or against a database you already point your MCP server at:

```bash
saga-web --db ~/saga/central.tracker.db --port 8080
```

| Option | Default | Description |
|--------|---------|-------------|
| `--db <path>` | `$DB_PATH` | Database to open. A positional path works too. |
| `--port <n>` | first free from `4319` | Omit it and saga-web takes the first free port, so one instance per project just works. `--port N` binds exactly N and fails if taken; `--port 0` lets the OS choose. Also `SAGA_WEB_PORT`. |
| `--host <addr>` | `127.0.0.1` | Bind address. Local-only by default. |
| `--read-only` | off | Serve the UI with every editing control removed. |
| `--open` | off | Open the UI in your default browser. |

What you get:

- **Overview** — stats, per-epic progress, blocked and overdue tasks
- **Board** — kanban across the five task statuses; drag a card to change its status
- **Epics** — the full Epic → Task → Subtask tree, which is the fastest way to review a spec an agent just wrote
- **Notes** and **Activity** — decisions and the complete change history
- **Task drawer** — edit any field, comment, remove or restore a comment, lock the description, drag subtasks into order, and set which subtasks wait on which. Each subtask has one control carrying its whole state (todo / in progress / done, or blocked), and the drawer resizes by dragging its edge
- **Project switcher** — every project in the database, so one central `.tracker.db` covers all your repos; every tab, including Activity, is scoped to the selected project
- **Shareable, refreshable URLs** — the open project, tab and task live in the address bar, so a browser refresh puts you back where you were and back/forward move between tasks. A ⟳ button in the task drawer re-reads that task without a page reload, for picking up what an agent just wrote

Writes from the UI call the *same handlers* the MCP tools do, so edits you make by hand are
validated identically and land in the same activity log as the agent's — an agent calling
`tracker_dashboard` after you fix something sees the fix and how it happened.

A few deliberate limits: it binds to `127.0.0.1` unless you ask otherwise, it has no
authentication (don't put it on a shared network), and it will not create a database — point it
at one your MCP server already uses. Separate `.tracker.db` files are not yet aggregated into
one view; a single database with multiple projects is.

## How It Works

saga-mcp stores everything in a single SQLite file (`.tracker.db`) per project. The database is auto-created on first use with all tables and indexes — no migration step needed.

### Hierarchy

```
Project
  └── Epic (feature/workstream)
        └── Task (unit of work)
              ├── Subtask (checklist item)
              ├── Comment (discussion thread)
              └── Dependencies (blocked by other tasks)
```

### Task Dependencies

Tasks can depend on other tasks. When you set `depends_on: [2, 3]` on a task:
- The task is auto-blocked if any dependency isn't `done`
- When a dependency is marked `done`, downstream tasks are re-evaluated
- If all dependencies are met, the blocked task auto-unblocks to `todo`

### Note Types

Notes replace scattered markdown files. Each note has a type:

| Type | Use case |
|------|----------|
| `general` | Free-form notes |
| `decision` | Architecture/design decisions |
| `context` | Conversation context for future sessions |
| `meeting` | Meeting notes |
| `technical` | Technical details, specs |
| `blocker` | Blockers and issues |
| `progress` | Progress updates |
| `release` | Release notes |

### Activity Log

Every create, update, and delete is automatically recorded:

```json
{
  "summary": "Task 'Fix CORS issue' status: blocked -> done",
  "action": "status_changed",
  "entity_type": "task",
  "entity_id": 15,
  "field_name": "status",
  "old_value": "blocked",
  "new_value": "done",
  "created_at": "2026-02-21T18:30:00"
}
```

## Privacy Policy

saga-mcp is a fully local, offline tool. It does **not**:

- Collect any user data
- Send any data to external servers
- Require internet access after installation
- Use analytics, telemetry, or tracking of any kind

All data is stored exclusively in the local SQLite file specified by `DB_PATH`. You own your data completely. Uninstalling saga-mcp and deleting the `.tracker.db` file removes all traces.

For questions about privacy, open an issue at https://github.com/spranab/saga-mcp/issues.

## Development

```bash
git clone https://github.com/spranab/saga-mcp.git
cd saga-mcp
npm install
npm run build
DB_PATH=./test.db npm start

# the web UI against the same database
node dist/web/index.js ./test.db --open

npm test     # unit and integration, ~140 tests, no network
npm run e2e  # release gate: packs a tarball, installs it, drives the real binaries
```

### Releasing

Publishing to npm is irreversible — a version number can never be reused — so it is the *last*
step, and it is triggered by publishing a GitHub release, not by pushing a tag.

```bash
# 1. bump the version in package.json, manifest.json and server.json, then merge
# 2. tag it. Nothing is published yet.
git tag -a v1.9.0 -m "v1.9.0 — ..." && git push origin v1.9.0

# 3. verify the tagged build: this packs the tarball that would be published
#    and drives it end to end, including an upgrade from an older database.
npm run e2e

# 4. publish the release. This fires the publish workflow.
gh release create v1.9.0 --notes-file notes.md
```

The workflow re-runs the suite against the tagged commit, refuses a tag that does not match
`package.json`, refuses a version already on npm, and sends a GitHub *pre-release* to the `next`
dist-tag so it never becomes what `npm install saga-mcp` gives people. A failed publish can be
retried against the same tag with `gh workflow run "Publish to npm" -f tag=v1.9.0`.

## Support

- **Issues**: https://github.com/spranab/saga-mcp/issues
- **Repository**: https://github.com/spranab/saga-mcp

## Related projects

Part of a set of agent infrastructure built by one person, meant to be used
together:

- [yantrikdb-mcp](https://github.com/yantrikos/yantrikdb-mcp) — persistent
  cognitive memory for the same agent: what it learned, not what it planned.
- [brainstorm-mcp](https://github.com/spranab/brainstorm-mcp) — multi-model
  debate before you commit a plan to the tracker.
- [swarmcode](https://github.com/spranab/swarmcode) — real-time channel
  between Claude Code instances on different machines.
- [truenas-mcp](https://github.com/spranab/truenas-mcp) — 278 TrueNAS SCALE
  actions behind one hierarchical tool.
- [mcpier](https://github.com/spranab/mcpier) — self-hosted MCP control plane
  that keeps API keys off your clients.

## License

MIT
