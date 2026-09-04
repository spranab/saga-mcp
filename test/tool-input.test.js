import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';

/**
 * #29 at the tool boundary. The unit tests in coerce.test.js pin the
 * normaliser; these pin that every array-taking tool actually uses it, which is
 * the part that was missing — the helper existing is no use if one call site
 * still reads `args.ids as number[]`.
 *
 * Each case is a shape a model was observed to send.
 */
const t = await loadTools(tempDbPath('saga-input'));
const project = t.project_create({ name: 'P' });
const epic = t.epic_create({ project_id: project.id, name: 'E' });
const newTask = (title = 'T' + Math.random()) => t.task_create({ epic_id: epic.id, title });
const subtasksOf = (id) => t.task_get({ id }).subtasks;

/* ---------- the reported bug ---------- */

test('subtask_create: a JSON array sent as a string creates several subtasks', () => {
  const task = newTask();
  const made = t.subtask_create({ task_id: task.id, titles: '["alpha","beta","gamma"]' });
  assert.equal(made.length, 3);
  assert.deepEqual(made.map((s) => s.title), ['alpha', 'beta', 'gamma']);
});

test('subtask_create: a bulleted list in one string creates several', () => {
  const task = newTask();
  const made = t.subtask_create({ task_id: task.id, titles: '- alpha\n- beta' });
  assert.deepEqual(made.map((s) => s.title), ['alpha', 'beta']);
});

test('subtask_create: a single title still creates exactly one', () => {
  const task = newTask();
  const made = t.subtask_create({ task_id: task.id, titles: 'just one' });
  assert.equal(made.title, 'just one');
  assert.equal(subtasksOf(task.id).length, 1);
});

test('subtask_create: a comma in a title does not split it', () => {
  const task = newTask();
  const made = t.subtask_create({ task_id: task.id, titles: 'Design the API, then implement it' });
  assert.equal(made.title, 'Design the API, then implement it');
  assert.equal(subtasksOf(task.id).length, 1);
});

test('subtask_create: unusable titles fail with a message, not a SQLite error', () => {
  const task = newTask();
  assert.throws(() => t.subtask_create({ task_id: task.id, titles: [1, 2] }), /must be strings/);
  assert.throws(() => t.subtask_create({ task_id: task.id, titles: 42 }), /must be a string or an array/);
});

/* ---------- ids ---------- */

test('subtask_delete accepts ids as a JSON string', () => {
  const task = newTask();
  const made = t.subtask_create({ task_id: task.id, titles: ['a', 'b', 'c'] });
  t.subtask_delete({ ids: `[${made[0].id},${made[1].id}]` });
  assert.deepEqual(subtasksOf(task.id).map((s) => s.title), ['c']);
});

test('subtask_delete still accepts a bare id', () => {
  const task = newTask();
  const made = t.subtask_create({ task_id: task.id, titles: ['only'] });
  t.subtask_delete({ ids: made.id });
  assert.equal(subtasksOf(task.id).length, 0);
});

test('task_batch_update accepts ids as a JSON string and as a bare number', () => {
  // Previously both produced "ids.map is not a function".
  const a = newTask('batch-a');
  const b = newTask('batch-b');
  t.task_batch_update({ ids: `[${a.id},${b.id}]`, status: 'review' });
  assert.equal(t.task_get({ id: a.id }).status, 'review');
  t.task_batch_update({ ids: a.id, status: 'todo' });
  assert.equal(t.task_get({ id: a.id }).status, 'todo');
});

test('subtask_reorder accepts ordered_ids as a JSON string', () => {
  // Previously "orderedIds.filter is not a function".
  const task = newTask();
  const made = t.subtask_create({ task_id: task.id, titles: ['one', 'two', 'three'] });
  t.subtask_reorder({ task_id: task.id, ordered_ids: `[${made[2].id},${made[0].id}]` });
  assert.deepEqual(subtasksOf(task.id).map((s) => s.title), ['three', 'one', 'two']);
});

test('task_create depends_on accepts a JSON string', () => {
  const first = newTask('dep-first');
  const second = t.task_create({ epic_id: epic.id, title: 'dep-second', depends_on: `[${first.id}]` });
  assert.equal(t.task_get({ id: second.id }).status, 'blocked', 'the dependency must actually register');
});

test('subtask_update depends_on and blocks accept JSON strings', () => {
  // Previously "Subtask(s) not found: [, 4, ]".
  const task = newTask();
  const made = t.subtask_create({ task_id: task.id, titles: ['x', 'y', 'z'] });
  t.subtask_update({ id: made[1].id, depends_on: `[${made[0].id}]` });
  assert.equal(subtasksOf(task.id).find((s) => s.id === made[1].id).depends_on[0].id, made[0].id);
  t.subtask_update({ id: made[0].id, blocks: `[${made[2].id}]` });
  assert.ok(subtasksOf(task.id).find((s) => s.id === made[2].id).depends_on.some((d) => d.id === made[0].id));
});

test('a bad id list names the field rather than leaking a TypeError', () => {
  assert.throws(() => t.task_batch_update({ ids: 'not-an-id', status: 'todo' }), /whole numbers/);
  assert.throws(() => t.subtask_delete({ ids: {} }), /must be a number or an array/);
});

/* ---------- tags, which used to corrupt silently ---------- */

const tagsOf = (row) => JSON.parse(row.tags);

test('tags sent as a JSON string are stored as a real array', () => {
  // Previously stored as a string, which made the UI render one pill per
  // character and made tag filters unable to match anything.
  const task = t.task_create({ epic_id: epic.id, title: 'tagged', tags: '["billing","urgent"]' });
  assert.deepEqual(tagsOf(t.task_get({ id: task.id })), ['billing', 'urgent']);
});

test('tags sent comma-separated are split', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'tagged2', tags: 'billing, urgent' });
  assert.deepEqual(tagsOf(t.task_get({ id: task.id })), ['billing', 'urgent']);
});

test('every entity that takes tags stores the same shape', () => {
  const p = t.project_create({ name: 'tag-project', tags: '["x"]' });
  const e = t.epic_create({ project_id: p.id, name: 'tag-epic', tags: 'y,z' });
  const n = t.note_save({ title: 'tag-note', content: 'c', tags: '["w"]' });
  assert.deepEqual(JSON.parse(p.tags), ['x']);
  assert.deepEqual(JSON.parse(e.tags), ['y', 'z']);
  assert.deepEqual(JSON.parse(n.tags), ['w']);
});

test('updating tags cannot store the shape creating them would reject', () => {
  const task = t.task_create({ epic_id: epic.id, title: 'tag-update' });
  t.task_update({ id: task.id, tags: '["from","update"]' });
  assert.deepEqual(tagsOf(t.task_get({ id: task.id })), ['from', 'update']);
});

test('tag filtering finds a task tagged through the string form', () => {
  // The real consequence: json_each over a corrupted tags column matched nothing.
  const task = t.task_create({ epic_id: epic.id, title: 'findable', tags: '["searchable"]' });
  const found = t.task_list({ tag: 'searchable', limit: 20 });
  assert.ok(found.some((r) => r.id === task.id), 'a tag stored from a JSON string should be filterable');
});

/* ---------- the schema models are asked to imitate ---------- */

test('no tool schema uses oneOf', async () => {
  // Smaller models handle a single concrete type far better, which is what the
  // reporter suspected was behind the batch confusion.
  const { loadDefinitions } = await import('./helpers.js');
  const defs = await loadDefinitions();
  for (const def of defs) {
    assert.ok(!JSON.stringify(def.inputSchema).includes('oneOf'), `${def.name} still uses oneOf`);
  }
});

test('the titles schema is a plain array of strings with an example', async () => {
  const { loadDefinitions } = await import('./helpers.js');
  const def = (await loadDefinitions()).find((d) => d.name === 'subtask_create');
  assert.equal(def.inputSchema.properties.titles.type, 'array');
  assert.equal(def.inputSchema.properties.titles.items.type, 'string');
  assert.match(def.inputSchema.properties.titles.description, /\["Write it", "Test it"\]/);
});
