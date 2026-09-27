/**
 * In-memory seed data for the demo domain.
 *
 * Every record has an `id`. `seed()` returns fresh copies so each server
 * instance (and each test) starts from the same state.
 *
 * The demo domain exists to exercise every ModelDefinitions property:
 *   users            plain bucket
 *   current_users    the logged-in user + settings
 *   projects         owner_id -> users, member_ids -> users (foreignKeysArray),
 *                    relatedObjectType tasks (cascade)
 *   tasks            project_id, assignee_id, embedded assignee, comments, tags
 *                    (deleting a task also deletes its comments and tag links)
 *   comments         plain rows (no model class)
 *   tags + task_tags many-to-many. The server table is `task_tags`; the client
 *                    bucket is `task_tags_relation`, whose rows the client
 *                    synthesises from GET /tasks/:id/tags and removes itself
 *                    by cascade when a task or tag is deleted (the server never
 *                    sends `deleted_task_tags*`).
 */

export type TaskStatus = "todo" | "doing" | "done";

export interface UserRow {
  id: number;
  name: string;
  email: string;
  /** Fixture-only. A real backend never returns this. */
  password: string;
  settings: Record<string, unknown>;
}

export interface ProjectRow {
  id: number;
  name: string;
  owner_id: number;
  /** Users on the project (an id array: exercises `foreignKeysArray`). */
  member_ids: number[];
  created_at: string;
}

export interface TaskRow {
  id: number;
  project_id: number;
  assignee_id: number | null;
  title: string;
  status: TaskStatus;
  due_on: string | null;
  /** Optimistic-locking token; changes on every write. */
  hash: string;
}

export interface CommentRow {
  id: number;
  task_id: number;
  author_id: number;
  body: string;
  created_at: string;
}

export interface TagRow {
  id: number;
  name: string;
}

export interface TaskTagRow {
  task_id: number;
  tag_id: number;
}

export interface SeedData {
  users: UserRow[];
  projects: ProjectRow[];
  tasks: TaskRow[];
  comments: CommentRow[];
  tags: TagRow[];
  task_tags: TaskTagRow[];
}

export function seed(): SeedData {
  return {
    users: [
      { id: 1, name: "Ada Lovelace", email: "ada@example.com", password: "password", settings: { theme: "dark" } },
      { id: 2, name: "Grace Hopper", email: "grace@example.com", password: "password", settings: {} },
      // on no project: invisible to the others through GET /users
      { id: 3, name: "Alan Turing", email: "alan@example.com", password: "password", settings: {} },
    ],
    projects: [
      { id: 1, name: "Analytical Engine", owner_id: 1, member_ids: [1, 2], created_at: "2026-09-01T09:00:00Z" },
      { id: 2, name: "COBOL Compiler", owner_id: 2, member_ids: [2], created_at: "2026-09-10T09:00:00Z" },
    ],
    tasks: [
      { id: 1, project_id: 1, assignee_id: 1, title: "Design the mill", status: "done", due_on: "2026-09-15", hash: "t1-1" },
      { id: 2, project_id: 1, assignee_id: 2, title: "Punch the cards", status: "doing", due_on: "2026-10-01", hash: "t2-1" },
      { id: 3, project_id: 1, assignee_id: null, title: "Write the first program", status: "todo", due_on: null, hash: "t3-1" },
      { id: 4, project_id: 2, assignee_id: 2, title: "Define the grammar", status: "done", due_on: "2026-09-20", hash: "t4-1" },
      { id: 5, project_id: 2, assignee_id: 1, title: "Implement the lexer", status: "doing", due_on: "2026-10-05", hash: "t5-1" },
      { id: 6, project_id: 2, assignee_id: null, title: "Ship v1", status: "todo", due_on: "2026-11-01", hash: "t6-1" },
    ],
    comments: [
      { id: 1, task_id: 1, author_id: 2, body: "Looks solid.", created_at: "2026-09-12T10:00:00Z" },
      { id: 2, task_id: 1, author_id: 1, body: "Thanks!", created_at: "2026-09-12T10:05:00Z" },
      { id: 3, task_id: 2, author_id: 1, body: "Need more cards.", created_at: "2026-09-14T08:30:00Z" },
      { id: 4, task_id: 5, author_id: 2, body: "Tokenizer edge cases?", created_at: "2026-09-16T11:00:00Z" },
    ],
    tags: [
      { id: 1, name: "hardware" },
      { id: 2, name: "software" },
      { id: 3, name: "urgent" },
    ],
    task_tags: [
      { task_id: 1, tag_id: 1 },
      { task_id: 2, tag_id: 1 },
      { task_id: 2, tag_id: 3 },
      { task_id: 3, tag_id: 2 },
      { task_id: 5, tag_id: 2 },
      { task_id: 5, tag_id: 3 },
    ],
  };
}
