/**
 * Builds the demo database behind the README screenshots.
 *
 * It has to look like real work: a project mid-flight, with things finished,
 * things blocked on each other, a spec worth reading and a decision trail.
 * Placeholder text would undersell every feature the screenshots exist to show.
 *
 *   node scripts/demo-db.mjs [path]
 *
 * Rebuilt from scratch each run, so the screenshots are reproducible rather
 * than hand-made artifacts that quietly go stale.
 */
import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = process.argv[2] || process.env.SAGA_DEMO_DB || join(tmpdir(), 'saga-demo.tracker.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { unlinkSync(db + suffix); } catch { /* not there */ }
}

const child = spawn(process.execPath, ['dist/index.js'], {
  env: { ...process.env, DB_PATH: db },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', () => {});

let buffer = '', id = 0;
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

const rpc = (method, params) => new Promise((resolve) => {
  const myId = ++id;
  pending.set(myId, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
});

const call = async (name, args) => {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result.content[0].text;
  if (res.result.isError) throw new Error(name + ': ' + text);
  return JSON.parse(text);
};

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

await rpc('initialize', {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'demo', version: '1' },
});

const project = await call('project_create', {
  name: 'E-Commerce API',
  description: 'REST API for the storefront, the admin console and the mobile app.',
});

/* ------------------------------------------------------------ authentication */
const auth = await call('epic_create', {
  project_id: project.id, name: 'Authentication', status: 'in_progress', priority: 'high',
  description: 'Sessions, tokens and social login. Everything else waits on this.',
});

const schema = await call('task_create', {
  epic_id: auth.id, title: 'Design the auth schema', priority: 'critical',
  description: 'Users, sessions, refresh tokens and the revocation list.\n\n' +
    '- One row per session, not per token, so revoking a session kills its refreshes\n' +
    '- Refresh tokens are hashed at rest\n' +
    '- `last_seen_at` on the session, for the "sign out everywhere" screen',
  tags: ['schema', 'security'],
});
await call('task_update', { id: schema.id, status: 'done' });

const jwt = await call('task_create', {
  epic_id: auth.id, title: 'Implement JWT issuing and refresh', priority: 'high',
  assigned_to: 'agent', due_date: day(3), tags: ['security'],
  description: 'Short-lived access token, long-lived refresh, rotation on every use.\n\n' +
    'Rotation is the part worth getting right: a refresh token is single-use, and presenting ' +
    'an already-used one invalidates the whole session — that is how a stolen token gets caught.',
});
await call('task_update', { id: jwt.id, status: 'in_progress' });

const subs = await call('subtask_create', {
  task_id: jwt.id,
  titles: ['Sign and verify access tokens', 'Rotate refresh tokens on use',
           'Reject a replayed refresh token', 'Cover rotation in tests'],
});
await call('subtask_update', { id: subs[0].id, status: 'done' });
await call('subtask_update', { id: subs[1].id, status: 'in_progress' });
await call('subtask_update', { id: subs[2].id, depends_on: [subs[1].id] });
await call('subtask_update', { id: subs[3].id, depends_on: [subs[2].id] });

await call('comment_add', {
  task_id: jwt.id, author: 'pranab',
  content: 'Went with rotation rather than a long-lived refresh. Replay detection is the whole point.',
});
await call('comment_add', {
  task_id: jwt.id, author: 'agent',
  content: 'Rotation is in. Replay currently returns 401 — should it also revoke the session? ' +
           'Leaning yes: a replayed token means one of the two copies is stolen.',
});

const oauth = await call('task_create', {
  epic_id: auth.id, title: 'Add Google and Apple sign-in', priority: 'medium', tags: ['oauth'],
  description: 'OIDC for both. Link to an existing account by verified email.',
});
await call('task_update', { id: oauth.id, depends_on: [jwt.id] });

const rateLimit = await call('task_create', {
  epic_id: auth.id, title: 'Rate limit the login endpoint', priority: 'high',
  due_date: day(-4), tags: ['security'],
  description: 'Per-IP and per-account. Account lockout is deliberately *not* on the list — ' +
    'it turns a nuisance into a denial of service against a real user.',
});
await call('task_update', { id: rateLimit.id, status: 'review' });

const audit = await call('task_create', {
  epic_id: auth.id, title: 'Audit the session cookie flags', priority: 'low',
  description: 'SameSite, Secure, HttpOnly, and the domain scope for the admin subdomain.',
});
await call('task_reorder', {
  epic_id: auth.id, ordered_ids: [schema.id, jwt.id, rateLimit.id, oauth.id, audit.id],
});
await call('task_lock_description', { id: schema.id });

/* --------------------------------------------------------------- catalog */
const catalog = await call('epic_create', {
  project_id: project.id, name: 'Product catalog', status: 'in_progress', priority: 'high',
  description: 'Search, faceting and the variant model.',
});
const variants = await call('task_create', {
  epic_id: catalog.id, title: 'Model product variants', priority: 'critical',
  description: 'Size and colour are the two everyone has; the model has to survive a third.',
});
await call('task_update', { id: variants.id, status: 'done' });
const search = await call('task_create', {
  epic_id: catalog.id, title: 'Full-text search over titles and descriptions',
  priority: 'high', assigned_to: 'agent', due_date: day(9),
});
const facets = await call('task_create', {
  epic_id: catalog.id, title: 'Faceted filtering by brand, price and size', priority: 'medium',
});
await call('task_update', { id: facets.id, depends_on: [search.id] });
const images = await call('task_create', {
  epic_id: catalog.id, title: 'Serve responsive product images', priority: 'low',
});
await call('task_reorder', {
  epic_id: catalog.id, ordered_ids: [variants.id, search.id, facets.id, images.id],
});
await call('subtask_create', {
  task_id: search.id, titles: ['Index on write', 'Rank by relevance, then stock'],
});

/* -------------------------------------------------------------- payments */
const payments = await call('epic_create', {
  project_id: project.id, name: 'Payments', status: 'planned', priority: 'critical',
  description: 'Stripe first. The provider is behind an interface so the second one is not a rewrite.',
});
const gateway = await call('task_create', {
  epic_id: payments.id, title: 'Wire the payment gateway', priority: 'critical',
  description: 'Behind a `PaymentProvider` interface. No Stripe types above the adapter.',
});
await call('task_update', { id: gateway.id, depends_on: [jwt.id] });
const webhooks = await call('task_create', {
  epic_id: payments.id, title: 'Handle failed and disputed charges', priority: 'high',
});
await call('task_update', { id: webhooks.id, depends_on: [gateway.id] });
await call('task_create', { epic_id: payments.id, title: 'Email the receipt', priority: 'low' });

/* ----------------------------------------------------------------- notes */
await call('note_save', {
  project_id: project.id, title: 'Why refresh-token rotation', note_type: 'decision',
  tags: ['security', 'auth'],
  content: 'Considered long-lived refresh tokens with a revocation list, and rotation with ' +
    'replay detection.\n\nRotation won. The revocation list only helps once you *know* a token ' +
    'leaked; rotation tells you, because the legitimate client and the thief cannot both use ' +
    'the same token without one of them presenting a used one.\n\nCost: every refresh is a write.',
});
await call('note_save', {
  project_id: project.id, title: 'No account lockout on failed logins', note_type: 'decision',
  tags: ['security'],
  content: 'Rate limit per IP and per account, but never lock an account. Lockout hands an ' +
    'attacker a denial of service against any user whose email they know.',
});
await call('note_save', {
  project_id: project.id, title: 'Where we left off', note_type: 'context',
  content: 'Refresh rotation works. Open question in the comments on the JWT task: should a ' +
    'replayed refresh token revoke the whole session, or just fail?',
});

/* ------------------------------------------------------------- templates */
await call('template_create', {
  name: 'New API endpoint',
  description: 'The steps we forget when adding an endpoint under pressure.',
  tasks: [
    { title: 'Design the {endpoint} contract', priority: 'high', estimated_hours: 2, tags: ['design'] },
    { title: 'Implement {endpoint}', priority: 'high', estimated_hours: 6 },
    { title: 'Write tests for {endpoint}', priority: 'high', estimated_hours: 3, tags: ['tests'] },
    { title: 'Add {endpoint} to the OpenAPI spec', priority: 'medium', estimated_hours: 1 },
    { title: 'Check rate limits and auth on {endpoint}', priority: 'critical', estimated_hours: 1, tags: ['security'] },
  ],
});
await call('template_create', {
  name: 'Incident follow-up',
  description: 'Run after every production incident, while it is still fresh.',
  tasks: [
    { title: 'Write the {incident} timeline', priority: 'high', estimated_hours: 2 },
    { title: 'Add a regression test for {incident}', priority: 'critical', estimated_hours: 3, tags: ['tests'] },
    { title: 'Alert on the signal we missed', priority: 'high', estimated_hours: 2 },
  ],
});

/* --------------------------------------------------------- archived work */
const legacy = await call('epic_create', {
  project_id: project.id, name: 'Migrate off the legacy store', status: 'completed',
});
const cutover = await call('task_create', { epic_id: legacy.id, title: 'Cut over the read path' });
await call('task_update', { id: cutover.id, status: 'done' });
await call('epic_archive', { id: legacy.id });

console.log(db);
console.log('featured task: #' + jwt.id);
child.kill();
process.exit(0);
