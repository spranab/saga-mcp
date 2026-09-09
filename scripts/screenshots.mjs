/**
 * Regenerates the README screenshots.
 *
 *   npm run screenshots
 *
 * Screenshots rot the same way documentation does — a UI changes and the
 * picture keeps showing last month's layout — so they are generated from a
 * scripted demo database rather than captured by hand.
 *
 * Driven over the Chrome DevTools Protocol, which buys two things a plain
 * `--screenshot` cannot: prefers-color-scheme emulation, so the light and dark
 * pair come from one run, and a real signal that rendering finished instead of
 * a hopeful sleep. Node 22+ ships a WebSocket client, so there is no dependency
 * to install.
 */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs', 'screenshots');
const PORT = 4611;
const DEBUG_PORT = 9333;
const DB = join(tmpdir(), 'saga-screenshots.tracker.db');

/** The path shown in the header, in place of whichever scratch file we used. */
const DISPLAY_PATH = '~/projects/ecommerce-api/.tracker.db';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chromePath = CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('No Chrome or Edge found. Set CHROME_PATH to the browser binary.');
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

console.log('building the demo database');
execFileSync(process.execPath, ['scripts/demo-db.mjs', DB], { cwd: root, stdio: 'inherit' });

console.log('starting saga-web');
const server = spawn(process.execPath, ['dist/web/index.js', '--port', String(PORT)], {
  cwd: root, env: { ...process.env, DB_PATH: DB }, stdio: ['ignore', 'ignore', 'inherit'],
});
await wait(2500);

const profile = join(tmpdir(), 'saga-shot-profile-' + Date.now());
const browser = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await wait(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch { /* not up yet */ }
}
if (!target) {
  console.error('the browser did not start');
  server.kill(); browser.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');

const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true });

async function waitFor(expression, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const { result } = await evaluate(expression);
    if (result.value) return true;
    await wait(200);
  }
  return false;
}

/** How tall the frame needs to be for the content actually on screen. */
const CONTENT_HEIGHT = `(function () {
  var bottom = 0;
  var view = document.querySelector('#view');
  if (view) {
    for (var i = 0; i < view.children.length; i++) {
      var box = view.children[i].getBoundingClientRect();
      if (box.height) bottom = Math.max(bottom, box.bottom + window.scrollY);
    }
  }
  var drawer = document.querySelector('.drawer');
  if (drawer) bottom = Math.max(bottom, drawer.scrollHeight);
  return JSON.stringify({
    width: document.documentElement.clientWidth,
    height: Math.ceil(bottom) + 28,
    page: document.documentElement.scrollHeight
  });
})()`;

async function capture({ name, hash, ready, before, theme }) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: theme }],
  });

  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${hash || ''}` });
  await wait(900);
  if (ready && !(await waitFor(ready))) {
    throw new Error(`${name}: never became ready (${ready})`);
  }
  if (before) {
    await evaluate(before);
    await wait(900);
  }

  // The header shows the resolved database path, which here is a scratch file
  // in a temp directory. Substitute the path a reader would actually have, for
  // the same reason the data is a demo project rather than a real one.
  await evaluate(`document.getElementById('dbpath').textContent = ${JSON.stringify(DISPLAY_PATH)}`);
  await wait(400);

  const { result } = await evaluate(CONTENT_HEIGHT);
  const size = JSON.parse(result.value);
  const height = Math.max(420, Math.min(size.height || size.page, 2600));

  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size.width, height, scale: 1 },
  });
  const file = join(OUT, `${name}-${theme}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  ${name}-${theme}.png  ${size.width * 2}x${height * 2}`);
}

const SHOTS = [
  { name: 'overview', hash: '#tab=overview', ready: "!!document.querySelector('.tiles')" },
  { name: 'epics', hash: '#tab=epics', ready: "!!document.querySelector('.epic-head')",
    before: "document.querySelector('#expandAll').click()" },
  { name: 'board', hash: '#tab=board', ready: "!!document.querySelector('.board')" },
  { name: 'task', hash: '#task=2', ready: "!!document.querySelector('.drawer .body')" },
  { name: 'templates', hash: '#tab=templates', ready: "!!document.querySelector('[data-template-card]')" },
];

let failed = false;
for (const theme of ['light', 'dark']) {
  console.log(theme + ':');
  for (const shot of SHOTS) {
    try {
      await capture({ ...shot, theme });
    } catch (err) {
      console.error('  ! ' + err.message);
      failed = true;
    }
  }
}

ws.close();
browser.kill();
server.kill();
await wait(400);
process.exit(failed ? 1 : 0);
