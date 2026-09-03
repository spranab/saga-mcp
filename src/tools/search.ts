import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { resolveBranch } from '../helpers/git.js';
import { resolveProjectId, noteScopeClause, repeatId, PROJECT_ID_SCHEMA } from '../helpers/project-scope.js';
import { slimList } from '../helpers/slim.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'tracker_search',
    description:
      'Search projects, epics, tasks and notes by keyword. Returns categorized previews — use task_get or note_list for full text.',
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
        project_id: PROJECT_ID_SCHEMA,
        branch: {
          type: 'string',
          description: 'Git branch filter: "current" = active branch, "" = branch-agnostic only, omit = all.',
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
  const branchFilter = resolveBranch(args.branch);

  let epicBranchClause = '';
  let taskBranchClause = '';
  const epicBranchParams: unknown[] = [];
  const taskBranchParams: unknown[] = [];
  if (branchFilter === null) {
    epicBranchClause = ' AND e.branch IS NULL';
    taskBranchClause = ' AND e.branch IS NULL';
  } else if (branchFilter !== undefined) {
    epicBranchClause = ' AND e.branch = ?';
    taskBranchClause = ' AND e.branch = ?';
    epicBranchParams.push(branchFilter);
    taskBranchParams.push(branchFilter);
  }

  const projectId = resolveProjectId(db, args);
  if (projectId !== undefined) {
    epicBranchClause += ' AND e.project_id = ?';
    epicBranchParams.push(projectId);
    taskBranchClause += ' AND e.project_id = ?';
    taskBranchParams.push(projectId);
  }

  // Search results are a shortlist to pick from, not the content itself — slim
  // the rows and preview long text. Follow up with task_get / note_list.
  const rows = (r: unknown[], truncate: string[] = ['description']) =>
    slimList(r as Array<Record<string, unknown>>, truncate);

  const results: Record<string, unknown[]> = {};

  if (entityTypes.includes('project')) {
    results.projects = rows(
      projectId !== undefined
        ? db.prepare('SELECT id, name, description, status FROM projects WHERE id = ? AND (name LIKE ? OR description LIKE ?) LIMIT ?')
            .all(projectId, pattern, pattern, limit)
        : db.prepare('SELECT id, name, description, status FROM projects WHERE name LIKE ? OR description LIKE ? LIMIT ?')
            .all(pattern, pattern, limit)
    );
  }

  if (entityTypes.includes('epic')) {
    results.epics = rows(db
      .prepare(
        `SELECT e.id, e.project_id, e.name, e.description, e.status, e.priority, e.branch, p.name as project_name
         FROM epics e
         JOIN projects p ON p.id = e.project_id
         WHERE (e.name LIKE ? OR e.description LIKE ?)${epicBranchClause}
         LIMIT ?`
      )
      .all(pattern, pattern, ...epicBranchParams, limit));
  }

  if (entityTypes.includes('task')) {
    results.tasks = rows(db
      .prepare(
        `SELECT t.id, t.epic_id, t.title, t.description, t.status, t.priority, t.assigned_to, t.due_date, e.name as epic_name
         FROM tasks t
         JOIN epics e ON e.id = t.epic_id
         WHERE (t.title LIKE ? OR t.description LIKE ?)${taskBranchClause}
         LIMIT ?`
      )
      .all(pattern, pattern, ...taskBranchParams, limit));
  }

  if (entityTypes.includes('note')) {
    if (projectId !== undefined) {
      const scope = noteScopeClause('notes');
      results.notes = rows(db
        .prepare(`SELECT id, title, content, note_type, related_entity_type, related_entity_id, created_at
                  FROM notes WHERE (title LIKE ? OR content LIKE ?) AND ${scope.sql} LIMIT ?`)
        .all(pattern, pattern, ...repeatId(projectId, scope.paramCount), limit), ['content']);
    } else {
      results.notes = rows(db
        .prepare(`SELECT id, title, content, note_type, related_entity_type, related_entity_id, created_at
                  FROM notes WHERE title LIKE ? OR content LIKE ? LIMIT ?`)
        .all(pattern, pattern, limit), ['content']);
    }
  }

  return results;
}

export const handlers: Record<string, ToolHandler> = {
  tracker_search: handleSearch,
};
