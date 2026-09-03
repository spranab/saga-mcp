import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PAGE } from '../dist/web/ui.js';

/**
 * The page script is one big string, so a bad edit can leave it syntactically
 * valid and behaviourally broken — an early `return` before the rest of a
 * function body compiles fine and silently returns undefined. That happened
 * once to reloadProjects() and broke every refresh in the app.
 *
 * These tests execute the real page script against minimal DOM stubs and check
 * the plumbing, which is cheap and needs no browser.
 */

const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];

function element() {
  const node = {
    innerHTML: '', textContent: '', value: '', hidden: false, checked: false,
    disabled: false, dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    style: {}, children: [],
    addEventListener() {}, removeEventListener() {}, remove() {},
    appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {},
  };
  return node;
}

/** Run the page with stubs, and a fetch that answers from `routes`. */
function runPage(routes = {}, hash = '') {
  const calls = [];
  const doc = {
    getElementById: () => element(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => element(),
    addEventListener() {},
    body: element(),
  };
  const listeners = {};
  const location = { hash, href: 'http://localhost/' + hash };
  const ctx = {
    document: doc,
    console,
    setTimeout, clearTimeout,
    history: { replaceState: (_a, _b, url) => { location.hash = String(url).replace(/^[^#]*/, ''); } },
    location,
    window: {
      addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
      location,
    },
    fetch: (path) => {
      calls.push(path);
      const body = routes[String(path).split('?')[0]] ?? routes[String(path)] ?? {};
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(body),
      });
    },
    Promise, JSON, Object, Array, Number, String, Boolean, Date, Math, Set, Map,
    isNaN, encodeURIComponent, parseInt, parseFloat, RegExp, Error,
  };
  ctx.globalThis = ctx;
  ctx.window.document = doc;
  createContext(ctx);
  runInContext(script, ctx);
  return { ctx, calls, listeners, location };
}

const emptyRoutes = { '/api/projects': { projects: [], db_path: '/tmp/x.tracker.db', read_only: false } };

test('the page script parses and runs without throwing', () => {
  assert.doesNotThrow(() => runPage(emptyRoutes));
});

test('reloadProjects returns a promise', () => {
  // The regression: an early `return` left this returning undefined, which
  // broke refresh() and every post-write update in the UI.
  const { ctx } = runPage(emptyRoutes);
  const result = ctx.reloadProjects();
  assert.ok(result && typeof result.then === 'function', 'reloadProjects must be thenable');
});

test('refresh returns a promise, so callers can chain off it', () => {
  const { ctx } = runPage(emptyRoutes);
  const result = ctx.refresh();
  assert.ok(result && typeof result.then === 'function', 'refresh must be thenable');
});

test('loadProject returns a promise even with no project selected', () => {
  const { ctx } = runPage(emptyRoutes);
  ctx.S.projectId = null;
  const result = ctx.loadProject();
  assert.ok(result && typeof result.then === 'function');
});

test('readHash parses project, tab and task', () => {
  const { ctx } = runPage(emptyRoutes, '#p=3&tab=board&task=42');
  // The result is created inside the vm, so its prototype differs from the
  // host's — compare fields rather than the object identity.
  const out = ctx.readHash();
  assert.equal(out.p, 3);
  assert.equal(out.tab, 'board');
  assert.equal(out.task, 42);
});

test('readHash ignores junk rather than throwing', () => {
  const cases = ['', '#', '#nonsense', '#p=abc&task=-1', '#tab=not-a-tab'];
  for (const hash of cases) {
    const { ctx } = runPage(emptyRoutes, hash);
    assert.doesNotThrow(() => ctx.readHash(), hash);
    const out = ctx.readHash();
    assert.ok(!('tab' in out) || ctx.TABS.some((t) => t[0] === out.tab), `bad tab survived: ${hash}`);
    assert.ok(!('p' in out) || out.p > 0, `bad project id survived: ${hash}`);
  }
});

test('syncHash writes the open task into the URL, and clears it again', () => {
  const { ctx, location } = runPage(emptyRoutes);
  ctx.S.projectId = 2;
  ctx.S.tab = 'epics';
  ctx.S.task = { id: 9 };
  ctx.syncHash();
  assert.match(location.hash, /p=2/);
  assert.match(location.hash, /tab=epics/);
  assert.match(location.hash, /task=9/);

  ctx.S.task = null;
  ctx.syncHash();
  assert.ok(!location.hash.includes('task='), location.hash);
});

test('the overview tab is the default and stays out of the URL', () => {
  const { ctx, location } = runPage(emptyRoutes);
  ctx.S.projectId = 1;
  ctx.S.tab = 'overview';
  ctx.S.task = null;
  ctx.syncHash();
  assert.ok(!location.hash.includes('tab='), location.hash);
});

test('a hashchange listener is registered, exactly once, before boot', () => {
  const { listeners } = runPage(emptyRoutes);
  assert.equal((listeners.hashchange ?? []).length, 1);
});

test('the hashchange listener survives a failing first fetch', () => {
  // Registration must not sit behind the boot request, or a server hiccup
  // leaves the page unable to respond to navigation.
  const doc = { getElementById: () => element(), querySelector: () => null,
                querySelectorAll: () => [], createElement: () => element(),
                addEventListener() {}, body: element() };
  const listeners = {};
  const ctx = {
    document: doc, console, setTimeout, clearTimeout,
    history: { replaceState() {} },
    location: { hash: '' },
    window: { addEventListener: (n, f) => { (listeners[n] ||= []).push(f); }, location: { hash: '' } },
    fetch: () => Promise.reject(new Error('network down')),
    Promise, JSON, Object, Array, Number, String, Boolean, Date, Math, Set, Map,
    isNaN, encodeURIComponent, parseInt, parseFloat, RegExp, Error,
  };
  ctx.globalThis = ctx;
  createContext(ctx);
  runInContext(script, ctx);
  assert.equal((listeners.hashchange ?? []).length, 1, 'listener must be registered before the boot fetch');
});

test('the task drawer offers a refresh control', () => {
  assert.ok(script.includes("id=\"refreshTask\""), 'drawer needs a refresh button');
  assert.ok(script.includes("target.id === 'refreshTask'"), 'and a handler for it');
});

test('every write still goes through the guarded action endpoint', () => {
  assert.ok(script.includes("'/api/action'"));
  assert.ok(script.includes("'x-saga-ui': '1'"), 'the CSRF header must not be dropped');
});
