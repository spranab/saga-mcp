/**
 * Normalising what models actually send.
 *
 * Reported as #29: a batch of subtasks arrived as one record. The cause is
 * general — smaller models routinely send an array parameter as a *string*
 * containing JSON, and every array-taking tool here assumed a real array. The
 * results ranged from bad to silent:
 *
 *   subtask_create titles: '["a","b"]'  -> one subtask literally titled ["a","b"]
 *   task_batch_update ids: '[1,2]'      -> "ids.map is not a function"
 *   subtask_reorder ordered_ids: '[1]'  -> "orderedIds.filter is not a function"
 *   subtask_update depends_on: '[4]'    -> "Subtask(s) not found: [, 4, ]"
 *   tags: '["a","b"]'                   -> stored as a string, then rendered as
 *                                          one tag pill per character
 *
 * So these helpers accept what a model is likely to send, and refuse the rest
 * with a message that says what arrived and what was wanted — a leaked
 * TypeError teaches an agent nothing.
 *
 * The rules are deliberately conservative. Coercion only happens where the
 * intent is unambiguous; anything that could plausibly be a legitimate single
 * value is left alone.
 */

/** `["a","b"]` or `['a','b']` written as a string, or null if it is not that. */
function parseArrayLiteral(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Models often emit Python-ish single quotes. Only retry when the string
    // holds no double quotes of its own, so nothing is mangled.
    if (trimmed.includes('"')) return null;
    try {
      const parsed = JSON.parse(trimmed.replace(/'/g, '"'));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

/** Unwrap the common `['["a","b"]']` shape — an array holding one JSON string. */
function unwrapSingleEncoded(items: unknown[]): unknown[] {
  if (items.length !== 1 || typeof items[0] !== 'string') return items;
  return parseArrayLiteral(items[0]) ?? items;
}

/**
 * A list of titles. Accepts an array, a JSON array written as a string, or a
 * single string. A single string holding several lines is split, because a
 * model asked for a checklist commonly returns one — bullets and numbering are
 * stripped.
 *
 * Commas are deliberately NOT split on: "Design the API, then implement it" is
 * a perfectly ordinary single title, and guessing there would quietly turn one
 * subtask into two.
 */
export function asTitleList(value: unknown, field = 'titles'): string[] {
  const fromValue = (input: unknown): string[] => {
    if (Array.isArray(input)) {
      return unwrapSingleEncoded(input).flatMap((item) => {
        if (typeof item === 'string') return fromValue(item);
        // Models sometimes send [{title: "..."}] instead of ["..."].
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).title === 'string') {
          return [((item as Record<string, unknown>).title as string).trim()];
        }
        throw new Error(
          `${field} must be strings. Received ${describe(item)}. Send ["First item", "Second item"].`
        );
      });
    }
    if (typeof input === 'string') {
      const asArray = parseArrayLiteral(input);
      if (asArray) return fromValue(asArray);

      const lines = input
        .split('\n')
        .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
        .filter(Boolean);
      return lines.length > 1 ? lines : [input.trim()];
    }
    throw new Error(`${field} must be a string or an array of strings. Received ${describe(input)}.`);
  };

  const titles = fromValue(value).filter((t) => t.length > 0);
  if (titles.length === 0) throw new Error(`${field} is empty — nothing to create.`);
  return titles;
}

/**
 * A list of ids. Accepts an array, a single number, numeric strings, and a JSON
 * array written as a string. Anything else is refused by name.
 */
export function asIdList(value: unknown, field = 'ids'): number[] {
  const toId = (item: unknown): number => {
    if (typeof item === 'number' && Number.isInteger(item)) return item;
    if (typeof item === 'string' && /^\s*\d+\s*$/.test(item)) return Number(item.trim());
    throw new Error(`${field} must contain whole numbers. Received ${describe(item)}. Send [1, 2, 3].`);
  };

  if (Array.isArray(value)) return unwrapSingleEncoded(value).map(toId);
  if (typeof value === 'string') {
    const parsed = parseArrayLiteral(value);
    if (parsed) return parsed.map(toId);
    // "1,2,3" is unambiguous for ids — a title may contain a comma, an id cannot.
    if (value.includes(',')) return value.split(',').map((part) => toId(part.trim()));
    return [toId(value)];
  }
  if (typeof value === 'number') return [toId(value)];
  throw new Error(`${field} must be a number or an array of numbers. Received ${describe(value)}. Send [1, 2, 3].`);
}

/**
 * A list of tags. Unlike titles, tags are keyword-like, so a single string
 * holding commas is split — that is what "tags: a,b" plainly means.
 */
export function asTagList(value: unknown, field = 'tags'): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return unwrapSingleEncoded(value).flatMap((item) => asTagList(item, field));
  }
  if (typeof value === 'string') {
    const parsed = parseArrayLiteral(value);
    if (parsed) return parsed.flatMap((item) => asTagList(item, field));
    return value.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  throw new Error(`${field} must be strings. Received ${describe(value)}. Send ["billing", "urgent"].`);
}

/** Tags ready for the column, so every writer stores the same shape. */
export function tagsColumn(value: unknown): string {
  return JSON.stringify(asTagList(value));
}

/** A short, honest description of a value, for error messages. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array (${JSON.stringify(value).slice(0, 60)})`;
  if (typeof value === 'object') return `an object (${JSON.stringify(value).slice(0, 60)})`;
  if (typeof value === 'string') return `the string ${JSON.stringify(value.slice(0, 60))}`;
  return `${typeof value} (${String(value)})`;
}
