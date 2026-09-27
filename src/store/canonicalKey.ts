/**
 * The one rule for index and foreign-key VALUES, and their one canonical
 * form as a Map key. Shared by the event bus, the schema's write guard and
 * every index the cache builds (getById, grouped, association).
 *
 *  - a key value is a finite number or a non-empty, non-padded string
 *    (NaN, Infinity, "" and " 1" would land an object under a key no
 *    subscriber ever uses);
 *  - `1` and `"1"` are the same key: the write guard lets a key hold either,
 *    so everything must key on `canonicalKey(value)` or they become two
 *    objects.
 */
export function isKeyValue(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value !== "" && value.trim() === value;
}

export function canonicalKey(value: string | number): string {
  return String(value);
}
