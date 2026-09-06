import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { resolveProjectId, PROJECT_ID_SCHEMA } from '../helpers/project-scope.js';
import { resolveBranch } from '../helpers/git.js';
import { slimListRow } from '../helpers/slim.js';
import type { ToolHandler } from '../types.js';

/**
 * "What should I work on?" — the question the tracker implied but never
 * answered.
 *
 * tracker_dashboard hands an agent everything and leaves it to reason, which
 * costs about 1,300 tokens and a round of thinking before any work starts.
 * Every input needed to answer directly already exists: dependencies, blocked
 * state, priority, due dates and manual order. This just applies them.
 *
 * When nothing is actionable that is the more useful answer, so it says what
 * is in the way rather than returning an empty result.
 */

export const definitions: Tool[] = [
  {
    name: 'tracker_next',
    description:
      'What to work on next: one recommended task with the reason, its next unfinished subtask, alternatives, and — when nothing is actionable — what to unblock. Call it when resuming work; cheaper than tracker_dashboard.',
    annotations: { title: 'What Next', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID_SCHEMA,
        assigned_to: { type: 'string', description: 'Only consider tasks assigned to this person' },
        branch: { type: 'string', description: 'Git branch filter: "current" = active branch, omit = all.' },
      },
    },
  },
];

interface Candidate extends Record<string, unknown> {
  id: number;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  sort_order: number;
  epic_id: number;
  epic_name: string;
  epic_status: string;
  epic_sort: number;
  open_subtasks: number;
}

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * The ordering, most significant first. Continuing beats starting: an agent
 * resuming should finish what it left open rather than opening something new,
 * which is the failure this tool exists to prevent.
 */
function rank(task: Candidate, today: string): number[] {
  const started = task.status === 'in_progress' ? 0 : task.status === 'review' ? 1 : 2;
  const overdue = task.due_date && task.due_date < today ? 0 : 1;
  const activeEpic = task.epic_status === 'in_progress' ? 0 : 1;
  return [
    started,
    overdue,
    activeEpic,
    PRIORITY_RANK[task.priority] ?? 2,
    task.due_date ? 0 : 1,
    task.epic_sort,
    task.sort_order,
    task.id,
  ];
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** A short sentence saying why this one, in the terms that actually decided it. */
function explain(task: Candidate, today: string): string {
  const parts: string[] = [];
  if (task.status === 'in_progress') parts.push('already in progress');
  else if (task.status === 'review') parts.push('waiting on review');
  if (task.due_date && task.due_date < today) parts.push(`overdue since ${task.due_date}`);
  else if (task.due_date) parts.push(`due ${task.due_date}`);
  if (task.priority === 'critical' || task.priority === 'high') parts.push(`${task.priority} priority`);
  if (task.epic_status === 'in_progress') parts.push(`in the active epic '${task.epic_name}'`);
  if (parts.length === 0) parts.push(`next in '${task.epic_name}'`);
  return parts.join(', ');
}

function handleNext(args: Record<string, unknown>) {
  const db = getDb();
  const projectId = resolveProjectId(db, args);
  const assignedTo = args.assigned_to as string | undefined;
  const branchFilter = resolveBranch(args.branch);
  const today = new Date().toISOString().slice(0, 10);

  const where: string[] = ["t.is_deleted = 0", "e.archived = 0", "t.status != 'done'"];
  const params: unknown[] = [];
  if (projectId !== undefined) {
    where.push('e.project_id = ?');
    params.push(projectId);
  }
  if (assignedTo) {
    where.push('t.assigned_to = ?');
    params.push(assignedTo);
  }
  if (branchFilter === null) where.push('e.branch IS NULL');
  else if (branchFilter !== undefined) {
    where.push('e.branch = ?');
    params.push(branchFilter);
  }

  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.priority, t.due_date, t.sort_order, t.assigned_to,
              t.epic_id, e.name as epic_name, e.status as epic_status, e.sort_order as epic_sort,
              (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status != 'done') as open_subtasks
       FROM tasks t JOIN epics e ON e.id = t.epic_id
       WHERE ${where.join(' AND ')}`
    )
    .all(...params) as Candidate[];

  // A task is out of the running if something it depends on is unfinished.
  const unmet = db.prepare(
    `SELECT d.task_id, t.id, t.title, t.status FROM task_dependencies d
     JOIN tasks t ON t.id = d.depends_on_task_id
     WHERE t.status != 'done' AND t.is_deleted = 0`
  ).all() as Array<{ task_id: number; id: number; title: string; status: string }>;

  const blockers = new Map<number, Array<{ id: number; title: string; status: string }>>();
  for (const row of unmet) {
    blockers.set(row.task_id, [...(blockers.get(row.task_id) ?? []), { id: row.id, title: row.title, status: row.status }]);
  }

  const actionable = rows.filter((t) => !blockers.has(t.id));
  const blocked = rows
    .filter((t) => blockers.has(t.id))
    .map((t) => ({ id: t.id, title: t.title, waiting_on: blockers.get(t.id) }));

  if (actionable.length === 0) {
    if (rows.length === 0) {
      return {
        summary: 'Nothing left to do — every task is done, removed, or in an archived epic.',
        task: null,
      };
    }
    // Everything remaining is blocked, so the useful answer is what to unblock.
    const counts = new Map<number, { title: string; blocking: number }>();
    for (const item of blocked) {
      for (const b of item.waiting_on ?? []) {
        const seen = counts.get(b.id) ?? { title: b.title, blocking: 0 };
        seen.blocking += 1;
        counts.set(b.id, seen);
      }
    }
    const worst = [...counts.entries()].sort((a, b) => b[1].blocking - a[1].blocking)[0];
    return {
      summary:
        `Nothing is actionable: all ${blocked.length} remaining task(s) are blocked. ` +
        (worst ? `Unblocking #${worst[0]} '${worst[1].title}' would release ${worst[1].blocking} of them.` : ''),
      task: null,
      blocked,
    };
  }

  const ordered = [...actionable].sort((a, b) => compare(rank(a, today), rank(b, today)));
  const pick = ordered[0];

  // The next thing to do *inside* the task, respecting subtask dependencies.
  const nextSubtask = db
    .prepare(
      `SELECT s.id, s.title, s.status FROM subtasks s
       WHERE s.task_id = ? AND s.status != 'done'
         AND NOT EXISTS (
           SELECT 1 FROM subtask_dependencies d
           JOIN subtasks b ON b.id = d.depends_on_subtask_id
           WHERE d.subtask_id = s.id AND b.status != 'done')
       ORDER BY s.sort_order, s.id LIMIT 1`
    )
    .get(pick.id) as { id: number; title: string; status: string } | undefined;

  // Continuing beats starting, so an in-progress task outranks an overdue one
  // that has not been touched — abandoning work in flight just leaves two
  // things unfinished. But the agent should still hear about the overdue work
  // rather than having to go looking for it.
  const overdueElsewhere = ordered
    .slice(1)
    .filter((t) => t.due_date && t.due_date < today);

  const summary =
    `Work on #${pick.id} '${pick.title}' — ${explain(pick, today)}.` +
    (nextSubtask ? ` Next step: ${nextSubtask.title}.` : '') +
    (overdueElsewhere.length > 0
      ? ` Also overdue: ${overdueElsewhere.slice(0, 3).map((t) => `#${t.id} '${t.title}'`).join(', ')}.`
      : '') +
    (blocked.length > 0 ? ` ${blocked.length} other task(s) are blocked.` : '');

  return {
    summary,
    task: slimListRow(pick as Record<string, unknown>),
    reason: explain(pick, today),
    ...(nextSubtask ? { next_subtask: nextSubtask } : {}),
    ...(pick.open_subtasks > 0 ? { open_subtasks: pick.open_subtasks } : {}),
    alternatives: ordered.slice(1, 4).map((t) => ({
      id: t.id,
      title: t.title,
      why_not_first: explain(t, today),
    })),
    ...(overdueElsewhere.length > 0
      ? { overdue: overdueElsewhere.map((t) => ({ id: t.id, title: t.title, due_date: t.due_date })) }
      : {}),
    ...(blocked.length > 0 ? { blocked } : {}),
  };
}

export const handlers: Record<string, ToolHandler> = {
  tracker_next: handleNext,
};
