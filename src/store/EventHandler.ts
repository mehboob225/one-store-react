/**
 * The typed broadcast bus.
 *
 * Two classes:
 *
 *  - `EventHandler<T>`: plain subscribe/emit. Used for app-level signals
 *    (API errors, "some bucket changed").
 *
 *  - `DataEventHandler`: the store's change bus. Listeners subscribe to a
 *    *key*; every write to a bucket broadcasts three key shapes per object:
 *
 *        "tasks"                    the bucket changed at all
 *        "tasks/7"                  object 7 changed
 *        "tasks/project_id/42"      an object with project_id=42 changed
 *                                   (one per foreign key the caller declares)
 *
 *    Every segment is escaped (`keySegment`), so no id, value, type or field
 *    name can make one shape collide with another. Keys are built in one
 *    place (`bucketKey`/`idKey`/`fkKey`) for both the subscribe and the
 *    broadcast side.
 *
 *    A change that moves an object OUT of a foreign-key bucket (reassigning
 *    a task, deleting it) must notify the old bucket too. `previous` — the
 *    written objects' state before the write, matched by id — lets the bus
 *    emit the old bucket's key with action `remove` and the new bucket's
 *    with `add`. Removes must broadcast the stored object, never an
 *    id-only stub, so their foreign-key buckets hear it.
 *
 *    Keys are collected in a pending map and flushed in a microtask, so a
 *    500-object write produces ONE callback per subscription. Only keys that
 *    have listeners are queued, and a per-id or per-foreign-key key is only
 *    built for ids and values somebody is watching. Nothing here consults
 *    the schema: the cache (step 7) passes the index field and foreign-key
 *    names from ModelDefinitions.
 *
 * Delivery contract (both classes):
 *  - each `subscribe` call is its own subscription, even for the same function;
 *  - a listener unsubscribed during a delivery is not called in that delivery
 *    (an unmount cleanup must silence its listener immediately);
 *  - a listener subscribed during a delivery is not called by that delivery
 *    pass, but may be called by a later batch of the same flush;
 *  - pending batches go to whoever listens when they are flushed. A batch may
 *    therefore include changes made just before a listener subscribed. That
 *    is deliberate: a redundant invalidation costs one re-read, a missed one
 *    costs a stale screen. It also means the bus cannot cover the gap between
 *    a component reading the store and subscribing to it — SUBSCRIBERS MUST
 *    RE-READ THE STORE ONCE AFTER SUBSCRIBING (the timestamp atoms do this on
 *    mount);
 *  - a throwing listener never stops the others;
 *  - a `flush()` requested from inside a flush runs after the current one,
 *    so batches are always delivered in the order they were queued.
 *
 * Batches are INVALIDATION SIGNALS: they say which ids changed and the net
 * effect per id, so a subscriber can decide whether to re-read the store.
 * The store is the source of truth; listeners never apply a batch to their
 * own copy of the data.
 */

export type Unsubscribe = () => void;

/** Called when a listener throws; the other listeners still run. */
export type ListenerErrorHandler = (error: unknown, context: { key?: string }) => void;

const defaultErrorHandler: ListenerErrorHandler = (error, context) => {
  console.error(context.key ? `listener for "${context.key}" threw` : "listener threw", error);
};

/** Reports a listener error; a throwing custom handler must not escape delivery either. */
function report(handler: ListenerErrorHandler, error: unknown, context: { key?: string }): void {
  try {
    handler(error, context);
  } catch (handlerError) {
    defaultErrorHandler(error, context);
    console.error("onListenerError handler threw", handlerError);
  }
}

/** One subscription. Two subscriptions of the same function are two entries. */
interface Entry<P> {
  readonly listener: (payload: P) => void;
}

/**
 * Calls each entry's listener with `payload`. Iterates a snapshot for
 * stability (entries added meanwhile wait for the next delivery) and skips
 * entries removed from `live` during the delivery.
 */
function deliver<P>(live: ReadonlySet<Entry<P>>, payload: P, onError: ListenerErrorHandler, context: { key?: string }): void {
  const snapshot = Array.from(live);
  for (const entry of snapshot) {
    if (!live.has(entry)) continue; // unsubscribed during this delivery
    try {
      entry.listener(payload);
    } catch (error) {
      report(onError, error, context);
    }
  }
}

export class EventHandler<T> {
  private readonly entries = new Set<Entry<T>>();

  constructor(private readonly onListenerError: ListenerErrorHandler = defaultErrorHandler) {}

  /** Adds a listener. Returns the function that removes exactly this subscription. */
  subscribe(listener: (payload: T) => void): Unsubscribe {
    const entry: Entry<T> = { listener };
    this.entries.add(entry);
    return () => {
      this.entries.delete(entry);
    };
  }

  /** Calls every listener synchronously (see the delivery contract above). */
  emit(payload: T): void {
    deliver(this.entries, payload, this.onListenerError, {});
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// DataEventHandler
// ---------------------------------------------------------------------------

export type DataAction = "add" | "update" | "remove";
export type IndexValue = string | number;

/** What a subscription selects. */
export type DataEventSelector =
  /** every change to the bucket */
  | { objectType: string }
  /** one object */
  | { objectType: string; id: IndexValue }
  /** every object whose foreign key `keyName` equals `key` */
  | { objectType: string; keyName: string; key: IndexValue };

/** The net effect on one id within a batch, from the subscribed key's point of view. */
export interface DataChange {
  id: IndexValue;
  action: DataAction;
}

/**
 * One flushed batch for one key. An invalidation signal: re-read the store,
 * do not apply it to a local copy. Actions are net effects (add then update
 * is `add`; add then remove is dropped; remove then add is `update`; remove
 * then update stays `remove`) and, for a foreign-key key, relative to that
 * bucket (an object reassigned into it is `add`, one reassigned out of it or
 * deleted is `remove`).
 */
export interface DataEventBatch {
  key: string;
  objectType: string;
  /** Net action per id, one entry per id. */
  changes: DataChange[];
  /** Convenience: the ids of `changes`. */
  ids: IndexValue[];
  /** Convenience: the distinct actions in `changes`, in first-seen order. */
  actions: DataAction[];
}

export type DataEventListener = (batch: DataEventBatch) => void;

export interface BroadcastInput {
  objectType: string;
  action: DataAction;
  /**
   * The objects after the write. For `remove`, pass the stored objects (the
   * state being deleted), not id-only stubs: their foreign-key values are
   * what lets the buckets they belonged to hear about the removal.
   */
  objects: readonly Record<string, unknown>[];
  /**
   * The pre-write state of the objects in `objects`, matched by index value;
   * entries whose id is not in `objects` are ignored. For each declared
   * foreign key *present* in the written object whose value changed, the old
   * bucket's key is emitted with `remove` and the new bucket's with `add`. A
   * foreign key absent from the written object (partial update) is unchanged
   * and its bucket is taken from `previous`.
   */
  previous?: readonly Record<string, unknown>[];
  /** Identity field, from ModelDefinitions[objectType].index. Default "id". */
  index?: string;
  /** Foreign-key field names declared for this type; each yields a "type/fk/value" key. */
  foreignKeys?: readonly string[];
}

// ---- keys -------------------------------------------------------------------

/** Escapes one key segment so "/" inside a value can never produce another key shape. */
export function keySegment(value: IndexValue): string {
  return String(value).replace(/%/g, "%25").replace(/\//g, "%2F");
}

function unescapeSegment(segment: string): string {
  return segment.replace(/%2F/g, "/").replace(/%25/g, "%");
}

export function bucketKey(objectType: string): string {
  return keySegment(objectType);
}

export function idKey(objectType: string, id: IndexValue): string {
  return `${keySegment(objectType)}/${keySegment(id)}`;
}

export function fkKey(objectType: string, keyName: string, value: IndexValue): string {
  return `${keySegment(objectType)}/${keySegment(keyName)}/${keySegment(value)}`;
}

/**
 * Builds the string key for a selector. Defined values decide the shape, so
 * an id selector that also carries `keyName: undefined` is still an id
 * selector. A selector whose only discriminator is present but undefined
 * throws: it would type-check (it matches the bare bucket shape) and then
 * never fire. Subscribe conditionally instead.
 */
export function eventKey(selector: DataEventSelector): string {
  const { objectType, id, keyName, key } = selector as {
    objectType: string;
    id?: IndexValue;
    keyName?: string;
    key?: IndexValue;
  };
  if (keyName !== undefined || key !== undefined) {
    if (typeof keyName !== "string" || !isIndexValue(key)) {
      throw new TypeError(`eventKey: selector for "${objectType}" needs both keyName and key`);
    }
    return fkKey(objectType, keyName, key);
  }
  if (id !== undefined) return idKey(objectType, id);
  if ("id" in selector || "key" in selector || "keyName" in selector) {
    throw new TypeError(`eventKey: selector for "${objectType}" has an undefined id; use { objectType } for the bucket`);
  }
  return bucketKey(objectType);
}

type ParsedKey =
  | { shape: "bucket"; objectType: string }
  | { shape: "id"; objectType: string; id: string }
  | { shape: "fk"; objectType: string; keyName: string; value: string };

/** Reads the shape and the unescaped segments back out of a key. */
function parseKey(key: string): ParsedKey {
  const parts = key.split("/").map(unescapeSegment);
  const objectType = parts[0] ?? "";
  if (parts.length >= 3) return { shape: "fk", objectType, keyName: parts[1]!, value: parts[2]! };
  if (parts.length === 2) return { shape: "id", objectType, id: parts[1]! };
  return { shape: "bucket", objectType };
}

// ---- action composition --------------------------------------------------------

/**
 * Net effect of `next` after `prev` within one batch. `null` means the id
 * cancels out (added and removed before anyone saw it).
 */
function composeAction(prev: DataAction | undefined, next: DataAction): DataAction | null {
  if (prev === undefined) return next;
  switch (prev) {
    case "add":
      return next === "remove" ? null : "add";
    case "update":
      return next === "remove" ? "remove" : "update";
    case "remove":
      // a late update for a deleted object must not resurrect it; a re-add makes it "changed"
      return next === "add" ? "update" : "remove";
  }
}

interface Pending {
  objectType: string;
  /** Net change per canonical (string) id; insertion order is delivery order. */
  changes: Map<string, DataChange>;
}

/** Reference-counted set of watched values (canonical strings). */
type Counts = Map<string, number>;

function increment(counts: Counts, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function decrement(counts: Counts, value: string): void {
  const n = (counts.get(value) ?? 0) - 1;
  if (n <= 0) counts.delete(value);
  else counts.set(value, n);
}

export class DataEventHandler {
  private readonly listeners = new Map<string, Set<Entry<DataEventBatch>>>();
  /** Per objectType: which ids have a subscriber. Lets broadcasts skip building keys nobody watches. */
  private readonly watchedIds = new Map<string, Counts>();
  /** Per objectType, per foreign key: which values have a subscriber. */
  private readonly watchedFks = new Map<string, Map<string, Counts>>();
  private pending = new Map<string, Pending>();
  private flushScheduled = false;
  private flushing = false;
  private flushRequested = false;

  constructor(private readonly onListenerError: ListenerErrorHandler = defaultErrorHandler) {}

  /** Subscribes to a selector (bucket, object, or foreign-key value). */
  subscribe(selector: DataEventSelector, listener: DataEventListener): Unsubscribe {
    return this.subscribeKey(eventKey(selector), listener);
  }

  /** Subscribes to a raw key string (as built by `eventKey`). Each call is its own subscription. */
  subscribeKey(key: string, listener: DataEventListener): Unsubscribe {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    const entry: Entry<DataEventBatch> = { listener };
    set.add(entry);
    const parsed = parseKey(key);
    this.watch(parsed, +1);

    return () => {
      const current = this.listeners.get(key);
      if (!current?.delete(entry)) return; // already unsubscribed
      if (current.size === 0) this.listeners.delete(key);
      this.watch(parsed, -1);
    };
  }

  /**
   * Records a change. Nothing is delivered synchronously: keys accumulate
   * until the next microtask, then each key's listeners are called once.
   */
  broadcast({ objectType, action, objects, previous = [], index = "id", foreignKeys = [] }: BroadcastInput): void {
    const bucket = bucketKey(objectType);
    const wantBucket = this.listeners.has(bucket);
    const ids = this.watchedIds.get(objectType);
    const fks = foreignKeys.length > 0 ? this.watchedFks.get(objectType) : undefined;
    if (!wantBucket && !ids && !fks) return; // nobody could hear it: build nothing

    const previousById = fks && previous.length > 0 ? indexById(previous, index) : undefined;
    let enqueued = false;

    for (const object of objects) {
      const id = object[index];
      if (!isIndexValue(id)) continue;
      const canon = String(id);

      if (wantBucket) enqueued = this.enqueue(bucket, objectType, id, action) || enqueued;
      if (ids?.has(canon)) enqueued = this.enqueue(idKey(objectType, id), objectType, id, action) || enqueued;
      if (fks) {
        const before = previousById?.get(canon);
        enqueued = this.enqueueForeignKeys(objectType, action, id, object, before, foreignKeys, fks) || enqueued;
      }
    }

    if (enqueued) this.scheduleFlush();
  }

  /**
   * Delivers everything pending right now, synchronously. Normally the
   * microtask does this; tests and "read your own write" paths may call it.
   * Called from inside a listener, it runs after the current flush finishes,
   * so batches keep their queued order.
   */
  flush(): void {
    this.flushScheduled = false;
    if (this.flushing) {
      this.flushRequested = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushRequested = false;
        this.deliverPending();
      } while (this.flushRequested && this.pending.size > 0);
    } finally {
      this.flushing = false;
    }
  }

  /** Number of listeners for a key (or in total). Mostly for tests and diagnostics. */
  listenerCount(key?: string): number {
    if (key !== undefined) return this.listeners.get(key)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  /** Keys with changes not yet delivered. */
  get pendingKeys(): string[] {
    return [...this.pending.keys()];
  }

  // ---- internals ----------------------------------------------------------

  private watch(parsed: ParsedKey, delta: 1 | -1): void {
    const apply = delta === 1 ? increment : decrement;
    if (parsed.shape === "id") {
      let ids = this.watchedIds.get(parsed.objectType);
      if (!ids) this.watchedIds.set(parsed.objectType, (ids = new Map()));
      apply(ids, parsed.id);
      if (ids.size === 0) this.watchedIds.delete(parsed.objectType);
    } else if (parsed.shape === "fk") {
      let fks = this.watchedFks.get(parsed.objectType);
      if (!fks) this.watchedFks.set(parsed.objectType, (fks = new Map()));
      let values = fks.get(parsed.keyName);
      if (!values) fks.set(parsed.keyName, (values = new Map()));
      apply(values, parsed.value);
      if (values.size === 0) fks.delete(parsed.keyName);
      if (fks.size === 0) this.watchedFks.delete(parsed.objectType);
    }
  }

  private deliverPending(): void {
    if (this.pending.size === 0) return;

    // Snapshot and reset first: a listener may broadcast again, which must
    // start a fresh batch delivered after this one.
    const batches = this.pending;
    this.pending = new Map();

    for (const [key, entry] of batches) {
      const listeners = this.listeners.get(key);
      if (!listeners || listeners.size === 0 || entry.changes.size === 0) continue;
      deliver(listeners, toBatch(key, entry), this.onListenerError, { key });
    }
  }

  /**
   * Foreign-key keys for one object, only for values somebody watches. With a
   * `before` state and the key present in the written object, a changed value
   * means the object left one bucket (`remove` there) and entered another
   * (`add` there). A key absent from the written object is unchanged and
   * its value is taken from `before`. A `remove` is a `remove` everywhere.
   */
  private enqueueForeignKeys(
    objectType: string,
    action: DataAction,
    id: IndexValue,
    object: Record<string, unknown>,
    before: Record<string, unknown> | undefined,
    foreignKeys: readonly string[],
    watched: Map<string, Counts>,
  ): boolean {
    let enqueued = false;
    for (const fk of foreignKeys) {
      const values = watched.get(fk);
      if (!values) continue; // nobody watches this foreign key on this type

      const oldValue = before?.[fk];
      const present = fk in object;
      const value = present ? object[fk] : oldValue;
      const differs = present && before !== undefined && canonical(oldValue) !== canonical(value);
      // Moved between buckets: `add` into the new one — unless the object is being removed,
      // in which case it is `remove` everywhere it was known.
      const newBucketAction = action === "remove" ? "remove" : differs ? "add" : action;

      if (isIndexValue(value) && values.has(String(value))) {
        enqueued = this.enqueue(fkKey(objectType, fk, value), objectType, id, newBucketAction) || enqueued;
      }
      if (differs && isIndexValue(oldValue) && values.has(String(oldValue))) {
        enqueued = this.enqueue(fkKey(objectType, fk, oldValue), objectType, id, "remove") || enqueued;
      }
    }
    return enqueued;
  }

  /** Queues `action` for `id` under `key`. Callers have already checked that `key` is watched. */
  private enqueue(key: string, objectType: string, id: IndexValue, action: DataAction): boolean {
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { objectType, changes: new Map() };
      this.pending.set(key, entry);
    }
    const canon = String(id);
    const existing = entry.changes.get(canon);
    const composed = composeAction(existing?.action, action);
    if (composed === null) entry.changes.delete(canon);
    else entry.changes.set(canon, { id: existing?.id ?? id, action: composed });
    return true;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      if (this.flushScheduled) this.flush();
    });
  }
}

function toBatch(key: string, entry: Pending): DataEventBatch {
  const changes = [...entry.changes.values()];
  const actions: DataAction[] = [];
  for (const change of changes) if (!actions.includes(change.action)) actions.push(change.action);
  return { key, objectType: entry.objectType, changes, ids: changes.map((c) => c.id), actions };
}

function indexById(objects: readonly Record<string, unknown>[], index: string): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const object of objects) {
    const id = object[index];
    if (isIndexValue(id)) map.set(String(id), object);
  }
  return map;
}

/** Comparable form of a foreign-key value: numbers and their string forms compare equal. */
function canonical(value: unknown): string | null {
  return isIndexValue(value) ? String(value) : null;
}

function isIndexValue(value: unknown): value is IndexValue {
  return typeof value === "number" || typeof value === "string";
}
