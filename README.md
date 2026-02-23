# saga-mcp

A Jira-like project tracker MCP server for AI agents. SQLite-backed, per-project scoped, with full hierarchy and activity logging — so LLMs never lose track.

**No more scattered markdown files.** saga-mcp gives your AI assistant a structured database to track projects, epics, tasks, subtasks, notes, and decisions across sessions.

## Features

- **Full hierarchy**: Projects > Epics > Tasks > Subtasks
- **Task dependencies**: Express sequencing with auto-block/unblock when deps are met
- **Comments**: Threaded discussions on tasks — leave breadcrumbs across sessions
- **Templates**: Reusable task sets with `{variable}` substitution
- **Dashboard**: One tool call gives full overview with natural language summary
- **SQLite**: Self-contained `.tracker.db` file per project — zero setup, no external database
- **Activity log**: Every mutation is automatically tracked with old/new values
- **Notes system**: Decisions, context, meeting notes, blockers — all searchable
- **Batch operations**: Create multiple subtasks or update multiple tasks in one call
- **31 focused tools**: With MCP safety annotations on every tool
- **Import/export**: Full project backup and migration as JSON (with dependencies and comments)
- **Source references**: Link tasks to specific code locations
- **Auto time tracking**: Hours computed automatically from activity log
- **Cross-platform**: Works on macOS, Windows, and Linux

## Quick Start

### With Claude Code

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

No API keys, no accounts, no external services. Everything is stored locally in the SQLite file you specify.

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
| `task_batch_update` | Update multiple tasks at once | `readOnly: false`, `idempotent: true` |

### Subtasks

| Tool | Description | Annotations |
|------|-------------|-------------|
| `subtask_create` | Create subtask(s) — supports batch | `readOnly: false` |
| `subtask_update` | Update subtask title/status | `readOnly: false`, `idempotent: true` |
| `subtask_delete` | Delete subtask(s) — supports batch | `destructive: true`, `idempotent: true` |

### Comments

| Tool | Description | Annotations |
|------|-------------|-------------|
| `comment_add` | Add a comment to a task (threaded discussion) | `readOnly: false` |
| `comment_list` | List all comments on a task | `readOnly: true` |

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
```

## Support

- **Issues**: https://github.com/spranab/saga-mcp/issues
- **Repository**: https://github.com/spranab/saga-mcp

## License

MIT
