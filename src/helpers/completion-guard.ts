import type Database from 'better-sqlite3';

/**
 * A dependency that does not actually stop anything is decoration.
 *
 * v1.8.0 computed `blocked` on read and never consulted it on write, so an
 * agent could move a blocked subtask straight to in_progress or done and the
 * dependency it was told about changed nothing (#26).
 *
 * The rule these helpers enforce: forward progress past an unmet prerequisite
 * is refused, and the refusal names what is in the way. It is not absolute —
 * a person genuinely does sometimes know the blocker no longer matters — so
 * `force` is the documented escape hatch. The difference that matters is
 * between an agent silently ignoring a blocker and someone deciding to
 * override one, and `force` makes that difference visible and loggable.
 */

/** Statuses that mean "this has been started or finished". Going back to todo is always fine. */
const FORWARD_SUBTASK_STATUSES = new Set(['in_progress', 'done']);

export interface Blocker {
  id: number;
  title: string;
  status: string;
}

export function unmetSubtaskBlockers(db: Database.Database, subtaskId: number): Blocker[] {
  return db
    .prepare(
      `SELECT s.id, s.title, s.status FROM subtask_dependencies d
       JOIN subtasks s ON s.id = d.depends_on_subtask_id
       WHERE d.subtask_id = ? AND s.status != 'done'
       ORDER BY s.sort_order, s.id`
    )
    .all(subtaskId) as Blocker[];
}

export function unfinishedSubtasks(db: Database.Database, taskId: number): Blocker[] {
  return db
    .prepare(
      `SELECT id, title, status FROM subtasks
       WHERE task_id = ? AND status != 'done'
       ORDER BY sort_order, id`
    )
    .all(taskId) as Blocker[];
}

function list(rows: Blocker[]): string {
  return rows.map((r) => `#${r.id} '${r.title}' (${r.status})`).join(', ');
}

/**
 * Refuse to start or finish a subtask whose prerequisites are unmet.
 * Returns the blockers that were overridden, so the caller can log the override.
 */
export function guardSubtaskStatus(
  db: Database.Database,
  subtaskId: number,
  nextStatus: unknown,
  force: boolean
): Blocker[] {
  if (typeof nextStatus !== 'string' || !FORWARD_SUBTASK_STATUSES.has(nextStatus)) return [];

  const blockers = unmetSubtaskBlockers(db, subtaskId);
  if (blockers.length === 0) return [];
  if (force) return blockers;

  const verb = nextStatus === 'done' ? 'completed' : 'started';
  throw new Error(
    `Subtask ${subtaskId} cannot be ${verb} — it waits on ${list(blockers)}. ` +
      'Finish those first, or pass force: true to override deliberately (the override is logged).'
  );
}

/**
 * Refuse to mark a task done while its checklist is unfinished.
 * Returns the items that were overridden, so the caller can log the override.
 */
export function guardTaskDone(
  db: Database.Database,
  taskId: number,
  nextStatus: unknown,
  force: boolean
): Blocker[] {
  if (nextStatus !== 'done') return [];

  const open = unfinishedSubtasks(db, taskId);
  if (open.length === 0) return [];
  if (force) return open;

  throw new Error(
    `Task ${taskId} cannot be completed — ${open.length} subtask(s) are unfinished: ${list(open)}. ` +
      'Finish or delete them, or pass force: true to override deliberately (the override is logged).'
  );
}

/** Shared schema fragment, so every guarded tool documents the escape hatch identically. */
export const FORCE_SCHEMA = {
  type: 'boolean' as const,
  default: false,
  description:
    'Proceed despite unmet prerequisites. Only when a human says the blocker no longer applies, never on your own initiative. Logged.',
};
