import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';

/**
 * #37. Two reports, and re-checking them turned up a third problem nobody had
 * noticed.
 *
 *  1. An agent numbering tasks 1,2,3 got them back in a different order. The
 *     cause was not a missing reorder tool: task_list defaults to sort_by
 *     'priority', where sort_order is only a third-level tiebreaker, and there
 *     was no way to sort by it at all.
 *  2. Task dependencies could be set but not seen or edited in the UI.
 *  3. Found while checking 2: reopening a *completed* blocker left everything
 *     waiting on it unblocked — reevaluateDownstream only ran on the way INTO
 *     done, never on the way out.
 */
const t = await loadTools(tempDbPath('saga-order'));
const project = t.project_create({ name: 'P' });
const epic = t.epic_create({ project_id: project.id, name: 'E' });
const other = t.epic_create({ project_id: project.id, name: 'Other' });

const titles = (rows) => rows.map((r) => r.title);

/* ---------- ordering ---------- */

const a = t.task_create({ epic_id: epic.id, title: 'Phase 1.1', priority: 'medium' });
const b = t.task_create({ epic_id: epic.id, title: 'Phase 1.2', priority: 'critical' });
const c = t.task_create({ epic_id: epic.id, title: 'Phase 2', priority: 'low' });

test('the default sort is still priority — unchanged for existing callers', () => {
  assert.deepEqual(titles(t.task_list({ epic_id: epic.id, limit: 10 })),
                   ['Phase 1.2', 'Phase 1.1', 'Phase 2']);
});

test('task_reorder sets the order, and sort_by manual reads it back', () => {
  // The reported symptom: numbering them 1,2,3 and getting a different order.
  t.task_reorder({ epic_id: epic.id, ordered_ids: [a.id, b.id, c.id] });
  assert.deepEqual(titles(t.task_list({ epic_id: epic.id, sort_by: 'manual', limit: 10 })),
                   ['Phase 1.1', 'Phase 1.2', 'Phase 2']);
});

test('manual order is ascending — lower sorts first', () => {
  const rows = t.task_list({ epic_id: epic.id, sort_by: 'manual', limit: 10 });
  const orders = rows.map((r) => r.sort_order);
  assert.deepEqual(orders, [...orders].sort((x, y) => x - y));
});

test('sort_order now documents which way it runs', async () => {
  // With no description at all, an agent guessing the convention had even odds
  // of getting it backwards — which is what was reported.
  const { loadDefinitions } = await import('./helpers.js');
  const def = (await loadDefinitions()).find((d) => d.name === 'task_update');
  const desc = def.inputSchema.properties.sort_order.description ?? '';
  assert.match(desc, /lower sorts first/);
  const list = (await loadDefinitions()).find((d) => d.name === 'task_list');
  assert.ok(list.inputSchema.properties.sort_by.enum.includes('manual'),
    'manual must be a reachable sort mode');
});

test('tasks left out of a reorder keep their relative order, at the end', () => {
  t.task_reorder({ epic_id: epic.id, ordered_ids: [c.id] });
  assert.deepEqual(titles(t.task_list({ epic_id: epic.id, sort_by: 'manual', limit: 10 })),
                   ['Phase 2', 'Phase 1.1', 'Phase 1.2']);
  t.task_reorder({ epic_id: epic.id, ordered_ids: [a.id, b.id, c.id] });
});

test('reorder refuses tasks from another epic', () => {
  const stray = t.task_create({ epic_id: other.id, title: 'elsewhere' });
  assert.throws(() => t.task_reorder({ epic_id: epic.id, ordered_ids: [stray.id] }), /do not belong/);
});

test('reorder on an epic with no tasks is an error, not a silent no-op', () => {
  const empty = t.epic_create({ project_id: project.id, name: 'Empty' });
  assert.throws(() => t.task_reorder({ epic_id: empty.id, ordered_ids: [] }), /no tasks/);
});

test('reorder positions are 1..n', () => {
  const rows = t.task_list({ epic_id: epic.id, sort_by: 'manual', limit: 10 });
  assert.deepEqual(rows.map((r) => r.sort_order), [1, 2, 3]);
});

/* ---------- dependencies re-evaluating in both directions ---------- */

test('a task with an unmet dependency is auto-blocked', () => {
  const blocker = t.task_create({ epic_id: epic.id, title: 'blocker' });
  const waiter = t.task_create({ epic_id: epic.id, title: 'waiter', depends_on: [blocker.id] });
  assert.equal(t.task_get({ id: waiter.id }).status, 'blocked');
  return { blocker, waiter };
});

test('finishing the blocker unblocks it', () => {
  const blocker = t.task_list({ limit: 30 }).find((x) => x.title === 'blocker');
  const waiter = t.task_list({ limit: 30, include_deleted: true }).find((x) => x.title === 'waiter');
  t.task_update({ id: blocker.id, status: 'done' });
  assert.equal(t.task_get({ id: waiter.id }).status, 'todo');
});

test('REOPENING a finished blocker blocks it again', () => {
  // Previously this left the waiter in todo with an unmet dependency: the
  // downstream re-evaluation only ran when a task became done.
  const blocker = t.task_list({ limit: 30 }).find((x) => x.title === 'blocker');
  const waiter = t.task_list({ limit: 30 }).find((x) => x.title === 'waiter');
  t.task_update({ id: blocker.id, status: 'in_progress' });
  assert.equal(t.task_get({ id: waiter.id }).status, 'blocked');
});

test('and finishing it again releases the waiter', () => {
  const blocker = t.task_list({ limit: 30 }).find((x) => x.title === 'blocker');
  const waiter = t.task_list({ limit: 30, include_deleted: true }).find((x) => x.title === 'waiter');
  t.task_update({ id: blocker.id, status: 'done' });
  assert.equal(t.task_get({ id: waiter.id }).status, 'todo');
});

/* ---------- cycles ---------- */

test('a circular task dependency is refused, naming the loop', () => {
  // Subtasks refused these from the start; tasks accepted them, and the
  // auto-blocking then left every task in the loop permanently blocked.
  const x = t.task_create({ epic_id: epic.id, title: 'cycle-x' });
  const y = t.task_create({ epic_id: epic.id, title: 'cycle-y' });
  t.task_update({ id: y.id, depends_on: [x.id] });
  assert.throws(() => t.task_update({ id: x.id, depends_on: [y.id] }), /circular task dependency/);
  assert.throws(() => t.task_update({ id: x.id, depends_on: [y.id] }), new RegExp('#' + x.id));
});

test('a longer task cycle is caught too', () => {
  const x = t.task_create({ epic_id: epic.id, title: 'c1' });
  const y = t.task_create({ epic_id: epic.id, title: 'c2' });
  const z = t.task_create({ epic_id: epic.id, title: 'c3' });
  t.task_update({ id: y.id, depends_on: [x.id] });
  t.task_update({ id: z.id, depends_on: [y.id] });
  assert.throws(() => t.task_update({ id: x.id, depends_on: [z.id] }), /circular/);
});

test('self-dependency is dropped rather than erroring', () => {
  const solo = t.task_create({ epic_id: epic.id, title: 'solo' });
  t.task_update({ id: solo.id, depends_on: [solo.id] });
  assert.equal(t.task_get({ id: solo.id }).depends_on.length, 0);
});

test('legitimate chains still work', () => {
  const one = t.task_create({ epic_id: epic.id, title: 'chain-1' });
  const two = t.task_create({ epic_id: epic.id, title: 'chain-2', depends_on: [one.id] });
  const three = t.task_create({ epic_id: epic.id, title: 'chain-3', depends_on: [two.id] });
  assert.equal(t.task_get({ id: three.id }).status, 'blocked');
  t.task_update({ id: one.id, status: 'done' });
  assert.equal(t.task_get({ id: two.id }).status, 'todo');
  assert.equal(t.task_get({ id: three.id }).status, 'blocked', 'still waiting on chain-2');
});

test('subtask cycles are still refused after sharing the implementation', () => {
  const host = t.task_create({ epic_id: epic.id, title: 'host' });
  const subs = t.subtask_create({ task_id: host.id, titles: ['s1', 's2'] });
  t.subtask_update({ id: subs[1].id, depends_on: [subs[0].id] });
  assert.throws(() => t.subtask_update({ id: subs[0].id, depends_on: [subs[1].id] }),
                /circular subtask dependency/);
});

test('clearing every dependency releases a task the system had blocked', () => {
  // This used to strand it: with no dependencies left there was nothing that
  // could ever re-evaluate it, so it sat in `blocked` permanently.
  const blocker = t.task_create({ epic_id: epic.id, title: 'clear-blocker' });
  const waiter = t.task_create({ epic_id: epic.id, title: 'clear-waiter', depends_on: [blocker.id] });
  assert.equal(t.task_get({ id: waiter.id }).status, 'blocked');
  t.task_update({ id: waiter.id, depends_on: [] });
  assert.equal(t.task_get({ id: waiter.id }).status, 'todo');
});

test('but a task blocked by hand stays blocked', () => {
  // `blocked` is also a status a person can set deliberately, and clearing it
  // as a side effect of unrelated dependency traffic would be wrong.
  const manual = t.task_create({ epic_id: epic.id, title: 'manually blocked' });
  t.task_update({ id: manual.id, status: 'blocked' });
  const unrelated = t.task_create({ epic_id: epic.id, title: 'unrelated' });
  t.task_update({ id: unrelated.id, status: 'done' });
  assert.equal(t.task_get({ id: manual.id }).status, 'blocked');
});
