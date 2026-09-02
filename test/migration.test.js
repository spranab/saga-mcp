import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tempDbPath } from './helpers.js';

/**
 * Opening a database written by an older saga-mcp must upgrade it in place.
 * SCHEMA_SQL runs before the ALTER TABLE migrations, so anything in SCHEMA_SQL
 * that references a migrated column would throw here and take the whole server
 * down for every existing user — this test is the guard against that.
 */
const dbPath = tempDbPath('saga-migration');

const legacy = new Database(dbPath);
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
  CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, author TEXT,
    content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO projects (name) VALUES ('Legacy');
  INSERT INTO epics (project_id, name) VALUES (1, 'Legacy epic');
  INSERT INTO tasks (epic_id, title) VALUES (1, 'Legacy task');
  INSERT INTO comments (task_id, author, content) VALUES (1, 'old', 'written before the upgrade');
`);
const legacyColumns = legacy.prepare('SELECT * FROM comments').columns().map((c) => c.name);
legacy.close();

process.env.DB_PATH = dbPath;
const { getDb } = await import('../dist/db.js');
const { handlers: comments } = await import('../dist/tools/comments.js');

test('the fixture really is a pre-soft-delete database', () => {
  assert.ok(!legacyColumns.includes('is_deleted'));
});

test('opening an old database adds the soft-delete columns instead of throwing', () => {
  const db = getDb();
  const columns = db.prepare('SELECT * FROM comments').columns().map((c) => c.name);
  for (const col of ['is_deleted', 'deleted_at', 'deleted_by', 'delete_reason']) {
    assert.ok(columns.includes(col), `expected migrated column ${col}`);
  }
});

test('rows written before the upgrade default to not-deleted', () => {
  const row = getDb().prepare('SELECT * FROM comments WHERE id = 1').get();
  assert.equal(row.is_deleted, 0);
  assert.equal(row.content, 'written before the upgrade');
});

test('pre-existing comments still list, and soft-delete works on them', () => {
  assert.equal(comments.comment_list({ task_id: 1 }).length, 1);
  comments.comment_delete({ id: 1, reason: 'migrated then removed' });
  assert.equal(comments.comment_list({ task_id: 1 }).length, 0);
  assert.equal(comments.comment_list({ task_id: 1, include_deleted: true }).length, 1);
});

test('opening the upgraded database a second time is a no-op', () => {
  assert.doesNotThrow(() => getDb().prepare('SELECT is_deleted FROM comments').all());
});
