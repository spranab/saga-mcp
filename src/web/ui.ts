/**
 * The viewer is a single self-contained page: no CDN, no build step, no network
 * calls beyond the local server. Client code avoids template literals so the
 * whole thing can live inside this TypeScript template literal safely.
 *
 * Every write goes through POST /api/action, which dispatches to the same
 * handlers the MCP tools use — so edits made here are logged and validated
 * exactly like edits made by an agent.
 */
export const PAGE: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Saga</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --panel-2: #f0f2f5;
  --border: #dfe3e8;
  --text: #1b1f24;
  --muted: #6b727c;
  --accent: #3b6cd4;
  --todo: #8a93a0;
  --progress: #3b6cd4;
  --review: #8b5cf6;
  --blocked: #d64545;
  --done: #2e9e5b;
  --critical: #d64545;
  --high: #d97706;
  --medium: #6b727c;
  --low: #9aa2ad;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b;
    --panel: #1c2025;
    --panel-2: #23282e;
    --border: #2e343b;
    --text: #e6e9ed;
    --muted: #929aa5;
    --accent: #6a9bff;
    --todo: #7d8794;
    --progress: #6a9bff;
    --review: #a78bfa;
    --blocked: #f07171;
    --done: #4ec27f;
    --critical: #f07171;
    --high: #e0a34a;
    --medium: #929aa5;
    --low: #6d7580;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--accent); }
header {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 18px; background: var(--panel);
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 20;
}
.brand { font-weight: 700; font-size: 16px; letter-spacing: .5px; }
.brand span { color: var(--accent); }
.badge-ro {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--blocked); color: var(--blocked);
}
select, input, textarea {
  background: var(--panel-2); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px;
  padding: 6px 10px; font: inherit; font-size: 13px;
}
textarea { resize: vertical; width: 100%; min-height: 90px; font-family: inherit; }
input[type=search] { min-width: 200px; }
input[type=checkbox] { width: auto; padding: 0; }
.spacer { flex: 1; }
.dbpath { font-size: 11px; color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; }
button.btn {
  background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 5px 11px; cursor: pointer; font: inherit; font-size: 13px;
}
button.btn:hover { border-color: var(--accent); color: var(--accent); }
button.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.btn.primary:hover { opacity: .9; color: #fff; }
button.btn.danger:hover { border-color: var(--blocked); color: var(--blocked); }
button.link {
  background: none; border: none; color: var(--muted); cursor: pointer;
  font: inherit; font-size: 12px; padding: 0 4px; text-decoration: underline;
}
button.link:hover { color: var(--accent); }
nav {
  display: flex; gap: 4px; padding: 0 18px; background: var(--panel);
  border-bottom: 1px solid var(--border); position: sticky; top: 51px; z-index: 19;
  overflow-x: auto;
}
nav button {
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--muted); padding: 9px 12px; font: inherit; font-size: 13px;
  cursor: pointer; white-space: nowrap;
}
nav button:hover { color: var(--text); }
nav button.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
main { padding: 18px; max-width: 1400px; margin: 0 auto; }
h2 { font-size: 15px; margin: 22px 0 10px; }
h2:first-child { margin-top: 0; }
.muted { color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.tile {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 12px 14px;
}
.tile .n { font-size: 24px; font-weight: 650; line-height: 1.1; }
.tile .l { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin-top: 4px; }
.bar { height: 7px; border-radius: 999px; background: var(--panel-2); overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--done); }
.card {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 12px 14px; margin-bottom: 10px;
}
.row { display: flex; align-items: center; gap: 8px; }
.grow { flex: 1; min-width: 0; }
.ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill {
  font-size: 11px; padding: 1px 8px; border-radius: 999px;
  border: 1px solid currentColor; white-space: nowrap;
}
.st-todo, .st-planned { color: var(--todo); }
.st-in_progress { color: var(--progress); }
.st-review { color: var(--review); }
.st-blocked { color: var(--blocked); }
.st-done, .st-completed, .st-active { color: var(--done); }
.st-cancelled, .st-archived { color: var(--muted); }
.st-on_hold { color: var(--high); }
.pr-critical { color: var(--critical); }
.pr-high { color: var(--high); }
.pr-medium { color: var(--medium); }
.pr-low { color: var(--low); }
.board { display: grid; grid-template-columns: repeat(5, minmax(190px, 1fr)); gap: 10px; overflow-x: auto; }
.col { background: var(--panel-2); border-radius: var(--radius); padding: 8px; min-height: 90px;
       border: 1px dashed transparent; }
.col.over { border-color: var(--accent); }
.col h3 { margin: 2px 4px 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
.col .count { color: var(--muted); font-weight: 400; }
.tcard {
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; margin-bottom: 7px; cursor: pointer; font-size: 13px;
}
.tcard:hover { border-color: var(--accent); }
.tcard.dragging { opacity: .4; }
.tcard .meta { display: flex; gap: 6px; align-items: center; margin-top: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
.epic-head { display: flex; align-items: center; gap: 10px; }
.epic-head .caret { cursor: pointer; }
.epic-body { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
.tlist { display: flex; flex-direction: column; }
.tline {
  display: flex; align-items: center; gap: 9px; padding: 6px 4px;
  border-bottom: 1px solid var(--border); cursor: pointer; font-size: 13px;
}
.tline:last-child { border-bottom: none; }
.tline:hover { background: var(--panel-2); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
pre.body {
  white-space: pre-wrap; word-wrap: break-word; margin: 8px 0 0;
  font: inherit; color: var(--text);
}
.drawer-backdrop, .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 30; }
.modal-backdrop { z-index: 40; }
.drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(640px, 100%);
  background: var(--panel); border-left: 1px solid var(--border);
  z-index: 31; overflow-y: auto; padding: 18px 20px 60px;
}
/* Drag the left edge to widen the drawer; the width is remembered per browser. */
.drawer-resize {
  position: absolute; left: 0; top: 0; bottom: 0; width: 6px;
  cursor: ew-resize; background: transparent;
}
.drawer-resize:hover, .drawer-resize.active { background: var(--accent); opacity: .5; }
body.resizing { cursor: ew-resize; user-select: none; }
.drawer h3 {
  margin: 18px 0 8px; font-size: 12px; text-transform: uppercase;
  letter-spacing: .6px; color: var(--muted);
  display: flex; align-items: center; gap: 8px;
}
.modal {
  position: fixed; z-index: 41; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(560px, calc(100% - 32px)); max-height: 86vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  padding: 18px 20px;
}
.modal h2 { margin: 0 0 14px; font-size: 16px; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.field input:not([type=checkbox]), .field select { width: 100%; }
.field.inline { display: flex; gap: 10px; }
.field.inline > div { flex: 1; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 13px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.cmt { border-left: 2px solid var(--border); padding: 4px 0 4px 10px; margin-bottom: 10px; }
.cmt.deleted { opacity: .65; border-left-color: var(--blocked); }
.cmt .hdr { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.strike { text-decoration: line-through; }
.sub { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 13px; }
.sub .grow { cursor: text; }
.empty { color: var(--muted); font-size: 13px; padding: 6px 0; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.err { color: var(--blocked); }
.act { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.act:last-child { border-bottom: none; }
.act time { color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.checklist { max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
.checkrow { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 13px; cursor: pointer; }
.checkrow input[type=checkbox] { width: auto; flex: none; margin: 0; }
.checkrow span { flex: 1; min-width: 0; }
.sub .handle { cursor: grab; color: var(--muted); user-select: none; font-size: 12px; }
/* One control per subtask carrying its whole state: todo / in progress / done,
   or blocked. Clicking advances it, so 'in progress' is reachable from the UI. */
.statebox {
  width: 18px; height: 18px; flex: none; border-radius: 4px;
  border: 1px solid var(--border); background: var(--panel-2);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1; cursor: pointer; padding: 0; color: var(--text);
}
.statebox:hover { border-color: var(--accent); }
.statebox.st-in_progress { border-color: var(--progress); color: var(--progress); font-weight: 700; }
.statebox.st-done { border-color: var(--done); color: var(--done); }
.statebox.st-blocked { border-color: var(--blocked); color: var(--blocked); background: transparent; }
.sub .title.in_progress { color: var(--progress); font-weight: 600; }
.sub .title.blocked { color: var(--muted); }
.iconbtn {
  background: none; border: none; color: var(--muted); cursor: pointer;
  font-size: 13px; line-height: 1; padding: 2px 3px; border-radius: 4px;
}
.iconbtn:hover { color: var(--accent); background: var(--panel-2); }
.iconbtn.danger:hover { color: var(--blocked); }
.sub.dragging { opacity: .4; }
.sub.dropinto { border-top: 2px solid var(--accent); }
.dep {
  font-size: 11px; color: var(--muted); white-space: nowrap; cursor: help;
  border: 1px solid var(--border); border-radius: 999px; padding: 0 6px;
}
.dep.unmet { color: var(--blocked); border-color: var(--blocked); }
.lockbtn.on { color: var(--high); border-color: var(--high); }
.card.archived { opacity: .62; border-style: dashed; }
.tline.removed .ellip { text-decoration: line-through; color: var(--muted); }
.hiddenbar {
  display: flex; align-items: center; gap: 8px; margin: 14px 0 8px;
  font-size: 12px; color: var(--muted);
}
.hiddenbar hr { flex: 1; border: none; border-top: 1px dashed var(--border); }
.toast {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 14px; z-index: 60; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.2);
}
.toast.bad { border-color: var(--blocked); color: var(--blocked); }
</style>
</head>
<body>
<header>
  <div class="brand">saga<span>.</span></div>
  <span class="badge-ro" id="roBadge" hidden>read-only</span>
  <select id="projectSel" title="Project"></select>
  <button class="btn" id="newProject" title="New project">+ Project</button>
  <input type="search" id="q" placeholder="Search tasks, epics, notes…" autocomplete="off">
  <div class="spacer"></div>
  <button class="btn" id="reload" title="Reload from database">⟳</button>
  <span class="dbpath" id="dbpath"></span>
</header>
<nav id="tabs"></nav>
<main id="view"><p class="muted">Loading…</p></main>
<script>
var S = { projects: [], projectId: null, tab: 'overview', overview: null, tasks: [],
          epicOpen: {}, task: null, showDeleted: false, query: '', readOnly: false,
          showArchived: false, hidden: { archived_epics: 0, removed_tasks: 0 } };

var TABS = [['overview','Overview'],['board','Board'],['epics','Epics'],['notes','Notes'],['activity','Activity']];
var TASK_STATUS = ['todo', 'in_progress', 'review', 'blocked', 'done'];
var EPIC_STATUS = ['planned', 'in_progress', 'completed', 'cancelled'];
var PROJECT_STATUS = ['active', 'on_hold', 'completed', 'archived'];
var PRIORITY = ['low', 'medium', 'high', 'critical'];
var NOTE_TYPES = ['general','decision','context','meeting','technical','blocker','progress','release'];

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function label(s) { return String(s || '').replace(/_/g, ' '); }
function el(id) { return document.getElementById(id); }
function fmtDate(s) {
  if (!s) return '';
  var raw = String(s);
  var d = new Date(raw.replace(' ', 'T') + (raw.indexOf('Z') < 0 ? 'Z' : ''));
  if (isNaN(d.getTime())) return esc(raw);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric',
                                       hour: '2-digit', minute: '2-digit' });
}
function get(path) {
  return fetch(path, { headers: { 'accept': 'application/json' } }).then(function (r) {
    return r.json().then(function (b) {
      if (!r.ok) throw new Error(b && b.error ? b.error : r.statusText);
      return b;
    });
  });
}
function act(tool, args) {
  return fetch('/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-saga-ui': '1' },
    body: JSON.stringify({ tool: tool, args: args })
  }).then(function (r) {
    return r.json().then(function (b) {
      if (!r.ok || b.error) throw new Error(b && b.error ? b.error : r.statusText);
      return b.result;
    });
  });
}
function toast(msg, bad) {
  var t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () { t.remove(); }, bad ? 5000 : 2200);
}
function fail(e) { el('view').innerHTML = '<p class="err">' + esc(e.message || e) + '</p>'; }
function oops(e) { toast(e.message || String(e), true); }

function pill(kind, value) {
  return '<span class="pill ' + kind + '-' + esc(value) + '">' + esc(label(value)) + '</span>';
}
function progressBar(pct) { return '<div class="bar"><i style="width:' + Number(pct || 0) + '%"></i></div>'; }
function parseTags(json) { try { return JSON.parse(json || '[]'); } catch (e) { return []; } }
function tagPills(json) {
  return parseTags(json).map(function (t) {
    return '<span class="pill pr-medium">' + esc(t) + '</span>';
  }).join(' ');
}
function canEdit() { return !S.readOnly; }

/* ---------- generic modal form ---------- */

function closeModal() {
  var m = document.querySelector('.modal');
  var b = document.querySelector('.modal-backdrop');
  if (m) m.remove();
  if (b) b.remove();
}

/**
 * fields: [{ key, label, type: text|textarea|select|number|date|tags|checkbox,
 *            value, options, placeholder, required }]
 * onSubmit(values, changed) -> Promise
 */
function modal(title, fields, submitLabel, onSubmit) {
  closeModal();
  var backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', closeModal);

  var m = document.createElement('div');
  m.className = 'modal';
  var h = '<h2>' + esc(title) + '</h2><form id="mform">';
  fields.forEach(function (f) {
    var v = f.value === null || f.value === undefined ? '' : f.value;
    h += '<div class="field"><label for="f_' + f.key + '">' + esc(f.label) + '</label>';
    if (f.type === 'textarea') {
      h += '<textarea id="f_' + f.key + '" name="' + f.key + '" placeholder="' +
           esc(f.placeholder || '') + '">' + esc(v) + '</textarea>';
    } else if (f.type === 'select') {
      h += '<select id="f_' + f.key + '" name="' + f.key + '">';
      (f.options || []).forEach(function (o) {
        var val = o.value !== undefined ? o.value : o;
        var txt = o.text !== undefined ? o.text : label(o);
        h += '<option value="' + esc(val) + '"' + (String(val) === String(v) ? ' selected' : '') +
             '>' + esc(txt) + '</option>';
      });
      h += '</select>';
    } else if (f.type === 'checkboxes') {
      h += '<div id="f_' + f.key + '" class="checklist">';
      (f.options || []).forEach(function (o) {
        var on = (f.value || []).indexOf(o.value) >= 0;
        h += '<label class="checkrow"><input type="checkbox" value="' + esc(o.value) + '"' +
             (on ? ' checked' : '') + '> <span>' + esc(o.text) + '</span></label>';
      });
      if (!(f.options || []).length) h += '<div class="empty">No other subtasks yet.</div>';
      h += '</div>';
    } else if (f.type === 'tags') {
      h += '<input id="f_' + f.key + '" name="' + f.key + '" value="' + esc(v) +
           '" placeholder="comma, separated">';
    } else {
      var t = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
      h += '<input type="' + t + '" id="f_' + f.key + '" name="' + f.key + '" value="' + esc(v) +
           '" placeholder="' + esc(f.placeholder || '') + '"' +
           (t === 'number' ? ' step="any"' : '') + '>';
    }
    h += '</div>';
  });
  h += '<p class="err" id="merr" hidden></p>';
  h += '<div class="row" style="justify-content:flex-end;margin-top:6px">' +
       '<button type="button" class="btn" id="mcancel">Cancel</button>' +
       '<button type="submit" class="btn primary">' + esc(submitLabel) + '</button></div></form>';
  m.innerHTML = h;
  document.body.appendChild(backdrop);
  document.body.appendChild(m);

  var first = m.querySelector('input, textarea, select');
  if (first) first.focus();

  m.querySelector('#mcancel').addEventListener('click', closeModal);
  m.querySelector('#mform').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var values = {}, changed = {};
    var bad = null;
    fields.forEach(function (f) {
      var node = m.querySelector('#f_' + f.key);
      if (f.type === 'checkboxes') {
        var picked = [];
        Array.prototype.forEach.call(node.querySelectorAll('input:checked'), function (cb) {
          picked.push(Number(cb.value));
        });
        values[f.key] = picked;
        if (picked.join(',') !== (f.value || []).join(',')) changed[f.key] = picked;
        return;
      }
      var raw = node.value;
      var out;
      if (f.type === 'tags') {
        out = raw.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      } else if (f.type === 'number') {
        out = raw === '' ? null : Number(raw);
      } else {
        out = raw.trim();
      }
      if (f.required && (out === '' || out === null)) bad = f.label + ' is required.';
      values[f.key] = out;
      var before = f.type === 'tags' ? (f.value || '') : (f.value === null || f.value === undefined ? '' : f.value);
      var after = f.type === 'tags' ? out.join(', ') : (out === null ? '' : String(out));
      if (String(before) !== after) changed[f.key] = out;
    });
    var errNode = m.querySelector('#merr');
    if (bad) { errNode.hidden = false; errNode.textContent = bad; return; }
    errNode.hidden = true;
    var btn = m.querySelector('button[type=submit]');
    btn.disabled = true;
    Promise.resolve(onSubmit(values, changed)).then(function () {
      closeModal();
    }).catch(function (e) {
      btn.disabled = false;
      errNode.hidden = false;
      errNode.textContent = e.message || String(e);
    });
  });
}

/* ---------- shell ---------- */

/* ---------- url state ---------- */

/**
 * Project, tab and the open task live in the location hash. A browser refresh
 * then puts you back exactly where you were instead of dumping you on the
 * overview with the task drawer closed, and back/forward work.
 */
var applyingHash = false;

function syncHash() {
  if (applyingHash) return;
  var parts = [];
  if (S.projectId) parts.push('p=' + S.projectId);
  if (S.tab && S.tab !== 'overview') parts.push('tab=' + S.tab);
  if (S.task) parts.push('task=' + S.task.id);
  var next = parts.length ? '#' + parts.join('&') : '#';
  if (next !== location.hash) history.replaceState(null, '', next);
}

function readHash() {
  var out = {};
  var raw = location.hash.replace(/^#/, '');
  if (!raw) return out;
  raw.split('&').forEach(function (pair) {
    var i = pair.indexOf('=');
    if (i < 0) return;
    var k = pair.slice(0, i), v = pair.slice(i + 1);
    if (k === 'p' || k === 'task') { var n = Number(v); if (n > 0) out[k] = n; }
    if (k === 'tab' && TABS.some(function (t) { return t[0] === v; })) out.tab = v;
  });
  return out;
}

function renderTabs() {
  el('tabs').innerHTML = TABS.map(function (t) {
    return '<button data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'active' : '') + '">' + t[1] + '</button>';
  }).join('');
}

function renderProjects() {
  var sel = el('projectSel');
  if (!S.projects.length) { sel.innerHTML = '<option value="">No projects</option>'; return; }
  sel.innerHTML = S.projects.map(function (p) {
    return '<option value="' + p.id + '"' + (p.id === S.projectId ? ' selected' : '') + '>' +
           esc(p.name) + ' · ' + (p.task_count || 0) + ' tasks</option>';
  }).join('');
}

function reloadProjects() {
  return get('/api/projects').then(function (r) {
    S.projects = r.projects;
    renderProjects();
  });
}

function loadProject(keepDrawer) {
  if (!S.projectId) {
    el('view').innerHTML = '<p class="empty">No projects in this database yet. ' +
      (canEdit() ? 'Use <b>+ Project</b> above to create one.'
                 : 'Create one with the <code>tracker_init</code> MCP tool.') + '</p>';
    return Promise.resolve();
  }
  var inc = S.showArchived ? '&include_archived=1' : '';
  return Promise.all([
    get('/api/overview?project_id=' + S.projectId + inc),
    get('/api/tasks?project_id=' + S.projectId + inc)
  ]).then(function (r) {
    S.overview = r[0];
    S.hidden = r[0].hidden || { archived_epics: 0, removed_tasks: 0 };
    S.tasks = r[1].tasks;
    render();
    if (keepDrawer && S.task) return openTask(S.task.id);
  }).catch(fail);
}

/** Refresh everything after a write, keeping the open task drawer in sync. */
function refresh() {
  return reloadProjects().then(function () { return loadProject(true); });
}

function render() {
  renderTabs();
  syncHash();
  el('roBadge').hidden = !S.readOnly;
  if (S.query) return renderSearch();
  var fns = { overview: viewOverview, board: viewBoard, epics: viewEpics,
              notes: viewNotes, activity: viewActivity };
  (fns[S.tab] || viewOverview)();
}

/* ---------- overview ---------- */

function viewOverview() {
  var o = S.overview;
  if (!o) return;
  var s = o.stats || {};
  var h = '<div class="tiles">' +
    tile(s.total_tasks || 0, 'tasks') + tile(s.tasks_done || 0, 'done') +
    tile(s.tasks_in_progress || 0, 'in progress') + tile(s.tasks_review || 0, 'in review') +
    tile(s.tasks_blocked || 0, 'blocked') + tile(o.overdue_tasks.length, 'overdue') +
    '</div>';

  h += '<div class="card" style="margin-top:12px">' +
    '<div class="row"><strong class="grow">' + esc(o.project.name) + '</strong>' +
    pill('st', o.project.status) +
    '<span class="muted">' + (s.completion_pct || 0) + '% complete</span>' +
    (canEdit() ? '<button class="btn" id="editProject">Edit</button>' : '') + '</div>' +
    (o.project.description ? '<pre class="body muted">' + esc(o.project.description) + '</pre>' : '') +
    '<div style="margin-top:10px">' + progressBar(s.completion_pct) + '</div>' +
    '</div>';

  var hiddenEpics = (o.hidden && o.hidden.archived_epics) || 0;
  var hiddenTasks = (o.hidden && o.hidden.removed_tasks) || 0;
  h += '<h2>Epics <span class="muted">(' + o.epics.filter(function (e) { return !e.archived; }).length + ')</span>' +
       (canEdit() ? ' <button class="btn" id="newEpic">+ Epic</button>' : '') +
       (hiddenEpics || hiddenTasks
         ? ' <button class="btn" id="toggleArchived">' + (S.showArchived ? 'Hide' : 'Show') + ' archived' +
           (hiddenEpics ? ' (' + hiddenEpics + ')' : '') + '</button>'
         : '') + '</h2>';
  if (!o.epics.length) h += '<p class="empty">No epics yet.</p>';
  var shownEpics = o.epics.slice();
  var archivedShown = false;
  shownEpics.forEach(function (e) {
    // Archived epics sort below a divider rather than mixing in.
    if (e.archived && !archivedShown) {
      archivedShown = true;
      h += '<div class="hiddenbar"><hr>archived<hr></div>';
    }
    h += '<div class="card' + (e.archived ? ' archived' : '') + '" data-epic-open="' + e.id + '" style="cursor:pointer">' +
      '<div class="row"><span class="grow ellip"><strong>' + esc(e.name) + '</strong></span>' +
      (e.branch ? '<span class="pill pr-low" title="branch">⎇ ' + esc(e.branch) + '</span> ' : '') +
      (e.archived ? '<span class="pill pr-low" title="Hidden from listings">archived</span> ' : '') +
      pill('pr', e.priority) + ' ' + pill('st', e.status) +
      (canEdit() ? ' <button class="btn" data-archive-epic="' + e.id + '" data-archived="' + (e.archived ? 1 : 0) + '">' +
        (e.archived ? 'Unarchive' : 'Archive') + '</button>' : '') + '</div>' +
      '<div class="row" style="margin-top:8px"><span class="grow">' + progressBar(e.completion_pct) + '</span>' +
      '<span class="muted" style="font-size:12px">' + (e.done_count || 0) + '/' + (e.task_count || 0) +
      (e.blocked_count ? ' · ' + e.blocked_count + ' blocked' : '') + '</span></div></div>';
  });

  if (o.blocked_tasks.length) h += '<h2>Blocked</h2>' + o.blocked_tasks.map(function (t) { return taskLine(t); }).join('');
  if (o.overdue_tasks.length) {
    h += '<h2>Overdue</h2>' + o.overdue_tasks.map(function (t) {
      return taskLine(t, 'due ' + esc(t.due_date));
    }).join('');
  }
  el('view').innerHTML = h;
}

function tile(n, l) {
  return '<div class="tile"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
}

function taskLine(t, extra) {
  return '<div class="tline" data-task="' + t.id + '">' +
    '<span class="dot st-' + esc(t.status) + '"></span>' +
    '<span class="grow ellip">' + esc(t.title) + '</span>' +
    (extra ? '<span class="muted" style="font-size:12px">' + extra + '</span>' : '') +
    (t.epic_name ? '<span class="muted ellip" style="font-size:12px;max-width:180px">' + esc(t.epic_name) + '</span>' : '') +
    pill('pr', t.priority) + '</div>';
}

/* ---------- board ---------- */

function viewBoard() {
  var byStatus = {};
  TASK_STATUS.forEach(function (s) { byStatus[s] = []; });
  S.tasks.forEach(function (t) { (byStatus[t.status] || (byStatus[t.status] = [])).push(t); });

  var h = '';
  if (canEdit()) h += '<div class="toolbar"><span class="muted">Drag a card to change its status.</span></div>';
  h += '<div class="board">';
  TASK_STATUS.forEach(function (st) {
    var list = byStatus[st] || [];
    h += '<div class="col" data-status="' + st + '"><h3 class="st-' + st + '">' + esc(label(st)) +
         ' <span class="count">' + list.length + '</span></h3>';
    list.forEach(function (t) { h += taskCard(t); });
    if (!list.length) h += '<div class="empty" style="padding:4px">—</div>';
    h += '</div>';
  });
  h += '</div>';
  el('view').innerHTML = h;
}

function taskCard(t) {
  var meta = [];
  if (t.subtask_count) meta.push('☑ ' + t.subtask_done + '/' + t.subtask_count);
  if (t.comment_count) meta.push('💬 ' + t.comment_count);
  if (t.due_date) meta.push('📅 ' + esc(t.due_date));
  if (t.assigned_to) meta.push('@' + esc(t.assigned_to));
  return '<div class="tcard" data-task="' + t.id + '"' + (canEdit() ? ' draggable="true"' : '') + '>' +
    esc(t.title) +
    '<div class="meta">' + pill('pr', t.priority) + '<span class="ellip grow">' + esc(t.epic_name) + '</span></div>' +
    (meta.length ? '<div class="meta">' + meta.join(' · ') + '</div>' : '') + '</div>';
}

/* ---------- epics ---------- */

function viewEpics() {
  var o = S.overview;
  if (!o) return;
  var byEpic = {};
  S.tasks.forEach(function (t) { (byEpic[t.epic_id] || (byEpic[t.epic_id] = [])).push(t); });

  var h = '<div class="toolbar">' +
    (canEdit() ? '<button class="btn primary" id="newEpic">+ Epic</button>' : '') +
    '<button class="btn" id="expandAll">Expand all</button>' +
    '<button class="btn" id="collapseAll">Collapse all</button></div>';
  if (!o.epics.length) h += '<p class="empty">No epics yet.</p>';

  o.epics.forEach(function (e) {
    var open = S.epicOpen[e.id];
    var list = byEpic[e.id] || [];
    h += '<div class="card"><div class="epic-head">' +
      '<span class="caret grow row" data-toggle="' + e.id + '" style="cursor:pointer">' +
        '<span class="muted">' + (open ? '▾' : '▸') + '</span>' +
        '<span class="grow ellip"><strong>' + esc(e.name) + '</strong></span></span>' +
      (e.branch ? '<span class="pill pr-low">⎇ ' + esc(e.branch) + '</span>' : '') +
      pill('pr', e.priority) + pill('st', e.status) +
      '<span class="muted" style="font-size:12px">' + (e.done_count || 0) + '/' + (e.task_count || 0) + '</span>' +
      (canEdit() ? '<button class="btn" data-edit-epic="' + e.id + '">Edit</button>' +
                   '<button class="btn" data-new-task="' + e.id + '">+ Task</button>' : '') +
      '</div>';
    if (open) {
      h += '<div class="epic-body">' +
        (e.description ? '<pre class="body muted" style="margin-bottom:10px">' + esc(e.description) + '</pre>' : '') +
        '<div class="tlist">' +
        (list.length ? list.map(function (t) {
          var extra = t.subtask_count ? '☑ ' + t.subtask_done + '/' + t.subtask_count : '';
          var copy = {};
          for (var k in t) copy[k] = t[k];
          copy.epic_name = '';
          return taskLine(copy, extra);
        }).join('') : '<div class="empty">No tasks in this epic.</div>') +
        '</div></div>';
    }
    h += '</div>';
  });
  el('view').innerHTML = h;
}

/* ---------- notes ---------- */

function viewNotes() {
  el('view').innerHTML = '<p class="muted">Loading…</p>';
  get('/api/notes?project_id=' + S.projectId + '&limit=200').then(function (r) {
    var h = canEdit() ? '<div class="toolbar"><button class="btn primary" id="newNote">+ Note</button></div>' : '';
    if (!r.notes.length) {
      el('view').innerHTML = h + '<p class="empty">No notes yet.</p>';
      return;
    }
    h += r.notes.map(function (n) {
      return '<div class="card">' +
        '<div class="row"><strong class="grow">' + esc(n.title) + '</strong>' +
        '<span class="pill pr-medium">' + esc(label(n.note_type)) + '</span>' +
        '<span class="muted" style="font-size:12px">' + fmtDate(n.created_at) + '</span>' +
        (canEdit() ? '<button class="btn" data-edit-note="' + n.id + '">Edit</button>' +
                     '<button class="btn danger" data-del-note="' + n.id + '">Delete</button>' : '') +
        '</div>' +
        (n.related_entity_type ? '<div class="muted" style="font-size:12px;margin-top:2px">on ' +
          esc(n.related_entity_type) + ' #' + esc(n.related_entity_id) + '</div>' : '') +
        '<pre class="body">' + esc(n.content) + '</pre>' +
        (tagPills(n.tags) ? '<div style="margin-top:8px">' + tagPills(n.tags) + '</div>' : '') +
        '</div>';
    }).join('');
    el('view').innerHTML = h;
    S.notes = r.notes;
  }).catch(fail);
}

/* ---------- activity ---------- */

function viewActivity() {
  el('view').innerHTML = '<p class="muted">Loading…</p>';
  get('/api/activity?project_id=' + S.projectId + '&limit=250').then(function (r) {
    if (!r.activity.length) { el('view').innerHTML = '<p class="empty">No activity recorded yet.</p>'; return; }
    el('view').innerHTML = '<div class="card">' + r.activity.map(function (a) {
      var clickable = a.entity_type === 'task';
      return '<div class="act"' + (clickable ? ' data-task="' + a.entity_id + '" style="cursor:pointer"' : '') + '>' +
        '<time>' + fmtDate(a.created_at) + '</time>' +
        '<span class="pill pr-medium">' + esc(label(a.action)) + '</span>' +
        '<span class="grow">' + esc(a.summary || (a.entity_type + ' #' + a.entity_id)) + '</span></div>';
    }).join('') + '</div>';
  }).catch(fail);
}

/* ---------- search ---------- */

function renderSearch() {
  el('view').innerHTML = '<p class="muted">Searching…</p>';
  get('/api/search?q=' + encodeURIComponent(S.query)).then(function (r) {
    var h = '<div class="toolbar"><strong>Results for “' + esc(S.query) + '”</strong>' +
            '<button class="btn" id="clearSearch">Clear</button></div>';
    var total = 0;
    if (r.tasks.length) {
      total += r.tasks.length;
      h += '<h2>Tasks</h2>' + r.tasks.map(function (t) { return taskLine(t); }).join('');
    }
    if (r.epics.length) {
      total += r.epics.length;
      h += '<h2>Epics</h2>' + r.epics.map(function (e) {
        return '<div class="tline" data-goto-epic="' + e.id + '" data-project="' + e.project_id + '">' +
          '<span class="dot st-' + esc(e.status) + '"></span><span class="grow ellip">' + esc(e.name) + '</span>' +
          '<span class="muted" style="font-size:12px">' + esc(e.project_name) + '</span></div>';
      }).join('');
    }
    if (r.notes.length) {
      total += r.notes.length;
      h += '<h2>Notes</h2>' + r.notes.map(function (n) {
        return '<div class="tline"><span class="dot" style="color:var(--muted)"></span>' +
          '<span class="grow ellip">' + esc(n.title) + '</span>' +
          '<span class="pill pr-medium">' + esc(label(n.note_type)) + '</span></div>';
      }).join('');
    }
    if (r.projects.length) {
      total += r.projects.length;
      h += '<h2>Projects</h2>' + r.projects.map(function (p) {
        return '<div class="tline" data-project="' + p.id + '"><span class="dot st-' + esc(p.status) +
          '"></span><span class="grow ellip">' + esc(p.name) + '</span></div>';
      }).join('');
    }
    if (!total) h += '<p class="empty">Nothing matched.</p>';
    el('view').innerHTML = h;
  }).catch(fail);
}

/* ---------- task drawer ---------- */

function openTask(id) {
  return get('/api/tasks/' + id + (S.showDeleted ? '?include_deleted=1' : '')).then(function (t) {
    S.task = t;
    drawTask();
    syncHash();
  }).catch(oops);
}

function closeDrawer() {
  S.task = null;
  syncHash();
  var d = document.querySelector('.drawer');
  var b = document.querySelector('.drawer-backdrop');
  if (d) d.remove();
  if (b) b.remove();
}

function drawTask() {
  var scroll = 0;
  var existing = document.querySelector('.drawer');
  if (existing) { scroll = existing.scrollTop; existing.remove(); }
  var oldBackdrop = document.querySelector('.drawer-backdrop');
  if (oldBackdrop) oldBackdrop.remove();

  var t = S.task;
  if (!t) return;
  var ed = canEdit();

  var backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.addEventListener('click', closeDrawer);

  var d = document.createElement('div');
  d.className = 'drawer';
  var savedWidth = null;
  try { savedWidth = localStorage.getItem('saga.drawerWidth'); } catch (e) { savedWidth = null; }
  if (savedWidth) d.style.width = savedWidth;

  var h = '<div class="drawer-resize" id="drawerResize" title="Drag to resize"></div>' +
    '<div class="row"><span class="grow"></span>' +
    '<button class="btn" id="refreshTask" title="Re-read this task from the database">⟳ Refresh</button>' +
    (ed && t.is_deleted ? '<button class="btn" id="restoreTask">Restore</button>' : '') +
    (ed && !t.is_deleted && t.status === 'todo'
      ? '<button class="btn danger" id="deleteTask" title="Remove this task — kept for the audit trail, restorable">Remove</button>'
      : '') +
    (ed ? '<button class="btn" id="editTask">Edit task</button>' : '') +
    '<button class="btn" id="closeDrawer">Close ✕</button></div>';
  h += '<h2 style="margin:6px 0 8px;font-size:18px">' + esc(t.title) + '</h2>';
  if (t.is_deleted) {
    h += '<div class="empty" style="color:var(--blocked)">This task was removed' +
      (t.deleted_by ? ' by ' + esc(t.deleted_by) : '') +
      (t.delete_reason ? ': ' + esc(t.delete_reason) : '') +
      '. It is hidden from listings until restored.</div>';
  }
  h += '<div class="row" style="gap:6px;flex-wrap:wrap">';
  if (ed) {
    h += '<select id="quickStatus" title="Status">' + TASK_STATUS.map(function (s) {
      return '<option value="' + s + '"' + (s === t.status ? ' selected' : '') + '>' + esc(label(s)) + '</option>';
    }).join('') + '</select>';
    h += '<select id="quickPriority" title="Priority">' + PRIORITY.map(function (p) {
      return '<option value="' + p + '"' + (p === t.priority ? ' selected' : '') + '>' + esc(p) + '</option>';
    }).join('') + '</select>';
  } else {
    h += pill('st', t.status) + pill('pr', t.priority);
  }
  h += '<span class="muted" style="font-size:12px">#' + t.id + ' · ' + esc(t.project_name) +
       ' › ' + esc(t.epic_name) + '</span></div>';

  var kv = [];
  if (t.assigned_to) kv.push(['Assigned', esc(t.assigned_to)]);
  if (t.due_date) kv.push(['Due', esc(t.due_date)]);
  if (t.estimated_hours !== null && t.estimated_hours !== undefined) kv.push(['Estimated', t.estimated_hours + 'h']);
  if (t.actual_hours !== null && t.actual_hours !== undefined) kv.push(['Actual', t.actual_hours + 'h']);
  if (t.epic_branch) kv.push(['Branch', esc(t.epic_branch)]);
  if (t.source_ref) kv.push(['Source', esc(t.source_ref)]);
  kv.push(['Created', fmtDate(t.created_at)]);
  kv.push(['Updated', fmtDate(t.updated_at)]);
  h += '<dl class="kv" style="margin-top:12px">' + kv.map(function (r) {
    return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>';
  }).join('') + '</dl>';
  if (tagPills(t.tags)) h += '<div style="margin-top:10px">' + tagPills(t.tags) + '</div>';

  var locked = !!t.description_locked;
  h += '<h3>Description' +
    (ed ? '<button class="btn lockbtn' + (locked ? ' on' : '') + '" id="toggleLock" title="' +
          (locked ? 'Unlock so task_update can change the description again'
                  : 'Lock so agents cannot rewrite the description') + '">' +
          (locked ? '🔒 Locked' : '🔓 Unlocked') + '</button>' : '') +
    '</h3>' +
    (locked ? '<div class="empty">Agents cannot rewrite this description while it is locked — ' +
              'they are told to comment instead.</div>' : '') +
    (t.description ? '<pre class="body">' + esc(t.description) + '</pre>'
                   : '<div class="empty">No description.</div>');

  h += '<h3>Subtasks <span class="muted">(' + t.subtasks.length + ')</span></h3>';
  h += t.subtasks.length ? t.subtasks.map(function (s) {
    var deps = s.depends_on || [];
    var blocked = !!s.blocked;
    var unmet = deps.filter(function (d) { return d.status !== 'done'; });
    // The blocked marker lives on the control itself rather than prefixing the
    // title, and the control stays clickable — being blocked is a warning, not
    // a locked door (see #26: overriding is allowed, but it must be deliberate).
    var glyph = blocked ? '⛔' : s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▶' : '';
    var stateTitle = blocked
      ? 'Blocked by ' + unmet.map(function (d) { return '#' + d.id + ' ' + d.title; }).join(', ')
      : 'Status: ' + label(s.status) + ' — click to advance';
    return '<div class="sub' + (blocked ? ' blocked' : '') + '" data-subtask-row="' + s.id + '"' +
      (ed ? ' draggable="true"' : '') + '>' +
      (ed ? '<span class="handle" title="Drag to reorder">⠿</span>' : '') +
      (ed
        ? '<button class="statebox st-' + (blocked ? 'blocked' : esc(s.status)) + '" ' +
          'data-subtask-cycle="' + s.id + '" title="' + esc(stateTitle) + '">' + glyph + '</button>'
        : '<span class="dot st-' + esc(s.status) + '"></span>') +
      '<span class="grow ellip title ' + (blocked ? 'blocked' : esc(s.status)) +
        (s.status === 'done' ? ' muted strike' : '') + '" title="' + esc(s.title) + '">' +
        esc(s.title) + '</span>' +
      (deps.length
        ? '<span class="dep' + (unmet.length ? ' unmet' : '') + '" title="' +
          esc('Waits on: ' + deps.map(function (d) {
            return '#' + d.id + ' ' + d.title + (d.status === 'done' ? ' (done)' : '');
          }).join(', ')) + '">' + deps.length + ' dep' + (deps.length === 1 ? '' : 's') + '</span>'
        : '') +
      (ed ? '<button class="iconbtn" data-subtask-deps="' + s.id + '" title="Set what this waits on">⛓</button>' +
            '<button class="iconbtn" data-subtask-rename="' + s.id + '" title="Rename">✎</button>' +
            '<button class="iconbtn danger" data-subtask-del="' + s.id + '" title="Remove">✕</button>' : '') +
      '</div>';
  }).join('') : '<div class="empty">None.</div>';
  if (ed) {
    h += '<div class="row" style="margin-top:8px">' +
      '<input id="newSubtask" class="grow" placeholder="Add a subtask and press Enter">' +
      '<button class="btn" id="addSubtask">Add</button></div>';
  }

  if (t.depends_on.length || t.dependents.length) {
    h += '<h3>Dependencies</h3>';
    t.depends_on.forEach(function (x) {
      h += '<div class="sub"><span class="muted">blocked by</span><span class="dot st-' + esc(x.status) +
           '"></span><a href="#" data-task="' + x.id + '">' + esc(x.title) + '</a></div>';
    });
    t.dependents.forEach(function (x) {
      h += '<div class="sub"><span class="muted">blocks</span><span class="dot st-' + esc(x.status) +
           '"></span><a href="#" data-task="' + x.id + '">' + esc(x.title) + '</a></div>';
    });
  }

  var liveComments = t.comments.filter(function (c) { return !c.is_deleted; }).length;
  h += '<h3>Comments <span class="muted">(' + liveComments + ')</span></h3>';
  if (t.deleted_comment_count) {
    h += '<label class="muted" style="font-size:12px;display:block;margin-bottom:8px">' +
      '<input type="checkbox" id="showDeleted"' + (S.showDeleted ? ' checked' : '') + '> ' +
      'show ' + t.deleted_comment_count + ' removed comment' + (t.deleted_comment_count === 1 ? '' : 's') + '</label>';
  }
  h += t.comments.length ? t.comments.map(function (c) {
    var head = (c.author ? esc(c.author) : 'anonymous') + ' · ' + fmtDate(c.created_at);
    if (c.is_deleted) head += ' · removed ' + fmtDate(c.deleted_at) + (c.deleted_by ? ' by ' + esc(c.deleted_by) : '');
    return '<div class="cmt' + (c.is_deleted ? ' deleted' : '') + '">' +
      '<div class="hdr"><span class="grow">' + head + '</span>' +
      (ed ? (c.is_deleted ? '<button class="link" data-cmt-restore="' + c.id + '">restore</button>'
                          : '<button class="link" data-cmt-del="' + c.id + '">remove</button>') : '') +
      '</div>' +
      '<pre class="body' + (c.is_deleted ? ' strike' : '') + '">' + esc(c.content) + '</pre>' +
      (c.is_deleted && c.delete_reason ? '<div class="hdr">reason: ' + esc(c.delete_reason) + '</div>' : '') +
      '</div>';
  }).join('') : '<div class="empty">No comments.</div>';
  if (ed) {
    h += '<div style="margin-top:8px"><textarea id="newComment" placeholder="Add a comment…" ' +
      'style="min-height:70px"></textarea>' +
      '<div class="row" style="margin-top:6px"><input id="commentAuthor" placeholder="your name (optional)" ' +
      'style="max-width:220px"><span class="grow"></span>' +
      '<button class="btn primary" id="addComment">Comment</button></div></div>';
  }

  h += '<h3>Notes' + (ed ? ' <button class="btn" id="addTaskNote">+ Note</button>' : '') + '</h3>';
  h += t.notes.length ? t.notes.map(function (n) {
    return '<div class="cmt"><div class="hdr">' + esc(label(n.note_type)) + ' · ' + fmtDate(n.created_at) +
      '</div><strong>' + esc(n.title) + '</strong><pre class="body">' + esc(n.content) + '</pre></div>';
  }).join('') : '<div class="empty">None.</div>';

  if (t.activity.length) {
    h += '<h3>History</h3>' + t.activity.map(function (a) {
      return '<div class="act"><time>' + fmtDate(a.created_at) + '</time>' +
        '<span class="grow">' + esc(a.summary || a.action) + '</span></div>';
    }).join('');
  }

  d.innerHTML = h;
  document.body.appendChild(backdrop);
  document.body.appendChild(d);
  d.scrollTop = scroll;
}

/* ---------- write actions ---------- */

function editTaskModal() {
  var t = S.task;
  var fields = [
    { key: 'title', label: 'Title', type: 'text', value: t.title, required: true },
  ];
  // A locked description is simply absent from the form — offering a field that
  // the server will refuse is worse than not offering it.
  if (!t.description_locked) {
    fields.push({ key: 'description', label: 'Description', type: 'textarea', value: t.description });
  }
  modal('Edit task #' + t.id + (t.description_locked ? '  ·  description locked' : ''), fields.concat([
    { key: 'status', label: 'Status', type: 'select', options: TASK_STATUS, value: t.status },
    { key: 'priority', label: 'Priority', type: 'select', options: PRIORITY, value: t.priority },
    { key: 'assigned_to', label: 'Assigned to', type: 'text', value: t.assigned_to },
    { key: 'due_date', label: 'Due date', type: 'date', value: t.due_date },
    { key: 'estimated_hours', label: 'Estimated hours', type: 'number', value: t.estimated_hours },
    { key: 'actual_hours', label: 'Actual hours', type: 'number', value: t.actual_hours },
    { key: 'tags', label: 'Tags', type: 'tags', value: parseTags(t.tags).join(', ') }
  ]), 'Save', function (values, changed) {
    if (!Object.keys(changed).length) return Promise.resolve();
    changed.id = t.id;
    return act('task_update', changed).then(function () {
      toast('Task updated');
      return refresh();
    });
  });
}

function newTaskModal(epicId) {
  modal('New task', [
    { key: 'title', label: 'Title', type: 'text', value: '', required: true },
    { key: 'description', label: 'Description', type: 'textarea', value: '' },
    { key: 'status', label: 'Status', type: 'select', options: TASK_STATUS, value: 'todo' },
    { key: 'priority', label: 'Priority', type: 'select', options: PRIORITY, value: 'medium' },
    { key: 'assigned_to', label: 'Assigned to', type: 'text', value: '' },
    { key: 'due_date', label: 'Due date', type: 'date', value: '' },
    { key: 'estimated_hours', label: 'Estimated hours', type: 'number', value: '' },
    { key: 'tags', label: 'Tags', type: 'tags', value: '' }
  ], 'Create', function (values) {
    var args = { epic_id: epicId, title: values.title, status: values.status, priority: values.priority };
    if (values.description) args.description = values.description;
    if (values.assigned_to) args.assigned_to = values.assigned_to;
    if (values.due_date) args.due_date = values.due_date;
    if (values.estimated_hours !== null) args.estimated_hours = values.estimated_hours;
    if (values.tags.length) args.tags = values.tags;
    return act('task_create', args).then(function () {
      toast('Task created');
      S.epicOpen[epicId] = true;
      return refresh();
    });
  });
}

function epicModal(epic) {
  var isNew = !epic;
  modal(isNew ? 'New epic' : 'Edit epic', [
    { key: 'name', label: 'Name', type: 'text', value: isNew ? '' : epic.name, required: true },
    { key: 'description', label: 'Description', type: 'textarea', value: isNew ? '' : epic.description },
    { key: 'status', label: 'Status', type: 'select', options: EPIC_STATUS, value: isNew ? 'planned' : epic.status },
    { key: 'priority', label: 'Priority', type: 'select', options: PRIORITY, value: isNew ? 'medium' : epic.priority },
    { key: 'branch', label: 'Git branch (blank = all branches)', type: 'text', value: isNew ? '' : epic.branch },
    { key: 'tags', label: 'Tags', type: 'tags', value: isNew ? '' : parseTags(epic.tags).join(', ') }
  ], isNew ? 'Create' : 'Save', function (values, changed) {
    if (isNew) {
      var args = { project_id: S.projectId, name: values.name, status: values.status, priority: values.priority };
      if (values.description) args.description = values.description;
      if (values.branch) args.branch = values.branch;
      if (values.tags.length) args.tags = values.tags;
      return act('epic_create', args).then(function () { toast('Epic created'); return refresh(); });
    }
    if (!Object.keys(changed).length) return Promise.resolve();
    changed.id = epic.id;
    return act('epic_update', changed).then(function () { toast('Epic updated'); return refresh(); });
  });
}

function projectModal(project) {
  var isNew = !project;
  modal(isNew ? 'New project' : 'Edit project', [
    { key: 'name', label: 'Name', type: 'text', value: isNew ? '' : project.name, required: true },
    { key: 'description', label: 'Description', type: 'textarea', value: isNew ? '' : project.description },
    { key: 'status', label: 'Status', type: 'select', options: PROJECT_STATUS, value: isNew ? 'active' : project.status },
    { key: 'tags', label: 'Tags', type: 'tags', value: isNew ? '' : parseTags(project.tags).join(', ') }
  ], isNew ? 'Create' : 'Save', function (values, changed) {
    if (isNew) {
      var args = { name: values.name, status: values.status };
      if (values.description) args.description = values.description;
      if (values.tags.length) args.tags = values.tags;
      return act('project_create', args).then(function (p) {
        toast('Project created');
        S.projectId = p.id;
        S.epicOpen = {};
        S.tab = 'overview';
        return refresh();
      });
    }
    if (!Object.keys(changed).length) return Promise.resolve();
    changed.id = project.id;
    return act('project_update', changed).then(function () { toast('Project updated'); return refresh(); });
  });
}

function noteModal(note, related) {
  var isNew = !note;
  var fields = [
    { key: 'title', label: 'Title', type: 'text', value: isNew ? '' : note.title, required: true },
    { key: 'content', label: 'Content', type: 'textarea', value: isNew ? '' : note.content, required: true },
    { key: 'note_type', label: 'Type', type: 'select', options: NOTE_TYPES,
      value: isNew ? 'general' : note.note_type },
    { key: 'tags', label: 'Tags', type: 'tags', value: isNew ? '' : parseTags(note.tags).join(', ') }
  ];
  modal(isNew ? 'New note' : 'Edit note', fields, isNew ? 'Save note' : 'Save', function (values, changed) {
    var args = { title: values.title, content: values.content, note_type: values.note_type, tags: values.tags };
    if (!isNew) args.id = note.id;
    if (isNew) {
      var link = related || { type: 'project', id: S.projectId };
      args.related_entity_type = link.type;
      args.related_entity_id = link.id;
    }
    return act('note_save', args).then(function () {
      toast(isNew ? 'Note saved' : 'Note updated');
      return refresh();
    });
  });
}

/* ---------- events ---------- */

document.addEventListener('click', function (ev) {
  var target = ev.target;

  var tabBtn = target.closest('nav button');
  if (tabBtn) { S.tab = tabBtn.dataset.tab; S.query = ''; el('q').value = ''; render(); return; }

  if (target.id === 'closeDrawer') return closeDrawer();
  if (target.id === 'refreshTask') {
    var btn = target;
    btn.disabled = true;
    btn.textContent = '⟳ …';
    return refresh().then(function () { toast('Refreshed'); }).catch(oops);
  }
  if (target.id === 'clearSearch') { S.query = ''; el('q').value = ''; render(); return; }
  if (target.id === 'reload') { toast('Reloaded'); refresh(); return; }
  if (target.id === 'expandAll') { S.overview.epics.forEach(function (e) { S.epicOpen[e.id] = true; }); render(); return; }
  if (target.id === 'collapseAll') { S.epicOpen = {}; render(); return; }
  if (target.id === 'newProject') return projectModal(null);
  if (target.id === 'editProject') return projectModal(S.overview.project);
  if (target.id === 'toggleArchived') {
    S.showArchived = !S.showArchived;
    return loadProject();
  }

  var archBtn = target.closest('[data-archive-epic]');
  if (archBtn) {
    var aid = Number(archBtn.dataset.archiveEpic);
    var isArchived = archBtn.dataset.archived === '1';
    return act('epic_archive', { id: aid, archived: !isArchived })
      .then(function (r) { toast(r.message); return refresh(); }).catch(oops);
  }

  if (target.id === 'deleteTask') {
    var t = S.task;
    if (t.status !== 'todo') {
      return oops(new Error("Only a task still in 'todo' can be removed — this one is '" + label(t.status) + "'."));
    }
    var why = prompt('Why is this task being removed? (kept in the audit trail)');
    if (why === null) return;
    return act('task_delete', { id: t.id, reason: why || null })
      .then(function (r) { toast(r.message); closeDrawer(); return refresh(); }).catch(oops);
  }
  if (target.id === 'restoreTask') {
    return act('task_restore', { id: S.task.id })
      .then(function (r) { toast(r.message); return refresh(); }).catch(oops);
  }

  if (target.id === 'newEpic') return epicModal(null);
  if (target.id === 'newNote') return noteModal(null, null);
  if (target.id === 'editTask') return editTaskModal();
  if (target.id === 'addTaskNote') return noteModal(null, { type: 'task', id: S.task.id });

  if (target.id === 'addSubtask') return submitSubtask();
  if (target.id === 'addComment') return submitComment();

  var editEpic = target.closest('[data-edit-epic]');
  if (editEpic) {
    var eid = Number(editEpic.dataset.editEpic);
    var epic = S.overview.epics.filter(function (x) { return x.id === eid; })[0];
    return epicModal(epic);
  }

  var newTask = target.closest('[data-new-task]');
  if (newTask) return newTaskModal(Number(newTask.dataset.newTask));

  var editNote = target.closest('[data-edit-note]');
  if (editNote) {
    var nid = Number(editNote.dataset.editNote);
    var note = (S.notes || []).filter(function (x) { return x.id === nid; })[0];
    return noteModal(note, null);
  }

  var delNote = target.closest('[data-del-note]');
  if (delNote) {
    if (!confirm('Delete this note? Notes are deleted permanently.')) return;
    return act('note_delete', { id: Number(delNote.dataset.delNote) })
      .then(function () { toast('Note deleted'); viewNotes(); }).catch(oops);
  }

  if (target.id === 'toggleLock') {
    return act('task_lock_description', { id: S.task.id, locked: !S.task.description_locked })
      .then(function (r) { toast(r.message); return refresh(); }).catch(oops);
  }

  var cycle = target.closest('[data-subtask-cycle]');
  if (cycle) {
    var cid = Number(cycle.dataset.subtaskCycle);
    var sub = S.task.subtasks.filter(function (x) { return x.id === cid; })[0];
    var next = { todo: 'in_progress', in_progress: 'done', done: 'todo' }[sub.status] || 'todo';
    var args = { id: cid, status: next };
    if (sub.blocked && next !== 'todo') {
      var unmet = (sub.depends_on || []).filter(function (d) { return d.status !== 'done'; });
      var msg = 'This subtask is blocked by ' +
        unmet.map(function (d) { return '#' + d.id + ' ' + d.title; }).join(', ') +
        '.\\n\\nMark it ' + label(next) + ' anyway? The override is recorded in the activity log.';
      if (!confirm(msg)) return;
      args.force = true;
    }
    return act('subtask_update', args).then(function () { return refresh(); }).catch(oops);
  }

  var depsBtn = target.closest('[data-subtask-deps]');
  if (depsBtn) {
    var sid = Number(depsBtn.dataset.subtaskDeps);
    var self = S.task.subtasks.filter(function (x) { return x.id === sid; })[0];
    var current = (self.depends_on || []).map(function (d) { return d.id; });
    var siblings = S.task.subtasks.filter(function (x) {
      if (x.id === sid) return false;
      // A finished sibling cannot block anything, so it is noise when choosing
      // prerequisites — unless it is already one, in which case it must stay
      // visible to be unchecked.
      return x.status !== 'done' || current.indexOf(x.id) >= 0;
    }).map(function (x) {
      return { value: x.id, text: '#' + x.id + '  ' + x.title +
        (x.status === 'done' ? '  (done)' : x.status === 'in_progress' ? '  (in progress)' : '') };
    });
    return modal('“' + self.title + '” waits on…', [
      { key: 'depends_on', label: 'Prerequisite subtasks — it stays blocked until these are done',
        type: 'checkboxes', options: siblings, value: current }
    ], 'Save', function (values) {
      return act('subtask_update', { id: sid, depends_on: values.depends_on })
        .then(function () { toast('Dependencies updated'); return refresh(); });
    });
  }

  var renameSub = target.closest('[data-subtask-rename]');
  if (renameSub) {
    var sid = Number(renameSub.dataset.subtaskRename);
    var sub = S.task.subtasks.filter(function (x) { return x.id === sid; })[0];
    var title = prompt('Subtask title', sub.title);
    if (title === null || !title.trim() || title === sub.title) return;
    return act('subtask_update', { id: sid, title: title.trim() })
      .then(function () { return refresh(); }).catch(oops);
  }

  var delSub = target.closest('[data-subtask-del]');
  if (delSub) {
    if (!confirm('Remove this subtask?')) return;
    return act('subtask_delete', { ids: Number(delSub.dataset.subtaskDel) })
      .then(function () { return refresh(); }).catch(oops);
  }

  var delCmt = target.closest('[data-cmt-del]');
  if (delCmt) {
    var reason = prompt('Why is this comment being removed? (kept in the audit trail)');
    if (reason === null) return;
    return act('comment_delete', { id: Number(delCmt.dataset.cmtDel), reason: reason || null })
      .then(function () { toast('Comment removed'); return refresh(); }).catch(oops);
  }

  var restoreCmt = target.closest('[data-cmt-restore]');
  if (restoreCmt) {
    return act('comment_restore', { id: Number(restoreCmt.dataset.cmtRestore) })
      .then(function () { toast('Comment restored'); return refresh(); }).catch(oops);
  }

  var taskNode = target.closest('[data-task]');
  if (taskNode) { ev.preventDefault(); openTask(Number(taskNode.dataset.task)); return; }

  var toggle = target.closest('[data-toggle]');
  if (toggle) {
    var tid = toggle.dataset.toggle;
    S.epicOpen[tid] = !S.epicOpen[tid];
    render();
    return;
  }

  var openEpic = target.closest('[data-epic-open]');
  if (openEpic) {
    S.epicOpen = {};
    S.epicOpen[openEpic.dataset.epicOpen] = true;
    S.tab = 'epics';
    render();
    return;
  }

  var gotoEpic = target.closest('[data-goto-epic]');
  if (gotoEpic) {
    var pid = Number(gotoEpic.dataset.project);
    S.epicOpen = {};
    S.epicOpen[gotoEpic.dataset.gotoEpic] = true;
    S.tab = 'epics';
    S.query = '';
    el('q').value = '';
    if (pid !== S.projectId) {
      S.projectId = pid;
      el('projectSel').value = String(pid);
      loadProject();
    } else render();
    return;
  }

  var projNode = target.closest('[data-project]');
  if (projNode) {
    S.projectId = Number(projNode.dataset.project);
    el('projectSel').value = String(S.projectId);
    S.query = ''; el('q').value = ''; S.tab = 'overview';
    loadProject();
    return;
  }
});

function submitSubtask() {
  var input = el('newSubtask');
  var title = input.value.trim();
  if (!title) return;
  input.value = '';
  act('subtask_create', { task_id: S.task.id, titles: title })
    .then(function () { return refresh(); }).catch(oops);
}

function submitComment() {
  var box = el('newComment');
  var content = box.value.trim();
  if (!content) return;
  var author = el('commentAuthor').value.trim();
  var args = { task_id: S.task.id, content: content };
  if (author) args.author = author;
  box.value = '';
  act('comment_add', args).then(function () { toast('Comment added'); return refresh(); }).catch(oops);
}

document.addEventListener('change', function (ev) {
  var target = ev.target;
  if (target.id === 'projectSel') {
    S.projectId = Number(target.value);
    S.epicOpen = {};
    loadProject();
    return;
  }
  if (target.id === 'showDeleted') {
    S.showDeleted = target.checked;
    openTask(S.task.id);
    return;
  }
  if (target.id === 'quickStatus') {
    var args = { id: S.task.id, status: target.value };
    var open = (S.task.subtasks || []).filter(function (x) { return x.status !== 'done'; });
    if (target.value === 'done' && open.length > 0) {
      var msg = open.length + ' subtask(s) are unfinished:\\n\\n' +
        open.map(function (x) { return '  • ' + x.title + ' (' + label(x.status) + ')'; }).join('\\n') +
        '\\n\\nComplete the task anyway? The override is recorded in the activity log.';
      if (!confirm(msg)) { target.value = S.task.status; return; }
      args.force = true;
    }
    act('task_update', args)
      .then(function () { toast('Status updated'); return refresh(); }).catch(oops);
    return;
  }
  if (target.id === 'quickPriority') {
    act('task_update', { id: S.task.id, priority: target.value })
      .then(function () { toast('Priority updated'); return refresh(); }).catch(oops);
    return;
  }

});

document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') {
    if (document.querySelector('.modal')) closeModal();
    else if (document.querySelector('.drawer')) closeDrawer();
    else if (S.query) { S.query = ''; el('q').value = ''; render(); }
    return;
  }
  if (ev.key === 'Enter' && ev.target.id === 'newSubtask') { ev.preventDefault(); submitSubtask(); }
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && ev.target.id === 'newComment') submitComment();
});

var qTimer = null;
document.addEventListener('input', function (ev) {
  if (ev.target.id !== 'q') return;
  clearTimeout(qTimer);
  var v = ev.target.value.trim();
  qTimer = setTimeout(function () { S.query = v.length >= 2 ? v : ''; render(); }, 220);
});

/* drag the drawer's left edge to resize it; the width persists per browser */
var resizing = false;
document.addEventListener('mousedown', function (ev) {
  if (!ev.target.closest || !ev.target.closest('#drawerResize')) return;
  resizing = true;
  ev.target.classList.add('active');
  document.body.classList.add('resizing');
  ev.preventDefault();
});
document.addEventListener('mousemove', function (ev) {
  if (!resizing) return;
  var width = Math.min(Math.max(window.innerWidth - ev.clientX, 380), window.innerWidth - 60);
  var drawer = document.querySelector('.drawer');
  if (drawer) drawer.style.width = width + 'px';
});
document.addEventListener('mouseup', function () {
  if (!resizing) return;
  resizing = false;
  document.body.classList.remove('resizing');
  var grip = document.querySelector('.drawer-resize');
  if (grip) grip.classList.remove('active');
  var drawer = document.querySelector('.drawer');
  if (drawer) {
    try { localStorage.setItem('saga.drawerWidth', drawer.style.width); } catch (e) { /* private mode */ }
  }
});

/* drag a subtask onto another to reorder the checklist */
var dragSub = null;
document.addEventListener('dragstart', function (ev) {
  var row = ev.target.closest ? ev.target.closest('.sub[data-subtask-row]') : null;
  if (!row) return;
  dragSub = Number(row.dataset.subtaskRow);
  row.classList.add('dragging');
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(dragSub));
  ev.stopPropagation();
});
document.addEventListener('dragover', function (ev) {
  if (dragSub === null) return;
  var row = ev.target.closest ? ev.target.closest('.sub[data-subtask-row]') : null;
  if (!row) return;
  ev.preventDefault();
  row.classList.add('dropinto');
});
document.addEventListener('dragleave', function (ev) {
  var row = ev.target.closest ? ev.target.closest('.sub[data-subtask-row]') : null;
  if (row) row.classList.remove('dropinto');
});
document.addEventListener('drop', function (ev) {
  if (dragSub === null) return;
  var row = ev.target.closest ? ev.target.closest('.sub[data-subtask-row]') : null;
  if (!row) return;
  ev.preventDefault();
  ev.stopPropagation();
  row.classList.remove('dropinto');
  var target = Number(row.dataset.subtaskRow);
  var moved = dragSub;
  dragSub = null;
  if (moved === target) return;

  var order = S.task.subtasks.map(function (x) { return x.id; });
  order.splice(order.indexOf(moved), 1);
  order.splice(order.indexOf(target), 0, moved);
  act('subtask_reorder', { task_id: S.task.id, ordered_ids: order })
    .then(function () { return refresh(); }).catch(oops);
});
document.addEventListener('dragend', function () {
  dragSub = null;
  Array.prototype.forEach.call(document.querySelectorAll('.sub.dragging, .sub.dropinto'), function (n) {
    n.classList.remove('dragging');
    n.classList.remove('dropinto');
  });
});

/* drag a board card into another status column */
var dragId = null;
document.addEventListener('dragstart', function (ev) {
  var card = ev.target.closest ? ev.target.closest('.tcard[draggable]') : null;
  if (!card) return;
  dragId = Number(card.dataset.task);
  card.classList.add('dragging');
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(dragId));
});
document.addEventListener('dragend', function (ev) {
  if (ev.target.classList) ev.target.classList.remove('dragging');
  dragId = null;
});
document.addEventListener('dragover', function (ev) {
  var col = ev.target.closest ? ev.target.closest('.col[data-status]') : null;
  if (!col || dragId === null) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  col.classList.add('over');
});
document.addEventListener('dragleave', function (ev) {
  var col = ev.target.closest ? ev.target.closest('.col[data-status]') : null;
  if (col) col.classList.remove('over');
});
document.addEventListener('drop', function (ev) {
  var col = ev.target.closest ? ev.target.closest('.col[data-status]') : null;
  if (!col || dragId === null) return;
  ev.preventDefault();
  col.classList.remove('over');
  var id = dragId;
  var status = col.dataset.status;
  var current = S.tasks.filter(function (t) { return t.id === id; })[0];
  dragId = null;
  if (current && current.status === status) return;
  var payload = { id: id, status: status };
  if (status === 'done' && current && current.subtask_count > current.subtask_done) {
    var left = current.subtask_count - current.subtask_done;
    if (!confirm(left + ' subtask(s) on “' + current.title + '” are unfinished. Complete it anyway?')) return;
    payload.force = true;
  }
  act('task_update', payload)
    .then(function () { toast('Moved to ' + label(status)); return refresh(); }).catch(oops);
});

/* ---------- boot ---------- */

// Back and forward move between tasks and tabs rather than leaving the page.
// Registered before boot so it survives a failed first fetch.
window.addEventListener('hashchange', function () {
  var want = readHash();
  var openId = S.task ? S.task.id : null;
  if (want.task === openId && (want.tab || 'overview') === S.tab &&
      (!want.p || want.p === S.projectId)) return;

  applyingHash = true;
  try {
    if (want.p && want.p !== S.projectId && S.projects.some(function (p) { return p.id === want.p; })) {
      S.projectId = want.p;
      el('projectSel').value = String(want.p);
      S.epicOpen = {};
      loadProject();
    }
    S.tab = want.tab || 'overview';
    render();
    if (want.task) openTask(want.task);
    else if (S.task) closeDrawer();
  } finally {
    applyingHash = false;
  }
});

get('/api/projects').then(function (r) {
  S.projects = r.projects;
  S.readOnly = !!r.read_only;
  el('dbpath').textContent = r.db_path;
  el('roBadge').hidden = !S.readOnly;
  if (S.readOnly) el('newProject').hidden = true;

  var want = readHash();
  var known = S.projects.some(function (p) { return p.id === want.p; });
  S.projectId = known ? want.p : (S.projects.length ? S.projects[0].id : null);
  if (want.tab) S.tab = want.tab;

  renderProjects();
  loadProject().then(function () {
    // Reopen whatever task the URL names, so a browser refresh keeps your place.
    if (want.task) return openTask(want.task);
  });
}).catch(fail);

</script>
</body>
</html>`;
