import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tempDbPath, loadTools, seed } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = tempDbPath('saga-web');
const fixture = seed(await loadTools(dbPath));

const running = [];
after(() => running.forEach((c) => c.kill()));

/** Start saga-web and wait for it to print the URL it actually bound. */
function startWeb(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/web/index.js', dbPath, ...args], {
      cwd: root,
      env: { ...process.env, SAGA_WEB_PORT: '', PORT: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error('saga-web did not start: ' + out)), 15000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/saga-web\s+(http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, base: m[1], output: () => out });
      }
    });
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`saga-web exited with ${code}: ${out}`));
    });
  });
}

const post = (base, body, headers = {}) =>
  fetch(base + '/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-saga-ui': '1', ...headers },
    body: JSON.stringify(body),
  });

const editable = await startWeb();

test('serves the page', async () => {
  const res = await fetch(editable.base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('<title>Saga</title>'));
  assert.ok(html.includes('/api/action'), 'the page must know where to write');
});

test('lists projects with the database path and mode', async () => {
  const body = await (await fetch(editable.base + '/api/projects')).json();
  assert.equal(body.read_only, false);
  assert.ok(body.db_path.endsWith('.tracker.db'));
  assert.equal(body.projects.length, 1);
  assert.equal(body.projects[0].name, 'Payments');
});

test('overview returns stats, epics and overdue/blocked buckets', async () => {
  const o = await (await fetch(`${editable.base}/api/overview?project_id=${fixture.project.id}`)).json();
  assert.equal(o.project.name, 'Payments');
  assert.equal(o.stats.total_tasks, 6);
  assert.equal(o.epics.length, 2);
  assert.equal(o.blocked_tasks.length, 1);
});

test('overview rejects a missing or unknown project', async () => {
  assert.equal((await fetch(editable.base + '/api/overview')).status, 400);
  assert.equal((await fetch(editable.base + '/api/overview?project_id=4242')).status, 404);
});

test('task detail includes subtasks, comments and history', async () => {
  const t = await (await fetch(`${editable.base}/api/tasks/${fixture.tasks[0].id}`)).json();
  assert.equal(t.subtasks.length, 3);
  assert.equal(t.comments.length, 2);
  assert.equal(t.deleted_comment_count, 0);
  assert.ok(Array.isArray(t.activity));
});

test('search needs two characters and finds tasks', async () => {
  const empty = await (await fetch(editable.base + '/api/search?q=a')).json();
  assert.equal(empty.tasks.length, 0);
  const hit = await (await fetch(editable.base + '/api/search?q=charge')).json();
  assert.ok(hit.tasks.length >= 1);
});

test('unknown routes 404', async () => {
  assert.equal((await fetch(editable.base + '/api/nope')).status, 404);
});

test('a write goes through and is visible on the next read', async () => {
  const res = await post(editable.base, {
    tool: 'task_update',
    // tasks[0] has subtasks, so completing it needs the #26 override
    args: { id: fixture.tasks[0].id, status: 'done', priority: 'critical', force: true },
  });
  assert.equal(res.status, 200);
  const t = await (await fetch(`${editable.base}/api/tasks/${fixture.tasks[0].id}`)).json();
  assert.equal(t.status, 'done');
  assert.equal(t.priority, 'critical');
});

test('UI edits land in the same activity log as agent edits', async () => {
  const { activity } = await (await fetch(editable.base + '/api/activity?limit=50')).json();
  assert.ok(
    activity.some((a) => /status: \w+ -> done/.test(a.summary ?? '')),
    'the status change made through the UI should be logged'
  );
});

test('comment removal and restore work through the UI path', async () => {
  const id = fixture.comments.doomed.id;
  await post(editable.base, { tool: 'comment_delete', args: { id, reason: 'wrong', deleted_by: 'ui' } });

  const hidden = await (await fetch(`${editable.base}/api/tasks/${fixture.tasks[0].id}`)).json();
  assert.equal(hidden.comments.length, 1);
  assert.equal(hidden.deleted_comment_count, 1);

  const shown = await (await fetch(`${editable.base}/api/tasks/${fixture.tasks[0].id}?include_deleted=1`)).json();
  const removed = shown.comments.find((c) => c.id === id);
  assert.equal(removed.is_deleted, 1);
  assert.equal(removed.delete_reason, 'wrong');

  await post(editable.base, { tool: 'comment_restore', args: { id } });
  const back = await (await fetch(`${editable.base}/api/tasks/${fixture.tasks[0].id}`)).json();
  assert.equal(back.comments.length, 2);
});

test('a write without the UI header is refused', async () => {
  const res = await fetch(editable.base + '/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'task_update', args: { id: 1, status: 'todo' } }),
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /x-saga-ui/);
});

test('a write from another origin is refused', async () => {
  const res = await post(editable.base, { tool: 'task_update', args: { id: 1, status: 'todo' } },
                         { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Cross-origin/);
});

test('a same-origin write is allowed', async () => {
  const res = await post(editable.base, { tool: 'task_update', args: { id: fixture.tasks[1].id, status: 'review' } },
                         { origin: editable.base });
  assert.equal(res.status, 200);
});

test('only whitelisted tools can be invoked', async () => {
  for (const tool of ['tracker_import', 'constructor', '__proto__', 'toString', '']) {
    const res = await post(editable.base, { tool, args: {} });
    assert.equal(res.status, 400, `${tool} should be refused`);
    assert.match((await res.json()).error, /Unknown or disallowed/);
  }
});

test('a failing tool returns its message rather than a stack trace', async () => {
  const res = await post(editable.base, { tool: 'task_update', args: { id: 999999, status: 'done' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Task 999999 not found/);
});

test('a malformed body is a 400', async () => {
  const res = await fetch(editable.base + '/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-saga-ui': '1' },
    body: 'not json',
  });
  assert.equal(res.status, 400);
});

test('--read-only serves reads and refuses every write', async () => {
  const ro = await startWeb(['--read-only']);
  const body = await (await fetch(ro.base + '/api/projects')).json();
  assert.equal(body.read_only, true);
  assert.equal((await fetch(`${ro.base}/api/overview?project_id=${fixture.project.id}`)).status, 200);
  const res = await post(ro.base, { tool: 'task_update', args: { id: 1, status: 'todo' } });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /read-only/);
});

test('a second instance takes the next free port instead of failing', async () => {
  const second = await startWeb();
  const third = await startWeb();
  const ports = [editable.base, second.base, third.base].map((u) => Number(new URL(u).port));
  assert.equal(new Set(ports).size, 3, `expected three distinct ports, got ${ports.join(', ')}`);
  assert.ok(second.output().includes('took the next free port'), 'should say why it moved');
  // and each one actually serves
  for (const base of [second.base, third.base]) {
    assert.equal((await fetch(base + '/api/projects')).status, 200);
  }
});

test('an explicit --port is honoured exactly', async () => {
  const pinned = await startWeb(['--port', '4457']);
  assert.equal(new URL(pinned.base).port, '4457');
});

test('--port 0 lets the OS choose', async () => {
  const any = await startWeb(['--port', '0']);
  assert.ok(Number(new URL(any.base).port) > 0);
});

test('a taken explicit port fails loudly rather than moving', async () => {
  await assert.rejects(startWeb(['--port', '4457']), /already in use|exited with 1/);
});

test('a missing database is refused, not created', async () => {
  const child = spawn(process.execPath, ['dist/web/index.js', join(root, 'definitely-not-here.db')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  const out = await new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.on('data', (d) => (buf += d));
    child.on('exit', () => resolve(buf));
  });
  assert.match(out, /Database not found/);
});
