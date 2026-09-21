import type Database from 'better-sqlite3';
import { logActivity } from './activity-logger.js';

/**
 * #53, asked for by @rusak47 as a follow-up to #19: the per-task description
 * lock works, but locking each task by hand does not scale across a plan.
 *
 * `SAGA_DESCRIPTION_LOCK=on_progress` locks a task's description at the moment
 * work starts on it — the moment the description stops being a plan and starts
 * being the record of what was agreed. It is off by default: turning it on
 * changes what an agent is allowed to do, and that is the user's call rather
 * than a new default for everybody.
 *
 * Deliberately *not* a rule evaluated on every write. It sets the same
 * `description_locked` flag a person sets by hand, so one mechanism governs the
 * field: the toggle in the web UI still works, `task_lock_description` still
 * unlocks it, and an unlock is not quietly undone by the next status change. A
 * rule would need a third state to express "locked by the rule, but unlocked by
 * a person", and the person would lose that argument every time.
 */

export type DescriptionLockMode = 'off' | 'on_progress';

/** Values that plainly mean "yes" — the issue itself proposed `=true`. */
const ON = new Set(['on_progress', 'on-progress', 'true', '1', 'on', 'yes']);
const OFF = new Set(['', 'off', 'false', '0', 'no']);

let warned = false;

export function descriptionLockMode(): DescriptionLockMode {
  const raw = (process.env.SAGA_DESCRIPTION_LOCK ?? '').trim().toLowerCase();
  if (OFF.has(raw)) return 'off';
  if (ON.has(raw)) return 'on_progress';
  if (!warned) {
    warned = true;
    // Same as an unknown SAGA_TOOLS: say so and carry on with the safe default,
    // rather than enforcing something the user did not ask for.
    console.error(
      `Unknown SAGA_DESCRIPTION_LOCK value "${raw}". Expected "on_progress" or "off"; leaving it off.`
    );
  }
  return 'off';
}

/**
 * Statuses that mean somebody has picked the task up. `blocked` is not one:
 * a task waiting on a dependency has not been worked on, and dependency
 * evaluation moves tasks in and out of that status by itself.
 */
const WORK_STARTED = new Set(['in_progress', 'review', 'done']);

/**
 * Does this status change start work on the task? `from` is undefined when the
 * task is being created — one created straight into `in_progress` has started
 * as surely as one moved there.
 */
export function startsWork(from: string | undefined, to: unknown): boolean {
  if (descriptionLockMode() !== 'on_progress') return false;
  if (typeof to !== 'string' || !WORK_STARTED.has(to)) return false;
  return from === undefined || !WORK_STARTED.has(from);
}

/**
 * Lock the description because work just started, and say so in the log. Never
 * touches a task that is already locked, so the reason on record stays the
 * first one.
 */
export function lockOnProgress(
  db: Database.Database,
  taskId: number,
  title: string,
  from: string | undefined,
  to: unknown
): boolean {
  if (!startsWork(from, to)) return false;
  const row = db.prepare('SELECT description_locked FROM tasks WHERE id = ?').get(taskId) as
    | { description_locked: number }
    | undefined;
  if (!row || row.description_locked) return false;
  db.prepare("UPDATE tasks SET description_locked = 1, updated_at = datetime('now') WHERE id = ?").run(taskId);
  logActivity(
    db, 'task', taskId, 'updated', 'description_locked', '0', '1',
    `Task '${title}' description locked: work started (SAGA_DESCRIPTION_LOCK=on_progress)`
  );
  return true;
}
