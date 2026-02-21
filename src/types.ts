export interface Project {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'on_hold' | 'completed' | 'archived';
  tags: string; // JSON array as text
  metadata: string; // JSON object as text
  created_at: string;
  updated_at: string;
}

export interface Epic {
  id: number;
  project_id: number;
  name: string;
  description: string | null;
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'critical';
  sort_order: number;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  epic_id: number;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'critical';
  sort_order: number;
  assigned_to: string | null;
  estimated_hours: number | null;
  actual_hours: number | null;
  due_date: string | null;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface Subtask {
  id: number;
  task_id: number;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: number;
  title: string;
  content: string;
  note_type: 'general' | 'decision' | 'context' | 'meeting' | 'technical' | 'blocker' | 'progress' | 'release';
  related_entity_type: 'project' | 'epic' | 'task' | null;
  related_entity_id: number | null;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface ActivityLogEntry {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  summary: string | null;
  created_at: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolHandler = (args: Record<string, unknown>) => unknown;
