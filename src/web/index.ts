#!/usr/bin/env node
/**
 * saga-web — a local web viewer/editor for a saga-mcp .tracker.db file.
 *
 * Reads go through hand-written queries (src/web/queries.ts); writes are
 * dispatched to the very same handlers the MCP tools use, so the UI and the
 * agent share one code path, one validation story, and one activity log.
 *
 * Binds to 127.0.0.1 by default — nothing is exposed to the network unless you
 * explicitly pass --host.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb, closeDb } from '../db.js';
import { PAGE } from './ui.js';
import * as q from './queries.js';

import { handlers as projectHandlers } from '../tools/projects.js';
import { handlers as epicHandlers } from '../tools/epics.js';
import { handlers as taskHandlers } from '../tools/tasks.js';
import { handlers as subtaskHandlers } from '../tools/subtasks.js';
import { handlers as noteHandlers } from '../tools/notes.js';
import { handlers as commentHandlers } from '../tools/comments.js';
import { handlers as dashboardHandlers } from '../tools/dashboard.js';

/** Write tools the UI is allowed to invoke. Anything not listed is refused. */
const WRITE_TOOLS: Record<string, (args: Record<string, unknown>) => unknown> = {
  project_create: projectHandlers.project_create,
  project_update: projectHandlers.project_update,
  tracker_init: dashboardHandlers.tracker_init,
  epic_create: epicHandlers.epic_create,
  epic_update: epicHandlers.epic_update,
  task_create: taskHandlers.task_create,
  task_update: taskHandlers.task_update,
  task_lock_description: taskHandlers.task_lock_description,
  subtask_create: subtaskHandlers.subtask_create,
  subtask_update: subtaskHandlers.subtask_update,
  subtask_reorder: subtaskHandlers.subtask_reorder,
  subtask_delete: subtaskHandlers.subtask_delete,
  note_save: noteHandlers.note_save,
  note_delete: noteHandlers.note_delete,
  comment_add: commentHandlers.comment_add,
  comment_delete: commentHandlers.comment_delete,
  comment_restore: commentHandlers.comment_restore,
};

interface Options {
  dbPath: string;
  /** Undefined means "find a free port", so several projects can each run their own. */
  port: number | undefined;
  host: string;
  readOnly: boolean;
  open: boolean;
}

/** Where the search for a free port starts when no --port is given. */
const DEFAULT_PORT = 4319;
/** How many consecutive ports to try before giving up. */
const PORT_SCAN_RANGE = 40;

const USAGE = `saga-web — local web UI for a saga-mcp tracker database

Usage:
  saga-web [db-path] [options]

Options:
  --db <path>     Path to the .tracker.db file (or set DB_PATH)
  --port <n>      Port to listen on. Omit to take the first free port from 4319 up,
                  so several projects can each run their own UI. Use 0 to let the
                  OS pick any free port. Also settable with SAGA_WEB_PORT.
  --host <addr>   Address to bind (default 127.0.0.1 — local only)
  --read-only     Serve the UI without any editing controls
  --open          Open the UI in your default browser
  -h, --help      Show this help

Examples:
  saga-web ./.tracker.db
  saga-web --db ~/saga/central.tracker.db --port 8080 --open
  DB_PATH=./.tracker.db npx saga-mcp-web

Running one per project is fine — each picks its own port and prints the URL.
`;

function parseArgs(argv: string[]): Options | null {
  let dbPath = process.env.DB_PATH ?? '';
  const portEnv = process.env.SAGA_WEB_PORT ?? process.env.PORT;
  let port: number | undefined = portEnv === undefined || portEnv === '' ? undefined : Number(portEnv);
  let host = process.env.SAGA_WEB_HOST ?? '127.0.0.1';
  let readOnly = false;
  let open = false;
  let dbPathWasPositional = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      return null;
    } else if (a === '--db') {
      dbPath = argv[++i] ?? '';
    } else if (a === '--port') {
      port = Number(argv[++i]);
    } else if (a === '--host') {
      host = argv[++i] ?? host;
    } else if (a === '--read-only' || a === '--readonly') {
      readOnly = true;
    } else if (a === '--open') {
      open = true;
    } else if (!a.startsWith('-') && !dbPathWasPositional) {
      dbPath = a;
      dbPathWasPositional = true;
    } else {
      throw new Error(`Unknown argument: ${a}\n\n${USAGE}`);
    }
  }

  if (!dbPath) {
    throw new Error(
      'No database given. Pass a path (saga-web ./.tracker.db), use --db, or set DB_PATH.\n\n' + USAGE
    );
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error('Invalid --port value: expected an integer between 0 and 65535.');
  }

  return { dbPath: resolve(dbPath), port, host, readOnly, open };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The UI sends a custom header on every write, which forces a CORS preflight we
 * never approve — so a page on some other origin cannot POST here. We also
 * reject any Origin that is not this server itself.
 */
function originAllowed(req: IncomingMessage, opts: Options): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (curl, script)
  try {
    const u = new URL(origin);
    const localHosts = ['localhost', '127.0.0.1', '[::1]', '::1', opts.host];
    return localHosts.includes(u.hostname) && (u.port === String(opts.port) || u.port === '');
  } catch {
    return false;
  }
}

function start(opts: Options): void {
  if (!existsSync(opts.dbPath)) {
    throw new Error(
      `Database not found: ${opts.dbPath}\n` +
        'saga-web does not create databases — point it at a .tracker.db your MCP server already uses.'
    );
  }

  // Shared with the MCP tool handlers; also applies pending schema migrations.
  process.env.DB_PATH = opts.dbPath;
  const db = getDb();

  const server = createServer((req, res) => {
    void handle(req, res, opts, db).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 500, { error: msg });
      else res.end();
    });
  });

  // An explicit --port must be honoured exactly (scripts and bookmarks depend on
  // it). With no --port we walk upward from the default until something is free,
  // so a second project's UI just lands on the next port instead of failing.
  const explicit = opts.port !== undefined;
  const firstPort = opts.port ?? DEFAULT_PORT;
  const attempts = explicit ? 1 : PORT_SCAN_RANGE;

  // Announce exactly once. server.listen(port, host, cb) registers cb as a
  // 'listening' listener, so passing it on every retry accumulated one per
  // attempted port — the banner printed once per attempt, and --open opened
  // that many browser tabs.
  const announce = (): void => {
    const bound = server.address();
    const actual = typeof bound === 'object' && bound ? bound.port : firstPort;
    const shown = opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host;
    const url = `http://${shown}:${actual}`;
    console.log(`saga-web  ${url}`);
    console.log(`database  ${opts.dbPath}`);
    console.log(`mode      ${opts.readOnly ? 'read-only' : 'editable'}`);
    if (!explicit && actual !== firstPort) {
      console.log(`note      ${firstPort} was busy — took the next free port.`);
    }
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
      console.log('warning   bound beyond localhost — this UI has no authentication.');
    }
    opts.port = actual;
    if (opts.open) openBrowser(url);
  };
  server.once('listening', announce);

  const tryListen = (port: number, remaining: number): void => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') throw err;
      if (remaining <= 1) {
        console.error(
          explicit
            ? `Port ${port} is already in use. Omit --port to take the next free one.`
            : `No free port between ${firstPort} and ${firstPort + PORT_SCAN_RANGE - 1}. Pass --port to choose one.`
        );
        process.exit(1);
      }
      tryListen(port + 1, remaining - 1);
    };
    server.once('error', onError);
    server.listen(port, opts.host);
  };

  tryListen(firstPort, attempts);

  const shutdown = () => {
    server.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Options,
  db: ReturnType<typeof getDb>
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    // No CORS approval — keeps cross-origin writes impossible.
    res.writeHead(204).end();
    return;
  }

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(PAGE);
    return;
  }

  if (req.method === 'GET' && path === '/api/projects') {
    json(res, 200, {
      projects: q.listProjects(db),
      db_path: opts.dbPath,
      read_only: opts.readOnly,
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/overview') {
    const pid = Number(url.searchParams.get('project_id'));
    if (!pid) return json(res, 400, { error: 'project_id is required' });
    const data = q.getOverview(db, pid);
    if (!data) return json(res, 404, { error: `Project ${pid} not found` });
    return json(res, 200, data);
  }

  if (req.method === 'GET' && path === '/api/tasks') {
    const pid = Number(url.searchParams.get('project_id'));
    if (!pid) return json(res, 400, { error: 'project_id is required' });
    return json(res, 200, { tasks: q.listTasks(db, pid) });
  }

  const taskMatch = /^\/api\/tasks\/(\d+)$/.exec(path);
  if (req.method === 'GET' && taskMatch) {
    const task = q.getTask(db, Number(taskMatch[1]), url.searchParams.get('include_deleted') === '1');
    if (!task) return json(res, 404, { error: `Task ${taskMatch[1]} not found` });
    return json(res, 200, task);
  }

  if (req.method === 'GET' && path === '/api/notes') {
    const raw = url.searchParams.get('project_id');
    const pid = raw ? Number(raw) : null;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    return json(res, 200, { notes: q.listNotes(db, pid, limit) });
  }

  if (req.method === 'GET' && path === '/api/activity') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
    const raw = url.searchParams.get('project_id');
    const pid = raw ? Number(raw) : null;
    return json(res, 200, { activity: q.listActivity(db, pid, limit) });
  }

  if (req.method === 'GET' && path === '/api/search') {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (query.length < 2) {
      return json(res, 200, { projects: [], epics: [], tasks: [], notes: [] });
    }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 25, 100);
    return json(res, 200, q.search(db, query, limit));
  }

  if (req.method === 'POST' && path === '/api/action') {
    if (opts.readOnly) {
      return json(res, 403, { error: 'This viewer was started with --read-only.' });
    }
    if (req.headers['x-saga-ui'] !== '1') {
      return json(res, 403, { error: 'Missing x-saga-ui header.' });
    }
    if (!originAllowed(req, opts)) {
      return json(res, 403, { error: 'Cross-origin write refused.' });
    }

    let payload: { tool?: string; args?: Record<string, unknown> };
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'Invalid JSON body' });
    }

    const tool = payload.tool ?? '';
    const handler = Object.prototype.hasOwnProperty.call(WRITE_TOOLS, tool)
      ? WRITE_TOOLS[tool]
      : undefined;
    if (!handler) return json(res, 400, { error: `Unknown or disallowed action: ${tool}` });

    try {
      return json(res, 200, { ok: true, result: handler(payload.args ?? {}) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json(res, 400, { error: msg });
    }
  }

  json(res, 404, { error: 'Not found' });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  import('node:child_process')
    .then(({ spawn }) => spawn(cmd, args, { stdio: 'ignore', detached: true }).unref())
    .catch(() => {
      /* opening a browser is a convenience, never a failure */
    });
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts) start(opts);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
