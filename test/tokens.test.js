import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools, loadDefinitions, seed } from './helpers.js';
import { truncate, slimListRow, LIST_DESCRIPTION_CHARS } from '../dist/helpers/slim.js';

const tools = await loadTools(tempDbPath('saga-tokens'));
seed(tools, { longDescription: true });

test('truncate leaves short text alone', () => {
  assert.equal(truncate('short'), 'short');
});

test('truncate cuts long text at a word boundary with an ellipsis', () => {
  const out = truncate('a'.repeat(10) + ' ' + 'word '.repeat(60));
  assert.ok(out.length <= LIST_DESCRIPTION_CHARS + 1, 'stays within the cap');
  assert.ok(out.endsWith('…'), 'signals that it was cut');
  assert.ok(!out.includes('  '), 'no dangling whitespace before the ellipsis');
});

test('truncate falls back to a hard cut when there is no usable space', () => {
  const out = truncate('x'.repeat(400));
  assert.equal(out.length, LIST_DESCRIPTION_CHARS + 1);
  assert.ok(out.endsWith('…'));
});

test('slimListRow drops nulls, metadata and empty tags but keeps real values', () => {
  const row = slimListRow({
    id: 1, title: 'Keep me', description: 'short', due_date: null,
    metadata: '{}', tags: '[]', assigned_to: 'agent', estimated_hours: 0,
  });
  assert.deepEqual(Object.keys(row).sort(), ['assigned_to', 'description', 'estimated_hours', 'id', 'title']);
  assert.equal(row.estimated_hours, 0, 'zero is a real value, not a null');
});

test('slimListRow keeps non-empty tags', () => {
  const row = slimListRow({ id: 1, tags: '["billing"]' });
  assert.equal(row.tags, '["billing"]');
});

test('task_list rows are slimmed', () => {
  const rows = tools.task_list({});
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(!('metadata' in row), 'metadata should never appear in a list row');
    for (const [key, value] of Object.entries(row)) {
      assert.notEqual(value, null, `${key} should be omitted rather than null`);
    }
    if (typeof row.description === 'string') {
      assert.ok(row.description.length <= LIST_DESCRIPTION_CHARS + 1);
    }
  }
});

test('task_list truncates but task_get keeps the full description', () => {
  const listed = tools.task_list({}).find((r) => r.description?.endsWith('…'));
  assert.ok(listed, 'the long-description fixture should produce a truncated row');
  const full = tools.task_get({ id: listed.id });
  assert.ok(full.description.length > LIST_DESCRIPTION_CHARS);
  assert.ok(!full.description.endsWith('…'));
});

test('slimming measurably shrinks the payload', () => {
  const slim = JSON.stringify(tools.task_list({})).length;
  const full = JSON.stringify(tools.task_list({}).map((r) => ({ ...r, metadata: '{}' }))).length;
  assert.ok(slim < full);
  // Guard the headline claim: a long-description project should shrink a lot.
  const rows = tools.task_list({});
  const rawish = rows.reduce((n, r) => n + JSON.stringify(tools.task_get({ id: r.id })).length, 0);
  assert.ok(slim < rawish * 0.6, `expected the list to be well under the sum of details (${slim} vs ${rawish})`);
});

test('every tool definition carries safety annotations', async () => {
  const defs = await loadDefinitions();
  assert.equal(defs.length, 38);
  for (const def of defs) {
    assert.ok(def.annotations, `${def.name} is missing annotations`);
    assert.equal(typeof def.annotations.readOnlyHint, 'boolean', `${def.name} readOnlyHint`);
    assert.ok(def.description.length > 0, `${def.name} needs a description`);
  }
});

test('read-only tools are annotated as such', async () => {
  const defs = await loadDefinitions();
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  for (const name of ['task_get', 'task_list', 'comment_list', 'tracker_dashboard', 'epic_list']) {
    assert.equal(byName[name].annotations.readOnlyHint, true, `${name} should be readOnly`);
  }
  for (const name of ['task_create', 'comment_delete', 'comment_restore', 'epic_update', 'task_lock_description', 'subtask_reorder', 'epic_archive', 'task_delete', 'task_restore']) {
    assert.equal(byName[name].annotations.readOnlyHint, false, `${name} should not be readOnly`);
  }
});

test('tool descriptions do not creep — density is what this guards', async () => {
  // The thing worth catching is prose bloat, not honest growth: three new tools
  // legitimately need more bytes than none. Density separates the two.
  //   v1.7.0  33 tools  756 bytes/tool
  //   v1.9.0  35 tools  714 bytes/tool
  // If this fails, a description grew. Trim it rather than raising the number.
  const defs = await loadDefinitions();
  const perTool = JSON.stringify(defs).length / defs.length;
  assert.ok(perTool < 750, `${Math.round(perTool)} bytes per tool, over the 750 ceiling`);
});

test('the whole surface stays within its context budget', async () => {
  // An absolute cap as well, so density cannot be gamed by adding many small
  // tools. Raised 25000 -> 28000 for v1.10.0 after trimming prose first: the
  // surface went 35 -> 38 tools while density went 714 -> 710 bytes/tool.
  const defs = await loadDefinitions();
  const bytes = JSON.stringify(defs).length;
  assert.ok(bytes < 28000, `tool list is ${bytes} bytes, over the 28000 budget`);
});

test('activity_log drops the row id and null columns', () => {
  const rows = tools.activity_log({ limit: 50 });
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(!('id' in row), 'no tool takes an activity id, so it is dead weight');
    for (const [key, value] of Object.entries(row)) {
      assert.notEqual(value, null, `${key} should be omitted rather than null`);
    }
  }
  assert.ok(rows.some((r) => r.summary), 'the readable summary must survive');
});

test('tracker_search returns previews, not whole records', () => {
  const results = tools.tracker_search({ query: 'the' });
  for (const task of results.tasks) {
    assert.ok(!('metadata' in task));
    if (typeof task.description === 'string') {
      assert.ok(task.description.length <= LIST_DESCRIPTION_CHARS + 1);
    }
  }
  for (const note of results.notes) {
    assert.ok(note.content.length <= LIST_DESCRIPTION_CHARS + 1, 'note content is previewed in search');
  }
});

test('note_list keeps full note content — it is the retrieval tool, not a preview', () => {
  const long = 'x'.repeat(LIST_DESCRIPTION_CHARS * 3);
  tools.note_save({ title: 'Long note', content: long, note_type: 'context' });
  const found = tools.note_list({}).find((n) => n.title === 'Long note');
  assert.equal(found.content.length, long.length);
});

test('list responses carry no null padding anywhere', () => {
  const sets = [
    ['epic_list', tools.epic_list({ project_id: 1 })],
    ['project_list', tools.project_list({})],
  ];
  for (const [name, rows] of sets) {
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        assert.notEqual(value, null, `${name}.${key} should be omitted rather than null`);
      }
    }
  }
});
