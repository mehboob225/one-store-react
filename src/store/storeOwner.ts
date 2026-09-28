/**
 * The link from a stored model back to the store that holds it, so a model's
 * generated accessors resolve relations in THAT store (not a module-level
 * singleton): a model held by a test's own DataCache reads that cache.
 *
 * The slot is a non-enumerable symbol property, so it never reaches JSON,
 * spreads, equality checks or `Object.keys`. Only objects that declare the
 * slot (PassiveModel instances) are stamped; plain rows are left untouched,
 * frozen or not.
 */
export const STORE_OWNER: unique symbol = Symbol("store owner");

/** Adds the (empty) slot to a model; the bucket fills it on `add`. */
export function declareOwnerSlot(object: object): void {
  Object.defineProperty(object, STORE_OWNER, { value: undefined, writable: true, enumerable: false, configurable: false });
}

export function hasOwnerSlot(object: object): boolean {
  return Object.hasOwn(object, STORE_OWNER);
}

export function setOwner(object: object, owner: object | undefined): void {
  (object as Record<symbol, unknown>)[STORE_OWNER] = owner;
}

export function ownerOf(object: object): object | undefined {
  return hasOwnerSlot(object) ? ((object as Record<symbol, unknown>)[STORE_OWNER] as object | undefined) : undefined;
}
