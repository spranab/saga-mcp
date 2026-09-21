import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    throw new Error(
      'DB_PATH environment variable is required. Set it to the path of your .tracker.db file, e.g., DB_PATH=/path/to/project/.tracker.db'
    );
  }

  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  db.exec(SCHEMA_SQL);

  // Migrations for existing databases
  try { db.exec('ALTER TABLE tasks ADD COLUMN source_ref TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE epics ADD COLUMN branch TEXT'); } catch { /* column already exists */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_epics_branch ON epics(branch)'); } catch { /* index already exists */ }
  try { db.exec('ALTER TABLE comments ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE comments ADD COLUMN deleted_at TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE comments ADD COLUMN deleted_by TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE comments ADD COLUMN delete_reason TEXT'); } catch { /* column already exists */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_comments_task_live ON comments(task_id, is_deleted)'); } catch { /* index already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN description_locked INTEGER NOT NULL DEFAULT 0'); } catch { /* column already exists */ }
  // #30: archiving an epic hides it without pretending it was cancelled, and a
  // todo task can be removed the way a comment can — kept, hidden, restorable.
  try { db.exec('ALTER TABLE epics ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE epics ADD COLUMN archived_at TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN deleted_at TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN deleted_by TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN delete_reason TEXT'); } catch { /* column already exists */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_epics_archived ON epics(project_id, archived)'); } catch { /* index already exists */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_live ON tasks(epic_id, is_deleted)'); } catch { /* index already exists */ }

  // #29 left corrupted tags behind: a tags array sent as a JSON *string* was
  // stored verbatim, so the column held a string rather than an array. The UI
  // then rendered one pill per character and json_each tag filters matched
  // nothing. Repair what is recoverable, losslessly.
  // Table names cannot be bound as query parameters, so each statement below
  // is a fully static string (no runtime interpolation) for every allowed table.
  const TAG_REPAIR_SQL: Record<string, string[]> = {
    projects: [
      `UPDATE projects SET tags = json_extract(tags, '$')
       WHERE json_valid(tags) AND json_type(tags) = 'text'
         AND json_valid(json_extract(tags, '$'))
         AND json_type(json_extract(tags, '$')) = 'array'`,
      `UPDATE projects SET tags = json_array(json_extract(tags, '$'))
       WHERE json_valid(tags) AND json_type(tags) = 'text'`,
    ],
    epics: [
      `UPDATE epics SET tags = json_extract(tags, '$')
       WHERE json_valid(tags) AND json_type(tags) = 'text'
         AND json_valid(json_extract(tags, '$'))
         AND json_type(json_extract(tags, '$')) = 'array'`,
      `UPDATE epics SET tags = json_array(json_extract(tags, '$'))
       WHERE json_valid(tags) AND json_type(tags) = 'text'`,
    ],
    tasks: [
      `UPDATE tasks SET tags = json_extract(tags, '$')
       WHERE json_valid(tags) AND json_type(tags) = 'text'
         AND json_valid(json_extract(tags, '$'))
         AND json_type(json_extract(tags, '$')) = 'array'`,
      `UPDATE tasks SET tags = json_array(json_extract(tags, '$'))
       WHERE json_valid(tags) AND json_type(tags) = 'text'`,
    ],
    notes: [
      `UPDATE notes SET tags = json_extract(tags, '$')
       WHERE json_valid(tags) AND json_type(tags) = 'text'
         AND json_valid(json_extract(tags, '$'))
         AND json_type(json_extract(tags, '$')) = 'array'`,
      `UPDATE notes SET tags = json_array(json_extract(tags, '$'))
       WHERE json_valid(tags) AND json_type(tags) = 'text'`,
    ],
  };

  for (const table of Object.keys(TAG_REPAIR_SQL)) {
    try {
      // A JSON string that is itself a JSON array — unwrap it. Anything still
      // stored as a bare string becomes a single-element array. Nothing is
      // split or invented; the text is preserved exactly.
      for (const sql of TAG_REPAIR_SQL[table]) db.exec(sql);
    } catch { /* table may not exist yet on a fresh database */ }
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
