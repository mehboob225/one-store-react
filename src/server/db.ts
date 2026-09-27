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
import { MUTABLE_TASK_FIELDS, validateNewTask, validateTaskEnvelope, validateTaskFields, type MutableTaskField } from "./validation";

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

/** The fields a client may change on a task. `id`, `project_id` and `hash` are server-owned. */
export type TaskFields = Partial<Omit<TaskRow, "id" | "project_id" | "hash">>;

/** Outcome of `createTask`, in check order: missing → 404, invalid → 400. */
export type CreateOutcome = { kind: "missing" } | { kind: "invalid"; error: string } | { kind: "created"; task: TaskRow };

/**
 * Outcome of `updateTask`, in check order — the route maps each to a status:
 * missing → 404, malformed → 400, conflict → 409, invalid → 400.
 */
export type UpdateOutcome =
  | { kind: "missing" }
  | { kind: "malformed"; error: string }
  | { kind: "conflict"; current: TaskRow }
  | { kind: "invalid"; error: string }
  | { kind: "updated"; task: TaskRow };

const ASSIGNEE_RULE = "task.assignee_id must be the project owner or a project member";

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

  /**
   * Whether `userId` may be assigned work in `projectId`: the project's owner
   * or one of its members. The owner need not appear in `member_ids`, so a
   * project's `getMembers()` is not guaranteed to list every assignee — the
   * owner is the one exception.
   */
  isProjectParticipant(projectId: number, userId: number): boolean {
    const project = this.data.projects.find((p) => p.id === projectId);
    return project !== undefined && (project.owner_id === userId || project.member_ids.includes(userId));
  }

  hasProject(id: number): boolean {
    return this.data.projects.some((p) => p.id === id);
  }

  /**
   * Creates a task from an untrusted body, in one step: the project must
   * exist, the body must validate, and an assignee must be an owner or
   * member. Validation and the assignee rule live here, next to the write,
   * so every writer (routes, imports, tests) gets them.
   */
  createTask(projectId: number, body: unknown): CreateOutcome {
    if (!this.hasProject(projectId)) return { kind: "missing" };
    const validated = validateNewTask(body);
    if (!validated.ok) return { kind: "invalid", error: validated.error };
    const input: NewTask = validated.value;
    if (input.assignee_id != null && !this.isProjectParticipant(projectId, input.assignee_id)) {
      return { kind: "invalid", error: ASSIGNEE_RULE };
    }
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
    return { kind: "created", task: clone(task) };
  }

  /**
   * Updates a task from an untrusted body in ONE synchronous step — optimistic
   * locking depends on nothing happening between the hash check and the write:
   *   1. the task must exist                                       → missing
   *   2. the envelope: an object with a string `hash`             → malformed
   *   3. the hash must be the current one                          → conflict (with the current row)
   *   4. the field values must validate, and a CHANGED assignee
   *      must be an owner or member                                → invalid
   *   5. the mutable fields are applied and the hash bumped        → updated
   * `id`, `project_id` and `hash` can never be set by a caller. The assignee
   * rule applies only to a change: saving a task back with its existing
   * assignee must not fail because that user has since left the project.
   */
  updateTask(id: number, body: unknown): UpdateOutcome {
    const task = this.data.tasks.find((t) => t.id === id);
    if (!task) return { kind: "missing" };
    const envelope = validateTaskEnvelope(body);
    if (!envelope.ok) return { kind: "malformed", error: envelope.error };
    if (envelope.value.hash !== task.hash) return { kind: "conflict", current: clone(task) };

    const validated = validateTaskFields(body as Record<string, unknown>);
    if (!validated.ok) return { kind: "invalid", error: validated.error };
    const fields = validated.value;
    const assigneeChanged = "assignee_id" in fields && fields.assignee_id !== task.assignee_id;
    if (assigneeChanged && fields.assignee_id != null && !this.isProjectParticipant(task.project_id, fields.assignee_id)) {
      return { kind: "invalid", error: ASSIGNEE_RULE };
    }

    for (const field of MUTABLE_TASK_FIELDS) {
      if (field in fields) (task as Record<MutableTaskField, unknown>)[field] = fields[field];
    }
    task.hash = bumpHash(task.hash);
    return { kind: "updated", task: clone(task) };
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
