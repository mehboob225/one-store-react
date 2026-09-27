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
 *    have listeners are queued, and per-id / per-foreign-key keys are not
 *    even built when no listener of that shape exists for the type. Nothing
 *    here consults the schema: the cache (step 7) passes the index field and
 *    foreign-key names from ModelDefinitions.
 *
 * Delivery contract (both classes):
 *  - each `subscribe` call is its own subscription, even for the same function;
 *  - a listener unsubscribed during a delivery is not called in that delivery
 *    (an unmount cleanup must silence its listener immediately);
 *  - a listener is only ever called for a batch that contains at least one
 *    change broadcast after it subscribed — never for changes queued before
 *    it existed, including by other listeners on the same key, and never in
 *    the flush during which it subscribed;
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
  /** The bus sequence number when subscribed; batches not newer than this are skipped. */
  readonly since: number;
}

/**
 * Calls each entry's listener with `payload`. Iterates a snapshot for
 * stability, skips entries removed from `live` during the delivery, and —
 * when `newestChange` is given — skips entries subscribed at or after it.
 */
function deliver<P>(
  live: ReadonlySet<Entry<P>>,
  payload: P,
  onError: ListenerErrorHandler,
  context: { key?: string },
  newestChange?: number,
): void {
  const snapshot = Array.from(live);
  for (const entry of snapshot) {
    if (!live.has(entry)) continue; // unsubscribed during this delivery
    if (newestChange !== undefined && entry.since >= newestChange) continue; // subscribed after every change in the batch
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
    const entry: Entry<T> = { listener, since: 0 };
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
 * is `add`; add then remove is dropped; remove then add is `update`) and,
 * for a foreign-key key, relative to that bucket (an object reassigned into
 * it is `add`, one reassigned out of it is `remove`).
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
   * foreign key whose value changed, the old bucket's key is emitted with
   * `remove` and the new bucket's with `add`.
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
 * Builds the string key for a selector. Throws when `id` or `key` is
 * present but undefined: that selector would type-check (it matches the
 * bare bucket shape) and then never fire. Subscribe conditionally instead.
 */
export function eventKey(selector: DataEventSelector): string {
  if ("keyName" in selector || "key" in selector) {
    const { keyName, key } = selector as { keyName?: string; key?: IndexValue };
    if (typeof keyName !== "string" || !isIndexValue(key)) {
      throw new TypeError(`eventKey: selector for "${selector.objectType}" has an undefined keyName or key`);
    }
    return fkKey(selector.objectType, keyName, key);
  }
  if ("id" in selector) {
    if (!isIndexValue(selector.id)) {
      throw new TypeError(`eventKey: selector for "${selector.objectType}" has an undefined id; use { objectType } for the bucket`);
    }
    return idKey(selector.objectType, selector.id);
  }
  return bucketKey(selector.objectType);
}

type KeyShape = "bucket" | "id" | "fk";

/** Reads the shape and (escaped) type segment back out of a key. */
function parseKey(key: string): { type: string; shape: KeyShape } {
  const parts = key.split("/");
  const shape: KeyShape = parts.length >= 3 ? "fk" : parts.length === 2 ? "id" : "bucket";
  return { type: parts[0] ?? "", shape };
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
      return next === "remove" ? "remove" : "update";
  }
}

interface Pending {
  objectType: string;
  /** Net change per canonical (string) id; insertion order is delivery order. */
  changes: Map<string, DataChange>;
  /** Sequence number of the newest broadcast that touched this batch. */
  newestChange: number;
}

interface ShapeCounts {
  id: number;
  fk: number;
}

export class DataEventHandler {
  private readonly listeners = new Map<string, Set<Entry<DataEventBatch>>>();
  /** Per (escaped) type: how many id-shaped and fk-shaped subscriptions exist. */
  private readonly shapeCounts = new Map<string, ShapeCounts>();
  private pending = new Map<string, Pending>();
  /** Incremented per broadcast; stamps subscriptions and batches. */
  private seq = 0;
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
    const entry: Entry<DataEventBatch> = { listener, since: this.seq };
    set.add(entry);
    const { type, shape } = parseKey(key);
    this.countShape(type, shape, +1);

    return () => {
      const current = this.listeners.get(key);
      if (!current?.delete(entry)) return; // already unsubscribed
      if (current.size === 0) this.listeners.delete(key);
      this.countShape(type, shape, -1);
    };
  }

  /**
   * Records a change. Nothing is delivered synchronously: keys accumulate
   * until the next microtask, then each key's listeners are called once.
   */
  broadcast({ objectType, action, objects, previous = [], index = "id", foreignKeys = [] }: BroadcastInput): void {
    const type = bucketKey(objectType);
    const counts = this.shapeCounts.get(type);
    const wantBucket = this.listeners.has(type);
    const wantId = (counts?.id ?? 0) > 0;
    const wantFk = (counts?.fk ?? 0) > 0 && foreignKeys.length > 0;
    if (!wantBucket && !wantId && !wantFk) return; // nobody could hear it: build nothing

    const stamp = ++this.seq;
    const previousById = wantFk && previous.length > 0 ? indexById(previous, index) : undefined;
    let enqueued = false;

    for (const object of objects) {
      const id = object[index];
      if (!isIndexValue(id)) continue;

      if (wantBucket) enqueued = this.enqueue(type, objectType, id, action, stamp) || enqueued;
      if (wantId) enqueued = this.enqueue(idKey(objectType, id), objectType, id, action, stamp) || enqueued;
      if (wantFk) {
        const before = previousById?.get(String(id));
        enqueued = this.enqueueForeignKeys(objectType, action, id, object, before, foreignKeys, stamp) || enqueued;
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

  private countShape(type: string, shape: KeyShape, delta: 1 | -1): void {
    if (shape === "bucket") return;
    const counts = this.shapeCounts.get(type) ?? { id: 0, fk: 0 };
    counts[shape] += delta;
    if (counts.id === 0 && counts.fk === 0) this.shapeCounts.delete(type);
    else this.shapeCounts.set(type, counts);
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
      deliver(listeners, toBatch(key, entry), this.onListenerError, { key }, entry.newestChange);
    }
  }

  /**
   * Foreign-key keys for one object. With a `before` state, a changed value
   * means the object left one bucket (`remove` there) and entered another
   * (`add` there); an unchanged value carries the write's own action.
   */
  private enqueueForeignKeys(
    objectType: string,
    action: DataAction,
    id: IndexValue,
    object: Record<string, unknown>,
    before: Record<string, unknown> | undefined,
    foreignKeys: readonly string[],
    stamp: number,
  ): boolean {
    let enqueued = false;
    for (const fk of foreignKeys) {
      const value = object[fk];
      const oldValue = before?.[fk];
      const changed = before !== undefined && canonical(oldValue) !== canonical(value);

      if (isIndexValue(value)) {
        enqueued = this.enqueue(fkKey(objectType, fk, value), objectType, id, changed ? "add" : action, stamp) || enqueued;
      }
      if (changed && isIndexValue(oldValue)) {
        enqueued = this.enqueue(fkKey(objectType, fk, oldValue), objectType, id, "remove", stamp) || enqueued;
      }
    }
    return enqueued;
  }

  /** Queues `action` for `id` under `key` — only if someone listens to `key`. */
  private enqueue(key: string, objectType: string, id: IndexValue, action: DataAction, stamp: number): boolean {
    if (!this.listeners.has(key)) return false;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { objectType, changes: new Map(), newestChange: stamp };
      this.pending.set(key, entry);
    }
    entry.newestChange = stamp;

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
