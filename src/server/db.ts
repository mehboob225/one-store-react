/**
 * A tiny in-memory database over the seed data.
 *
 * Pure data access — no HTTP, no auth, no push. Routes call into this and
 * decide what to broadcast.
 */
import {
  seed,
  type CommentRow,
  type ProjectRow,
  type SeedData,
  type TagRow,
  type TaskRow,
  type TaskTagRow,
  type UserRow,
} from "./fixtures";
import { MUTABLE_TASK_FIELDS, type MutableTaskField } from "./validation";

/** What other users may see: id and name only — never email, password or settings. */
export type PublicUser = Pick<UserRow, "id" | "name">;

/** What the logged-in user sees about themselves. */
export type CurrentUser = Omit<UserRow, "password">;

export interface NewTask {
  title: string;
  status?: TaskRow["status"];
  assignee_id?: number | null;
  due_on?: string | null;
}

export type TaskPatch = Partial<Omit<TaskRow, "id" | "project_id" | "hash">> & { hash: string };

/** Result of looking a task up for an update: the route maps each case to 404, 409 or a write. */
export type TaskLookup = { kind: "missing" } | { kind: "conflict"; current: TaskRow } | { kind: "ok"; current: TaskRow };

export class Database {
  private data: SeedData;
  private nextId: Record<keyof SeedData, number>;

  constructor(initial: SeedData = seed()) {
    this.data = initial;
    this.nextId = Database.idsFor(initial);
  }

  /** Replaces all data with a fresh seed (tests). */
  reset(initial: SeedData = seed()): void {
    this.data = initial;
    this.nextId = Database.idsFor(initial);
  }

  private static idsFor(initial: SeedData): Record<keyof SeedData, number> {
    return {
      users: maxId(initial.users) + 1,
      projects: maxId(initial.projects) + 1,
      tasks: maxId(initial.tasks) + 1,
      comments: maxId(initial.comments) + 1,
      tags: maxId(initial.tags) + 1,
      task_tags: 0,
    };
  }

  // ---- users -------------------------------------------------------------

  findUserByEmail(email: string): UserRow | undefined {
    return this.data.users.find((u) => u.email === email);
  }

  /**
   * Every workspace user, public representation (id and name). The demo is
   * one workspace whose members can all see each other by name — the usual
   * collaboration model — so owner, member, assignee and author keys always
   * resolve. What must never leave `current_user` is email and settings, and
   * `publicUser` guarantees that for every representation.
   */
  listUsers(): PublicUser[] {
    return this.data.users.map(publicUser);
  }

  getUser(id: number): PublicUser | undefined {
    const user = this.data.users.find((u) => u.id === id);
    return user ? publicUser(user) : undefined;
  }

  /** Includes `settings`; only ever returned to that user. */
  getCurrentUser(id: number): CurrentUser | undefined {
    const user = this.data.users.find((u) => u.id === id);
    return user ? currentUser(user) : undefined;
  }

  updateUserSettings(id: number, settings: Record<string, unknown>): CurrentUser | undefined {
    const user = this.data.users.find((u) => u.id === id);
    if (!user) return undefined;
    user.settings = { ...user.settings, ...settings };
    return currentUser(user);
  }

  // ---- projects ----------------------------------------------------------

  listProjects(): ProjectRow[] {
    return this.data.projects.map(clone);
  }

  getProject(id: number): ProjectRow | undefined {
    const project = this.data.projects.find((p) => p.id === id);
    return project ? clone(project) : undefined;
  }

  // ---- tasks -------------------------------------------------------------

  listTasks(projectId: number): TaskRow[] {
    return this.data.tasks.filter((t) => t.project_id === projectId).map(clone);
  }

  getTask(id: number): TaskRow | undefined {
    const task = this.data.tasks.find((t) => t.id === id);
    return task ? clone(task) : undefined;
  }

  createTask(projectId: number, input: NewTask): TaskRow {
    const id = this.nextId.tasks++;
    const task: TaskRow = {
      id,
      project_id: projectId,
      assignee_id: input.assignee_id ?? null,
      title: input.title,
      status: input.status ?? "todo",
      due_on: input.due_on ?? null,
      hash: `t${id}-1`,
    };
    this.data.tasks.push(task);
    return clone(task);
  }

  /**
   * The first step of an update: is the task there, and does the caller hold
   * its current hash? Only the hash is needed to answer, so a route can send
   * 404 or 409 (with the current row) before it validates anything else.
   */
  findTaskForUpdate(id: number, hash: unknown): TaskLookup {
    const task = this.data.tasks.find((t) => t.id === id);
    if (!task) return { kind: "missing" };
    if (hash !== task.hash) return { kind: "conflict", current: clone(task) };
    return { kind: "ok", current: clone(task) };
  }

  /**
   * The second step: applies the mutable fields (see MUTABLE_TASK_FIELDS) to
   * a task whose hash was verified by `findTaskForUpdate` and bumps the hash.
   * `id`, `project_id` and `hash` can never be set by a caller.
   */
  applyTaskPatch(id: number, patch: Omit<TaskPatch, "hash">): TaskRow {
    const task = this.data.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`applyTaskPatch: task ${id} vanished between lookup and write`);
    for (const field of MUTABLE_TASK_FIELDS) {
      if (field in patch) (task as Record<MutableTaskField, unknown>)[field] = patch[field];
    }
    task.hash = bumpHash(task.hash);
    return clone(task);
  }

  /** Removes the task and its comments + tag links. Returns what was removed. */
  deleteTask(id: number): { task: TaskRow; comments: CommentRow[] } | undefined {
    const index = this.data.tasks.findIndex((t) => t.id === id);
    if (index === -1) return undefined;
    const [task] = this.data.tasks.splice(index, 1);

    const comments = this.data.comments.filter((c) => c.task_id === id);
    this.data.comments = this.data.comments.filter((c) => c.task_id !== id);
    this.data.task_tags = this.data.task_tags.filter((tt) => tt.task_id !== id);

    return { task: task!, comments };
  }

  // ---- comments ----------------------------------------------------------

  listComments(taskId: number): CommentRow[] {
    return this.data.comments.filter((c) => c.task_id === taskId).map(clone);
  }

  // ---- tags --------------------------------------------------------------

  listTagsForTask(taskId: number): TagRow[] {
    const tagIds = new Set(this.data.task_tags.filter((tt) => tt.task_id === taskId).map((tt) => tt.tag_id));
    return this.data.tags.filter((t) => tagIds.has(t.id)).map(clone);
  }

  listTaskTags(): TaskTagRow[] {
    return this.data.task_tags.map(clone);
  }

  /**
   * Attaches the given task to the given user. Used by responses that embed
   * the assignee inside the task (`embeddedObject.assignee`).
   */
  withAssignee(task: TaskRow): TaskRow & { assignee: PublicUser | null } {
    const assignee = task.assignee_id === null ? null : (this.getUser(task.assignee_id) ?? null);
    return { ...task, assignee };
  }
}

function maxId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0);
}

function publicUser(user: UserRow): PublicUser {
  return { id: user.id, name: user.name };
}

function currentUser(user: UserRow): CurrentUser {
  const { password: _p, ...rest } = user;
  return { ...rest, settings: { ...rest.settings } };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function bumpHash(hash: string): string {
  const [prefix, n] = hash.split("-");
  return `${prefix}-${Number(n ?? "0") + 1}`;
}
