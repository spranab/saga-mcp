import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';
import { resetProjectScopeCache } from '../dist/helpers/project-scope.js';

/**
 * The "global" setup: one .tracker.db shared by every repo, several projects
 * inside it. Without scoping, an agent working in one repo sees another repo's
 * work. These tests pin the scoping rule:
 *
 *   explicit project_id  >  SAGA_PROJECT  >  whole database
 */
const t = await loadTools(tempDbPath('saga-global'));

const alpha = t.project_create({ name: 'Alpha' });
const beta = t.project_create({ name: 'Beta' });

const alphaEpic = t.epic_create({ project_id: alpha.id, name: 'Alpha epic' });
const betaEpic = t.epic_create({ project_id: beta.id, name: 'Beta epic' });

const alphaTasks = ['a1', 'a2', 'a3'].map((title) =>
  t.task_create({ epic_id: alphaEpic.id, title, description: 'alpha work' })
);
const betaTask = t.task_create({ epic_id: betaEpic.id, title: 'b1', description: 'beta work' });

t.subtask_create({ task_id: alphaTasks[0].id, titles: ['a-sub'] });
t.comment_add({ task_id: betaTask.id, content: 'a beta comment' });
t.note_save({ title: 'Alpha note', content: 'alpha', related_entity_type: 'project', related_entity_id: alpha.id });
t.note_save({ title: 'Beta note', content: 'beta', related_entity_type: 'task', related_entity_id: betaTask.id });
t.note_save({ title: 'Floating note', content: 'belongs to no project' });

const titlesOf = (rows) => rows.map((r) => r.title ?? r.name).sort();

test('unscoped calls still see the whole database (backward compatible)', () => {
  assert.equal(t.task_list({ limit: 100 }).length, 4);
  assert.equal(t.note_list({}).length, 3);
});

test('task_list scoped by project_id only returns that project', () => {
  assert.deepEqual(titlesOf(t.task_list({ project_id: alpha.id, limit: 100 })), ['a1', 'a2', 'a3']);
  assert.deepEqual(titlesOf(t.task_list({ project_id: beta.id, limit: 100 })), ['b1']);
});

test('project_id composes with the other task filters', () => {
  // a1 carries a subtask, and completing a task with an open checklist now
  // needs an explicit override (#26)
  t.task_update({ id: alphaTasks[0].id, status: 'done', force: true });
  const done = t.task_list({ project_id: alpha.id, status: 'done', limit: 100 });
  assert.deepEqual(titlesOf(done), ['a1']);
  assert.equal(t.task_list({ project_id: beta.id, status: 'done', limit: 100 }).length, 0);
});

test('note_list scoped by project includes its epics and tasks, plus unattached notes', () => {
  const alphaNotes = titlesOf(t.note_list({ project_id: alpha.id }));
  assert.ok(alphaNotes.includes('Alpha note'));
  assert.ok(alphaNotes.includes('Floating note'), 'notes attached to nothing are global');
  assert.ok(!alphaNotes.includes('Beta note'));

  const betaNotes = titlesOf(t.note_list({ project_id: beta.id }));
  assert.ok(betaNotes.includes('Beta note'), 'a note on a task counts as that task\'s project');
  assert.ok(!betaNotes.includes('Alpha note'));
});

test('activity_log scoped by project excludes the other project entirely', () => {
  const alphaLog = JSON.stringify(t.activity_log({ project_id: alpha.id, limit: 200 }));
  const betaLog = JSON.stringify(t.activity_log({ project_id: beta.id, limit: 200 }));
  assert.ok(alphaLog.includes('Alpha'));
  assert.ok(!alphaLog.includes('Beta epic'), 'alpha log must not mention beta');
  assert.ok(betaLog.includes('Beta') || betaLog.includes('b1'));
  assert.ok(!betaLog.includes('Alpha epic'), 'beta log must not mention alpha');
});

test('activity_log scoping reaches subtasks and comments, not just tasks', () => {
  const betaLog = JSON.stringify(t.activity_log({ project_id: beta.id, limit: 200 }));
  assert.ok(betaLog.includes('Comment'), 'a comment on a beta task belongs to beta');
  const alphaLog = JSON.stringify(t.activity_log({ project_id: alpha.id, limit: 200 }));
  assert.ok(alphaLog.includes('a-sub'), 'a subtask of an alpha task belongs to alpha');
});

test('tracker_search scoped by project filters every result bucket', () => {
  const scoped = t.tracker_search({ query: 'a', project_id: alpha.id });
  assert.ok(scoped.tasks.every((x) => alphaTasks.some((a) => a.id === x.id)));
  assert.ok(scoped.epics.every((e) => e.project_id === alpha.id));
  assert.ok(scoped.projects.every((p) => p.id === alpha.id));
  assert.ok(!JSON.stringify(scoped.notes).includes('Beta note'));
});

test('tracker_dashboard scoped by project_id reports only that project', () => {
  const d = t.tracker_dashboard({ project_id: beta.id });
  assert.equal(d.project.name, 'Beta');
  assert.equal(d.stats.total_tasks, 1);
  assert.ok(!('other_projects' in d), 'an explicit scope is not a guess, so no warning');
});

test('an ambiguous dashboard says it guessed and lists the alternatives', () => {
  const d = t.tracker_dashboard({});
  assert.ok(d.other_projects, 'a multi-project database with no scope must flag it');
  assert.deepEqual(titlesOf(d.other_projects), ['Beta']);
  assert.match(d.summary, /none was specified/);
  assert.match(d.summary, /SAGA_PROJECT/);
});

test('a single-project database gets no warning', () => {
  const solo = t.tracker_dashboard({ project_id: alpha.id });
  assert.ok(!('other_projects' in solo));
});

test('SAGA_PROJECT scopes every tool by id', () => {
  process.env.SAGA_PROJECT = String(beta.id);
  resetProjectScopeCache();
  try {
    assert.deepEqual(titlesOf(t.task_list({ limit: 100 })), ['b1']);
    assert.equal(t.tracker_dashboard({}).project.name, 'Beta');
    assert.ok(!JSON.stringify(t.note_list({})).includes('Alpha note'));
    assert.ok(!JSON.stringify(t.activity_log({ limit: 200 })).includes('Alpha epic'));
  } finally {
    delete process.env.SAGA_PROJECT;
    resetProjectScopeCache();
  }
});

test('SAGA_PROJECT also accepts a project name, case-insensitively', () => {
  process.env.SAGA_PROJECT = 'beta';
  resetProjectScopeCache();
  try {
    assert.deepEqual(titlesOf(t.task_list({ limit: 100 })), ['b1']);
  } finally {
    delete process.env.SAGA_PROJECT;
    resetProjectScopeCache();
  }
});

test('an explicit project_id overrides SAGA_PROJECT', () => {
  process.env.SAGA_PROJECT = String(beta.id);
  resetProjectScopeCache();
  try {
    assert.deepEqual(titlesOf(t.task_list({ project_id: alpha.id, limit: 100 })), ['a1', 'a2', 'a3']);
  } finally {
    delete process.env.SAGA_PROJECT;
    resetProjectScopeCache();
  }
});

test('a SAGA_PROJECT that matches nothing fails loudly and names the real projects', () => {
  process.env.SAGA_PROJECT = 'does-not-exist';
  resetProjectScopeCache();
  try {
    assert.throws(() => t.task_list({ limit: 10 }), /not a project in this database/);
    assert.throws(() => t.task_list({ limit: 10 }), /Alpha/);
  } finally {
    delete process.env.SAGA_PROJECT;
    resetProjectScopeCache();
  }
});

test('writes are unaffected by scoping — they are addressed by parent id', () => {
  process.env.SAGA_PROJECT = String(beta.id);
  resetProjectScopeCache();
  try {
    const created = t.task_create({ epic_id: alphaEpic.id, title: 'a4' });
    assert.equal(t.task_get({ id: created.id }).title, 'a4');
    assert.deepEqual(titlesOf(t.task_list({ project_id: alpha.id, limit: 100 })), ['a1', 'a2', 'a3', 'a4']);
  } finally {
    delete process.env.SAGA_PROJECT;
    resetProjectScopeCache();
  }
});
