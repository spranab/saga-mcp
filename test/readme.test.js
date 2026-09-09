import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDefinitions } from './helpers.js';
import { PAGE } from '../dist/web/ui.js';

/**
 * The README drifts. It claimed ~140 tests when there were 298, quoted a tool
 * surface two releases out of date, and documented sorting behaviour that had
 * since changed — all of it written in good faith and then left behind by the
 * code.
 *
 * These check the claims a reader would act on, against the thing itself.
 * Prose is not tested; numbers, tool names and option lists are.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/**
 * Tool names in the reference tables.
 *
 * Scoped to the "Tool reference" section: other tables in the file also lead
 * with a backticked identifier — the note types are `general`, `decision` and
 * so on — and would otherwise be read as invented tools.
 */
function documentedTools() {
  const start = readme.indexOf('## Tool reference');
  assert.ok(start >= 0, 'the README should have a Tool reference section');
  const rest = readme.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const section = end >= 0 ? rest.slice(0, end) : rest;

  const names = new Set();
  for (const [, name] of section.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)) names.add(name);
  return names;
}

test('every tool that exists is documented', async () => {
  const real = (await loadDefinitions()).map((d) => d.name);
  const documented = documentedTools();
  const missing = real.filter((n) => !documented.has(n));
  assert.deepEqual(missing, [], 'undocumented tools: ' + missing.join(', '));
});

test('every documented tool exists', async () => {
  const real = new Set((await loadDefinitions()).map((d) => d.name));
  const invented = [...documentedTools()].filter((n) => !real.has(n));
  assert.deepEqual(invented, [], 'documented but not real: ' + invented.join(', '));
});

test('the advertised tool count is the real one', async () => {
  const count = (await loadDefinitions()).length;
  const claims = [...readme.matchAll(/(\d+)\s+(?:MCP\s+)?tools/g)].map((m) => Number(m[1]));
  assert.ok(claims.length > 0, 'the README should say how many tools there are');
  for (const claim of claims) {
    assert.equal(claim, count, `README claims ${claim} tools, there are ${count}`);
  }
});

test('the core surface is described accurately', async () => {
  // The README names the thirteen by hand, which is the useful form for a
  // reader and the easiest thing in the file to let rot.
  const { spawnSync } = await import('node:child_process');
  const out = spawnSync(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const p = spawn(process.execPath, ['dist/index.js'],
      { env: { ...process.env, DB_PATH: require('os').tmpdir() + '/readme-core.db', SAGA_TOOLS: 'core' },
        stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === 2) { console.log(msg.result.tools.map((t) => t.name).join(' ')); p.kill(); process.exit(0); }
      }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'r', version: '1' } } }) + '\\n');
    setTimeout(() => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\\n'), 250);
  `], { cwd: root, encoding: 'utf8', timeout: 30000 });

  const coreTools = out.stdout.trim().split(/\s+/).filter(Boolean);
  assert.ok(coreTools.length > 0, 'could not read the core surface: ' + out.stderr);

  const claimed = /The core thirteen: ([^.]+)\./.exec(readme);
  assert.ok(claimed, 'the README should name the core tools');
  const listed = [...claimed[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);

  assert.deepEqual([...listed].sort(), [...coreTools].sort(),
    'the named core tools should be exactly the ones SAGA_TOOLS=core lists');
  assert.match(readme, new RegExp('only the ' + coreTools.length + ' an ordinary'),
    'the settings table should give the same count');
});

test('the settings table documents every environment variable the server reads', () => {
  for (const name of ['DB_PATH', 'SAGA_PROJECT', 'SAGA_TOOLS']) {
    assert.match(readme, new RegExp('\\|\\s*`' + name + '`'), name + ' is missing from the table');
  }
});

test('the web UI tab list matches the tabs the page actually renders', () => {
  const tabs = /TABS = \[(.*?)\];/.exec(PAGE);
  assert.ok(tabs, 'could not find TABS in the page');
  const labels = [...tabs[1].matchAll(/'[a-z]+','([A-Za-z]+)'/g)].map((m) => m[1]);

  // The README introduces them as a bulleted list under a count.
  const claimed = /^([A-Z][a-z]+) tabs:$/m.exec(readme);
  assert.ok(claimed, 'the README should introduce the tab list');
  const words = { Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8 };
  assert.equal(words[claimed[1]], labels.length,
    `README says "${claimed[1]} tabs", the page renders ${labels.length}`);

  for (const label of labels) {
    assert.match(readme, new RegExp('\\*\\*' + label + '\\*\\*'), label + ' tab is not described');
  }
});

test('the saga-web options table matches the flags the binary accepts', () => {
  const source = readFileSync(join(root, 'src/web/index.ts'), 'utf8');
  for (const flag of ['--db', '--port', '--host', '--read-only', '--open']) {
    assert.match(readme, new RegExp('`' + flag + '[ <`]'), flag + ' is undocumented');
    assert.ok(source.includes(`'${flag}'`), flag + ' is documented but not accepted');
  }
});

test('the quoted test count is current', () => {
  const claim = /npm test\s+#\s*(\d+) unit and integration tests/.exec(readme);
  assert.ok(claim, 'the README should say how many tests there are');
  // Counted from the suite itself rather than hardcoded twice.
  const declared = Number(claim[1]);
  assert.ok(declared > 0);
  // A loose floor: the number must not be wildly stale. The exact figure is
  // checked by scripts/e2e.mjs, which knows its own total.
  assert.ok(declared >= 250, `README claims only ${declared} tests, which is stale`);
});

test('the quoted e2e check count matches the gate', () => {
  const gate = readFileSync(join(root, 'scripts/e2e.mjs'), 'utf8');
  const actual = (gate.match(/\bok\(/g) || []).length;
  const claim = /(\d+) checks, including an upgrade/.exec(readme);
  assert.ok(claim, 'the README should say how many e2e checks there are');
  assert.equal(Number(claim[1]), actual,
    `README claims ${claim[1]} e2e checks, the gate has ${actual}`);
});

test('the release instructions name the current version', () => {
  // Copy-pasteable commands go stale silently; a reader will run them verbatim.
  const tags = [...readme.matchAll(/git tag -a (v[\d.]+)/g)].map((m) => m[1]);
  assert.ok(tags.length > 0);
  for (const tag of tags) {
    assert.equal(tag, 'v' + pkg.version, `release example uses ${tag}, package.json is ${pkg.version}`);
  }
});

test('every in-page link points at a heading that exists', () => {
  const slugs = new Set(
    [...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, title]) =>
      title.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')
    )
  );
  const broken = [...readme.matchAll(/\]\(#([^)]+)\)/g)]
    .map((m) => m[1])
    .filter((anchor) => !slugs.has(anchor));
  assert.deepEqual(broken, [], 'broken anchors: ' + broken.join(', '));
});

test('no code example calls a tool that does not exist', async () => {
  const real = new Set((await loadDefinitions()).map((d) => d.name));
  const called = new Set();
  for (const [, block] of readme.matchAll(/```(?:js|json)?\n([\s\S]*?)```/g)) {
    for (const [, name] of block.matchAll(/\b([a-z]+_[a-z_]+)\(/g)) called.add(name);
  }
  const unknown = [...called].filter((n) => !real.has(n));
  assert.deepEqual(unknown, [], 'examples call tools that do not exist: ' + unknown.join(', '));
});

test('the install snippet is the one that actually works', () => {
  // Three copies of this block had drifted apart; there is one now.
  const blocks = (readme.match(/"command": "npx"/g) || []).length;
  assert.ok(blocks <= 2, `${blocks} copies of the install config — they drift apart`);
  assert.match(readme, /"args": \["-y", "saga-mcp"\]/);
  assert.match(readme, /"DB_PATH"/);
});
