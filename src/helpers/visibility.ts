/**
 * What a listing shows by default.
 *
 * #30: after a while the epic list is mostly finished work, and agents leave
 * behind tasks that should have been subtasks. Both are noise an agent pays
 * for on every call, so both can be put out of sight without being destroyed.
 *
 * Two separate ideas, deliberately not merged into one:
 *
 *   epics.archived   — "stop showing me this". Distinct from the `cancelled`
 *                      status, which means "we decided not to do it": most of
 *                      what you want to archive is *completed*, and overloading
 *                      the status would make that impossible to say.
 *   tasks.is_deleted — the same soft delete comments already have. Restricted
 *                      to `todo` tasks, because a task with real history has an
 *                      activity log that deleting it would orphan.
 *
 * Nothing is hidden silently: the dashboard reports how much it left out.
 */

/** SQL fragment hiding archived epics, given the alias the caller used. */
export function liveEpicClause(alias = 'e'): string {
  return `${alias}.archived = 0`;
}

/**
 * SQL fragment hiding removed tasks, and tasks belonging to an archived epic —
 * an epic you have put away should not keep sending its tasks to the model.
 */
export function liveTaskClause(taskAlias = 't', epicAlias = 'e'): string {
  return `${taskAlias}.is_deleted = 0 AND ${epicAlias}.archived = 0`;
}

/** Whether a caller asked to see hidden rows. Accepts the usual truthy shapes. */
export function wantsHidden(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/** Shared schema fragments, so every tool documents these identically. */
export const INCLUDE_ARCHIVED_SCHEMA = {
  type: 'boolean' as const,
  default: false,
  description: 'Include archived epics and their tasks.',
};

export const INCLUDE_DELETED_TASKS_SCHEMA = {
  type: 'boolean' as const,
  default: false,
  description: 'Include removed tasks.',
};
