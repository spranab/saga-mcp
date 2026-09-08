import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';

/**
 * task_list default ordering (#48).
 *
 * Reported by @rusak47: a deliberately sequenced plan came back scrambled,
 * because the default sorted by priority and treated the arrangement as a
 * third-level tiebreaker. The list opened on "Phase 1.1" while the plan began
 * at "Phase 0" -- an agent following it would work the plan out of order,
 * which is worse than a cosmetic complaint.
 *
 * The fix has to earn its keep twice: honour an arrangement when one exists,
 * and change NOTHING for the far larger number of callers who never reorder.
 */
const t = await loadTools(tempDbPath('saga-sort48'));
const project = t.project_create({ name: 'Sorting' });

const titles = (rows) => rows.map((r) => r.title);

/* ------------------------------------------------------------ untouched epic */

const plain = t.epic_create({ project_id: project.id, name: 'Never reordered', status: 'in_progress' });
t.task_create({ epic_id: plain.id, title: 'a low one', priority: 'low' });
t.task_create({ epic_id: plain.id, title: 'a critical one', priority: 'critical' });
t.task_create({ epic_id: plain.id, title: 'a medium one', priority: 'medium' });

test('an epic nobody arranged still sorts by priority', () => {
  const rows = t.task_list({ epic_id: plain.id, limit: 20 });
  assert.deepEqual(titles(rows), ['a critical one', 'a medium one', 'a low one']);
});

test('and the default is byte for byte what sort_by=priority gives', () => {
  // The whole safety argument for this change: callers who never reorder must
  // see no difference at all.
  const auto = t.task_list({ epic_id: plain.id, limit: 20 });
  const explicit = t.task_list({ epic_id: plain.id, sort_by: 'priority', limit: 20 });
  assert.equal(JSON.stringify(auto), JSON.stringify(explicit));
});

/* ------------------------------------------------------------ arranged epic */

const planned = t.epic_create({ project_id: project.id, name: 'A real plan', status: 'in_progress' });
const steps = ['Phase 0: prepare', 'Phase 1: rebase', 'Phase 2: reset'].map((title, i) =>
  t.task_create({ epic_id: planned.id, title, priority: i === 1 ? 'critical' : 'low' })
);
t.task_reorder({ epic_id: planned.id, ordered_ids: steps.map((x) => x.id) });

test('an arranged epic comes back in the arranged order by default', () => {
  const rows = t.task_list({ epic_id: planned.id, limit: 20 });
  assert.deepEqual(titles(rows), ['Phase 0: prepare', 'Phase 1: rebase', 'Phase 2: reset']);
});

test('the highest priority no longer jumps the queue it was placed in', () => {
  // "Phase 1: rebase" is critical; before the fix it came first.
  const rows = t.task_list({ epic_id: planned.id, limit: 20 });
  assert.equal(rows[0].title, 'Phase 0: prepare');
});

test('asking for priority explicitly still gets priority', () => {
  // An explicit sort_by is a direct instruction; the arrangement does not
  // override it.
  const rows = t.task_list({ epic_id: planned.id, sort_by: 'priority', limit: 20 });
  assert.equal(rows[0].title, 'Phase 1: rebase');
});

test('a status sort is likewise untouched', () => {
  const rows = t.task_list({ epic_id: planned.id, sort_by: 'status', limit: 20 });
  assert.ok(rows.length === 3);
});

/* -------------------------------------------- a task added after the plan */

test('a task created after the arrangement goes last, not first', () => {
  // task_reorder writes 1..N, so a new task has sort_order 0. Sorted naively
  // that is the smallest number and it would land at the head of the plan --
  // the one place it certainly does not belong.
  const late = t.task_create({ epic_id: planned.id, title: 'thought of later', priority: 'critical' });
  const rows = t.task_list({ epic_id: planned.id, limit: 20 });
  assert.equal(rows[rows.length - 1].title, 'thought of later');
  assert.equal(rows[0].title, 'Phase 0: prepare');

  const manual = t.task_list({ epic_id: planned.id, sort_by: 'manual', limit: 20 });
  assert.equal(manual[manual.length - 1].title, 'thought of later',
    'sort_by=manual should place it the same way');

  t.task_delete({ id: late.id, reason: 'fixture' });
});

/* ------------------------------------------------------- across epics */

test('two arranged epics do not interleave by position number', () => {
  // Position 1 of one epic and position 1 of another are unrelated; ordering
  // by the number alone would invent a sequence nobody set.
  const other = t.epic_create({ project_id: project.id, name: 'Another plan', status: 'in_progress' });
  const more = ['Other A', 'Other B'].map((title) => t.task_create({ epic_id: other.id, title }));
  t.task_reorder({ epic_id: other.id, ordered_ids: more.map((x) => x.id) });

  const rows = t.task_list({ project_id: project.id, limit: 50 });
  const names = titles(rows);
  const planIdx = names.map((n, i) => [n, i]).filter(([n]) => /^Phase/.test(n)).map(([, i]) => i);
  const otherIdx = names.map((n, i) => [n, i]).filter(([n]) => /^Other/.test(n)).map(([, i]) => i);

  const contiguous = (idx) => idx[idx.length - 1] - idx[0] === idx.length - 1;
  assert.ok(contiguous(planIdx), 'one epic should stay together: ' + JSON.stringify(names));
  assert.ok(contiguous(otherIdx), 'so should the other: ' + JSON.stringify(names));
});

test('an unarranged epic mixed in still orders its own tasks by priority', () => {
  const rows = t.task_list({ project_id: project.id, limit: 50 });
  const plainNames = titles(rows).filter((n) => /one$/.test(n));
  assert.deepEqual(plainNames, ['a critical one', 'a medium one', 'a low one']);
});

/* ------------------------------------------------------- other filters */

test('the arrangement survives a status filter', () => {
  t.task_update({ id: steps[0].id, status: 'in_progress' });
  const rows = t.task_list({ epic_id: planned.id, status: 'todo', limit: 20 });
  assert.deepEqual(titles(rows), ['Phase 1: rebase', 'Phase 2: reset']);
  t.task_update({ id: steps[0].id, status: 'todo' });
});

test('a filter that matches only unarranged tasks falls back to priority', () => {
  // The detection runs against the same filters as the list, so a result set
  // with nothing placed in it sorts the old way.
  const rows = t.task_list({ epic_id: plain.id, limit: 20 });
  assert.equal(rows[0].title, 'a critical one');
});
