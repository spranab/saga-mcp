# saga-mcp

A Jira-like project tracker MCP server for AI agents. SQLite-backed, per-project scoped, with full hierarchy and activity logging — so LLMs never lose track.

**No more scattered markdown files.** saga-mcp gives your AI assistant a structured database to track projects, epics, tasks, subtasks, notes, and decisions across sessions.

## Features

- **Full hierarchy**: Projects > Epics > Tasks > Subtasks
- **SQLite**: Self-contained `.tracker.db` file per project — zero setup, no external database
- **Activity log**: Every mutation is automatically tracked with old/new values
- **Dashboard**: One tool call gives full project overview (stats, blocked tasks, recent changes)
- **Notes system**: Decisions, context, meeting notes, blockers — all searchable
- **Batch operations**: Create multiple subtasks or update multiple tasks in one call
- **22 focused tools**: With MCP safety annotations on every tool
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
| `tracker_dashboard` | Full project overview — **call this first when resuming work** | `readOnly: true` |

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
| `task_create` | Create a task within an epic | `readOnly: false` |
| `task_list` | List/filter tasks (by epic, status, priority, assignee, tag) | `readOnly: true` |
| `task_get` | Get task with subtasks and related notes | `readOnly: true` |
| `task_update` | Update task (status changes auto-logged) | `readOnly: false`, `idempotent: true` |
| `task_batch_update` | Update multiple tasks at once | `readOnly: false`, `idempotent: true` |

### Subtasks

| Tool | Description | Annotations |
|------|-------------|-------------|
| `subtask_create` | Create subtask(s) — supports batch | `readOnly: false` |
| `subtask_update` | Update subtask title/status | `readOnly: false`, `idempotent: true` |
| `subtask_delete` | Delete subtask(s) — supports batch | `destructive: true`, `idempotent: true` |

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

## Usage Examples

### Example 1: Starting a new project

**User prompt:** "Set up tracking for my new e-commerce API project"

**Tool calls:**
```
tracker_init({ project_name: "E-Commerce API", project_description: "REST API for online store" })
epic_create({ project_id: 1, name: "Authentication", priority: "high" })
epic_create({ project_id: 1, name: "Product Catalog", priority: "medium" })
task_create({ epic_id: 1, title: "Implement JWT auth", priority: "high" })
task_create({ epic_id: 1, title: "Add OAuth2 Google login", priority: "medium" })
subtask_create({ task_id: 1, titles: ["Set up JWT library", "Create login endpoint", "Create refresh endpoint", "Add middleware"] })
```

**Expected output:** Project created with ID 1, two epics, two tasks, and four subtasks. Activity log records all creations.

### Example 2: Resuming work on an existing project

**User prompt:** "What's the current status of my project? What should I work on next?"

**Tool calls:**
```
tracker_dashboard({})
```

**Expected output:**
```json
{
  "project": { "id": 1, "name": "E-Commerce API", "status": "active" },
  "stats": {
    "total_epics": 2,
    "total_tasks": 5,
    "tasks_done": 2,
    "tasks_in_progress": 1,
    "tasks_blocked": 1,
    "tasks_todo": 1,
    "completion_pct": 40.0
  },
  "epics": [
    { "name": "Authentication", "task_count": 3, "done_count": 2, "completion_pct": 66.7 },
    { "name": "Product Catalog", "task_count": 2, "done_count": 0, "completion_pct": 0 }
  ],
  "blocked_tasks": [
    { "id": 4, "title": "Add rate limiting", "epic_name": "Authentication" }
  ],
  "recent_activity": [...],
  "recent_notes": [...]
}
```

The dashboard immediately shows: 40% done, 1 blocked task in Auth, Product Catalog hasn't started. The LLM can now prioritize unblocking the rate limiting task or starting on the catalog.

### Example 3: Recording a decision and marking tasks done

**User prompt:** "We decided to use Redis for caching. Mark the caching research tasks as done."

**Tool calls:**
```
note_save({
  title: "Decision: Use Redis for caching",
  content: "After evaluating Redis vs Memcached vs in-memory, decided on Redis.\n\nReasons:\n- Built-in persistence\n- Pub/sub for cache invalidation\n- Better data structure support\n\nTrade-offs: Extra infrastructure, but managed Redis on AWS is acceptable.",
  note_type: "decision",
  related_entity_type: "epic",
  related_entity_id: 3,
  tags: ["caching", "infrastructure"]
})
task_batch_update({ ids: [8, 9], status: "done" })
```

**Expected output:** Decision note created with ID, linked to the epic. Tasks 8 and 9 marked as done. Activity log records both the note creation and the status changes with "status: todo -> done" entries.

## How It Works

saga-mcp stores everything in a single SQLite file (`.tracker.db`) per project. The database is auto-created on first use with all tables and indexes — no migration step needed.

### Hierarchy

```
Project
  └── Epic (feature/workstream)
        └── Task (unit of work)
              └── Subtask (checklist item)
```

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
