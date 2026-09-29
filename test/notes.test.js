import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';

/**
 * #64: the Epics tab and the task drawer both need to edit a note in place
 * without losing what it is attached to. note_save's update path wrote every
 * column unconditionally — defaulting related_entity_type/id and tags to
 * null when a call left them out — instead of going through buildUpdate like
 * every other tool's update handler. The web UI's noteModal never sent them
 * on an edit, so editing a note through the existing Notes tab already
 * silently unlinked it from its epic/task/project and wiped its tags; #64's
 * new epic-note popup would have hit this immediately. Fixed alongside #64
 * rather than filed separately, since that is what surfaced it.
 */
const t = await loadTools(tempDbPath('saga-notes'));
const project = t.project_create({ name: 'P' });
const epic = t.epic_create({ project_id: project.id, name: 'E' });

test('editing a note without its relation leaves the relation alone', () => {
  const note = t.note_save({
    title: 'Original', content: 'x', related_entity_type: 'epic', related_entity_id: epic.id,
  });
  const updated = t.note_save({ id: note.id, title: 'Renamed', content: 'x' });
  assert.equal(updated.related_entity_type, 'epic');
  assert.equal(updated.related_entity_id, epic.id);
});

test('editing a note without its tags leaves the tags alone', () => {
  const note = t.note_save({ title: 'Tagged', content: 'x', tags: ['keep'] });
  const updated = t.note_save({ id: note.id, title: 'Tagged v2', content: 'x' });
  assert.deepEqual(JSON.parse(updated.tags), ['keep']);
});

test('an explicit relation change still applies', () => {
  const note = t.note_save({
    title: 'Movable', content: 'x', related_entity_type: 'epic', related_entity_id: epic.id,
  });
  const moved = t.note_save({
    id: note.id, title: 'Movable', content: 'x', related_entity_type: 'project', related_entity_id: project.id,
  });
  assert.equal(moved.related_entity_type, 'project');
  assert.equal(moved.related_entity_id, project.id);
});

test('a save with nothing recognised to change is refused, not a silent no-op', () => {
  const note = t.note_save({ title: 'Untouched', content: 'x' });
  assert.throws(() => t.note_save({ id: note.id }), /nothing to update/);
});
