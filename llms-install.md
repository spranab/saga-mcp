# Installing saga-mcp

saga-mcp is a project-tracker MCP server: projects, epics, tasks, subtasks,
notes and an activity log, all in one local SQLite file. No account, no API
key, no network calls.

## Steps

1. Add this to the client's MCP config (Claude Code: `.mcp.json`; Cline: the
   MCP settings file):

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

2. Set `DB_PATH` to an absolute path inside the user's project — this is the
   **only** required setting. The SQLite file and schema are created
   automatically on first use; do not create the file yourself first.
3. Restart the client. No further setup, login, or credentials are needed.

## Notes for the installing agent

- Node.js 18+ must be on PATH for `npx` to work.
- `DB_PATH` must be an absolute path, not relative — a relative path resolves
  against the client's working directory, which is often not the project
  root.
- An optional `SAGA_PROJECT` env var scopes a shared database to one project
  when multiple agents write to the same `DB_PATH`; omit it for the common
  case of one database per repo.
- Do not set any other environment variables — there are no API keys or
  external services involved.
