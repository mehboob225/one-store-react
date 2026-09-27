/**
 * The one canonical form of an index or foreign-key value for use as a Map
 * key. Shared by the event bus and the schema's write guard, and REQUIRED for
 * every index the cache builds (getById, grouped, association): the write
 * guard lets a key hold numbers or strings, so `1` and `"1"` must map to the
 * same entry everywhere or they become two objects.
 */
export function canonicalKey(value: string | number): string {
  return String(value);
}
