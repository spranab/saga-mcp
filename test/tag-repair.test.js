import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tempDbPath } from './helpers.js';

/**
 * #29 stored corrupted tags before it was fixed: an array sent as a JSON
 * *string* was written to the column verbatim, so the column held a string
 * rather than an array. The UI then rendered one pill per character, and
 * json_each tag filters matched nothing.
 *
 * Opening such a database repairs what is recoverable, losslessly — no text is
 * split, nothing is invented, and healthy rows are left exactly as they are.
 */
const dbPath = tempDbPath('saga-tag-repair');

const seed = new Database(dbPath);
seed.exec(`
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
  INSERT INTO projects (name) VALUES ('P');
  INSERT INTO epics (project_id, name) VALUES (1, 'E');
`);
const insert = seed.prepare('INSERT INTO tasks (epic_id, title, tags) VALUES (1, ?, ?)');
// Exactly what the old code wrote for each input shape.
insert.run('healthy', JSON.stringify(['billing', 'urgent']));      // never corrupted
insert.run('encoded-array', JSON.stringify('["billing","urgent"]')); // recoverable
insert.run('plain-text', JSON.stringify('billing,urgent'));          // wrappable
insert.run('empty', '[]');
seed.close();

process.env.DB_PATH = dbPath;
const { getDb } = await import('../dist/db.js');
const db = getDb(); // opening runs the repair

const tagsOf = (title) =>
  db.prepare('SELECT tags FROM tasks WHERE title = ?').get(title).tags;

test('a healthy tags array is left exactly as it was', () => {
  assert.equal(tagsOf('healthy'), '["billing","urgent"]');
});

test('an array that was stored as a JSON string is unwrapped', () => {
  assert.deepEqual(JSON.parse(tagsOf('encoded-array')), ['billing', 'urgent']);
});

test('other text is wrapped into a single tag rather than split or discarded', () => {
  // Splitting on the comma here would be the migration inventing intent, so it
  // preserves the text verbatim as one tag instead.
  assert.deepEqual(JSON.parse(tagsOf('plain-text')), ['billing,urgent']);
});

test('an empty array stays empty', () => {
  assert.equal(tagsOf('empty'), '[]');
});

test('every row now holds a real JSON array', () => {
  const rows = db.prepare('SELECT title, tags FROM tasks').all();
  for (const row of rows) {
    assert.ok(Array.isArray(JSON.parse(row.tags)), `${row.title} should hold an array`);
  }
});

test('json_each works across the table again, so tag filters can match', () => {
  // The real consequence of the corruption: this query returned nothing.
  const count = db.prepare('SELECT COUNT(*) c FROM tasks, json_each(tasks.tags)').get().c;
  assert.equal(count, 5, 'billing+urgent, billing+urgent, billing,urgent');
  const billing = db
    .prepare("SELECT title FROM tasks WHERE EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE json_each.value = 'billing')")
    .all()
    .map((r) => r.title);
  assert.deepEqual(billing.sort(), ['encoded-array', 'healthy']);
});

test('re-opening the database changes nothing further', async () => {
  // The repair must be idempotent — it runs on every open.
  const before = db.prepare('SELECT title, tags FROM tasks ORDER BY id').all();
  const { getDb: again } = await import('../dist/db.js');
  const after = again().prepare('SELECT title, tags FROM tasks ORDER BY id').all();
  assert.deepEqual(after, before);
});
