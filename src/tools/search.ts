import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'tracker_search',
    description:
      'Search across ALL entities (projects, epics, tasks, notes) by keyword. Returns categorized results.',
    annotations: { title: 'Global Search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        entity_types: {
          type: 'array',
          items: { type: 'string', enum: ['project', 'epic', 'task', 'note'] },
          description: 'Limit search to specific entity types (omit for all)',
        },
        limit: { type: 'integer', default: 20, description: 'Max results per entity type' },
      },
      required: ['query'],
    },
  },
];

function handleSearch(args: Record<string, unknown>) {
  const db = getDb();
  const query = args.query as string;
  const entityTypes = (args.entity_types as string[] | undefined) ?? ['project', 'epic', 'task', 'note'];
  const limit = (args.limit as number) ?? 20;
  const pattern = `%${query}%`;

  const results: Record<string, unknown[]> = {};

  if (entityTypes.includes('project')) {
    results.projects = db
      .prepare('SELECT * FROM projects WHERE name LIKE ? OR description LIKE ? LIMIT ?')
      .all(pattern, pattern, limit);
  }

  if (entityTypes.includes('epic')) {
    results.epics = db
      .prepare(
        `SELECT e.*, p.name as project_name
         FROM epics e
         JOIN projects p ON p.id = e.project_id
         WHERE e.name LIKE ? OR e.description LIKE ?
         LIMIT ?`
      )
      .all(pattern, pattern, limit);
  }

  if (entityTypes.includes('task')) {
    results.tasks = db
      .prepare(
        `SELECT t.*, e.name as epic_name
         FROM tasks t
         JOIN epics e ON e.id = t.epic_id
         WHERE t.title LIKE ? OR t.description LIKE ?
         LIMIT ?`
      )
      .all(pattern, pattern, limit);
  }

  if (entityTypes.includes('note')) {
    results.notes = db
      .prepare('SELECT * FROM notes WHERE title LIKE ? OR content LIKE ? LIMIT ?')
      .all(pattern, pattern, limit);
  }

  return results;
}

export const handlers: Record<string, ToolHandler> = {
  tracker_search: handleSearch,
};
