import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tempDbPath, loadTools, seed } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = tempDbPath('saga-stdio');
seed(await loadTools(dbPath));

/** Speak JSON-RPC to a freshly spawned MCP server over stdio. */
function startServer(env = {}) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, SAGA_TOOLS: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));

  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });

  let id = 0;
  const send = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });

  const ready = (async () => {
    await send('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  })();

  return { child, send, ready, stderr: () => stderr, stop: () => child.kill() };
}

const servers = [];
async function server(env) {
  const s = startServer(env);
  servers.push(s);
  await s.ready;
  return s;
}
after(() => servers.forEach((s) => s.stop()));

test('tools/list returns every tool by default', async () => {
  const s = await server();
  const res = await s.send('tools/list', {});
  assert.equal(res.result.tools.length, 40);
});

test('SAGA_TOOLS=core lists only the core surface, and it is much smaller', async () => {
  const full = await server();
  const core = await server({ SAGA_TOOLS: 'core' });
  const fullTools = (await full.send('tools/list', {})).result.tools;
  const coreTools = (await core.send('tools/list', {})).result.tools;

  assert.equal(coreTools.length, 13);
  assert.ok(coreTools.every((t) => fullTools.some((f) => f.name === t.name)), 'core must be a subset');
  for (const required of ['tracker_dashboard', 'task_create', 'task_list', 'task_get', 'task_update']) {
    assert.ok(coreTools.some((t) => t.name === required), `core is missing ${required}`);
  }
  const ratio = JSON.stringify(coreTools).length / JSON.stringify(fullTools).length;
  assert.ok(ratio < 0.6, `core should be well under half the full list, got ${ratio.toFixed(2)}`);
});

test('a tool left off the core list is still callable by name', async () => {
  const s = await server({ SAGA_TOOLS: 'core' });
  const listed = (await s.send('tools/list', {})).result.tools.map((t) => t.name);
  assert.ok(!listed.includes('template_list'), 'precondition: template_list is not core');
  const res = await s.send('tools/call', { name: 'template_list', arguments: {} });
  assert.ok(!res.result.isError, 'unlisted tools must still work when called directly');
});

test('an unrecognised SAGA_TOOLS value warns and falls back to the full list', async () => {
  const s = await server({ SAGA_TOOLS: 'nonsense' });
  const res = await s.send('tools/list', {});
  assert.equal(res.result.tools.length, 40);
  assert.match(s.stderr(), /Unknown SAGA_TOOLS/);
});

test('tool results are compact JSON, not pretty-printed', async () => {
  const s = await server();
  const res = await s.send('tools/call', { name: 'tracker_dashboard', arguments: {} });
  const text = res.result.content[0].text;
  assert.doesNotThrow(() => JSON.parse(text), 'still valid JSON');
  assert.ok(!/\n\s\s/.test(text), 'no indentation');
});

test('errors come back as readable text, not a JSON blob', async () => {
  const s = await server();
  const res = await s.send('tools/call', { name: 'task_get', arguments: { id: 999999 } });
  assert.ok(res.result.isError);
  assert.match(res.result.content[0].text, /Task 999999 not found/);
});

test('an unknown tool name is an error, not a crash', async () => {
  const s = await server();
  const res = await s.send('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.ok(res.result.isError);
  assert.match(res.result.content[0].text, /Unknown tool/);
});

test('a round trip through the server actually reads the database', async () => {
  const s = await server();
  const res = await s.send('tools/call', { name: 'task_list', arguments: {} });
  const rows = JSON.parse(res.result.content[0].text);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => !('metadata' in r)), 'list rows stay slim over the wire');
});
