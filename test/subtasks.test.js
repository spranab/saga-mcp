import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';

const t = await loadTools(tempDbPath('saga-subtasks'));
const project = t.project_create({ name: 'P' });
const epic = t.epic_create({ project_id: project.id, name: 'E' });
const task = t.task_create({ epic_id: epic.id, title: 'Parent task' });
const other = t.task_create({ epic_id: epic.id, title: 'Another task' });

const titles = (rows) => rows.map((r) => r.title);
const subtasksOf = (id = task.id) => t.task_get({ id }).subtasks;

/* ---------- #21 ordering ---------- */

test('a batch of subtasks is numbered in the order given', () => {
  const made = t.subtask_create({ task_id: task.id, titles: ['first', 'second', 'third'] });
  assert.deepEqual(made.map((s) => s.sort_order), [1, 2, 3]);
});

test('a later subtask is appended rather than landing at 0', () => {
  // The reported behaviour: new subtasks arrived "without a number" and sorted
  // ahead of everything that already had one.
  const made = t.subtask_create({ task_id: task.id, titles: 'fourth' });
  assert.equal(made.sort_order, 4);
  assert.deepEqual(titles(subtasksOf()), ['first', 'second', 'third', 'fourth']);
});

test('subtask_reorder puts the listed ids first, in the order given', () => {
  const ids = subtasksOf().map((s) => s.id);
  const rows = t.subtask_reorder({ task_id: task.id, ordered_ids: [ids[3], ids[1]] });
  assert.deepEqual(titles(rows).slice(0, 2), ['fourth', 'second']);
});

test('subtasks left out of a reorder keep their relative order, at the end', () => {
  assert.deepEqual(titles(subtasksOf()), ['fourth', 'second', 'first', 'third']);
});

test('reordering renumbers cleanly as 1..n', () => {
  assert.deepEqual(subtasksOf().map((s) => s.sort_order), [1, 2, 3, 4]);
});

test('reorder refuses ids from another task', () => {
  const stray = t.subtask_create({ task_id: other.id, titles: 'elsewhere' });
  assert.throws(
    () => t.subtask_reorder({ task_id: task.id, ordered_ids: [stray.id] }),
    /do not belong to task/
  );
});

test('reorder on a task with no subtasks is an error, not a silent no-op', () => {
  const bare = t.task_create({ epic_id: epic.id, title: 'No subtasks' });
  assert.throws(() => t.subtask_reorder({ task_id: bare.id, ordered_ids: [] }), /no subtasks/);
});

/* ---------- #22 dependencies ---------- */

test('a subtask can wait on a sibling, and reports itself blocked', () => {
  const [a, b] = subtasksOf();
  t.subtask_update({ id: b.id, depends_on: [a.id] });
  const after = subtasksOf().find((s) => s.id === b.id);
  assert.equal(after.depends_on.length, 1);
  assert.equal(after.depends_on[0].id, a.id);
  assert.equal(after.blocked, true);
});

test('it unblocks when the prerequisite is done', () => {
  const [a, b] = subtasksOf();
  t.subtask_update({ id: a.id, status: 'done' });
  assert.equal(subtasksOf().find((s) => s.id === b.id).blocked, false);
});

test('subtasks with no dependencies carry no dependency fields at all', () => {
  // Keeps the common case free of per-row noise.
  const plain = subtasksOf().find((s) => !s.depends_on);
  assert.ok(plain, 'expected at least one subtask without dependencies');
  assert.ok(!('blocked' in plain));
});

test('blocks sets the inverse edge on several siblings at once', () => {
  // The reported scenario: a bug subtask that holds up everything after it.
  const rows = subtasksOf();
  const bug = t.subtask_create({ task_id: task.id, titles: 'BUG: fix first' });
  const victims = rows.slice(0, 3).map((s) => s.id);
  t.subtask_update({ id: bug.id, blocks: victims });

  const after = subtasksOf();
  for (const id of victims) {
    const row = after.find((s) => s.id === id);
    assert.ok(row.depends_on.some((d) => d.id === bug.id), `#${id} should wait on the bug`);
  }
});

test('blocks is a replacement, so clearing it releases the others', () => {
  const bug = subtasksOf().find((s) => s.title.startsWith('BUG'));
  t.subtask_update({ id: bug.id, blocks: [] });
  const after = subtasksOf();
  assert.ok(
    after.every((s) => !(s.depends_on ?? []).some((d) => d.id === bug.id)),
    'no subtask should still be waiting on the bug'
  );
});

test('depends_on replaces rather than appends, and an empty array clears it', () => {
  const rows = subtasksOf();
  const [a, b, c] = rows;
  t.subtask_update({ id: c.id, depends_on: [a.id, b.id] });
  assert.equal(subtasksOf().find((s) => s.id === c.id).depends_on.length, 2);
  t.subtask_update({ id: c.id, depends_on: [a.id] });
  assert.equal(subtasksOf().find((s) => s.id === c.id).depends_on.length, 1);
  t.subtask_update({ id: c.id, depends_on: [] });
  assert.ok(!subtasksOf().find((s) => s.id === c.id).depends_on);
});

test('a subtask cannot depend on itself', () => {
  const a = subtasksOf()[0];
  t.subtask_update({ id: a.id, depends_on: [a.id] });
  assert.ok(!subtasksOf().find((s) => s.id === a.id).depends_on, 'self-reference is dropped');
});

test('circular dependencies are refused with the cycle spelled out', () => {
  // Start from a clean slate — earlier cases leave edges behind.
  subtasksOf().forEach((s) => t.subtask_update({ id: s.id, depends_on: [] }));
  const [a, b] = subtasksOf();
  t.subtask_update({ id: a.id, depends_on: [b.id] });
  assert.throws(() => t.subtask_update({ id: b.id, depends_on: [a.id] }), /circular/);
  t.subtask_update({ id: a.id, depends_on: [] });
});

test('a longer cycle is caught too', () => {
  subtasksOf().forEach((s) => t.subtask_update({ id: s.id, depends_on: [] }));
  const [a, b, c] = subtasksOf();
  t.subtask_update({ id: b.id, depends_on: [a.id] });
  t.subtask_update({ id: c.id, depends_on: [b.id] });
  assert.throws(() => t.subtask_update({ id: a.id, depends_on: [c.id] }), /circular/);
  t.subtask_update({ id: b.id, depends_on: [] });
  t.subtask_update({ id: c.id, depends_on: [] });
});

test('dependencies must stay within one task, and the error says what to use instead', () => {
  const stray = t.task_get({ id: other.id }).subtasks[0];
  const mine = subtasksOf()[0];
  assert.throws(() => t.subtask_update({ id: mine.id, depends_on: [stray.id] }), /same task/);
  assert.throws(() => t.subtask_update({ id: mine.id, depends_on: [stray.id] }), /task_update/);
});

test('a missing prerequisite id is rejected', () => {
  const mine = subtasksOf()[0];
  assert.throws(() => t.subtask_update({ id: mine.id, depends_on: [999999] }), /not found/);
});

test('subtask_create can set dependencies up front', () => {
  const first = subtasksOf()[0];
  const made = t.subtask_create({ task_id: task.id, titles: 'depends at birth', depends_on: [first.id] });
  const row = subtasksOf().find((s) => s.id === made.id);
  assert.equal(row.depends_on[0].id, first.id);
});

test('deleting a subtask removes the edges pointing at it', () => {
  const rows = subtasksOf();
  const blocker = rows[0];
  const waiter = rows[rows.length - 1];
  t.subtask_update({ id: waiter.id, depends_on: [blocker.id] });
  assert.ok(subtasksOf().find((s) => s.id === waiter.id).depends_on);

  t.subtask_delete({ ids: blocker.id });
  const after = subtasksOf().find((s) => s.id === waiter.id);
  assert.ok(!after.depends_on, 'the dangling dependency should cascade away');
});
