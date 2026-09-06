#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { definitions as projectDefs, handlers as projectHandlers } from './tools/projects.js';
import { definitions as epicDefs, handlers as epicHandlers } from './tools/epics.js';
import { definitions as taskDefs, handlers as taskHandlers } from './tools/tasks.js';
import { definitions as subtaskDefs, handlers as subtaskHandlers } from './tools/subtasks.js';
import { definitions as noteDefs, handlers as noteHandlers } from './tools/notes.js';
import { definitions as dashboardDefs, handlers as dashboardHandlers } from './tools/dashboard.js';
import { definitions as searchDefs, handlers as searchHandlers } from './tools/search.js';
import { definitions as nextDefs, handlers as nextHandlers } from './tools/next.js';
import { definitions as activityDefs, handlers as activityHandlers } from './tools/activity.js';
import { definitions as commentDefs, handlers as commentHandlers } from './tools/comments.js';
import { definitions as templateDefs, handlers as templateHandlers } from './tools/templates.js';
import { definitions as exportImportDefs, handlers as exportImportHandlers } from './tools/export-import.js';
import { closeDb } from './db.js';

const ALL_TOOLS: Tool[] = [
  ...projectDefs,
  ...epicDefs,
  ...taskDefs,
  ...subtaskDefs,
  ...noteDefs,
  ...commentDefs,
  ...templateDefs,
  ...dashboardDefs,
  ...searchDefs,
  ...nextDefs,
  ...activityDefs,
  ...exportImportDefs,
];

const ALL_HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  ...projectHandlers,
  ...epicHandlers,
  ...taskHandlers,
  ...subtaskHandlers,
  ...noteHandlers,
  ...commentHandlers,
  ...templateHandlers,
  ...dashboardHandlers,
  ...searchHandlers,
  ...nextHandlers,
  ...activityHandlers,
  ...exportImportHandlers,
};

/**
 * The full tool list costs ~6,000 tokens of context in every session before any
 * work happens. SAGA_TOOLS=core exposes the subset that covers ordinary tracking
 * (~2,300 tokens); handlers stay registered either way, so a client that already
 * knows a tool name can still call it. Unset (or "full") keeps every tool listed.
 */
const CORE_TOOLS = new Set([
  'tracker_init',
  'tracker_dashboard',
  'tracker_next',
  'project_list',
  'epic_create',
  'epic_list',
  'task_create',
  'task_list',
  'task_get',
  'task_update',
  'subtask_create',
  'note_save',
  'comment_add',
]);

function listedTools(): Tool[] {
  const mode = (process.env.SAGA_TOOLS ?? 'full').trim().toLowerCase();
  if (mode === 'full' || mode === '') return ALL_TOOLS;
  if (mode !== 'core') {
    console.error(`Unknown SAGA_TOOLS value '${mode}' — expected 'core' or 'full'. Listing all tools.`);
    return ALL_TOOLS;
  }
  return ALL_TOOLS.filter((t) => CORE_TOOLS.has(t.name));
}

const server = new Server(
  { name: 'tracker', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: listedTools() };
});

function friendlyError(msg: string): string {
  if (msg.includes('UNIQUE constraint failed')) {
    const match = msg.match(/UNIQUE constraint failed: \w+\.(\w+)/);
    return match ? `A record with that ${match[1]} already exists.` : 'A record with that value already exists.';
  }
  if (msg.includes('NOT NULL constraint failed')) {
    const match = msg.match(/NOT NULL constraint failed: \w+\.(\w+)/);
    return match ? `Missing required field: ${match[1]}.` : 'A required field is missing.';
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return 'Referenced record not found. Check that the parent item exists.';
  }
  if (msg.includes('no such table')) {
    return 'Database not initialized. Run tracker_init first.';
  }
  return msg;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    const handler = ALL_HANDLERS[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const result = handler(args ?? {});
    return {
      // Compact, not pretty-printed: indentation costs ~22% of every response
      // in tokens and buys the model nothing.
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const friendly = friendlyError(msg);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${friendly}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const listed = listedTools().length;
  console.error(
    `Tracker MCP Server running on stdio (${listed} of ${ALL_TOOLS.length} tools listed` +
      `${listed < ALL_TOOLS.length ? ' — SAGA_TOOLS=core' : ''})`
  );
}

process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
