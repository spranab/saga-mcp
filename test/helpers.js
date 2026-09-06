import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Each test file gets its own database in its own temp directory. `node --test`
 * runs one process per file, so the module-level connection in db.js stays
 * isolated between files.
 */
export function tempDbPath(name = 'saga-test') {
  const dir = mkdtempSync(join(tmpdir(), name + '-'));
  const path = join(dir, '.tracker.db');
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS will clean the temp dir up eventually */
    }
  });
  return path;
}

/** Import the built tool handlers against a given database. */
export async function loadTools(dbPath) {
  process.env.DB_PATH = dbPath;
  const load = (m) => import('../dist/tools/' + m + '.js');
  const [projects, epics, tasks, subtasks, notes, comments, dashboard, activity, templates, search, exportImport, next] =
    await Promise.all([
      load('projects'), load('epics'), load('tasks'), load('subtasks'), load('notes'),
      load('comments'), load('dashboard'), load('activity'), load('templates'),
      load('search'), load('export-import'), load('next'), load('next'),
    ]);
  return {
    ...projects.handlers, ...epics.handlers, ...tasks.handlers, ...subtasks.handlers,
    ...notes.handlers, ...comments.handlers, ...dashboard.handlers, ...activity.handlers,
    ...templates.handlers, ...search.handlers, ...exportImport.handlers, ...next.handlers,
  };
}

/** Every tool definition the server knows about. */
export async function loadDefinitions() {
  const mods = ['projects', 'epics', 'tasks', 'subtasks', 'notes', 'comments',
                'templates', 'dashboard', 'search', 'activity', 'export-import', 'next'];
  const out = [];
  for (const m of mods) out.push(...(await import('../dist/tools/' + m + '.js')).definitions);
  return out;
}

/**
 * A small but realistic project: 2 epics, 6 tasks across every status,
 * subtasks, comments and a note.
 */
export function seed(t, opts = {}) {
  const longDescription = opts.longDescription ?? false;
  const project = t.project_create({ name: 'Payments', description: 'Billing and reconciliation.' });
  const billing = t.epic_create({
    project_id: project.id, name: 'Billing core', status: 'in_progress', priority: 'high',
  });
  const reporting = t.epic_create({ project_id: project.id, name: 'Reporting', priority: 'low' });

  const statuses = ['todo', 'in_progress', 'review', 'done', 'blocked', 'todo'];
  const tasks = statuses.map((status, i) =>
    t.task_create({
      epic_id: i % 2 === 0 ? billing.id : reporting.id,
      title: `Task ${i + 1}: the ${['charge', 'refund', 'webhook', 'ledger', 'export', 'retry'][i]} path`,
      description: longDescription
        ? 'Walk the settlement file, match each line against the ledger by provider reference, ' +
          'flag anything past the tolerance threshold, and write an exception row for review. ' +
          'Must be idempotent so a re-run after a partial failure does not double-post.'
        : 'Short note.',
      status,
      priority: ['low', 'medium', 'high', 'critical'][i % 4],
      estimated_hours: i + 1,
    })
  );

  t.subtask_create({ task_id: tasks[0].id, titles: ['Write it', 'Test it', 'Document it'] });
  const keeper = t.comment_add({ task_id: tasks[0].id, content: 'Provider needs an idempotency key.', author: 'agent' });
  const doomed = t.comment_add({ task_id: tasks[0].id, content: 'This API does not exist.', author: 'agent' });
  t.note_save({
    title: 'Scope decision', content: 'Chose A over B: one fewer round trip.',
    note_type: 'decision', related_entity_type: 'project', related_entity_id: project.id,
  });

  return { project, epics: { billing, reporting }, tasks, comments: { keeper, doomed } };
}
