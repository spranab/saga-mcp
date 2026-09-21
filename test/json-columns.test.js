import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJsonColumns } from '../dist/helpers/json-columns.js';
import { tempDbPath, loadTools } from './helpers.js';

/**
 * #55, reported by @rusak47: `tags` is stored as JSON text and was handed back
 * as that text, so the MCP layer escaped it a second time on the way out.
 *
 * The decoder runs over a whole result at the response boundary rather than
 * row by row, so these pin two things: that it reaches a row wherever one is
 * nested, and that it refuses to touch anything whose shape it cannot vouch
 * for — a decoder that guesses would corrupt data rather than reveal it.
 */

test('a stored tags column comes out as a list', () => {
  assert.deepEqual(decodeJsonColumns({ tags: '["a","b"]' }), { tags: ['a', 'b'] });
});

test('a row nested anywhere in the result is still reached', () => {
  // tracker_dashboard shape: rows inside arrays inside objects.
  const out = decodeJsonColumns({
    project: { tags: '["p"]' },
    epics: [{ tags: '["e"]', tasks: [{ tags: '["t"]' }] }],
  });
  assert.deepEqual(out.project.tags, ['p']);
  assert.deepEqual(out.epics[0].tags, ['e']);
  assert.deepEqual(out.epics[0].tasks[0].tags, ['t']);
});

test('a value that is already decoded is left alone', () => {
  const tags = ['a'];
  assert.equal(decodeJsonColumns({ tags }).tags, tags);
});

test('text that is not JSON stays exactly as it is', () => {
  // A source_ref holding a bare path or URL is not a mistake to be repaired.
  assert.deepEqual(decodeJsonColumns({ source_ref: 'src/index.ts:12' }),
    { source_ref: 'src/index.ts:12' });
});

test('a scalar that happens to parse is not silently retyped', () => {
  // '5' and '"x"' are valid JSON. Replacing them would change the column's type
  // under the caller, which is a worse bug than the one being fixed.
  assert.deepEqual(decodeJsonColumns({ source_ref: '5', metadata: '"x"' }),
    { source_ref: '5', metadata: '"x"' });
});

test('a tags column that is not an array is reported as stored', () => {
  assert.deepEqual(decodeJsonColumns({ tags: '{"not":"a list"}' }), { tags: '{"not":"a list"}' });
});

test('keys that merely look like columns are untouched', () => {
  assert.deepEqual(decodeJsonColumns({ title: '["not","tags"]' }), { title: '["not","tags"]' });
});

test('null and missing values survive the walk', () => {
  assert.deepEqual(decodeJsonColumns({ tags: null, metadata: undefined, id: 3 }),
    { tags: null, metadata: undefined, id: 3 });
});

/* ---------- the backup still round-trips ---------- */

const t = await loadTools(tempDbPath('saga-json-columns'));

test('a dump carries tags as a list, and imports back as one', () => {
  const project = t.project_create({ name: 'Backup', tags: ['alpha'] });
  const epic = t.epic_create({ project_id: project.id, name: 'E', tags: ['beta'] });
  t.task_create({
    epic_id: epic.id, title: 'T', tags: ['gamma'],
    source_ref: { file: 'src/db.ts', line_start: 1 },
  });

  const dump = t.tracker_export({ project_id: project.id });
  assert.equal(dump.format_version, '1.3');
  assert.deepEqual(dump.project.tags, ['alpha'], 'the dump itself holds a list');
  assert.deepEqual(dump.project.epics[0].tasks[0].source_ref, { file: 'src/db.ts', line_start: 1 });

  // The import lands as a second project with the same name, and new ids.
  const imported = t.tracker_import({ data: dump });
  const restored = t.project_list({}).find((p) => p.id === imported.project_id);
  const restoredEpic = t.epic_list({ project_id: restored.id })[0];
  const restoredTask = t.task_list({ epic_id: restoredEpic.id })[0];
  // The tools are called in process here, so these are the stored column values.
  assert.deepEqual(JSON.parse(restoredTask.tags), ['gamma']);
  assert.deepEqual(JSON.parse(restoredEpic.tags), ['beta']);
});

test('a dump written before 1.3 still imports', () => {
  // Older backups hold the JSON *strings*. A backup that cannot be restored is
  // not a backup, so both shapes have to land in the column the same way.
  const legacy = {
    format_version: '1.2',
    project: {
      name: 'Old backup', status: 'active', tags: '["alpha"]', metadata: '{}',
      epics: [{
        name: 'E', status: 'planned', priority: 'medium', tags: '["beta"]', metadata: '{}',
        tasks: [{ title: 'T', status: 'todo', priority: 'medium', tags: '["gamma"]', metadata: '{}' }],
      }],
    },
    notes: [],
  };
  t.tracker_import({ data: legacy });
  const restored = t.project_list({}).find((p) => p.name === 'Old backup');
  const epic = t.epic_list({ project_id: restored.id })[0];
  assert.deepEqual(JSON.parse(t.task_list({ epic_id: epic.id })[0].tags), ['gamma']);
  assert.deepEqual(JSON.parse(epic.tags), ['beta']);
});
