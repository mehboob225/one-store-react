/**
 * The one rule for index and foreign-key VALUES, their one canonical form
 * as a Map key, and the one way to READ a data field. Shared by the event
 * bus, the schema's write guard and every index the cache builds (getById,
 * grouped, association).
 *
 *  - a key value is a finite number or a non-empty, non-padded string
 *    (NaN, Infinity, "" and " 1" would land an object under a key no
 *    subscriber ever uses);
 *  - `1` and `"1"` are the same key: the write guard lets a key hold either,
 *    so everything must key on `canonicalKey(value)` or they become two
 *    objects;
 *  - a data field is an OWN property. Inherited values and prototype
 *    accessors are not data (generated accessors live on the prototype). A
 *    field is PRESENT when it is an own property, whatever its value. The
 *    reason: a server response is the complete, authoritative state of the
 *    object it carries, so the cache REPLACES the stored object with it
 *    rather than merging field by field (a merge would keep fields the
 *    server has since cleared). Under replace semantics an own `undefined`
 *    cannot mean "leave it as it was"; it means "no value", exactly like
 *    `null`. Only a field that is not own at all is absent, and absent
 *    fields are how `previous` is consulted.
 *
 * `isRecord` is the one plain-object predicate for data: the server's body
 * validators and the schema validator must agree on what counts as a record.
 */
export function isKeyValue(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value !== "" && value.trim() === value;
}

export function canonicalKey(value: string | number): string {
  return String(value);
}

/** A plain object (not null, not an array): the only shape a data record or request body may have. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a data field per the own-property rule; `undefined` when absent or not a record. */
export function ownField<T>(record: Record<string, T> | null | undefined, field: string): T | undefined {
  return typeof record === "object" && record !== null && Object.hasOwn(record, field) ? record[field] : undefined;
}

/** Whether a data field is present per the own-property rule (own, whatever its value). */
export function hasField(record: Record<string, unknown> | null | undefined, field: string): boolean {
  return typeof record === "object" && record !== null && Object.hasOwn(record, field);
}
