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
- **22 focused tools**: Reduced from typical 38+ by combining related operations

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

## Tools

### Getting Started

| Tool | Description |
|------|-------------|
| `tracker_init` | Initialize tracker and create first project |
| `tracker_dashboard` | Full project overview — **call this first when resuming work** |

### Projects

| Tool | Description |
|------|-------------|
| `project_create` | Create a new project |
| `project_list` | List projects with completion stats |
| `project_update` | Update project (archive to soft-delete) |

### Epics

| Tool | Description |
|------|-------------|
| `epic_create` | Create an epic within a project |
| `epic_list` | List epics with task counts |
| `epic_update` | Update an epic |

### Tasks

| Tool | Description |
|------|-------------|
| `task_create` | Create a task within an epic |
| `task_list` | List/filter tasks (by epic, status, priority, assignee, tag) |
| `task_get` | Get task with subtasks and related notes |
| `task_update` | Update task (status changes auto-logged) |
| `task_batch_update` | Update multiple tasks at once |

### Subtasks

| Tool | Description |
|------|-------------|
| `subtask_create` | Create subtask(s) — supports batch |
| `subtask_update` | Update subtask title/status |
| `subtask_delete` | Delete subtask(s) — supports batch |

### Notes

| Tool | Description |
|------|-------------|
| `note_save` | Create or update a note (upsert) |
| `note_list` | List notes with filters |
| `note_search` | Full-text search across notes |
| `note_delete` | Delete a note |

### Intelligence

| Tool | Description |
|------|-------------|
| `tracker_search` | Cross-entity search (projects, epics, tasks, notes) |
| `activity_log` | View change history with filters |

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_PATH` | Yes | Absolute path to the `.tracker.db` file |

## Development

```bash
git clone https://github.com/spranab/saga-mcp.git
cd saga-mcp
npm install
npm run build
DB_PATH=./test.db npm start
```

## License

MIT
