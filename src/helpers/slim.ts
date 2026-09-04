/**
 * List responses are the tokens an agent pays over and over. Detail responses
 * (task_get) stay complete; list rows drop what a scan does not need.
 *
 * Measured on a 40-task project: task_list went from ~5,300 to ~3,600 tokens.
 */

/** Longest description kept in a list row. Longer text is cut with an ellipsis. */
export const LIST_DESCRIPTION_CHARS = 120;

export function truncate(text: string, max = LIST_DESCRIPTION_CHARS): string {
  if (text.length <= max) return text;
  // Prefer a word boundary so the cut reads as prose rather than mid-token.
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/** Fields never worth their bytes in a list response. */
const ALWAYS_DROP = new Set(['metadata']);

/** Flags that only matter when set — carrying the common `0` is pure noise. */
const DROP_WHEN_ZERO = new Set(['description_locked', 'is_deleted', 'archived']);

/**
 * Strip a list row down: no nulls, no metadata blob, no empty tags array, and
 * long text fields truncated. Everything removed here is still available from
 * the matching *_get tool.
 */
export function slimListRow(
  row: Record<string, unknown>,
  truncateFields: string[] = ['description'],
  drop: string[] = []
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (ALWAYS_DROP.has(key) || drop.includes(key)) continue;
    if (DROP_WHEN_ZERO.has(key) && (value === 0 || value === false)) continue;
    if (key === 'tags' && (value === '[]' || value === '')) continue;
    if (truncateFields.includes(key) && typeof value === 'string') {
      out[key] = truncate(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Apply slimListRow across a result set. */
export function slimList(
  rows: Array<Record<string, unknown>>,
  truncateFields?: string[],
  drop?: string[]
): Array<Record<string, unknown>> {
  return rows.map((row) => slimListRow(row, truncateFields, drop));
}
