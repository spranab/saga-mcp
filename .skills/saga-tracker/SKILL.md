---
name: saga-tracker
description: Track projects, epics, tasks, subtasks, notes, and decisions using the saga-mcp project tracker. Use when the user asks to track work, manage tasks, plan features, log decisions, or when you need persistent context across coding sessions.
license: MIT
metadata:
  author: spranab
  version: "1.5.0"
---

# Saga Project Tracker

Use the saga-mcp tools to maintain structured project state across sessions. This replaces scattered markdown files and mental bookkeeping with a SQLite-backed tracker.

## When to Use

- User says "track this", "add a task", "create an epic", "log this decision"
- Starting a multi-session project that needs persistent context
- You need to remember what was done, what's blocked, and what's next
- User asks for project status, progress, or what to work on next

## Getting Started

1. Call `tracker_init` with a project name to set up the database
2. Call `tracker_dashboard` at the start of each session to get full context
3. Create epics for major features, tasks for units of work, subtasks for checklists

## Hierarchy

```
Project
  └── Epic (feature/workstream)
        └── Task (unit of work)
              ├── Subtask (checklist item)
              ├── Comment (discussion thread)
              └── Dependencies (blocked by other tasks)
```

## Core Workflow

### Starting a session
```
tracker_dashboard()  → Get full project overview with summary
```

### Planning work
```
epic_create({ project_id, name, priority })
task_create({ epic_id, title, priority, depends_on: [task_ids] })
subtask_create({ task_id, titles: ["step 1", "step 2", "step 3"] })
```

### Tracking progress
```
task_update({ id, status: "in_progress" })   → Start working
task_update({ id, status: "done" })           → Complete (auto-unblocks dependents)
subtask_update({ id, status: "done" })        → Check off a step
```

### Recording decisions
```
note_save({ title: "Auth approach", content: "Chose JWT because...", note_type: "decision", related_entity_type: "epic", related_entity_id: 1 })
comment_add({ task_id: 5, content: "Root cause was missing CORS headers" })
```

### Finding things
```
tracker_search({ query: "authentication" })   → Search across everything
activity_log({ since: "2026-02-24T00:00:00" })  → What changed today
```

## Task Dependencies

- Set `depends_on: [2, 3]` when creating/updating a task
- Tasks auto-block if dependencies aren't done
- When a dependency completes, downstream tasks auto-unblock
- Use `task_get` to see both upstream dependencies and downstream dependents

## Templates

Create reusable task sets for repeated workflows:

```
template_create({ name: "feature_workflow", tasks: [
  { "title": "Design {feature} API", "priority": "critical" },
  { "title": "Implement {feature}", "priority": "high" },
  { "title": "Write tests for {feature}", "priority": "high" }
]})

template_apply({ template_id: 1, epic_id: 2, variables: { "feature": "user auth" } })
```

## Best Practices

- Always call `tracker_dashboard` at the start of a session
- Use comments on tasks to leave breadcrumbs for future sessions
- Use notes with type "decision" for architectural choices
- Set task priorities: critical > high > medium > low
- Use dependencies to express sequencing between tasks
- Mark tasks done immediately when complete — don't batch updates
