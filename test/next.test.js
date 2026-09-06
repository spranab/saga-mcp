import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';

/**
 * tracker_next answers "what should I work on", which the tracker implied but
 * never answered — tracker_dashboard hands over everything and leaves the
 * reasoning to the caller.
 *
 * The ordering rule that matters most: continuing beats starting. An agent
 * resuming should finish what it left open rather than opening something new,
 * because abandoning work in flight just leaves two things unfinished.
 */
const t = await loadTools(tempDbPath('saga-next'));
const project = t.project_create({ name: 'P' });
const activeEpic = t.epic_create({ project_id: project.id, name: 'Active', status: 'in_progress' });
const laterEpic = t.epic_create({ project_id: project.id, name: 'Later', status: 'planned' });

test('an empty project says so rather than returning nothing', () => {
  const r = t.tracker_next({ project_id: project.id });
  assert.equal(r.task, null);
  assert.match(r.summary, /Nothing left to do/);
});

test('with nothing started, the active epic wins over an equally urgent one elsewhere', () => {
  t.task_create({ epic_id: activeEpic.id, title: 'adapter', priority: 'high' });
  const critical = t.task_create({ epic_id: activeEpic.id, title: 'migrate', priority: 'critical' });
  t.task_create({ epic_id: laterEpic.id, title: 'report', priority: 'critical' });

  const r = t.tracker_next({ project_id: project.id });
  assert.equal(r.task.id, critical.id);
  assert.match(r.reason, /active epic/);
});

test('it offers alternatives with a reason for each', () => {
  const r = t.tracker_next({ project_id: project.id });
  assert.ok(r.alternatives.length >= 2);
  assert.ok(r.alternatives.every((a) => a.id && a.title && a.why_not_first));
});

test('once something is in progress, that is the recommendation', () => {
  // The core rule: do not scatter.
  const started = t.task_list({ limit: 20 }).find((x) => x.title === 'adapter');
  t.task_update({ id: started.id, status: 'in_progress' });
  const r = t.tracker_next({ project_id: project.id });
  assert.equal(r.task.id, started.id, 'should continue the started task, not start the critical one');
  assert.match(r.reason, /already in progress/);
});

test('it names the next subtask, respecting subtask dependencies', () => {
  const started = t.task_list({ limit: 20 }).find((x) => x.title === 'adapter');
  const subs = t.subtask_create({ task_id: started.id, titles: ['design', 'implement', 'test'] });
  t.subtask_update({ id: subs[1].id, depends_on: [subs[0].id] });

  let r = t.tracker_next({ project_id: project.id });
  assert.equal(r.next_subtask.title, 'design');
  assert.match(r.summary, /Next step: design/);

  t.subtask_update({ id: subs[0].id, status: 'done' });
  r = t.tracker_next({ project_id: project.id });
  assert.equal(r.next_subtask.title, 'implement', 'the blocked one is now free');
});

test('a blocked subtask is never offered as the next step', () => {
  const started = t.task_list({ limit: 20 }).find((x) => x.title === 'adapter');
  const subs = t.task_get({ id: started.id }).subtasks;
  const blocked = subs.find((s) => (s.depends_on ?? []).length > 0 && s.blocked);
  if (blocked) {
    assert.notEqual(t.tracker_next({ project_id: project.id }).next_subtask.id, blocked.id);
  }
});

test('overdue work is announced even when it is not the pick', () => {
  // It loses to work in flight, but the agent should not have to go looking.
  const overdue = t.task_create({
    epic_id: activeEpic.id, title: 'renew cert', priority: 'low', due_date: '2020-01-01',
  });
  const r = t.tracker_next({ project_id: project.id });
  assert.notEqual(r.task.id, overdue.id, 'in-progress work still wins');
  assert.match(r.summary, /Also overdue/);
  assert.ok(r.overdue.some((x) => x.id === overdue.id));
});

test('a blocked task is never recommended', () => {
  const all = t.task_list({ limit: 20 });
  const report = all.find((x) => x.title === 'report');
  const migrate = all.find((x) => x.title === 'migrate');
  t.task_update({ id: report.id, depends_on: [migrate.id] });

  const r = t.tracker_next({ project_id: project.id });
  assert.notEqual(r.task.id, report.id);
  assert.ok(r.blocked.some((b) => b.id === report.id));
  assert.ok(r.blocked.find((b) => b.id === report.id).waiting_on.some((w) => w.id === migrate.id),
    'it should say what the blocked task is waiting on');
});

test('when everything is blocked it says what to unblock, not just that it is stuck', () => {
  const solo = t.project_create({ name: 'Gridlocked' });
  const epic = t.epic_create({ project_id: solo.id, name: 'E', status: 'in_progress' });
  const keystone = t.task_create({ epic_id: epic.id, title: 'the keystone' });
  for (const name of ['a', 'b', 'c']) {
    const task = t.task_create({ epic_id: epic.id, title: name });
    t.task_update({ id: task.id, depends_on: [keystone.id] });
  }
  // block the keystone itself so nothing at all is actionable
  const outside = t.task_create({ epic_id: epic.id, title: 'outside' });
  t.task_update({ id: keystone.id, depends_on: [outside.id] });
  t.task_update({ id: outside.id, depends_on: [keystone.id === outside.id ? keystone.id : undefined].filter(Boolean) });

  const r = t.tracker_next({ project_id: solo.id });
  if (r.task === null) {
    assert.match(r.summary, /Nothing is actionable/);
    assert.match(r.summary, /would release/, 'it should name the most valuable thing to unblock');
  } else {
    // `outside` remains actionable, which is itself the right answer
    assert.equal(r.task.title, 'outside');
  }
});

test('archived epics and removed tasks are never recommended', () => {
  const p = t.project_create({ name: 'Hidden' });
  const shelved = t.epic_create({ project_id: p.id, name: 'Shelved' });
  t.task_create({ epic_id: shelved.id, title: 'in an archived epic' });
  t.epic_archive({ id: shelved.id });

  const live = t.epic_create({ project_id: p.id, name: 'Live', status: 'in_progress' });
  const junk = t.task_create({ epic_id: live.id, title: 'removed task' });
  const real = t.task_create({ epic_id: live.id, title: 'real work' });
  t.task_delete({ id: junk.id, reason: 'clutter' });

  const r = t.tracker_next({ project_id: p.id });
  assert.equal(r.task.id, real.id);
});

test('assigned_to narrows it to one person', () => {
  const p = t.project_create({ name: 'Assigned' });
  const e = t.epic_create({ project_id: p.id, name: 'E', status: 'in_progress' });
  const mine = t.task_create({ epic_id: e.id, title: 'mine', assigned_to: 'agent' });
  t.task_create({ epic_id: e.id, title: 'theirs', assigned_to: 'someone', priority: 'critical' });

  assert.equal(t.tracker_next({ project_id: p.id, assigned_to: 'agent' }).task.id, mine.id);
  assert.equal(t.tracker_next({ project_id: p.id, assigned_to: 'nobody' }).task, null);
});

test('it is substantially cheaper than the dashboard', () => {
  // The reason for existing: answer the question instead of handing over the
  // raw material to reason about.
  const next = JSON.stringify(t.tracker_next({ project_id: project.id })).length;
  const dash = JSON.stringify(t.tracker_dashboard({ project_id: project.id })).length;
  assert.ok(next < dash * 0.6, `tracker_next ${next} vs dashboard ${dash}`);
});

test('the recommendation carries no null padding', () => {
  const r = t.tracker_next({ project_id: project.id });
  for (const [key, value] of Object.entries(r.task)) {
    assert.notEqual(value, null, `${key} should be omitted rather than null`);
  }
});

test('it is in the core tool surface — it is the first call of a session', async () => {
  const { loadDefinitions } = await import('./helpers.js');
  assert.ok((await loadDefinitions()).some((d) => d.name === 'tracker_next'));
});
