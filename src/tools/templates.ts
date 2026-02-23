import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'template_create',
    description:
      'Create a reusable task template. Templates define a set of tasks that can be instantiated into any epic. Use {variable} placeholders for dynamic values.',
    annotations: { title: 'Create Template', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Template name (must be unique)' },
        description: { type: 'string', description: 'Template description' },
        tasks: {
          type: 'array',
          description: 'Task definitions. Use {variable} for placeholders.',
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
    description: 'List all available task templates.',
    annotations: { title: 'List Templates', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {},
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

function substituteVariables(text: string, variables: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key) => {
    return variables[key] ?? match;
  });
}

function handleTemplateCreate(args: Record<string, unknown>) {
  const db = getDb();
  const name = args.name as string;
  const description = (args.description as string) ?? null;
  const tasks = args.tasks as Array<Record<string, unknown>>;

  const templateData = JSON.stringify(tasks);

  const template = db
    .prepare('INSERT INTO templates (name, description, template_data) VALUES (?, ?, ?) RETURNING *')
    .get(name, description, templateData);

  const row = template as Record<string, unknown>;
  logActivity(db, 'template', row.id as number, 'created', null, null, null,
    `Template '${name}' created with ${tasks.length} task(s)`);

  return { ...row, tasks };
}

function handleTemplateList() {
  const db = getDb();
  const templates = db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;

  return templates.map((t) => ({
    ...t,
    task_count: (JSON.parse(t.template_data as string) as unknown[]).length,
  }));
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
      const tags = JSON.stringify((taskDef.tags as string[]) ?? []);

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
  template_list: handleTemplateList,
  template_apply: handleTemplateApply,
  template_delete: handleTemplateDelete,
};
