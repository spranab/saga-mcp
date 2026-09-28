/**
 * Regenerates the README's MCP demo GIF.
 *
 *   npm run demo-gif
 *
 * Same reasoning as scripts/screenshots.mjs: a hand-recorded terminal clip
 * goes stale the moment a tool's output changes shape, so this drives the
 * real stdio server with the exact calls from the README's "Your first
 * session" example and renders their real results — not scripted text —
 * into a console-styled page, captured frame by frame over the Chrome
 * DevTools Protocol (same technique as the screenshots, no browser
 * automation dependency to install), then encoded to a GIF by the system's
 * ffmpeg.
 */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs', 'screenshots', 'mcp-demo.gif');
const DEBUG_PORT = 9334;
const DB = join(tmpdir(), 'saga-demo-gif.tracker.db');
const FRAMES = join(tmpdir(), 'saga-demo-gif-frames');
const FPS = 5;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- find Chrome and ffmpeg, the same way screenshots.mjs does ---------------- */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('No Chrome or Edge found. Set CHROME_PATH to the browser binary.');
  process.exit(1);
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { /* not on PATH */ }
  return null;
}
const ffmpeg = findFfmpeg();
if (!ffmpeg) {
  console.error('No ffmpeg found. Install it (e.g. "winget install Gyan.FFmpeg" or "apt install ffmpeg"),');
  console.error('or set FFMPEG_PATH to the binary.');
  process.exit(1);
}

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  try { rmSync(DB + suffix); } catch { /* not there */ }
}

/* ---------------- drive the real MCP server, over real stdio ---------------- */

function mcp() {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: root, env: { ...process.env, DB_PATH: DB }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  let buf = '';
  const pending = new Map();
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
  const ready = (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo-gif', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  })();
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return JSON.parse(r.result.content[0].text);
  };
  return { call, ready, stop: () => child.kill() };
}

console.log('driving the real MCP server');
const s = mcp();
await s.ready;

// Exactly the README's "Your first session" example — the transcript is
// built from what the server actually returned, not written by hand.
const steps = [];
const init = await s.call('tracker_init', { project_name: 'E-Commerce API' });
steps.push({
  cmd: 'tracker_init({ project_name: "E-Commerce API" })',
  res: `created project #${init.project.id} "${init.project.name}"`,
});

const epic = await s.call('epic_create', { project_id: init.project.id, name: 'Authentication', priority: 'high' });
steps.push({
  cmd: `epic_create({ project_id: ${init.project.id}, name: "Authentication", priority: "high" })`,
  res: `created epic #${epic.id} "${epic.name}"`,
});

const t1 = await s.call('task_create', { epic_id: epic.id, title: 'Design auth schema', priority: 'critical' });
steps.push({
  cmd: `task_create({ epic_id: ${epic.id}, title: "Design auth schema", priority: "critical" })`,
  res: `created task #${t1.id} · ${t1.status}`,
});

const t2 = await s.call('task_create', { epic_id: epic.id, title: 'Implement JWT auth', depends_on: [t1.id] });
steps.push({
  cmd: `task_create({ epic_id: ${epic.id}, title: "Implement JWT auth", depends_on: [${t1.id}] })`,
  res: `created task #${t2.id} · ${t2.status} (waiting on #${t1.id})`,
});

const t3 = await s.call('task_create', { epic_id: epic.id, title: 'Add OAuth2 Google login', depends_on: [t2.id] });
steps.push({
  cmd: `task_create({ epic_id: ${epic.id}, title: "Add OAuth2 Google login", depends_on: [${t2.id}] })`,
  res: `created task #${t3.id} · ${t3.status} (waiting on #${t2.id})`,
});

await s.call('task_update', { id: t1.id, status: 'done' });
const t2After = await s.call('task_get', { id: t2.id });
steps.push({
  cmd: `task_update({ id: ${t1.id}, status: "done" })`,
  res: `#${t1.id} done → #${t2.id} auto-unblocked (${t2After.status})`,
});

const next = await s.call('tracker_next', { project_id: init.project.id });
steps.push({ cmd: 'tracker_next({})', res: next.summary });

s.stop();
console.log(steps.length + ' steps captured from the real server');

/* ---------------- render the transcript into a console-styled page ---------------- */

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; background:#0d1117; }
  .win { width:720px; margin:20px auto; border-radius:10px; overflow:hidden;
         box-shadow:0 12px 28px rgba(0,0,0,.45); font-family:ui-monospace,Consolas,Menlo,monospace; }
  .bar { background:#21262d; padding:10px 14px; display:flex; align-items:center; gap:7px; }
  .dot { width:11px; height:11px; border-radius:50%; }
  .bar .title { flex:1; text-align:center; color:#8b949e; font-size:12px; margin-right:40px; }
  .body { background:#0d1117; color:#c9d1d9; font-size:14px; line-height:1.65;
          padding:16px 18px; height:480px; overflow:auto; }
  .cmd { color:#e6edf3; }
  .cmd .p { color:#58a6ff; margin-right:8px; }
  .res { color:#7ee787; margin:0 0 14px 20px; }
  .entry { opacity:0; transition:opacity .15s; }
  .entry.show { opacity:1; }
</style></head><body>
  <div class="win">
    <div class="bar">
      <span class="dot" style="background:#ff5f56"></span>
      <span class="dot" style="background:#ffbd2e"></span>
      <span class="dot" style="background:#27c93f"></span>
      <span class="title">agent session · saga-mcp</span>
    </div>
    <div class="body" id="body"></div>
  </div>
<script>
var STEPS = ${JSON.stringify(steps)};
var body = document.getElementById('body');
STEPS.forEach(function (s, i) {
  var e = document.createElement('div');
  e.className = 'entry'; e.id = 'entry' + i;
  e.innerHTML = '<div class="cmd"><span class="p">&#9656;</span>' + s.cmd.replace(/</g,'&lt;') + '</div>' +
                '<div class="res" id="res' + i + '" style="visibility:hidden">&rarr; ' + s.res.replace(/</g,'&lt;') + '</div>';
  body.appendChild(e);
});
function revealCmd(i) {
  document.getElementById('entry' + i).classList.add('show');
  body.scrollTop = body.scrollHeight;
}
function revealResult(i) {
  document.getElementById('res' + i).style.visibility = 'visible';
  body.scrollTop = body.scrollHeight;
}
</script>
</body></html>`;

console.log('starting a headless browser');
const profile = join(tmpdir(), 'saga-demo-gif-profile-' + Date.now());
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
if (!target) { console.error('the browser did not start'); browser.kill(); process.exit(1); }

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
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 560, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'about:blank' });
await wait(200);
await evaluate(`document.open(); document.write(${JSON.stringify(HTML)}); document.close();`);
await wait(300);

let frameIdx = 0;
async function captureFrame(holdCount) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  const first = join(FRAMES, 'frame-' + String(frameIdx).padStart(4, '0') + '.png');
  writeFileSync(first, buf);
  frameIdx++;
  for (let k = 1; k < holdCount; k++) {
    copyFileSync(first, join(FRAMES, 'frame-' + String(frameIdx).padStart(4, '0') + '.png'));
    frameIdx++;
  }
}

console.log('capturing frames');
await captureFrame(FPS); // a one-second hold on the empty console before the first command
for (let i = 0; i < steps.length; i++) {
  await evaluate(`revealCmd(${i})`);
  await wait(80);
  await captureFrame(Math.round(FPS * 0.5));
  await evaluate(`revealResult(${i})`);
  await wait(80);
  const isLast = i === steps.length - 1;
  await captureFrame(Math.round(FPS * (isLast ? 3.5 : 1.1)));
}

ws.close();
browser.kill();
await wait(300);

console.log(frameIdx + ' frames -> encoding with ffmpeg');
mkdirSync(dirname(OUT), { recursive: true });
execFileSync(ffmpeg, [
  '-y', '-framerate', String(FPS), '-i', join(FRAMES, 'frame-%04d.png'),
  '-vf', 'split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
  '-loop', '0', OUT,
], { stdio: 'inherit' });

rmSync(FRAMES, { recursive: true, force: true });
console.log('wrote ' + OUT);
