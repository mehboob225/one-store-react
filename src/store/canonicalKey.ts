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
 *    accessors are not data (generated accessors live on the prototype), and
 *    an own property explicitly set to `undefined` counts as ABSENT, the same
 *    as a missing one (JSON cannot carry `undefined`; a partial update simply
 *    leaves the field out).
 */
export function isKeyValue(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value !== "" && value.trim() === value;
}

export function canonicalKey(value: string | number): string {
  return String(value);
}

/** Reads a data field per the own-property rule; `undefined` when absent or not a record. */
export function ownField<T>(record: Record<string, T> | null | undefined, field: string): T | undefined {
  return typeof record === "object" && record !== null && Object.hasOwn(record, field) ? record[field] : undefined;
}

/** Whether a data field is present per the own-property rule (own, and not `undefined`). */
export function hasField(record: Record<string, unknown> | null | undefined, field: string): boolean {
  return ownField(record, field) !== undefined;
}
