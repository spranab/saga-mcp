import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';

/**
 * #26: v1.8.0 computed `blocked` on read and never consulted it on write, so a
 * dependency stopped nothing. These tests pin the rule that forward progress
 * past an unmet prerequisite is refused, and that `force` is the only way past.
 */
const t = await loadTools(tempDbPath('saga-guards'));
const project = t.project_create({ name: 'P' });
const epic = t.epic_create({ project_id: project.id, name: 'E' });

function taskWithBlockedSubtask() {
  const task = t.task_create({ epic_id: epic.id, title: 'T' + Math.random() });
  const [first, second] = t.subtask_create({ task_id: task.id, titles: ['first', 'second'] });
  t.subtask_update({ id: second.id, depends_on: [first.id] });
  return { task, first, second };
}
const statusOf = (taskId, subId) =>
  t.task_get({ id: taskId }).subtasks.find((s) => s.id === subId).status;

/* ---------- subtasks ---------- */

test('a blocked subtask cannot be started', () => {
  const { task, second } = taskWithBlockedSubtask();
  assert.throws(() => t.subtask_update({ id: second.id, status: 'in_progress' }), /waits on/);
  assert.equal(statusOf(task.id, second.id), 'todo', 'status must not change');
});

test('a blocked subtask cannot be completed either', () => {
  const { task, second } = taskWithBlockedSubtask();
  assert.throws(() => t.subtask_update({ id: second.id, status: 'done' }), /completed/);
  assert.equal(statusOf(task.id, second.id), 'todo');
});

test('the refusal names the blocker and the way out', () => {
  const { first, second } = taskWithBlockedSubtask();
  try {
    t.subtask_update({ id: second.id, status: 'done' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, new RegExp('#' + first.id), 'names the blocking subtask');
    assert.match(err.message, /first/, 'names it in words too');
    assert.match(err.message, /force/, 'says how to override');
  }
});

test('moving a blocked subtask back to todo is always allowed', () => {
  const { task, second } = taskWithBlockedSubtask();
  t.subtask_update({ id: second.id, status: 'todo' });
  assert.equal(statusOf(task.id, second.id), 'todo');
});

test('non-status edits are unaffected by a block', () => {
  const { task, second } = taskWithBlockedSubtask();
  t.subtask_update({ id: second.id, title: 'renamed while blocked' });
  const row = t.task_get({ id: task.id }).subtasks.find((s) => s.id === second.id);
  assert.equal(row.title, 'renamed while blocked');
});

test('force overrides, and the override is recorded', () => {
  const { task, first, second } = taskWithBlockedSubtask();
  const row = t.subtask_update({ id: second.id, status: 'in_progress', force: true });
  assert.equal(row.status, 'in_progress');
  const log = JSON.stringify(t.activity_log({ entity_type: 'subtask', entity_id: second.id, limit: 20 }));
  assert.match(log, /forced past/);
  assert.match(log, new RegExp('#' + first.id), 'the log says what was overridden');
});

test('finishing the prerequisite lifts the block without force', () => {
  const { task, first, second } = taskWithBlockedSubtask();
  t.subtask_update({ id: first.id, status: 'done' });
  t.subtask_update({ id: second.id, status: 'done' });
  assert.equal(statusOf(task.id, second.id), 'done');
});

test('a subtask with no dependencies is never guarded', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'free' });
  const sub = t.subtask_create({ task_id: task.id, titles: 'anything' });
  t.subtask_update({ id: sub.id, status: 'done' });
  assert.equal(statusOf(task.id, sub.id), 'done');
});

test('several blockers are all reported', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'many' });
  const [a, b, c] = t.subtask_create({ task_id: task.id, titles: ['a', 'b', 'c'] });
  t.subtask_update({ id: c.id, depends_on: [a.id, b.id] });
  try {
    t.subtask_update({ id: c.id, status: 'done' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, new RegExp('#' + a.id));
    assert.match(err.message, new RegExp('#' + b.id));
  }
});

/* ---------- tasks ---------- */

test('a task cannot be completed while its checklist is open', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'open checklist' });
  t.subtask_create({ task_id: task.id, titles: ['x', 'y'] });
  assert.throws(() => t.task_update({ id: task.id, status: 'done' }), /unfinished/);
  assert.notEqual(t.task_get({ id: task.id }).status, 'done');
});

test('the refusal lists what is left', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'listing' });
  const x = t.subtask_create({ task_id: task.id, titles: ['leftover'] });
  try {
    t.task_update({ id: task.id, status: 'done' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, new RegExp('#' + x.id));
    assert.match(err.message, /leftover/);
    assert.match(err.message, /force/);
  }
});

test('other task statuses are unaffected', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'review is fine' });
  t.subtask_create({ task_id: task.id, titles: 'still open' });
  t.task_update({ id: task.id, status: 'review' });
  assert.equal(t.task_get({ id: task.id }).status, 'review');
});

test('force completes the task and records what was skipped', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'forced' });
  t.subtask_create({ task_id: task.id, titles: ['unfinished'] });
  const row = t.task_update({ id: task.id, status: 'done', force: true });
  assert.equal(row.status, 'done');
  // Scope the log to this task — a shared fixture database makes an unscoped
  // tail mostly other tests' noise.
  const log = JSON.stringify(t.activity_log({ entity_type: 'task', entity_id: task.id, limit: 20 }));
  assert.match(log, /forced to done/);
});

test('a task with no subtasks completes freely', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'no checklist' });
  assert.equal(t.task_update({ id: task.id, status: 'done' }).status, 'done');
});

test('a task whose subtasks are all done completes freely', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'all done' });
  const subs = t.subtask_create({ task_id: task.id, titles: ['p', 'q'] });
  subs.forEach((s) => t.subtask_update({ id: s.id, status: 'done' }));
  assert.equal(t.task_update({ id: task.id, status: 'done' }).status, 'done');
});

test('task_batch_update cannot be used to slip past the check', () => {
  // A batch is a convenience, not a back door.
  const task = t.task_create({ epic_id: epic.id, title: 'batched' });
  t.subtask_create({ task_id: task.id, titles: 'open' });
  assert.throws(() => t.task_batch_update({ ids: [task.id], status: 'done' }), /unfinished/);
  assert.notEqual(t.task_get({ id: task.id }).status, 'done');
});

test('task_batch_update accepts the same force flag', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'batched force' });
  t.subtask_create({ task_id: task.id, titles: 'open' });
  t.task_batch_update({ ids: [task.id], status: 'done', force: true });
  assert.equal(t.task_get({ id: task.id }).status, 'done');
});

test('a batch that would fail changes nothing at all', () => {
  // The batch runs in a transaction, so a refusal must not leave half of it applied.
  const clean = t.task_create({ epic_id: epic.id, title: 'clean' });
  const dirty = t.task_create({ epic_id: epic.id, title: 'dirty' });
  t.subtask_create({ task_id: dirty.id, titles: 'open' });
  assert.throws(() => t.task_batch_update({ ids: [clean.id, dirty.id], status: 'done' }), /unfinished/);
  assert.notEqual(t.task_get({ id: clean.id }).status, 'done', 'the clean task must roll back too');
});
