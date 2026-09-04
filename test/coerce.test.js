import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asTitleList, asIdList, asTagList, tagsColumn } from '../dist/helpers/coerce.js';

/**
 * #29. The coercion has to be generous about what models send and strict about
 * what it guesses — a wrong guess silently turns one subtask into two, which is
 * worse than the error it replaced.
 */

/* ---------- titles ---------- */

test('a real array passes through unchanged', () => {
  assert.deepEqual(asTitleList(['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('a single string is a single title', () => {
  assert.deepEqual(asTitleList('just one'), ['just one']);
});

test('a JSON array sent as a string is unpacked — the reported bug', () => {
  assert.deepEqual(asTitleList('["alpha","beta","gamma"]'), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(asTitleList('[ "alpha", "beta" ]'), ['alpha', 'beta']);
});

test('single-quoted pseudo-JSON is unpacked too', () => {
  assert.deepEqual(asTitleList("['alpha','beta']"), ['alpha', 'beta']);
});

test('an array holding one encoded array is unwrapped', () => {
  assert.deepEqual(asTitleList(['["alpha","beta"]']), ['alpha', 'beta']);
});

test('a multi-line string becomes one title per line', () => {
  assert.deepEqual(asTitleList('alpha\nbeta\ngamma'), ['alpha', 'beta', 'gamma']);
});

test('bullets and numbering are stripped', () => {
  assert.deepEqual(asTitleList('- alpha\n- beta'), ['alpha', 'beta']);
  assert.deepEqual(asTitleList('* alpha\n* beta'), ['alpha', 'beta']);
  assert.deepEqual(asTitleList('1. alpha\n2. beta'), ['alpha', 'beta']);
  assert.deepEqual(asTitleList('1) alpha\n2) beta'), ['alpha', 'beta']);
});

test('a comma inside a title is LEFT ALONE', () => {
  // The line this must not cross. Splitting here would quietly turn one
  // subtask into two for an entirely ordinary title.
  assert.deepEqual(asTitleList('Design the API, then implement it'),
                   ['Design the API, then implement it']);
  assert.deepEqual(asTitleList(['Write it, test it', 'Ship it']),
                   ['Write it, test it', 'Ship it']);
});

test('a title that merely mentions brackets is not treated as JSON', () => {
  assert.deepEqual(asTitleList('Handle [] in the parser'), ['Handle [] in the parser']);
  assert.deepEqual(asTitleList('Fix the [beta] flag'), ['Fix the [beta] flag']);
});

test('objects with a title are accepted, since models send them', () => {
  assert.deepEqual(asTitleList([{ title: 'alpha' }, { title: 'beta' }]), ['alpha', 'beta']);
});

test('blank entries are dropped, and an empty list is an error', () => {
  assert.deepEqual(asTitleList(['a', '', '  ', 'b']), ['a', 'b']);
  assert.throws(() => asTitleList([]), /empty/);
  assert.throws(() => asTitleList(''), /empty/);
});

test('an unusable value is refused by name, not with a TypeError', () => {
  assert.throws(() => asTitleList(42), /must be a string or an array/);
  assert.throws(() => asTitleList([1, 2]), /must be strings/);
  assert.throws(() => asTitleList(null), /must be a string or an array/);
  assert.throws(() => asTitleList([{ name: 'wrong key' }]), /must be strings/);
});

test('the error says what arrived and what was wanted', () => {
  try {
    asTitleList([1, 2]);
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /Received/);
    assert.match(err.message, /\["First item", "Second item"\]/);
  }
});

/* ---------- ids ---------- */

test('ids accept arrays, single numbers and numeric strings', () => {
  assert.deepEqual(asIdList([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(asIdList(7), [7]);
  assert.deepEqual(asIdList('7'), [7]);
  assert.deepEqual(asIdList(['1', '2']), [1, 2]);
});

test('ids sent as a JSON string are unpacked', () => {
  assert.deepEqual(asIdList('[1,2,3]'), [1, 2, 3]);
  assert.deepEqual(asIdList('[ 1, 2 ]'), [1, 2]);
});

test('a comma-separated id string is split — an id cannot contain a comma', () => {
  assert.deepEqual(asIdList('1,2,3'), [1, 2, 3]);
  assert.deepEqual(asIdList('1, 2, 3'), [1, 2, 3]);
});

test('non-numeric ids are refused clearly', () => {
  assert.throws(() => asIdList('abc'), /whole numbers/);
  assert.throws(() => asIdList([1, 'two']), /whole numbers/);
  assert.throws(() => asIdList(1.5), /whole numbers/);
  assert.throws(() => asIdList({ id: 1 }), /must be a number or an array/);
});

/* ---------- tags ---------- */

test('tags accept arrays and comma-separated strings', () => {
  assert.deepEqual(asTagList(['billing', 'urgent']), ['billing', 'urgent']);
  assert.deepEqual(asTagList('billing,urgent'), ['billing', 'urgent']);
  assert.deepEqual(asTagList('billing, urgent'), ['billing', 'urgent']);
  assert.deepEqual(asTagList('billing'), ['billing']);
});

test('tags sent as a JSON string are unpacked rather than stored raw', () => {
  // Previously this was stored as a string, and the UI then rendered one tag
  // pill per character.
  assert.deepEqual(asTagList('["billing","urgent"]'), ['billing', 'urgent']);
});

test('missing tags are an empty list, not an error', () => {
  assert.deepEqual(asTagList(undefined), []);
  assert.deepEqual(asTagList(null), []);
  assert.deepEqual(asTagList([]), []);
  assert.deepEqual(asTagList(''), []);
});

test('tagsColumn always produces a JSON array string', () => {
  for (const input of [['a', 'b'], 'a,b', '["a","b"]', undefined, null, []]) {
    const stored = tagsColumn(input);
    const parsed = JSON.parse(stored);
    assert.ok(Array.isArray(parsed), `tags stored as ${stored} should parse to an array`);
    assert.ok(parsed.every((t) => typeof t === 'string'));
  }
});

test('a tag list round-trips through the column unchanged', () => {
  assert.deepEqual(JSON.parse(tagsColumn(['billing', 'urgent'])), ['billing', 'urgent']);
  assert.deepEqual(JSON.parse(tagsColumn('["billing","urgent"]')), ['billing', 'urgent']);
});
