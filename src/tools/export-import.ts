import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'tracker_export',
    description:
      'Export a full project as nested JSON. Includes all epics, tasks, subtasks, and related notes. Useful for backup, migration, or sharing.',
    annotations: { title: 'Export Project', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'integer',
          description: 'Project ID to export (omit if only one project exists)',
        },
      },
    },
  },
  {
    name: 'tracker_import',
    description:
      'Import a project from JSON (matching tracker_export format). Creates all entities with new IDs and remaps references. Uses a transaction for atomicity.',
    annotations: { title: 'Import Project', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          description: 'Full export JSON object from tracker_export',
        },
      },
      required: ['data'],
    },
  },
];

function handleExport(args: Record<string, unknown>) {
  const db = getDb();

  let projectId = args.project_id as number | undefined;
  if (!projectId) {
    const first = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number } | undefined;
    if (!first) throw new Error('No projects found. Create a project first.');
    projectId = first.id;
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown>;
  if (!project) throw new Error(`Project ${projectId} not found`);

  const epics = db.prepare('SELECT * FROM epics WHERE project_id = ? ORDER BY sort_order, created_at')
    .all(projectId) as Array<Record<string, unknown>>;

  const epicData = epics.map((epic) => {
    const tasks = db.prepare('SELECT * FROM tasks WHERE epic_id = ? ORDER BY sort_order, created_at')
      .all(epic.id as number) as Array<Record<string, unknown>>;

    const taskData = tasks.map((task) => {
      const subtasks = db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at')
        .all(task.id as number) as Array<Record<string, unknown>>;

      return {
        _original_id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        sort_order: task.sort_order,
        assigned_to: task.assigned_to,
        estimated_hours: task.estimated_hours,
        actual_hours: task.actual_hours,
        due_date: task.due_date,
        source_ref: task.source_ref,
        tags: task.tags,
        metadata: task.metadata,
        subtasks: subtasks.map((s) => ({
          title: s.title,
          status: s.status,
          sort_order: s.sort_order,
        })),
      };
    });

    return {
      _original_id: epic.id,
      name: epic.name,
      description: epic.description,
      status: epic.status,
      priority: epic.priority,
      sort_order: epic.sort_order,
      tags: epic.tags,
      metadata: epic.metadata,
      tasks: taskData,
    };
  });

  // Collect notes linked to this project, its epics, or its tasks
  const notes: Array<Record<string, unknown>> = [];

  notes.push(...db.prepare(
    `SELECT * FROM notes WHERE related_entity_type = 'project' AND related_entity_id = ?`
  ).all(projectId) as Array<Record<string, unknown>>);

  const epicIds = epics.map((e) => e.id as number);
  if (epicIds.length > 0) {
    const placeholders = epicIds.map(() => '?').join(',');
    notes.push(...db.prepare(
      `SELECT * FROM notes WHERE related_entity_type = 'epic' AND related_entity_id IN (${placeholders})`
    ).all(...epicIds) as Array<Record<string, unknown>>);
  }

  const allTaskIds: number[] = [];
  for (const epic of epics) {
    const tasks = db.prepare('SELECT id FROM tasks WHERE epic_id = ?')
      .all(epic.id as number) as Array<{ id: number }>;
    allTaskIds.push(...tasks.map((t) => t.id));
  }
  if (allTaskIds.length > 0) {
    const placeholders = allTaskIds.map(() => '?').join(',');
    notes.push(...db.prepare(
      `SELECT * FROM notes WHERE related_entity_type = 'task' AND related_entity_id IN (${placeholders})`
    ).all(...allTaskIds) as Array<Record<string, unknown>>);
  }

  // Include unlinked notes
  notes.push(...db.prepare(
    'SELECT * FROM notes WHERE related_entity_type IS NULL'
  ).all() as Array<Record<string, unknown>>);

  const noteData = notes.map((n) => ({
    title: n.title,
    content: n.content,
    note_type: n.note_type,
    related_entity_type: n.related_entity_type,
    _original_related_entity_id: n.related_entity_id,
    tags: n.tags,
    metadata: n.metadata,
  }));

  return {
    format_version: '1.0',
    exported_at: new Date().toISOString(),
    project: {
      name: project.name,
      description: project.description,
      status: project.status,
      tags: project.tags,
      metadata: project.metadata,
      epics: epicData,
    },
    notes: noteData,
  };
}

function handleImport(args: Record<string, unknown>) {
  const db = getDb();
  const data = args.data as Record<string, unknown>;

  if (data.format_version !== '1.0') {
    throw new Error(`Unsupported format version: ${data.format_version}. Expected "1.0".`);
  }

  const projectData = data.project as Record<string, unknown>;
  if (!projectData || !projectData.name) {
    throw new Error('Invalid import data: missing project or project.name');
  }

  const result = db.transaction(() => {
    const epicIdMap = new Map<number, number>();
    const taskIdMap = new Map<number, number>();

    // 1. Create project
    const project = db.prepare(
      'INSERT INTO projects (name, description, status, tags, metadata) VALUES (?, ?, ?, ?, ?) RETURNING *'
    ).get(
      projectData.name,
      projectData.description ?? null,
      projectData.status ?? 'active',
      projectData.tags ?? '[]',
      projectData.metadata ?? '{}'
    ) as Record<string, unknown>;

    const newProjectId = project.id as number;
    logActivity(db, 'project', newProjectId, 'created', null, null, null, `Project '${projectData.name}' imported`);

    // 2. Create epics and their children
    const epics = (projectData.epics as Array<Record<string, unknown>>) ?? [];
    let epicCount = 0;
    let taskCount = 0;
    let subtaskCount = 0;

    for (const epicData of epics) {
      const epic = db.prepare(
        `INSERT INTO epics (project_id, name, description, status, priority, sort_order, tags, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      ).get(
        newProjectId,
        epicData.name,
        epicData.description ?? null,
        epicData.status ?? 'planned',
        epicData.priority ?? 'medium',
        epicData.sort_order ?? 0,
        epicData.tags ?? '[]',
        epicData.metadata ?? '{}'
      ) as Record<string, unknown>;

      const newEpicId = epic.id as number;
      if (epicData._original_id != null) {
        epicIdMap.set(epicData._original_id as number, newEpicId);
      }
      epicCount++;
      logActivity(db, 'epic', newEpicId, 'created', null, null, null, `Epic '${epicData.name}' imported`);

      // 3. Create tasks
      const tasks = (epicData.tasks as Array<Record<string, unknown>>) ?? [];
      for (const taskData of tasks) {
        const task = db.prepare(
          `INSERT INTO tasks (epic_id, title, description, status, priority, sort_order,
           assigned_to, estimated_hours, actual_hours, due_date, source_ref, tags, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
        ).get(
          newEpicId,
          taskData.title,
          taskData.description ?? null,
          taskData.status ?? 'todo',
          taskData.priority ?? 'medium',
          taskData.sort_order ?? 0,
          taskData.assigned_to ?? null,
          taskData.estimated_hours ?? null,
          taskData.actual_hours ?? null,
          taskData.due_date ?? null,
          taskData.source_ref ?? null,
          taskData.tags ?? '[]',
          taskData.metadata ?? '{}'
        ) as Record<string, unknown>;

        const newTaskId = task.id as number;
        if (taskData._original_id != null) {
          taskIdMap.set(taskData._original_id as number, newTaskId);
        }
        taskCount++;
        logActivity(db, 'task', newTaskId, 'created', null, null, null, `Task '${taskData.title}' imported`);

        // 4. Create subtasks
        const subtasks = (taskData.subtasks as Array<Record<string, unknown>>) ?? [];
        for (const subtaskData of subtasks) {
          const subtask = db.prepare(
            'INSERT INTO subtasks (task_id, title, status, sort_order) VALUES (?, ?, ?, ?) RETURNING *'
          ).get(
            newTaskId,
            subtaskData.title,
            subtaskData.status ?? 'todo',
            subtaskData.sort_order ?? 0
          ) as Record<string, unknown>;

          subtaskCount++;
          logActivity(db, 'subtask', subtask.id as number, 'created', null, null, null, `Subtask '${subtaskData.title}' imported`);
        }
      }
    }

    // 5. Create notes with ID remapping
    const importNotes = (data.notes as Array<Record<string, unknown>>) ?? [];
    let noteCount = 0;

    for (const noteData of importNotes) {
      let relatedEntityType = noteData.related_entity_type as string | null;
      let relatedEntityId: number | null = null;
      const originalId = noteData._original_related_entity_id as number | null;

      if (relatedEntityType && originalId != null) {
        if (relatedEntityType === 'project') {
          relatedEntityId = newProjectId;
        } else if (relatedEntityType === 'epic') {
          relatedEntityId = epicIdMap.get(originalId) ?? null;
          if (relatedEntityId === null) relatedEntityType = null;
        } else if (relatedEntityType === 'task') {
          relatedEntityId = taskIdMap.get(originalId) ?? null;
          if (relatedEntityId === null) relatedEntityType = null;
        }
      }

      const note = db.prepare(
        `INSERT INTO notes (title, content, note_type, related_entity_type, related_entity_id, tags, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
      ).get(
        noteData.title,
        noteData.content,
        noteData.note_type ?? 'general',
        relatedEntityType,
        relatedEntityId,
        noteData.tags ?? '[]',
        noteData.metadata ?? '{}'
      ) as Record<string, unknown>;

      noteCount++;
      logActivity(db, 'note', note.id as number, 'created', null, null, null, `Note '${noteData.title}' imported`);
    }

    return {
      message: 'Import complete.',
      project_id: newProjectId,
      project_name: projectData.name,
      counts: { epics: epicCount, tasks: taskCount, subtasks: subtaskCount, notes: noteCount },
    };
  })();

  return result;
}

export const handlers: Record<string, ToolHandler> = {
  tracker_export: handleExport,
  tracker_import: handleImport,
};
