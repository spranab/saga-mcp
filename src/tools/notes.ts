import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { addTagFilter } from '../helpers/sql-builder.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'note_save',
    description:
      'Create or update a note. Notes capture decisions, context, progress, meeting notes, blockers, technical details, or release info. If "id" is provided, updates the existing note; otherwise creates a new one.',
    annotations: { title: 'Save Note', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Note ID (omit to create new)' },
        title: { type: 'string', description: 'Note title' },
        content: { type: 'string', description: 'Full note content (markdown supported)' },
        note_type: {
          type: 'string',
          enum: ['general', 'decision', 'context', 'meeting', 'technical', 'blocker', 'progress', 'release'],
          default: 'general',
        },
        related_entity_type: {
          type: 'string',
          enum: ['project', 'epic', 'task'],
          description: 'Link note to an entity',
        },
        related_entity_id: { type: 'integer', description: 'ID of the related entity' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'note_list',
    description: 'List notes with optional filters. Returns notes sorted by most recent first.',
    annotations: { title: 'List Notes', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        note_type: {
          type: 'string',
          enum: ['general', 'decision', 'context', 'meeting', 'technical', 'blocker', 'progress', 'release'],
        },
        related_entity_type: { type: 'string', enum: ['project', 'epic', 'task'] },
        related_entity_id: { type: 'integer' },
        tag: { type: 'string', description: 'Filter by a single tag' },
        limit: { type: 'integer', default: 30 },
      },
    },
  },
  {
    name: 'note_search',
    description: 'Search across note titles and content by keyword.',
    annotations: { title: 'Search Notes', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        note_type: {
          type: 'string',
          enum: ['general', 'decision', 'context', 'meeting', 'technical', 'blocker', 'progress', 'release'],
        },
        limit: { type: 'integer', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'note_delete',
    description: 'Delete a note by ID.',
    annotations: { title: 'Delete Note', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Note ID' },
      },
      required: ['id'],
    },
  },
];

function handleNoteSave(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number | undefined;
  const title = args.title as string;
  const content = args.content as string;
  const noteType = (args.note_type as string) ?? 'general';
  const relatedEntityType = (args.related_entity_type as string) ?? null;
  const relatedEntityId = (args.related_entity_id as number) ?? null;
  const tags = JSON.stringify((args.tags as string[]) ?? []);

  if (id !== undefined) {
    // Update existing note
    const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!existing) throw new Error(`Note ${id} not found`);

    const note = db
      .prepare(
        `UPDATE notes SET title = ?, content = ?, note_type = ?, related_entity_type = ?,
         related_entity_id = ?, tags = ?, updated_at = datetime('now')
         WHERE id = ? RETURNING *`
      )
      .get(title, content, noteType, relatedEntityType, relatedEntityId, tags, id);

    logActivity(db, 'note', id, 'updated', null, null, null, `Note '${title}' updated`);
    return note;
  } else {
    // Create new note
    const note = db
      .prepare(
        `INSERT INTO notes (title, content, note_type, related_entity_type, related_entity_id, tags)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .get(title, content, noteType, relatedEntityType, relatedEntityId, tags);

    const row = note as Record<string, unknown>;
    logActivity(db, 'note', row.id as number, 'created', null, null, null, `Note '${title}' created`);
    return note;
  }
}

function handleNoteList(args: Record<string, unknown>) {
  const db = getDb();
  const noteType = args.note_type as string | undefined;
  const relatedEntityType = args.related_entity_type as string | undefined;
  const relatedEntityId = args.related_entity_id as number | undefined;
  const tag = args.tag as string | undefined;
  const limit = (args.limit as number) ?? 30;

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (noteType) {
    whereClauses.push('note_type = ?');
    params.push(noteType);
  }
  if (relatedEntityType) {
    whereClauses.push('related_entity_type = ?');
    params.push(relatedEntityType);
  }
  if (relatedEntityId !== undefined) {
    whereClauses.push('related_entity_id = ?');
    params.push(relatedEntityId);
  }
  if (tag) {
    addTagFilter(whereClauses, params, tag, 'notes');
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sql = `SELECT * FROM notes ${whereStr} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function handleNoteSearch(args: Record<string, unknown>) {
  const db = getDb();
  const query = args.query as string;
  const noteType = args.note_type as string | undefined;
  const limit = (args.limit as number) ?? 20;

  const whereClauses = ['(title LIKE ? OR content LIKE ?)'];
  const pattern = `%${query}%`;
  const params: unknown[] = [pattern, pattern];

  if (noteType) {
    whereClauses.push('note_type = ?');
    params.push(noteType);
  }

  const sql = `SELECT * FROM notes WHERE ${whereClauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function handleNoteDelete(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!note) throw new Error(`Note ${id} not found`);

  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  logActivity(db, 'note', id, 'deleted', null, null, null, `Note '${note.title}' deleted`);

  return { id, title: note.title, deleted: true };
}

export const handlers: Record<string, ToolHandler> = {
  note_save: handleNoteSave,
  note_list: handleNoteList,
  note_search: handleNoteSearch,
  note_delete: handleNoteDelete,
};
