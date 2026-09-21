/**
 * `tags`, `metadata` and `source_ref` live in TEXT columns holding JSON, and
 * every tool answers with the row SQLite handed back. So those columns left the
 * server as *strings*, and the MCP layer escaped them a second time on the way
 * out: an agent reading a task saw
 *
 *   "tags":"[\"cherry-pick\",\"dedicated branch\"]"
 *
 * where it expected a list (#55, reported by @rusak47). Agents that trusted the
 * declared type read no tags at all.
 *
 * Decoding a row where it is built would mean a call in every tool that returns
 * one, and the next tool added would miss it — which is how a gap this wide
 * opened in the first place. So it happens once, over the whole result, at the
 * boundary where a response is serialised.
 *
 * Anything that does not parse to the shape its column is meant to hold is
 * handed back untouched: a `source_ref` holding a bare URL stays that URL, and
 * a value already decoded is left alone.
 */

/** JSON columns, and the shape each one must parse to before it is replaced. */
const JSON_COLUMNS: Record<string, 'array' | 'object'> = {
  tags: 'array',
  metadata: 'object',
  source_ref: 'object',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeColumn(value: unknown, shape: 'array' | 'object'): unknown {
  if (typeof value !== 'string') return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value; // not JSON at all: plain text that happens to sit in the column
  }
  if (shape === 'array') return Array.isArray(parsed) ? parsed : value;
  // A bare number or quoted string parses cleanly and would change type under
  // the caller's feet, so only the container shapes are accepted.
  return isPlainObject(parsed) || Array.isArray(parsed) ? parsed : value;
}

/** Decode the JSON columns anywhere they appear in a tool result. */
export function decodeJsonColumns<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => decodeJsonColumns(item)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const shape = JSON_COLUMNS[key];
    out[key] = shape ? decodeColumn(item, shape) : decodeJsonColumns(item);
  }
  return out as unknown as T;
}
