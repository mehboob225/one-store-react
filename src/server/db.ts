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
import { hasField } from "../store/canonicalKey";
import { MUTABLE_TASK_FIELDS, validateNewTask, validateTaskEnvelope, validateTaskFields, type MutableTaskField, type Validated } from "./validation";

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

/**
 * Write outcomes, in check order — the route maps each to a status:
 * missing → 404, forbidden → 403 (the actor is not on the project),
 * conflict → 409, invalid → 400 (a malformed envelope and a bad field value
 * are both `invalid`; each method's docblock gives the detection order).
 * Reads are workspace-wide; WRITES REQUIRE MEMBERSHIP of the project.
 */
export type CreateOutcome = { kind: "missing" } | { kind: "forbidden" } | { kind: "invalid"; error: string } | { kind: "created"; task: TaskRow };

export type UpdateOutcome =
  | { kind: "missing" }
  | { kind: "forbidden" }
  | { kind: "conflict"; current: TaskRow }
  | { kind: "invalid"; error: string }
  | { kind: "updated"; task: TaskRow };

export type DeleteOutcome = { kind: "missing" } | { kind: "forbidden" } | { kind: "deleted"; task: TaskRow; comments: CommentRow[] };

/** Outcome of `importTasks`: all or nothing — on `invalid` no row was written. */
export type ImportOutcome = { kind: "missing" } | { kind: "forbidden" } | { kind: "invalid"; error: string } | { kind: "imported"; tasks: TaskRow[] };

/** The one authorization step for writing to a project: 404 before 403, then the loaded row. */
type Authorized = { kind: "missing" } | { kind: "forbidden" } | { kind: "ok"; project: ProjectRow };

const ASSIGNEE_RULE = "task.assignee_id must be a project member";

export class Database {
  private data: SeedData;
  private nextId: Record<keyof SeedData, number>;

  constructor(initial: SeedData = seed()) {
    assertSeedInvariants(initial);
    this.data = initial;
    this.nextId = Database.idsFor(initial);
  }

  /** Replaces all data with a fresh seed (tests). */
  reset(initial: SeedData = seed()): void {
    assertSeedInvariants(initial);
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
   * Finds the project and checks membership, in that order, for every write.
   * Membership is the one rule for who may write to a project and who may be
   * assigned its tasks. The owner is always a member (a seed invariant), so
   * `member_ids` — and the client's `getMembers()` — is the complete list.
   */
  private authorize(projectId: number, actorId: number): Authorized {
    const project = this.data.projects.find((p) => p.id === projectId);
    if (!project) return { kind: "missing" };
    if (!isMember(project, actorId)) return { kind: "forbidden" };
    return { kind: "ok", project };
  }

  /** Writes a validated task into a loaded project. Cannot fail: every check has already run. */
  private insertTask(project: ProjectRow, input: NewTask): TaskRow {
    const id = this.nextId.tasks++;
    const task: TaskRow = {
      id,
      project_id: project.id,
      assignee_id: input.assignee_id ?? null,
      title: input.title,
      status: input.status ?? "todo",
      due_on: input.due_on ?? null,
      hash: `t${id}-1`,
    };
    this.data.tasks.push(task);
    return clone(task);
  }

  hasProject(id: number): boolean {
    return this.data.projects.some((p) => p.id === id);
  }

  hasTask(id: number): boolean {
    return this.data.tasks.some((t) => t.id === id);
  }

  /**
   * Creates a task from an untrusted body, in one step: the project must
   * exist, the actor must be on it, the body must validate, and an assignee
   * must be a member. Authorization, validation and the assignee rule live
   * here, next to the write, so every writer (routes, imports, tests) gets them.
   */
  createTask(projectId: number, body: unknown, actorId: number): CreateOutcome {
    const access = this.authorize(projectId, actorId);
    if (access.kind !== "ok") return access;
    const prepared = prepareNewTask(access.project, body);
    if (!prepared.ok) return { kind: "invalid", error: prepared.error };
    return { kind: "created", task: this.insertTask(access.project, prepared.value) };
  }

  /**
   * Creates several tasks, all or nothing: authorizes once, validates every
   * body before writing any row, then inserts them all. An `invalid` outcome
   * means nothing was written.
   */
  importTasks(projectId: number, bodies: readonly unknown[], actorId: number): ImportOutcome {
    const access = this.authorize(projectId, actorId);
    if (access.kind !== "ok") return access;
    const inputs: NewTask[] = [];
    for (const body of bodies) {
      const prepared = prepareNewTask(access.project, body); // the same per-row rules as createTask
      if (!prepared.ok) return { kind: "invalid", error: prepared.error };
      inputs.push(prepared.value);
    }
    return { kind: "imported", tasks: inputs.map((input) => this.insertTask(access.project, input)) };
  }

  /**
   * Updates a task from an untrusted body in ONE synchronous step — optimistic
   * locking depends on nothing happening between the hash check and the write:
   *   1. the task must exist                                       → missing
   *   2. the actor must be on the task's project                   → forbidden
   *   3. the envelope: an object with a string `hash`             → invalid (400, before the hash is compared)
   *   4. the hash must be the current one                          → conflict (with the current row)
   *   5. the field values must validate, and a CHANGED assignee
   *      must be a member                                          → invalid
   *   6. the mutable fields are applied and the hash bumped        → updated
   * `id`, `project_id` and `hash` can never be set by a caller. The assignee
   * rule applies only to a change: saving a task back with its existing
   * assignee must not fail because that user has since left the project.
   */
  updateTask(id: number, body: unknown, actorId: number): UpdateOutcome {
    const task = this.data.tasks.find((t) => t.id === id);
    if (!task) return { kind: "missing" };
    const access = this.authorize(task.project_id, actorId); // an orphan task is `missing` (the seed invariant makes it unreachable)
    if (access.kind !== "ok") return access;
    const { project } = access;
    const envelope = validateTaskEnvelope(body);
    if (!envelope.ok) return { kind: "invalid", error: envelope.error };
    if (envelope.value.hash !== task.hash) return { kind: "conflict", current: clone(task) };

    const validated = validateTaskFields(envelope.value.body);
    if (!validated.ok) return { kind: "invalid", error: validated.error };
    const fields = validated.value;
    const assigneeChanged = hasField(fields, "assignee_id") && fields.assignee_id !== task.assignee_id;
    if (assigneeChanged && fields.assignee_id != null && !isMember(project, fields.assignee_id)) {
      return { kind: "invalid", error: ASSIGNEE_RULE };
    }

    for (const field of MUTABLE_TASK_FIELDS) {
      if (hasField(fields, field)) (task as Record<MutableTaskField, unknown>)[field] = fields[field];
    }
    task.hash = bumpHash(task.hash);
    return { kind: "updated", task: clone(task) };
  }

  /** Removes the task and its comments + tag links, if the actor is on its project. */
  deleteTask(id: number, actorId: number): DeleteOutcome {
    const task = this.data.tasks.find((t) => t.id === id);
    if (!task) return { kind: "missing" };
    const access = this.authorize(task.project_id, actorId);
    if (access.kind !== "ok") return access;
    this.data.tasks = this.data.tasks.filter((t) => t !== task);

    const comments = this.data.comments.filter((c) => c.task_id === id);
    this.data.comments = this.data.comments.filter((c) => c.task_id !== id);
    this.data.task_tags = this.data.task_tags.filter((tt) => tt.task_id !== id);

    return { kind: "deleted", task, comments };
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

/** The one membership rule, on a loaded project row. */
function isMember(project: ProjectRow, userId: number): boolean {
  return project.member_ids.includes(userId);
}

/** The per-row rules shared by every create path: the body must validate and an assignee must be a member. */
function prepareNewTask(project: ProjectRow, body: unknown): Validated<NewTask> {
  const validated = validateNewTask(body);
  if (!validated.ok) return validated;
  if (validated.value.assignee_id != null && !isMember(project, validated.value.assignee_id)) return { ok: false, error: ASSIGNEE_RULE };
  return validated;
}

/**
 * Data invariants the rules above rely on. Checked whenever data is loaded so
 * a bad seed fails at startup, not in a route.
 */
function assertSeedInvariants(data: SeedData): void {
  const fail = (message: string) => {
    throw new Error(`seed invariant: ${message}`);
  };
  const projects = new Map(data.projects.map((p) => [p.id, p]));
  const taskIds = new Set(data.tasks.map((t) => t.id));
  const tagIds = new Set(data.tags.map((t) => t.id));
  const userIds = new Set(data.users.map((u) => u.id));

  for (const project of data.projects) {
    if (!project.member_ids.includes(project.owner_id)) fail(`project ${project.id} owner ${project.owner_id} must be in member_ids`);
    for (const id of project.member_ids) if (!userIds.has(id)) fail(`project ${project.id} member ${id} is not a user`);
  }
  for (const task of data.tasks) {
    if (!projects.has(task.project_id)) fail(`task ${task.id} belongs to missing project ${task.project_id}`);
    if (task.assignee_id !== null && !userIds.has(task.assignee_id)) fail(`task ${task.id} assignee ${task.assignee_id} is not a user`);
    // deliberately NOT asserted: assignee ∈ members. The write rule applies to a CHANGED assignee only,
    // so a task may keep an assignee who has since left the project (docs/API.md).
  }
  for (const comment of data.comments) {
    if (!taskIds.has(comment.task_id)) fail(`comment ${comment.id} belongs to missing task ${comment.task_id}`);
    if (!userIds.has(comment.author_id)) fail(`comment ${comment.id} author ${comment.author_id} is not a user`);
  }
  for (const link of data.task_tags) {
    if (!taskIds.has(link.task_id) || !tagIds.has(link.tag_id)) fail(`task_tags link ${link.task_id}-${link.tag_id} references a missing row`);
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
