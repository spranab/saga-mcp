import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools, seed } from './helpers.js';

const tools = await loadTools(tempDbPath('saga-comments'));
const fixture = seed(tools);
const taskId = fixture.tasks[0].id;
const { keeper, doomed } = fixture.comments;

test('comment_list returns live comments in order', () => {
  const list = tools.comment_list({ task_id: taskId });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((c) => c.id), [keeper.id, doomed.id]);
});

test('comment_delete soft-deletes and records who and why', () => {
  const res = tools.comment_delete({ id: doomed.id, reason: 'hallucinated API', deleted_by: 'pranab' });
  assert.equal(res.comment.is_deleted, 1);
  assert.equal(res.comment.delete_reason, 'hallucinated API');
  assert.equal(res.comment.deleted_by, 'pranab');
  assert.ok(res.comment.deleted_at, 'deleted_at should be stamped');
  assert.equal(res.comment.content, 'This API does not exist.', 'content must survive for the audit trail');
});

test('removed comments are hidden from comment_list and task_get', () => {
  assert.equal(tools.comment_list({ task_id: taskId }).length, 1);
  assert.equal(tools.task_get({ id: taskId }).comments.length, 1);
});

test('include_deleted surfaces them with the reason', () => {
  const all = tools.comment_list({ task_id: taskId, include_deleted: true });
  assert.equal(all.length, 2);
  const removed = all.find((c) => c.id === doomed.id);
  assert.equal(removed.is_deleted, 1);
  assert.equal(removed.delete_reason, 'hallucinated API');
});

test('the removal is written to the activity log', () => {
  const entries = tools.activity_log({ limit: 50 });
  const rows = Array.isArray(entries) ? entries : entries.activity ?? entries.entries ?? [];
  const found = JSON.stringify(rows).includes('Comment ' + doomed.id + ' removed');
  assert.ok(found, 'expected a "Comment N removed" entry in the activity log');
});

test('comment_delete is idempotent', () => {
  const again = tools.comment_delete({ id: doomed.id });
  assert.match(again.message, /already removed/);
  assert.equal(tools.comment_list({ task_id: taskId, include_deleted: true }).length, 2);
});

test('comment_restore brings it back and clears the removal fields', () => {
  const res = tools.comment_restore({ id: doomed.id });
  assert.equal(res.comment.is_deleted, 0);
  assert.equal(res.comment.deleted_at, null);
  assert.equal(res.comment.deleted_by, null);
  assert.equal(res.comment.delete_reason, null);
  assert.equal(tools.comment_list({ task_id: taskId }).length, 2);
});

test('comment_restore is idempotent', () => {
  assert.match(tools.comment_restore({ id: doomed.id }).message, /not removed/);
});

test('a missing comment id is an error, not a silent no-op', () => {
  assert.throws(() => tools.comment_delete({ id: 999999 }), /not found/);
  assert.throws(() => tools.comment_restore({ id: 999999 }), /not found/);
});

test('export carries the removal flags so the audit trail survives a round-trip', () => {
  tools.comment_delete({ id: doomed.id, reason: 'wrong again' });
  const exported = tools.tracker_export({ project_id: fixture.project.id });
  const payload = typeof exported === 'string' ? JSON.parse(exported) : exported;
  const json = JSON.stringify(payload);
  assert.ok(json.includes('wrong again'), 'delete_reason should appear in the export');
  assert.ok(json.includes('This API does not exist.'), 'removed comment content should be exported');
});
