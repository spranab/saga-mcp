import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDbPath, loadTools } from './helpers.js';
import { descriptionLockMode, startsWork } from '../dist/helpers/description-lock.js';

/**
 * #53, asked for by @rusak47: locking each description by hand does not scale
 * across a plan, so `SAGA_DESCRIPTION_LOCK=on_progress` locks a task the moment
 * work starts on it.
 *
 * The design decision these pin: the flag it sets is the *same* one a person
 * sets by hand (#19), not a rule re-evaluated on every write. That is what
 * makes an unlock stick — a rule would overrule the person every time.
 */
const t = await loadTools(tempDbPath('saga-desc-lock'));
const project = t.project_create({ name: 'Locking' });
const epic = t.epic_create({ project_id: project.id, name: 'E' });

/** Run one case with the feature in a known state, whatever it was before. */
function withMode(value, fn) {
  const before = process.env.SAGA_DESCRIPTION_LOCK;
  if (value === undefined) delete process.env.SAGA_DESCRIPTION_LOCK;
  else process.env.SAGA_DESCRIPTION_LOCK = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.SAGA_DESCRIPTION_LOCK;
    else process.env.SAGA_DESCRIPTION_LOCK = before;
  }
}

const newTask = (fields = {}) =>
  t.task_create({ epic_id: epic.id, title: 'A task', description: 'The plan.', ...fields });

/* ---------- reading the setting ---------- */

test('it is off unless it is asked for', () => {
  withMode(undefined, () => assert.equal(descriptionLockMode(), 'off'));
  withMode('off', () => assert.equal(descriptionLockMode(), 'off'));
  withMode('false', () => assert.equal(descriptionLockMode(), 'off'));
});

test('the values a user would plausibly type all turn it on', () => {
  // The issue proposed `=true`; the documented spelling is `on_progress`.
  for (const value of ['on_progress', 'on-progress', 'true', '1', 'ON', ' yes ']) {
    withMode(value, () => assert.equal(descriptionLockMode(), 'on_progress', value));
  }
});

test('an unrecognised value warns and stays off, rather than guessing', () => {
  const errors = [];
  const original = console.error;
  console.error = (msg) => errors.push(msg);
  try {
    withMode('sometimes', () => assert.equal(descriptionLockMode(), 'off'));
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /Unknown SAGA_DESCRIPTION_LOCK/);
});

test('blocked is not the same as started', () => {
  // Dependency evaluation moves tasks in and out of blocked on its own, and a
  // task waiting on another has not been worked on.
  withMode('on_progress', () => {
    assert.equal(startsWork('todo', 'blocked'), false);
    assert.equal(startsWork('todo', 'in_progress'), true);
    assert.equal(startsWork('blocked', 'in_progress'), true);
    assert.equal(startsWork('in_progress', 'review'), false, 'work already started');
  });
});

/* ---------- what it does to a task ---------- */

test('off by default, starting work changes nothing', () => {
  withMode(undefined, () => {
    const task = newTask();
    const moved = t.task_update({ id: task.id, status: 'in_progress' });
    assert.ok(!moved.description_locked);
    assert.equal(t.task_update({ id: task.id, description: 'Rewritten.' }).description, 'Rewritten.');
  });
});

test('starting work locks the description, and says why', () => {
  withMode('on_progress', () => {
    const task = newTask();
    const moved = t.task_update({ id: task.id, status: 'in_progress' });
    assert.equal(moved.description_locked, 1);
    assert.throws(
      () => t.task_update({ id: task.id, description: 'Rewritten by an agent.' }),
      /locked and was not changed[\s\S]*comment_add/
    );
    const log = JSON.stringify(t.activity_log({ limit: 20 }));
    assert.match(log, /description locked: work started/);
  });
});

test('a description sent with the status change is still accepted', () => {
  // The lock applies from the transition onward; refusing the call that caused
  // it would be a trap.
  withMode('on_progress', () => {
    const task = newTask();
    const moved = t.task_update({ id: task.id, status: 'in_progress', description: 'Final plan.' });
    assert.equal(moved.description, 'Final plan.');
    assert.equal(moved.description_locked, 1);
  });
});

test('a task created in progress is locked too', () => {
  withMode('on_progress', () => {
    assert.equal(newTask({ status: 'in_progress' }).description_locked, 1);
    assert.ok(!newTask({ status: 'todo' }).description_locked, 'a plan is still a plan');
  });
});

test('a blocked task is left alone', () => {
  withMode('on_progress', () => {
    const first = newTask();
    const second = newTask({ depends_on: [first.id] });
    assert.equal(t.task_get({ id: second.id }).status, 'blocked');
    assert.ok(!t.task_get({ id: second.id }).description_locked,
      'waiting on a dependency is not working on it');
  });
});

test('a batch is not a way around it', () => {
  withMode('on_progress', () => {
    const a = newTask();
    const b = newTask();
    t.task_batch_update({ ids: [a.id, b.id], status: 'in_progress' });
    assert.equal(t.task_get({ id: a.id }).description_locked, 1);
    assert.equal(t.task_get({ id: b.id }).description_locked, 1);
  });
});

test('an unlock is not undone by the next status change', () => {
  // The heart of the design: the rule sets the same flag a person sets, so a
  // person can overrule it and be left alone afterwards.
  withMode('on_progress', () => {
    const task = newTask();
    t.task_update({ id: task.id, status: 'in_progress' });
    t.task_lock_description({ id: task.id, locked: false });
    const moved = t.task_update({ id: task.id, status: 'review' });
    assert.ok(!moved.description_locked, 'moving on must not re-lock what a person unlocked');
    assert.equal(t.task_update({ id: task.id, description: 'Corrected.' }).description, 'Corrected.');
  });
});

test('turning the setting off later does not unlock what it locked', () => {
  // It sets a real flag rather than answering a question at read time, so the
  // tasks it locked stay locked until someone unlocks them.
  const task = withMode('on_progress', () => {
    const created = newTask();
    t.task_update({ id: created.id, status: 'in_progress' });
    return created;
  });
  withMode('off', () => {
    assert.equal(t.task_get({ id: task.id }).description_locked, 1);
    assert.throws(() => t.task_update({ id: task.id, description: 'x' }), /locked/);
  });
});
