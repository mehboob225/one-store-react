/**
 * Body validators for every write endpoint.
 *
 * All request bodies are untrusted JSON. Each validator returns either a
 * typed, allowlisted value or an error message for a 400 response. Unknown
 * fields are dropped; badly typed values are rejected before anything is
 * written or broadcast.
 */
import type { NewTask, TaskPatch } from "./db";
import type { TaskRow } from "./fixtures";

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Validated<T> => ({ ok: true, value });
const fail = <T>(error: string): Validated<T> => ({ ok: false, error });

export const TASK_STATUSES: readonly TaskRow["status"][] = ["todo", "doing", "done"];

/** The only task fields a client may set. `id`, `project_id`, `hash` are server-owned. */
export const MUTABLE_TASK_FIELDS = ["title", "status", "assignee_id", "due_on"] as const;
export type MutableTaskField = (typeof MUTABLE_TASK_FIELDS)[number];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTaskField(field: MutableTaskField, value: unknown): string | undefined {
  switch (field) {
    case "title":
      return typeof value === "string" && value.trim() !== "" ? undefined : "task.title must be a non-empty string";
    case "status":
      return TASK_STATUSES.includes(value as TaskRow["status"])
        ? undefined
        : `task.status must be one of ${TASK_STATUSES.join(", ")}`;
    case "assignee_id":
      return value === null || typeof value === "number" ? undefined : "task.assignee_id must be a number or null";
    case "due_on":
      return value === null || typeof value === "string" ? undefined : "task.due_on must be a string or null";
  }
}

/** Copies the mutable fields present in `body` into `target`, validating each. */
function collectTaskFields(body: Record<string, unknown>, target: Record<string, unknown>): string | undefined {
  for (const field of MUTABLE_TASK_FIELDS) {
    if (!(field in body)) continue;
    const problem = validateTaskField(field, body[field]);
    if (problem) return problem;
    target[field] = body[field];
  }
  return undefined;
}

/** `POST /projects/:id/tasks` body (`task`): title required, other fields optional. */
export function validateNewTask(input: unknown): Validated<NewTask> {
  if (!isPlainObject(input)) return fail("task must be an object");
  if (!("title" in input)) return fail("task.title is required");
  const value: Record<string, unknown> = {};
  const problem = collectTaskFields(input, value);
  return problem ? fail(problem) : ok(value as unknown as NewTask);
}

/** `PUT /tasks/:id` body (`task`): hash required, mutable fields optional. */
export function validateTaskPatch(input: unknown): Validated<TaskPatch> {
  if (!isPlainObject(input)) return fail("task must be an object");
  if (typeof input.hash !== "string") return fail("task.hash is required");
  const value: Record<string, unknown> = { hash: input.hash };
  const problem = collectTaskFields(input, value);
  return problem ? fail(problem) : ok(value as unknown as TaskPatch);
}

/** `PUT /users/current/settings` body (`settings`): a plain object of preferences. */
export function validateSettings(input: unknown): Validated<Record<string, unknown>> {
  return isPlainObject(input) ? ok({ ...input }) : fail("settings must be an object");
}

/** `POST /sign_in` body. */
export function validateCredentials(input: unknown): Validated<{ email: string; password: string }> {
  if (!isPlainObject(input)) return fail("body must be an object");
  const { email, password } = input;
  if (typeof email !== "string" || email === "" || typeof password !== "string" || password === "") {
    return fail("email and password are required strings");
  }
  return ok({ email, password });
}
