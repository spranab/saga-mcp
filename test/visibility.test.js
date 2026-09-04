import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';

/**
 * #30: an epic list that is mostly finished work, and tasks an agent created
 * that should have been subtasks, are both context the caller pays for on every
 * call. Archiving and soft delete put them out of sight without destroying
 * them — and, importantly, without hiding the fact that something was hidden.
 */
const t = await loadTools(tempDbPath('saga-visibility'));
const project = t.project_create({ name: 'P' });
const live = t.epic_create({ project_id: project.id, name: 'Active epic', status: 'in_progress' });
const old = t.epic_create({ project_id: project.id, name: 'Finished epic', status: 'completed' });

const liveTask = t.task_create({ epic_id: live.id, title: 'live task' });
const clutter = t.task_create({ epic_id: live.id, title: 'clutter task' });
t.task_create({ epic_id: old.id, title: 'old task' });
t.task_create({ epic_id: old.id, title: 'old blocked task', status: 'blocked' });

/* ---------- archiving an epic ---------- */

test('archiving is separate from cancelling', () => {
  // A completed epic is the common case for archiving, which overloading the
  // status could not express.
  const res = t.epic_archive({ id: old.id });
  assert.match(res.message, /archived/);
  assert.equal(res.epic.status, 'completed', 'the status is untouched');
  assert.equal(res.epic.archived, 1);
});

test('it says how much it just hid', () => {
  t.epic_archive({ id: old.id, archived: false });
  const res = t.epic_archive({ id: old.id });
  assert.match(res.message, /2 task\(s\) are hidden/);
});

test('epic_list hides it, include_archived brings it back', () => {
  assert.equal(t.epic_list({ project_id: project.id }).length, 1);
  assert.equal(t.epic_list({ project_id: project.id, include_archived: true }).length, 2);
});

test('the dashboard drops the epic and its tasks from the numbers', () => {
  const d = t.tracker_dashboard({ project_id: project.id });
  assert.equal(d.stats.total_epics, 1);
  assert.equal(d.stats.total_tasks, 2, 'the archived epic contributes nothing');
});

test('but the dashboard says what it left out, rather than quietly shrinking', () => {
  const d = t.tracker_dashboard({ project_id: project.id });
  assert.match(d.summary, /1 archived epic/);
  assert.match(d.summary, /include_archived/);
  assert.equal(d.archived_epic_count, 1);
});

test('a blocked task inside an archived epic stops nagging', () => {
  assert.equal(t.tracker_dashboard({ project_id: project.id }).blocked_tasks.length, 0);
});

test('task_list hides tasks belonging to an archived epic', () => {
  // Hiding the epic but still listing its tasks would defeat the purpose.
  assert.equal(t.task_list({ limit: 20 }).length, 2);
  assert.equal(t.task_list({ limit: 20, include_archived: true }).length, 4);
});

test('search hides them too', () => {
  assert.ok(!JSON.stringify(t.tracker_search({ query: 'old' })).includes('old task'));
  assert.ok(JSON.stringify(t.tracker_search({ query: 'old', include_archived: true })).includes('old task'));
});

test('unarchiving restores everything, and both directions are idempotent', () => {
  t.epic_archive({ id: old.id, archived: false });
  assert.equal(t.epic_list({ project_id: project.id }).length, 2);
  assert.match(t.epic_archive({ id: old.id, archived: false }).message, /already active/);
  t.epic_archive({ id: old.id });
  assert.match(t.epic_archive({ id: old.id }).message, /already archived/);
});

test('archiving is logged', () => {
  const log = JSON.stringify(t.activity_log({ entity_type: 'epic', entity_id: old.id, limit: 20 }));
  assert.match(log, /archived/);
});

/* ---------- removing a todo task ---------- */

test('a todo task can be removed, and the row is kept', () => {
  const res = t.task_delete({ id: clutter.id, reason: 'should have been a subtask', deleted_by: 'human' });
  assert.equal(res.task.is_deleted, 1);
  assert.equal(res.task.delete_reason, 'should have been a subtask');
  assert.equal(res.task.title, 'clutter task', 'the content survives for the audit trail');
});

test('it drops out of listings, the dashboard and search', () => {
  assert.ok(!t.task_list({ limit: 20 }).some((r) => r.id === clutter.id));
  assert.equal(t.tracker_dashboard({ project_id: project.id }).stats.total_tasks, 1);
  assert.ok(!JSON.stringify(t.tracker_search({ query: 'clutter' })).includes('clutter task'));
});

test('the dashboard reports the removal rather than hiding it', () => {
  assert.equal(t.tracker_dashboard({ project_id: project.id }).removed_task_count, 1);
});

test('include_deleted shows it, and task_get always does', () => {
  assert.ok(t.task_list({ limit: 20, include_deleted: true }).some((r) => r.id === clutter.id));
  assert.equal(t.task_get({ id: clutter.id }).is_deleted, 1, 'so it can be reviewed before restoring');
});

test('restore clears every removal field', () => {
  const res = t.task_restore({ id: clutter.id });
  assert.equal(res.task.is_deleted, 0);
  assert.equal(res.task.deleted_at, null);
  assert.equal(res.task.deleted_by, null);
  assert.equal(res.task.delete_reason, null);
});

test('both directions are idempotent', () => {
  assert.match(t.task_restore({ id: clutter.id }).message, /not removed/);
  t.task_delete({ id: clutter.id });
  assert.match(t.task_delete({ id: clutter.id }).message, /already removed/);
  t.task_restore({ id: clutter.id });
});

/* ---------- the guards ---------- */

test('only a todo task can be removed', () => {
  // Work that has started has comments, time tracking and an activity log that
  // removing the task would strand.
  t.task_update({ id: liveTask.id, status: 'in_progress' });
  assert.throws(() => t.task_delete({ id: liveTask.id }), /not 'todo'/);
  assert.throws(() => t.task_delete({ id: liveTask.id }), /history worth keeping/);
  t.task_update({ id: liveTask.id, status: 'todo' });
});

test('a task others depend on cannot be removed', () => {
  const blocker = t.task_create({ epic_id: live.id, title: 'blocker' });
  const waiter = t.task_create({ epic_id: live.id, title: 'waiter', depends_on: [blocker.id] });
  assert.throws(() => t.task_delete({ id: blocker.id }), /depends? on it/);
  assert.throws(() => t.task_delete({ id: blocker.id }), new RegExp('#' + waiter.id));
});

test('a missing id is an error for both operations', () => {
  assert.throws(() => t.task_delete({ id: 999999 }), /not found/);
  assert.throws(() => t.task_restore({ id: 999999 }), /not found/);
  assert.throws(() => t.epic_archive({ id: 999999 }), /not found/);
});

/* ---------- nothing is lost ---------- */

test('export keeps archived epics and removed tasks — it is a backup', () => {
  t.task_delete({ id: clutter.id, reason: 'clutter' });
  const dump = JSON.stringify(t.tracker_export({ project_id: project.id }));
  assert.ok(dump.includes('Finished epic'), 'the archived epic must be in the backup');
  assert.ok(dump.includes('clutter task'), 'the removed task must be in the backup');
  t.task_restore({ id: clutter.id });
});

test('the flags cost nothing in list rows while they are off', () => {
  const rows = t.task_list({ limit: 20 });
  assert.ok(rows.every((r) => !('is_deleted' in r)));
  const epics = t.epic_list({ project_id: project.id });
  assert.ok(epics.every((e) => !('archived' in e)));
});
