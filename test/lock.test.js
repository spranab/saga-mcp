import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';

/**
 * #19: agents sometimes rewrite a task's description when they meant to record
 * progress in a comment. The lock guards that one field — not the whole task.
 */
const t = await loadTools(tempDbPath('saga-lock'));
const project = t.project_create({ name: 'P' });
const epic = t.epic_create({ project_id: project.id, name: 'E' });
const task = t.task_create({ epic_id: epic.id, title: 'Spec', description: 'The agreed spec.' });

test('descriptions are editable by default', () => {
  t.task_update({ id: task.id, description: 'edited freely' });
  assert.equal(t.task_get({ id: task.id }).description, 'edited freely');
});

test('locking is reported and reflected on the task', () => {
  const res = t.task_lock_description({ id: task.id });
  assert.match(res.message, /locked/);
  assert.equal(t.task_get({ id: task.id }).description_locked, 1);
});

test('a locked description refuses the write and says what to do instead', () => {
  assert.throws(() => t.task_update({ id: task.id, description: 'agent rewrite' }), /locked/);
  assert.throws(() => t.task_update({ id: task.id, description: 'agent rewrite' }), /comment_add/);
});

test('the refusal leaves the description untouched', () => {
  assert.equal(t.task_get({ id: task.id }).description, 'edited freely');
});

test('the rest of the task stays editable while locked', () => {
  // The point is to protect the spec, not to freeze the task.
  t.task_update({ id: task.id, status: 'in_progress', priority: 'high', assigned_to: 'agent' });
  const after = t.task_get({ id: task.id });
  assert.equal(after.status, 'in_progress');
  assert.equal(after.priority, 'high');
  assert.equal(after.assigned_to, 'agent');
});

test('comments still work while locked — that is the intended path', () => {
  t.comment_add({ task_id: task.id, content: 'Progress: matcher done.', author: 'agent' });
  assert.equal(t.task_get({ id: task.id }).comments.length, 1);
});

test('the lock cannot be picked via task_update', () => {
  // description_locked is not in task_update's field list, so a confused agent
  // cannot clear it as a side effect of an ordinary edit.
  t.task_update({ id: task.id, title: 'Spec v2', description_locked: 0 });
  assert.equal(t.task_get({ id: task.id }).description_locked, 1);
  assert.throws(() => t.task_update({ id: task.id, description: 'still refused' }), /locked/);
});

test('locking twice is idempotent', () => {
  assert.match(t.task_lock_description({ id: task.id }).message, /already locked/);
});

test('unlocking restores editing', () => {
  t.task_lock_description({ id: task.id, locked: false });
  t.task_update({ id: task.id, description: 'allowed again' });
  assert.equal(t.task_get({ id: task.id }).description, 'allowed again');
});

test('unlocking twice is idempotent', () => {
  assert.match(t.task_lock_description({ id: task.id, locked: false }).message, /already unlocked/);
});

test('both directions are written to the activity log', () => {
  t.task_lock_description({ id: task.id, locked: true });
  t.task_lock_description({ id: task.id, locked: false });
  const log = JSON.stringify(t.activity_log({ limit: 50 }));
  assert.match(log, /description locked/);
  assert.match(log, /description unlocked/);
});

test('a missing task id is an error', () => {
  assert.throws(() => t.task_lock_description({ id: 999999 }), /not found/);
});

test('the flag stays out of list rows while it is off', () => {
  // It would otherwise cost bytes on every row of every list, for nothing.
  const rows = t.task_list({ limit: 10 });
  assert.ok(rows.every((r) => !('description_locked' in r)));
});

test('but a locked task carries the flag where it matters', () => {
  t.task_lock_description({ id: task.id });
  assert.equal(t.task_get({ id: task.id }).description_locked, 1);
  const listed = t.task_list({ limit: 10 }).find((r) => r.id === task.id);
  assert.equal(listed.description_locked, 1);
});
