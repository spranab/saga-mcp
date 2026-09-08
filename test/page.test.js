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
const css = PAGE.match(/<style>([\s\S]*?)<\/style>/)[1]
  .replace(/\/\*[\s\S]*?\*\//g, '');   // comments would leak into selectors

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

/* ---------- CSS cascade ---------- */

/** Every rule that declares `property`, in source order. */
function declarationsOf(property) {
  const out = [];
  for (const [, rawSelector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    // Split the declaration block by hand rather than building a regex from the
    // property name — it keeps this readable and avoids escaping surprises.
    let value = null;
    for (const part of body.split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      if (part.slice(0, colon).trim() !== property) continue;
      value = part.slice(colon + 1).trim();
    }
    if (value === null) continue;
    for (const sel of rawSelector.split(',').map((x) => x.trim())) {
      out.push({ sel, value });
    }
  }
  return out;
}

/** Rough specificity: [ids, classes+attributes+pseudo-classes, element types]. */
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
  const types = (sel.match(/(^|[\s>+~])[a-z]+/gi) || []).length;
  return [ids, classes, types];
}

/**
 * Does this selector apply to an <input type=checkbox> sitting inside the given
 * ancestor class? Deliberately narrow — it only understands the handful of
 * shapes this stylesheet uses.
 */
function appliesToCheckbox(sel, ancestorClasses) {
  if (sel.includes(':not([type=checkbox])')) return false;
  const parts = sel.split(/\s+/);
  const target = parts[parts.length - 1];
  if (target !== 'input' && target !== 'input[type=checkbox]') return false;
  const ancestors = parts.slice(0, -1);
  return ancestors.every((a) => ancestorClasses.includes(a));
}

/** The declaration that actually wins: highest specificity, latest on a tie. */
function winner(candidates) {
  let best = null;
  candidates.forEach((c, order) => {
    const spec = specificity(c.sel);
    if (!best) { best = { ...c, spec, order }; return; }
    for (let i = 0; i < 3; i++) {
      if (spec[i] !== best.spec[i]) { if (spec[i] > best.spec[i]) best = { ...c, spec, order }; return; }
    }
    best = { ...c, spec, order }; // equal specificity: later wins
  });
  return best;
}

test('a checkbox inside a form field keeps its natural width', () => {
  // Reported on #25: the checkbox filled its row and pushed the label onto the
  // next line. `.field input { width: 100% }` and `input[type=checkbox] { width: auto }`
  // had identical specificity, so whichever came last silently won. Asserting
  // the source order of two rules would be brittle, so resolve the cascade.
  const widths = declarationsOf('width');
  const applicable = widths.filter((d) => appliesToCheckbox(d.sel, ['.field', '.checkrow']));
  assert.ok(applicable.length > 0, 'expected at least one width rule to reach a checkbox');
  const won = winner(applicable);
  assert.notEqual(won.value, '100%',
    `a checkbox in a .field would be stretched by "${won.sel} { width: ${won.value} }"`);
  assert.equal(won.value, 'auto');
});

test('the deps checklist row lays out on one line', () => {
  assert.match(css, /\.checkrow \{[^}]*display: flex/);
  assert.match(css, /\.checkrow input\[type=checkbox\][^}]*width: auto/);
  assert.match(css, /\.checkrow input\[type=checkbox\][^}]*flex: none/);
});

test('ordinary text inputs in a field still fill the row', () => {
  // The fix must not quietly regress every other form field.
  const rule = declarationsOf('width').find((d) => d.sel === '.field input:not([type=checkbox])');
  assert.ok(rule, 'the .field input width rule should still exist');
  assert.equal(rule.value, '100%');
});

/* ---------- markdown (#38) ---------- */

/** The renderer as it actually ships, pulled out of the page and executed. */
function renderer() {
  const ctx = {
    console, JSON, Object, Array, Number, String, Boolean, Date, Math, Set, Map,
    RegExp, Error, isNaN, encodeURIComponent, parseInt, parseFloat,
    setTimeout, clearTimeout,
    document: { getElementById: () => element(), querySelector: () => null,
                querySelectorAll: () => [], createElement: () => element(),
                addEventListener() {}, body: element() },
    window: { addEventListener() {}, location: { hash: '' } },
    location: { hash: '' }, history: { replaceState() {} },
    fetch: () => Promise.reject(new Error('no network in this test')),
  };
  ctx.globalThis = ctx;
  createContext(ctx);
  runInContext(script, ctx);
  return ctx.md;
}
const md = renderer();
const NL = String.fromCharCode(10);

/** Every tag the renderer is permitted to emit. */
const ALLOWED_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
  'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th',
  'td', 'div', 'a', 'input', 'br']);

test('markdown renders the constructs a report actually uses', () => {
  assert.match(md('## Title'), /<h2/);
  assert.match(md('**bold**'), /<strong>bold<\/strong>/);
  assert.match(md('run `npm test` now'), /<code>npm test<\/code>/);
  assert.match(md('- one' + NL + '- two'), /<ul[^>]*>.*<li>one<\/li>/);
  assert.match(md('1. one' + NL + '2. two'), /<ol/);
  const table = md('| a | b |' + NL + '|---|---|' + NL + '| 1 | 2 |');
  assert.match(table, /<th>a<\/th>/);
  assert.match(table, /<td>1<\/td>/);
  assert.match(table, /md-tablewrap/, 'wide tables must scroll in their own box');
});

test('code spans keep their contents literal', () => {
  assert.match(md('`**not bold**`'), /<code>\*\*not bold\*\*<\/code>/);
  assert.ok(!md('```' + NL + '**x**' + NL + '```').includes('<strong>'));
});

test('raw HTML in the source can never reach the output as markup', () => {
  // The whole security design: everything is escaped BEFORE any rule runs, so
  // by the time a rule could match, `<` is already `&lt;`.
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="javascript:alert(1)">',
    '**<svg onload=alert(1)>**',
    '# <img src=x onerror=alert(1)>',
    '| <script>x</script> | b |' + NL + '|---|---|' + NL + '| c | d |',
    '> <script>alert(1)</script>',
    '- <script>alert(1)</script>',
    '<a href="javascript:alert(1)">x</a>',
  ];
  for (const attack of attacks) {
    const out = md(attack);
    const tags = [...out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
    const stray = tags.find((t) => !ALLOWED_TAGS.has(t));
    assert.equal(stray, undefined, `${attack} emitted <${stray}>`);
    const handlers = [...out.matchAll(/<[^>]+?\s(on[a-z]+)=/gi)].map((m) => m[1]);
    assert.deepEqual(handlers, [], `${attack} emitted an event handler`);
  }
});

test('only non-executable link schemes become links', () => {
  assert.match(md('[x](https://a.example)'), /href="https:\/\/a\.example"/);
  assert.match(md('[x](https://a.example)'), /rel="noopener noreferrer"/);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:x',
                     'data:text/html;base64,PHNjcmlwdD4=']) {
    const out = md('[x](' + bad + ')');
    assert.ok(!out.includes('<a '), `${bad} became a link`);
    assert.ok(out.includes('[x]'), 'a rejected link should render as its literal source');
  }
});

test('a dense real-world document renders without emitting anything unexpected', () => {
  const doc = [
    '## Report', '', 'Some **bold** and `code`.', '',
    '| # | thing | note |', '|---|---|---|', '| 1 | `a` | **b** |', '| 2 | c | d |', '',
    '- bullet with `code`', '- [x] done item', '', '1. first', '2. second', '',
    '> a quote', '', '---', '', '```', '<script>not executed</script>', '```',
  ].join(NL);
  const out = md(doc);
  const tags = [...out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
  assert.ok(tags.every((t) => ALLOWED_TAGS.has(t)), 'unexpected tag: ' + tags.find((t) => !ALLOWED_TAGS.has(t)));
  assert.match(out, /<table/);
  assert.match(out, /<blockquote/);
  assert.match(out, /<hr/);
  assert.match(out, /checked/);
  assert.ok(!/ C\d+ /.test(out), 'a code placeholder leaked into the output');
});

test('empty and missing input render as nothing', () => {
  assert.equal(md(''), '');
  assert.equal(md(null), '');
  assert.equal(md(undefined), '');
});

test('every place prose is shown renders it as markdown', () => {
  // Descriptions, comments and notes should behave the same; one of them still
  // escaping into a <pre> would be an inconsistency users would trip over.
  assert.ok(!/esc\(t\.description\)/.test(script), 'task description still raw-escaped');
  assert.ok(!/esc\(c\.content\)/.test(script), 'comments still raw-escaped');
  assert.ok(!/esc\(n\.content\)/.test(script), 'notes still raw-escaped');
  assert.ok((script.match(/md-body/g) || []).length >= 6, 'expected markdown at every prose site');
});

/* ---------- blocked visibility in the epic tree (#37) ---------- */

/**
 * Reported by @rusak47 as a follow-up on #37: the task drawer says clearly when
 * a task is blocked, but the epic tree did not, and the colour it used was
 * ambiguous against a critical-priority task.
 *
 * It was worse than ambiguous. `--blocked` and `--critical` are the SAME hex in
 * both themes, so a blocked row and a critical row were painted the identical
 * red and told apart only by dot-versus-pill. These tests pin the fix: the two
 * must differ by form, which survives greyscale and colour blindness.
 */
const BLOCKED_TASK = {
  id: 7, epic_id: 2, title: 'Publish to the registry', status: 'blocked',
  priority: 'low', blocked_by: 'Sign the artifacts',
};

test('a blocked row in the tree is marked with a stop sign', () => {
  const { ctx } = runPage(emptyRoutes);
  const html = ctx.taskLine(BLOCKED_TASK, '', {});
  assert.match(html, /class="stopsign"/);
  assert.ok(html.includes('⛔'), 'the stop sign glyph itself should be in the markup');
});

test('the stop sign replaces the status dot rather than joining it', () => {
  // Two markers for one fact is noise; the glyph carries the status.
  const { ctx } = runPage(emptyRoutes);
  const html = ctx.taskLine(BLOCKED_TASK, '', {});
  assert.ok(!/class="dot /.test(html), 'a blocked row should not also render a dot: ' + html);
});

test('the stop sign names what the task is waiting on', () => {
  // The tree can answer "why" without the user opening the task.
  const { ctx } = runPage(emptyRoutes);
  const html = ctx.taskLine(BLOCKED_TASK, '', {});
  assert.match(html, /title="Blocked by Sign the artifacts"/);
});

test('a blocked task with no named blockers still gets a stop sign', () => {
  // blocked_by is absent when the status was set by hand rather than derived.
  const { ctx } = runPage(emptyRoutes);
  const html = ctx.taskLine({ id: 8, epic_id: 2, title: 'Manual hold', status: 'blocked', priority: 'medium' }, '', {});
  assert.match(html, /class="stopsign"/);
  assert.match(html, /title="Blocked"/);
});

test('an unblocked row is untouched', () => {
  const { ctx } = runPage(emptyRoutes);
  const html = ctx.taskLine({ id: 9, epic_id: 2, title: 'Announce', status: 'todo', priority: 'low' }, '', {});
  assert.match(html, /class="dot st-todo"/);
  assert.ok(!/stopsign/.test(html));
});

test('blocked and critical are not distinguished by colour alone', () => {
  // The heart of the report. If the two tokens ever resolve to the same value
  // again -- they do today, deliberately, since both mean "red alert" -- then a
  // non-colour differentiator MUST exist, or the two states look identical.
  const paletteFor = (token) => [...css.matchAll(new RegExp('--' + token + ':\\s*([^;]+);', 'g'))]
    .map((m) => m[1].trim());
  const blocked = paletteFor('blocked');
  const critical = paletteFor('critical');
  assert.ok(blocked.length >= 2 && critical.length >= 2, 'both tokens should be themed light and dark');

  const sameHue = blocked.some((b) => critical.includes(b));
  if (sameHue) {
    // form must carry the distinction
    assert.match(css, /\.stopsign \{/, 'blocked needs a non-colour marker when it shares critical\'s red');
    const backgrounds = declarationsOf('background').filter((d) => d.sel === '.pill.pr-critical');
    assert.equal(backgrounds.length, 1,
      'critical needs a fill so it cannot be mistaken for a blocked marker of the same hue');
    assert.equal(winner(backgrounds).value, 'var(--critical-fill)');
  }
});

test('the filled critical pill is not overridden by the base pill rule', () => {
  // `.pill` sets no background today, but adding one later would silently undo
  // the fix, so resolve the cascade rather than trusting source order.
  const candidates = declarationsOf('background').filter(
    (d) => d.sel === '.pill' || d.sel === '.pill.pr-critical'
  );
  assert.ok(candidates.length > 0);
  assert.equal(winner(candidates).sel, '.pill.pr-critical');
});

/** WCAG relative luminance for a #rrggbb colour. */
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the filled critical pill meets WCAG AA in both themes', () => {
  // The fill was introduced to separate critical from blocked by form rather
  // than hue, which is an accessibility argument -- so it should be measured,
  // not asserted. The pill is 11px, i.e. normal text, so the bar is 4.5:1.
  //
  // This is why --critical-fill exists as its own token: white on the plain
  // --critical (#d64545) is 4.38:1, which fails. The fill is darkened just far
  // enough to pass while staying the same red family.
  const token = (name) => [...css.matchAll(new RegExp('--' + name + ':\\s*(#[0-9a-f]{6});', 'gi'))]
    .map((m) => m[1]);
  const fills = token('critical-fill');
  const inks = token('critical-ink');
  assert.equal(fills.length, 2, 'light and dark fills');
  assert.equal(inks.length, 2, 'light and dark inks');

  for (let i = 0; i < 2; i++) {
    const ratio = contrast(fills[i], inks[i]);
    assert.ok(ratio >= 4.5,
      `${inks[i]} on ${fills[i]} is ${ratio.toFixed(2)}:1, below the 4.5:1 needed for 11px text`);
  }
});

test('the critical pill keeps readable text on its fill in both themes', () => {
  // A white-on-light-red pill would be unreadable in dark mode, where
  // --critical lightens. The ink is themed alongside it.
  assert.match(css, /\.pill\.pr-critical \{[^}]*color: var\(--critical-ink\)/);
  const inks = [...css.matchAll(/--critical-ink:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(inks.length, 2, 'critical ink should be defined for light and dark');
  assert.notEqual(inks[0], inks[1], 'the two themes need different ink or one of them is unreadable');
});

/* ---------- dependency picker filtering (#45) ---------- */

/**
 * The dependency picker offers every unfinished task in the project, which
 * @rusak47 reported gets unusably long. It now has a keyword filter and a
 * "this epic only" toggle.
 *
 * Filtering is presentation only -- the boxes stay in the DOM and the submit
 * reads every checked one -- so the invariant that matters is that a CHECKED
 * row is never hidden. Hiding a selected dependency would leave the user
 * unable to see or remove something that is still being saved.
 */
test('a filtered-out row is actually hidden by the stylesheet', () => {
  // .checkrow sets display:flex, which ties with a bare [hidden] on
  // specificity -- source order alone would decide. Same trap as #25, so
  // resolve the cascade rather than trusting where the rule happens to sit.
  const displays = declarationsOf('display').filter(
    (d) => d.sel === '.checkrow' || d.sel === '.checkrow[hidden]'
  );
  assert.ok(displays.length >= 2, 'expected both a .checkrow and a .checkrow[hidden] display rule');
  const won = winner(displays);
  assert.equal(won.sel, '.checkrow[hidden]');
  assert.equal(won.value, 'none');
});

test('the filter is presentation only: hidden boxes still submit', () => {
  // The submit reads input:checked across the whole list, which ignores
  // visibility. This is the behaviour the "never hide a checked row" rule
  // depends on, so pin it.
  assert.match(script, /querySelectorAll\('input:checked'\)/);
});

test('a checked row is never hidden by the filter', () => {
  // The invariant, read off the filter itself: the checked state short-circuits
  // the keyword and scope tests.
  const fn = script.slice(script.indexOf('function applyFilter()'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.match(body, /var keep = hit \|\| \(cb && cb\.checked\);/,
    'a row is kept if it matched OR is checked -- the checked case must not be conditional');
});

test('the picker asks for a filter and a scope toggle', () => {
  assert.match(script, /filterable: true/);
  assert.match(script, /scopeLabel: 'This epic only'/);
  assert.match(script, /scopeValue: self\.epic_id/);
});

test('candidate rows carry what the filter matches on', () => {
  // data-search is lowercased at render time so the filter can do a plain
  // substring test, and data-scope carries the epic for the toggle.
  assert.match(script, /data-search="' \+ esc\(String\(o\.text\)\.toLowerCase\(\)\)/);
  assert.match(script, /data-scope="' \+ esc\(o\.scope\)/);
  assert.match(script, /scope: x\.epic_id/);
});

test('the scope toggle starts off, so nothing is hidden until asked', () => {
  assert.match(script, /scopeOn: false/);
});

test('"no match" describes the search, not the selections still on screen', () => {
  // A selected row is always shown, so counting visible rows would report a
  // match when the keyword actually found nothing. The two are counted apart.
  const fn = script.slice(script.indexOf('function applyFilter()'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  assert.match(body, /var matched = 0, shown = 0;/);
  assert.match(body, /none\.hidden = matched > 0;/,
    'the note must key off what matched, not off what is visible');
  assert.match(body, /showing your current selections/);
});
