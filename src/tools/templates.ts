import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { tagsColumn, asTagList } from '../helpers/coerce.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'template_create',
    description:
      'Create a reusable set of tasks that can be instantiated into any epic. {variable} placeholders are filled in on apply.',
    annotations: { title: 'Create Template', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Template name (must be unique)' },
        description: { type: 'string' },
        tasks: {
          type: 'array',
          description: 'The tasks this template creates.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Task title (supports {variable} placeholders)' },
              description: { type: 'string', description: 'Task description (supports {variable} placeholders)' },
              priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
              estimated_hours: { type: 'number' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
          },
        },
      },
      required: ['name', 'tasks'],
    },
  },
  {
    name: 'template_list',
    description:
      'List task templates. Pass include_tasks to see what each one actually creates.',
    annotations: { title: 'List Templates', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        include_tasks: { type: 'boolean', description: 'Return each template\'s task definitions, not just a count.' },
      },
    },
  },
  {
    name: 'template_apply',
    description:
      'Apply a template to create tasks in an epic. Replaces {variable} placeholders with provided values.',
    annotations: { title: 'Apply Template', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'integer', description: 'Template ID to apply' },
        epic_id: { type: 'integer', description: 'Epic to create tasks in' },
        variables: {
          type: 'object',
          description: 'Key-value pairs for {variable} substitution (e.g., {"feature": "auth"})',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['template_id', 'epic_id'],
    },
  },
  {
    name: 'template_update',
    description:
      'Edit a template in place. Only the fields you pass change; tasks replace the whole list.',
    annotations: { title: 'Update Template', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Template ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        tasks: {
          type: 'array',
          description: 'Replaces every task. Omit to leave them alone. {variable} works in title and description.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
              estimated_hours: { type: 'number' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
          },
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'template_delete',
    description: 'Delete a task template.',
    annotations: { title: 'Delete Template', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Template ID' },
      },
      required: ['id'],
    },
  },
];

const PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);

/**
 * Check and normalise a template's task list.
 *
 * Templates are stored as opaque JSON, so anything wrong in here surfaces much
 * later as a confusing failure inside template_apply -- against an epic the
 * user has already chosen. Rejecting it at write time keeps the blame where
 * the mistake was made. Unknown keys are dropped rather than stored, so the
 * JSON cannot quietly accumulate fields nothing reads.
 */
function normaliseTasks(input: unknown, where: string): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) throw new Error(`${where}: tasks must be an array.`);
  if (input.length === 0) throw new Error(`${where}: a template needs at least one task.`);

  return input.map((raw, i) => {
    const at = `${where}: task ${i + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${at} is not an object.`);
    }
    const task = raw as Record<string, unknown>;
    const title = typeof task.title === 'string' ? task.title.trim() : '';
    if (!title) throw new Error(`${at} needs a title.`);

    const out: Record<string, unknown> = { title };

    if (task.description !== undefined && task.description !== null) {
      if (typeof task.description !== 'string') throw new Error(`${at}: description must be text.`);
      if (task.description.trim()) out.description = task.description;
    }
    if (task.priority !== undefined && task.priority !== null) {
      const priority = String(task.priority);
      if (!PRIORITIES.has(priority)) {
        throw new Error(`${at}: priority '${priority}' is not one of ${[...PRIORITIES].join(', ')}.`);
      }
      out.priority = priority;
    }
    if (task.estimated_hours !== undefined && task.estimated_hours !== null) {
      const hours = Number(task.estimated_hours);
      if (!Number.isFinite(hours)) throw new Error(`${at}: estimated_hours must be a number.`);
      out.estimated_hours = hours;
    }
    const tags = asTagList(task.tags);
    if (tags.length) out.tags = tags;

    return out;
  });
}

/** SQLite's UNIQUE message names a column, which is no help to the caller. */
function friendlyNameClash(err: unknown, name: string): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('UNIQUE') && message.includes('templates.name')) {
    throw new Error(`A template called '${name}' already exists. Pick another name, or edit that one with template_update.`);
  }
  throw err;
}

function substituteVariables(text: string, variables: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key) => {
    return variables[key] ?? match;
  });
}

function handleTemplateCreate(args: Record<string, unknown>) {
  const db = getDb();
  const name = args.name as string;
  const description = (args.description as string) ?? null;
  const tasks = normaliseTasks(args.tasks, `Template '${name}'`);

  const templateData = JSON.stringify(tasks);

  let template;
  try {
    template = db
      .prepare('INSERT INTO templates (name, description, template_data) VALUES (?, ?, ?) RETURNING *')
      .get(name, description, templateData);
  } catch (err) {
    friendlyNameClash(err, name);
  }

  const row = template as Record<string, unknown>;
  logActivity(db, 'template', row.id as number, 'created', null, null, null,
    `Template '${name}' created with ${tasks.length} task(s)`);

  return { ...row, tasks };
}

function handleTemplateList(args: Record<string, unknown> = {}) {
  const db = getDb();
  const templates = db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  const withTasks = args.include_tasks === true;

  return templates.map((t) => {
    const tasks = JSON.parse(t.template_data as string) as unknown[];
    // template_data is the raw JSON column; it would be sent twice otherwise.
    const { template_data, ...rest } = t;
    return withTasks
      ? { ...rest, task_count: tasks.length, tasks }
      : { ...rest, task_count: tasks.length };
  });
}

/**
 * Edit a template in place.
 *
 * Until now the only way to change one was template_delete followed by
 * template_create (#44), which loses the id -- so anything referring to the
 * template by id breaks, and the activity log shows a deletion rather than an
 * edit. Only the fields passed are touched; tasks replace the whole list,
 * since a partial merge into an ordered array has no obvious meaning.
 */
function handleTemplateUpdate(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const existing = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) throw new Error(`Template ${id} not found`);

  const sets: string[] = [];
  const params: unknown[] = [];
  const changed: string[] = [];

  const name = args.name === undefined ? (existing.name as string) : String(args.name).trim();
  if (args.name !== undefined) {
    if (!name) throw new Error('Template name cannot be empty.');
    sets.push('name = ?');
    params.push(name);
    changed.push('name');
  }
  if (args.description !== undefined) {
    sets.push('description = ?');
    params.push(args.description === null ? null : String(args.description));
    changed.push('description');
  }
  if (args.tasks !== undefined) {
    const tasks = normaliseTasks(args.tasks, `Template '${name}'`);
    sets.push('template_data = ?');
    params.push(JSON.stringify(tasks));
    changed.push(`tasks (${tasks.length})`);
  }

  if (!sets.length) {
    throw new Error('Nothing to update. Pass name, description or tasks.');
  }

  // The column has always existed; nothing ever wrote it, because there was no
  // way to edit a template at all.
  sets.push("updated_at = datetime('now')");

  let row;
  try {
    row = db
      .prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
      .get(...params, id) as Record<string, unknown>;
  } catch (err) {
    friendlyNameClash(err, name);
  }

  const updated = row as Record<string, unknown>;
  logActivity(db, 'template', id, 'updated', null, null, null,
    `Template '${updated.name}' updated: ${changed.join(', ')}`);

  const { template_data, ...rest } = updated;
  return { ...rest, tasks: JSON.parse(template_data as string) };
}

function handleTemplateApply(args: Record<string, unknown>) {
  const db = getDb();
  const templateId = args.template_id as number;
  const epicId = args.epic_id as number;
  const variables = (args.variables as Record<string, string>) ?? {};

  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId) as Record<string, unknown> | undefined;
  if (!template) throw new Error(`Template ${templateId} not found`);

  const epic = db.prepare('SELECT id, name FROM epics WHERE id = ?').get(epicId) as { id: number; name: string } | undefined;
  if (!epic) throw new Error(`Epic ${epicId} not found`);

  const taskDefs = JSON.parse(template.template_data as string) as Array<Record<string, unknown>>;

  const createdTasks = db.transaction(() => {
    return taskDefs.map((taskDef) => {
      const title = substituteVariables(taskDef.title as string, variables);
      const description = taskDef.description
        ? substituteVariables(taskDef.description as string, variables)
        : null;
      const priority = (taskDef.priority as string) ?? 'medium';
      const estimatedHours = (taskDef.estimated_hours as number) ?? null;
      const tags = tagsColumn(taskDef.tags);

      const task = db.prepare(
        `INSERT INTO tasks (epic_id, title, description, priority, estimated_hours, tags)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
      ).get(epicId, title, description, priority, estimatedHours, tags);

      const row = task as Record<string, unknown>;
      logActivity(db, 'task', row.id as number, 'created', null, null, null,
        `Task '${title}' created from template '${template.name}'`);

      return task;
    });
  })();

  return {
    message: `Applied template '${template.name}' to epic '${epic.name}'`,
    template_name: template.name,
    epic_name: epic.name,
    tasks_created: createdTasks.length,
    tasks: createdTasks,
  };
}

function handleTemplateDelete(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!template) throw new Error(`Template ${id} not found`);

  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  logActivity(db, 'template', id, 'deleted', null, null, null,
    `Template '${template.name}' deleted`);

  return { message: `Template '${template.name}' deleted` };
}

export const handlers: Record<string, ToolHandler> = {
  template_create: handleTemplateCreate,
  template_update: handleTemplateUpdate,
  template_list: handleTemplateList,
  template_apply: handleTemplateApply,
  template_delete: handleTemplateDelete,
};
