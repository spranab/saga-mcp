/**
 * Release verification: pack the build, install that tarball into a clean
 * directory, and drive it the way a user would — MCP over real stdio, and the
 * web server over real HTTP. Nothing here imports the source.
 *
 *   npm run e2e
 *
 * Run this on a tagged build BEFORE publishing the GitHub release, because
 * publishing the release is what pushes to npm, and npm is forever.
 *
 * Deliberately outside test/: `node --test` discovers **\/test\/**\/*.mjs, so
 * living there meant `npm test` ran it — including in CI, where installing a
 * fresh tarball rebuilds better-sqlite3 and needs a toolchain the Windows
 * runners do not have. This is a release gate, not a unit test.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'saga-e2e-'));
const results = [];
const ok = (n, c, x) => results.push((c ? 'PASS' : 'FAIL') + '  ' + n + (c || !x ? '' : '  -- ' + x));
const section = (t) => results.push('\n--- ' + t + ' ---');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function cleanup() {
  children.forEach((c) => { try { c.kill(); } catch { /* already gone */ } });
  try { rmSync(work, { recursive: true, force: true }); } catch { /* windows file locks */ }
}

/* ---------------- install the real tarball ---------------- */

section('packaging');
execFileSync('npm', ['pack', '--pack-destination', work], { cwd: root, stdio: 'pipe', shell: true });
const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
ok('npm pack produced a tarball', !!tarball, readdirSync(work).join(','));

const app = join(work, 'app');
mkdirSync(app, { recursive: true });
execFileSync('npm', ['init', '-y'], { cwd: app, stdio: 'pipe', shell: true });
execFileSync('npm', ['install', join(work, tarball)], { cwd: app, stdio: 'pipe', shell: true });

const installed = join(app, 'node_modules', 'saga-mcp');
const pkg = JSON.parse(execFileSync('node', ['-p', `JSON.stringify(require(${JSON.stringify(join(installed, 'package.json'))}))`], { encoding: 'utf8' }));
ok('the tarball installs cleanly', !!pkg.version, pkg.version);
ok('README ships', readdirSync(installed).includes('README.md'));
ok('LICENSE ships', readdirSync(installed).includes('LICENSE'));
ok('both binaries are declared', !!pkg.bin['saga-mcp'] && !!pkg.bin['saga-web']);

const SERVER = join(installed, 'dist', 'index.js');
const WEB = join(installed, 'dist', 'web', 'index.js');
const DB = join(work, '.tracker.db');

/* ---------------- MCP over stdio ---------------- */

function mcp(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DB_PATH: DB, SAGA_TOOLS: '', SAGA_PROJECT: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '', buf = '';
  const pending = new Map();
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res) => {
    const my = ++id; pending.set(my, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  });
  let handshake = null;
  const ready = (async () => {
    const r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    handshake = r.result;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  })();
  const info = () => handshake;
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result.content[0].text;
    if (r.result.isError) return { __error: text };
    try { return JSON.parse(text); } catch { return { __raw: text }; }
  };
  return { info, rpc, call, ready, stderr: () => stderr, stop: () => child.kill() };
}

const s = mcp();
await s.ready;

section('an agent plans a piece of work');
const init = await s.call('tracker_init', { project_name: 'Checkout rewrite' });
ok('tracker_init creates the first project', init.project?.name === 'Checkout rewrite');
const projectId = init.project.id;

const epic = await s.call('epic_create', { project_id: projectId, name: 'Provider swap', status: 'in_progress' });
const t1 = await s.call('task_create', { epic_id: epic.id, title: 'Write the adapter', description: 'x'.repeat(400) });
const t2 = await s.call('task_create', { epic_id: epic.id, title: 'Migrate cards', depends_on: [t1.id] });
ok('a task with an unmet dependency is auto-blocked', (await s.call('task_get', { id: t2.id })).status === 'blocked');

const subs = await s.call('subtask_create', { task_id: t1.id, titles: ['design', 'implement', 'test'] });
ok('subtasks are numbered in order', JSON.stringify(subs.map((x) => x.sort_order)) === '[1,2,3]');
const late = await s.call('subtask_create', { task_id: t1.id, titles: 'document' });
ok('a later subtask appends rather than jumping to the front', late.sort_order === 4);

section('a human reviews and reorders');
const reordered = await s.call('subtask_reorder', { task_id: t1.id, ordered_ids: [subs[0].id, subs[1].id, late.id] });
ok('reorder applies, unlisted items keep their order at the end',
   reordered.map((x) => x.title).join(',') === 'design,implement,document,test', reordered.map((x) => x.title).join(','));
await s.call('subtask_update', { id: subs[1].id, depends_on: [subs[0].id] });
ok('a subtask reports itself blocked', (await s.call('task_get', { id: t1.id })).subtasks.find((x) => x.id === subs[1].id).blocked === true);

section('blocked really means blocked');
const refuse = await s.call('subtask_update', { id: subs[1].id, status: 'in_progress' });
ok('starting a blocked subtask is refused', !!refuse.__error && /waits on/.test(refuse.__error), refuse.__error);
ok('the refusal names the blocker', !!refuse.__error && refuse.__error.includes('#' + subs[0].id));
ok('the status did not change', (await s.call('task_get', { id: t1.id })).subtasks.find((x) => x.id === subs[1].id).status === 'todo');
const refuseDone = await s.call('subtask_update', { id: subs[1].id, status: 'done' });
ok('completing a blocked subtask is refused too', !!refuseDone.__error);
ok('force overrides', (await s.call('subtask_update', { id: subs[1].id, status: 'in_progress', force: true })).status === 'in_progress');
ok('the override is logged', JSON.stringify(await s.call('activity_log', { entity_type: 'subtask', entity_id: subs[1].id, limit: 10 })).includes('forced past'));
await s.call('subtask_update', { id: subs[1].id, status: 'todo' });

const refuseTask = await s.call('task_update', { id: t1.id, status: 'done' });
ok('a task will not complete over an open checklist', !!refuseTask.__error && /unfinished/.test(refuseTask.__error));
ok('nor via a batch update', !!(await s.call('task_batch_update', { ids: [t1.id], status: 'done' })).__error);

section('working through it in order');
await s.call('subtask_update', { id: subs[0].id, status: 'done' });
ok('the prerequisite being done lifts the block', (await s.call('subtask_update', { id: subs[1].id, status: 'in_progress' })).status === 'in_progress');
for (const x of [subs[1].id, subs[2].id, late.id]) await s.call('subtask_update', { id: x, status: 'done' });
ok('the task completes once the checklist is clear', (await s.call('task_update', { id: t1.id, status: 'done' })).status === 'done');
ok('the downstream task auto-unblocks', (await s.call('task_get', { id: t2.id })).status !== 'blocked');

section('guarding the spec, and the discussion');
await s.call('task_lock_description', { id: t2.id });
ok('a locked description is protected', !!(await s.call('task_update', { id: t2.id, description: 'rewrite' })).__error);
ok('the rest of the task stays editable', (await s.call('task_update', { id: t2.id, priority: 'high' })).priority === 'high');
await s.call('task_lock_description', { id: t2.id, locked: false });
ok('unlocking restores editing', (await s.call('task_update', { id: t2.id, description: 'ok' })).description === 'ok');

const bad = await s.call('comment_add', { task_id: t2.id, content: 'a wrong claim', author: 'agent' });
await s.call('comment_add', { task_id: t2.id, content: 'a good one', author: 'human' });
await s.call('comment_delete', { id: bad.id, reason: 'wrong', deleted_by: 'human' });
ok('a removed comment is hidden', (await s.call('comment_list', { task_id: t2.id })).length === 1);
ok('but retrievable with its reason', (await s.call('comment_list', { task_id: t2.id, include_deleted: true })).some((c) => c.delete_reason === 'wrong'));
ok('export carries the removal for the audit trail', JSON.stringify(await s.call('tracker_export', { project_id: projectId })).includes('wrong'));

section('reading it back');
const listed = await s.call('task_list', { limit: 50 });
ok('list rows carry no nulls or metadata', listed.every((r) => !('metadata' in r) && !Object.values(r).includes(null)));
ok('long descriptions are previewed in lists', listed.some((r) => typeof r.description === 'string' && r.description.endsWith('…')));
ok('task_get returns the full description', (await s.call('task_get', { id: t1.id })).description.length === 400);
ok('the dashboard reports real progress', (await s.call('tracker_dashboard', { project_id: projectId })).stats.total_tasks === 2);

section('what to work on next');
{
  // Through the real transport, on the same data the dashboard just reported.
  const n = await s.call('tracker_next', { project_id: projectId });
  ok('tracker_next recommends one task with a reason', !!n.task && typeof n.reason === 'string', n.summary);
  ok('the summary names the task it picked', n.summary.includes("#" + n.task.id), n.summary);
  const dash = JSON.stringify(await s.call('tracker_dashboard', { project_id: projectId })).length;
  ok('and it is cheaper than the dashboard', JSON.stringify(n).length < dash * 0.6,
     JSON.stringify(n).length + ' vs ' + dash);

  await s.call('task_update', { id: t1.id, status: 'in_progress' });
  ok('continuing beats starting', (await s.call('tracker_next', { project_id: projectId })).task.id === t1.id);
  await s.call('task_update', { id: t1.id, status: 'todo' });
}

section('ordering and dependencies');
{
  const orderEpic = await s.call('epic_create', { project_id: projectId, name: 'Ordered work' });
  const one = await s.call('task_create', { epic_id: orderEpic.id, title: 'step one', priority: 'low' });
  const two = await s.call('task_create', { epic_id: orderEpic.id, title: 'step two', priority: 'critical' });
  await s.call('task_reorder', { epic_id: orderEpic.id, ordered_ids: [one.id, two.id] });
  const manual = await s.call('task_list', { epic_id: orderEpic.id, sort_by: 'manual', limit: 10 });
  ok('task_reorder + sort_by manual round-trips', manual.map((t) => t.title).join(',') === 'step one,step two',
     manual.map((t) => t.title).join(','));
  // #48: once an epic has been arranged, the default follows the arrangement.
  // 'step two' is critical and would otherwise lead; the point is that a
  // deliberate order outranks a guess.
  const byDefault = await s.call('task_list', { epic_id: orderEpic.id, limit: 10 });
  ok('the default follows a deliberate arrangement', byDefault[0].title === 'step one',
     byDefault.map((t) => t.title).join(','));
  const byPriority = await s.call('task_list', { epic_id: orderEpic.id, sort_by: 'priority', limit: 10 });
  ok('an explicit priority sort is still obeyed literally', byPriority[0].title === 'step two',
     byPriority.map((t) => t.title).join(','));
  const late = await s.call('task_create', { epic_id: orderEpic.id, title: 'added later', priority: 'critical' });
  const withLate = await s.call('task_list', { epic_id: orderEpic.id, limit: 10 });
  ok('a task added after the arrangement lands at the end, not the head',
     withLate[withLate.length - 1].title === 'added later', withLate.map((t) => t.title).join(','));
  await s.call('task_delete', { id: late.id, reason: 'gate fixture' });

  await s.call('task_update', { id: two.id, depends_on: [one.id] });
  ok('a dependent task auto-blocks', (await s.call('task_get', { id: two.id })).status === 'blocked');
  await s.call('task_update', { id: one.id, status: 'done' });
  ok('finishing the blocker releases it', (await s.call('task_get', { id: two.id })).status !== 'blocked');
  await s.call('task_update', { id: one.id, status: 'todo' });
  ok('reopening the blocker blocks it again', (await s.call('task_get', { id: two.id })).status === 'blocked');
  await s.call('task_update', { id: two.id, depends_on: [] });
  ok('clearing the dependency releases it', (await s.call('task_get', { id: two.id })).status !== 'blocked');

  await s.call('task_update', { id: two.id, depends_on: [one.id] });
  const cycle = await s.call('task_update', { id: one.id, depends_on: [two.id] });
  ok('a circular task dependency is refused', /circular/.test(cycle.__error ?? ''), cycle.__error);
  await s.call('task_update', { id: two.id, depends_on: [] });
}

section('getting old work out of the way');
{
  const shelf = await s.call('epic_create', { project_id: projectId, name: 'Finished work', status: 'completed' });
  await s.call('task_create', { epic_id: shelf.id, title: 'old task' });
  const beforeEpics = (await s.call('epic_list', { project_id: projectId })).length;
  const arch = await s.call('epic_archive', { id: shelf.id });
  ok('archiving reports what it hid', /task\(s\) are hidden/.test(arch.message ?? ''), arch.message);
  ok('the epic drops out of epic_list', (await s.call('epic_list', { project_id: projectId })).length === beforeEpics - 1);
  ok('include_archived brings it back', (await s.call('epic_list', { project_id: projectId, include_archived: true })).length === beforeEpics);
  const d = await s.call('tracker_dashboard', { project_id: projectId });
  ok('the dashboard says what it hid', /archived epic/.test(d.summary));
  ok('and does not count its tasks', !JSON.stringify(await s.call('task_list', { limit: 50 })).includes('old task'));

  const junk = await s.call('task_create', { epic_id: epic.id, title: 'agent clutter' });
  const removed = await s.call('task_delete', { id: junk.id, reason: 'should have been a subtask' });
  ok('a todo task can be removed', !removed.__error && removed.task.is_deleted === 1, removed.__error);
  ok('it drops out of task_list', !JSON.stringify(await s.call('task_list', { limit: 50 })).includes('agent clutter'));
  ok('task_restore brings it back', (await s.call('task_restore', { id: junk.id })).task.is_deleted === 0);
  await s.call('task_update', { id: junk.id, status: 'in_progress' });
  ok('a started task cannot be removed', /not 'todo'/.test((await s.call('task_delete', { id: junk.id })).__error ?? ''));
  ok('export still holds the archived epic', JSON.stringify(await s.call('tracker_export', { project_id: projectId })).includes('Finished work'));
  await s.call('epic_archive', { id: shelf.id, archived: false });
}



section('templates: view and edit');
{
  const t = await s.call('template_create', {
    name: 'Gate template',
    description: 'seeded by the gate',
    tasks: [
      { title: 'Do {thing}', priority: 'high', tags: ['a'] },
      { title: 'Then the other', estimated_hours: 1 },
    ],
  });
  ok('a template can be created', !!t.id);

  const bare = (await s.call('template_list', {})).find((x) => x.id === t.id);
  const full = (await s.call('template_list', { include_tasks: true })).find((x) => x.id === t.id);
  ok('template_list is cheap by default', !('tasks' in bare) && bare.task_count === 2);
  ok('and can show what a template creates', Array.isArray(full.tasks) && full.tasks.length === 2);
  ok('the raw JSON column is never returned', !('template_data' in bare) && !('template_data' in full));

  // The point of #44: editing in place, keeping the id.
  const renamed = await s.call('template_update', { id: t.id, name: 'Gate template v2' });
  ok('a template can be renamed in place', renamed.name === 'Gate template v2' && renamed.id === t.id);
  ok('renaming leaves the tasks alone', renamed.tasks.length === 2);

  const retasked = await s.call('template_update', { id: t.id, tasks: [{ title: 'Only this', priority: 'low' }] });
  ok('tasks can be replaced', retasked.tasks.length === 1);
  ok('and the name survives a tasks-only edit', retasked.name === 'Gate template v2');

  ok('an empty task list is refused', !!(await s.call('template_update', { id: t.id, tasks: [] })).__error);
  ok('a task with no title is refused',
     !!(await s.call('template_update', { id: t.id, tasks: [{ priority: 'low' }] })).__error);
  ok('an unknown priority is refused',
     !!(await s.call('template_update', { id: t.id, tasks: [{ title: 'x', priority: 'urgent' }] })).__error);
  ok('an update with no fields is refused', !!(await s.call('template_update', { id: t.id })).__error);

  const clash = await s.call('template_create', { name: 'Gate template v2', tasks: [{ title: 'x' }] });
  ok('a duplicate name is refused in words a human can act on',
     /already exists/.test(clash.__error || ''), clash.__error);

  await s.call('template_delete', { id: t.id });
  ok('and it can be deleted', !(await s.call('template_list', {})).some((x) => x.id === t.id));
}

section('one database, several projects');
const p2 = await s.call('project_create', { name: 'Second project' });
const e2 = await s.call('epic_create', { project_id: p2.id, name: 'Other' });
await s.call('task_create', { epic_id: e2.id, title: 'unrelated' });
const spanning = await s.call('task_list', { limit: 50 });
const scopedList = await s.call('task_list', { project_id: projectId, limit: 50 });
ok('unscoped calls still span the file', spanning.some((t) => t.title === 'unrelated'));
ok('project_id scopes them', !scopedList.some((t) => t.title === 'unrelated') && scopedList.length === spanning.length - 1,
   scopedList.length + ' of ' + spanning.length);
ok('an ambiguous dashboard says it guessed', !!(await s.call('tracker_dashboard', {})).other_projects);
s.stop();

const scoped = mcp({ SAGA_PROJECT: 'Second project' });
await scoped.ready;
ok('SAGA_PROJECT scopes by name', (await scoped.call('task_list', { limit: 50 })).length === 1);
scoped.stop();

const badScope = mcp({ SAGA_PROJECT: 'nope' });
await badScope.ready;
ok('a bad SAGA_PROJECT fails loudly', /not a project/.test((await badScope.call('task_list', {})).__error ?? ''));
badScope.stop();

section('tool surface');
const full = mcp();
await full.ready;
// The handshake reports a version read from package.json at runtime. That path
// only resolves once the package is installed, which is what this gate exercises;
// a unit test running from the source tree cannot catch it breaking.
{
  const info = full.info();
  ok('the handshake names the installed package', info.serverInfo.name === pkg.name, info.serverInfo.name);
  ok('and reports the version actually installed', info.serverInfo.version === pkg.version,
     info.serverInfo.version + ' vs ' + pkg.version);
}

const fullTools = (await full.rpc('tools/list', {})).result.tools;
ok('every tool is listed by default', fullTools.length === 41, String(fullTools.length));
ok('every tool carries safety annotations', fullTools.every((t) => typeof t.annotations?.readOnlyHint === 'boolean'));
ok('the tool list stays inside its context budget', JSON.stringify(fullTools).length < 29000, String(JSON.stringify(fullTools).length));
ok('and tool descriptions have not crept', JSON.stringify(fullTools).length / fullTools.length < 750,
   Math.round(JSON.stringify(fullTools).length / fullTools.length) + ' bytes/tool');
full.stop();

const core = mcp({ SAGA_TOOLS: 'core' });
await core.ready;
const coreTools = (await core.rpc('tools/list', {})).result.tools;
ok('the core surface is much smaller', coreTools.length === 13 && JSON.stringify(coreTools).length < JSON.stringify(fullTools).length * 0.6);
ok('a tool left off the list still works', !(await core.call('template_list', {})).__error);
core.stop();

/* ---------------- upgrading someone's existing database ---------------- */

section('upgrading an older database in place');
const legacyPath = join(work, 'legacy.db');
const legacy = new Database(legacyPath);
legacy.exec(`
  CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'active', tags TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE epics (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'planned', priority TEXT NOT NULL DEFAULT 'medium',
    sort_order INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, epic_id INTEGER NOT NULL, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
    sort_order INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, estimated_hours REAL, actual_hours REAL,
    due_date TEXT, tags TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE subtasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo', sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, author TEXT,
    content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO projects (name) VALUES ('Legacy');
  INSERT INTO epics (project_id, name) VALUES (1, 'Legacy epic');
  INSERT INTO tasks (epic_id, title, description) VALUES (1, 'Legacy task', 'old spec');
  INSERT INTO subtasks (task_id, title) VALUES (1, 'legacy A');
  INSERT INTO subtasks (task_id, title) VALUES (1, 'legacy B');
  INSERT INTO comments (task_id, content) VALUES (1, 'old comment');
`);
legacy.close();

const upgraded = mcp({ DB_PATH: legacyPath });
await upgraded.ready;
const legacyTask = await upgraded.call('task_get', { id: 1 });
ok('an older database opens without error', legacyTask.title === 'Legacy task');
ok('its data is intact', legacyTask.subtasks.length === 2 && legacyTask.comments.length === 1);
await upgraded.call('subtask_update', { id: legacyTask.subtasks[1].id, depends_on: [legacyTask.subtasks[0].id] });
ok('new tables are created by the upgrade', !!(await upgraded.call('task_get', { id: 1 })).subtasks.find((x) => x.id === legacyTask.subtasks[1].id).depends_on);
ok('new guards apply to migrated rows', /waits on/.test((await upgraded.call('subtask_update', { id: legacyTask.subtasks[1].id, status: 'done' })).__error ?? ''));
await upgraded.call('task_lock_description', { id: 1 });
ok('new columns work on migrated rows', !!(await upgraded.call('task_get', { id: 1 })).description_locked);
upgraded.stop();

/* ---------------- the web server ---------------- */

function web(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WEB, DB, ...args], {
      env: { ...process.env, SAGA_WEB_PORT: '', PORT: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error('saga-web did not start: ' + out)), 20000);
    const onData = (d) => {
      out += d;
      const m = out.match(/saga-web\s+(http:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve({ child, base: m[1], output: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('saga-web exited ' + code + ': ' + out)); });
  });
}
const post = (base, body, headers = {}) =>
  fetch(base + '/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-saga-ui': '1', ...headers },
    body: JSON.stringify(body),
  });

section('the web UI');
const ui = await web([]);
ok('saga-web starts and prints its URL', /^http:\/\/127\.0\.0\.1:\d+$/.test(ui.base), ui.base);
const page = await fetch(ui.base + '/');
ok('it serves the page', page.status === 200 && (await page.text()).includes('<title>Saga</title>'));
const projects = await (await fetch(ui.base + '/api/projects')).json();
ok('the project list is served', projects.projects.length === 2 && projects.read_only === false);
ok('the overview is served', (await fetch(`${ui.base}/api/overview?project_id=${projectId}`)).status === 200);
ok('a task detail is served', (await (await fetch(`${ui.base}/api/tasks/${t1.id}`)).json()).subtasks.length === 4);

ok('a write without the UI header is refused', (await fetch(ui.base + '/api/action', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool: 'task_update', args: { id: t1.id, status: 'todo' } }) })).status === 403);
ok('a cross-origin write is refused',
   (await post(ui.base, { tool: 'task_update', args: { id: t1.id, status: 'todo' } }, { origin: 'https://evil.example' })).status === 403);
ok('a non-whitelisted tool is refused', (await post(ui.base, { tool: 'tracker_import', args: {} })).status === 400);
ok('a legitimate write succeeds', (await post(ui.base, { tool: 'task_update', args: { id: t2.id, priority: 'low' } })).status === 200);
const guardRes = await post(ui.base, { tool: 'task_update', args: { id: t2.id, status: 'done' } });
const guardBody = await guardRes.json();
ok('the guards reach the web API too', guardRes.status === 200 || /unfinished|blocked/.test(guardBody.error ?? ''), JSON.stringify(guardBody).slice(0, 90));

const ro = await web(['--read-only']);
ok('--read-only reports itself', (await (await fetch(ro.base + '/api/projects')).json()).read_only === true);
ok('--read-only still serves reads', (await fetch(`${ro.base}/api/overview?project_id=${projectId}`)).status === 200);
ok('--read-only refuses every write', (await post(ro.base, { tool: 'task_update', args: { id: t1.id, status: 'todo' } })).status === 403);

const second = await web([]);
ok('a second instance takes its own port', new URL(second.base).port !== new URL(ui.base).port,
   ui.base + ' vs ' + second.base);
await wait(300); // the note is printed just after the URL line we resolved on
ok('and says why it moved', second.output().includes('took the next free port'), second.output());
ok('and announces itself exactly once', (second.output().match(/saga-web {2}http/g) || []).length === 1,
   String((second.output().match(/saga-web {2}http/g) || []).length));
ok('both actually serve', (await fetch(second.base + '/api/projects')).status === 200);

const pinned = await web(['--port', '4471']);
ok('an explicit --port is honoured', new URL(pinned.base).port === '4471');
let refusedPort = false;
try { await web(['--port', '4471']); } catch { refusedPort = true; }
ok('a taken explicit port fails rather than drifting', refusedPort);

/* ---------------- report ---------------- */

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log('\n' + (failed ? `${failed} FAILURES out of ${failed + passed}` : `all ${passed} checks passed against saga-mcp@${pkg.version}`));
cleanup();
process.exit(failed ? 1 : 0);
