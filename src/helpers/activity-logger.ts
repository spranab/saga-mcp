import type Database from 'better-sqlite3';

export function logActivity(
  db: Database.Database,
  entityType: string,
  entityId: number,
  action: string,
  fieldName: string | null,
  oldValue: string | null,
  newValue: string | null,
  summary: string
): void {
  db.prepare(
    `INSERT INTO activity_log (entity_type, entity_id, action, field_name, old_value, new_value, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(entityType, entityId, action, fieldName, oldValue, newValue, summary);
}

export function logEntityUpdate(
  db: Database.Database,
  entityType: string,
  entityId: number,
  entityName: string,
  oldRow: Record<string, unknown>,
  newRow: Record<string, unknown>,
  trackedFields: string[]
): void {
  for (const field of trackedFields) {
    const oldVal = String(oldRow[field] ?? '');
    const newVal = String(newRow[field] ?? '');
    if (oldVal !== newVal) {
      const action = field === 'status' ? 'status_changed' : 'updated';
      logActivity(
        db, entityType, entityId, action, field, oldVal, newVal,
        `${entityType} '${entityName}' ${field}: ${oldVal} -> ${newVal}`
      );
    }
  }
}
