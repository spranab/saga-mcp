import { tagsColumn } from './coerce.js';

const JSON_COLUMNS = new Set(['tags', 'metadata', 'source_ref']);

export function buildUpdate(
  table: string,
  id: number,
  fields: Record<string, unknown>,
  allowedColumns: string[]
): { sql: string; params: unknown[] } | null {
  const updates: string[] = [];
  const params: unknown[] = [];

  for (const col of allowedColumns) {
    if (fields[col] !== undefined) {
      updates.push(`${col} = ?`);
      // Tags go through the normaliser so an update cannot store the shape a
      // create would have rejected — addTagFilter runs json_each over this.
      if (col === 'tags') params.push(tagsColumn(fields[col]));
      else params.push(JSON_COLUMNS.has(col) ? JSON.stringify(fields[col]) : fields[col]);
    }
  }

  if (updates.length === 0) return null;

  updates.push("updated_at = datetime('now')");
  params.push(id);

  return {
    sql: `UPDATE ${table} SET ${updates.join(', ')} WHERE id = ? RETURNING *`,
    params,
  };
}

export function addTagFilter(
  whereClauses: string[],
  params: unknown[],
  tag: string,
  table: string
): void {
  whereClauses.push(
    `EXISTS (SELECT 1 FROM json_each(${table}.tags) WHERE json_each.value = ?)`
  );
  params.push(tag);
}
