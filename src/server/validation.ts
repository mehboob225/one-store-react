/**
 * Body validators for every write endpoint.
 *
 * All request bodies are untrusted JSON. Each validator returns either a
 * typed, allowlisted value or an error message for a 400 response. Unknown
 * fields are dropped; badly typed values are rejected before anything is
 * written or broadcast.
 */
import { hasField, isRecord, ownField } from "../store/canonicalKey";
import type { NewTask, TaskFields } from "./db";
import type { TaskRow } from "./fixtures";

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Validated<T> => ({ ok: true, value });
const fail = <T>(error: string): Validated<T> => ({ ok: false, error });

export const TASK_STATUSES: readonly TaskRow["status"][] = ["todo", "doing", "done"];

/** The only task fields a client may set. `id`, `project_id`, `hash` are server-owned. */
export const MUTABLE_TASK_FIELDS = ["title", "status", "assignee_id", "due_on"] as const;
export type MutableTaskField = (typeof MUTABLE_TASK_FIELDS)[number];

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
    if (!hasField(body, field)) continue; // the one field-reading rule (canonicalKey.ts)
    const problem = validateTaskField(field, body[field]);
    if (problem) return problem;
    target[field] = body[field]; // own: checked above
  }
  return undefined;
}

/** `POST /projects/:id/tasks` body (`task`): title required, other fields optional. */
export function validateNewTask(input: unknown): Validated<NewTask> {
  if (!isRecord(input)) return fail("task must be an object");
  if (!hasField(input, "title")) return fail("task.title is required");
  const value: Record<string, unknown> = {};
  const problem = collectTaskFields(input, value);
  return problem ? fail(problem) : ok(value as unknown as NewTask);
}

/**
 * `PUT /tasks/:id` body (`task`), step one — the envelope: an object carrying
 * a non-empty string `hash` (server hashes are never empty, so an empty one
 * can only be a broken request). Checked BEFORE the hash comparison, so a
 * request without a usable hash is reported as malformed (400), never as a
 * conflict. Returns the
 * narrowed body so the field step needs no cast.
 */
export function validateTaskEnvelope(input: unknown): Validated<{ hash: string; body: Record<string, unknown> }> {
  if (!isRecord(input)) return fail("task must be an object");
  const hash = ownField(input, "hash");
  if (typeof hash !== "string" || hash === "") return fail("task.hash must be a non-empty string");
  return ok({ hash, body: input });
}

/**
 * `PUT /tasks/:id` body (`task`), step two — the mutable fields, all
 * optional. Checked AFTER the hash comparison, so a stale hash wins over a
 * bad value and the client always gets the current task on conflict.
 */
export function validateTaskFields(input: Record<string, unknown>): Validated<TaskFields> {
  const value: Record<string, unknown> = {};
  const problem = collectTaskFields(input, value);
  return problem ? fail(problem) : ok(value as TaskFields);
}

/** `PUT /users/current/settings` body (`settings`): a plain object of preferences. */
export function validateSettings(input: unknown): Validated<Record<string, unknown>> {
  return isRecord(input) ? ok({ ...input }) : fail("settings must be an object");
}

/** `POST /sign_in` body. */
export function validateCredentials(input: unknown): Validated<{ email: string; password: string }> {
  if (!isRecord(input)) return fail("body must be an object");
  const email = ownField(input, "email");
  const password = ownField(input, "password");
  if (typeof email !== "string" || email === "" || typeof password !== "string" || password === "") {
    return fail("email and password are required strings");
  }
  return ok({ email, password });
}
