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
 *    A change that moves an object OUT of a foreign-key bucket (reassigning
 *    a task, deleting it) must notify the old bucket too. The bus derives
 *    those keys from `previous`: the object's state before the write. Removes
 *    must therefore broadcast the stored object, never an id-only stub.
 *
 *    Keys are collected in a pending map and flushed in a microtask, so a
 *    500-object write produces ONE callback per subscription. Only keys that
 *    have listeners are queued at all. Nothing here consults the schema: the
 *    cache (step 7) passes the index field and foreign-key names from
 *    ModelDefinitions.
 *
 * Delivery contract (both classes):
 *  - each `subscribe` call is its own subscription, even for the same function;
 *  - a listener unsubscribed during a delivery is not called in that delivery
 *    (an unmount cleanup must silence its listener immediately);
 *  - a listener subscribed during a delivery is first called by the next one;
 *  - a throwing listener never stops the others;
 *  - a `flush()` requested from inside a flush runs after the current one,
 *    so batches are always delivered in the order they were queued.
 *
 * Batches are INVALIDATION SIGNALS. They say which ids changed and how, so a
 * subscriber can decide whether to re-read the store — the store is the
 * source of truth, and listeners never apply a batch incrementally.
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
interface Entry<L> {
  readonly listener: L;
}

/**
 * Calls each entry's listener with `payload`. Iterates a snapshot for
 * stability, but skips entries removed from `live` during the delivery.
 */
function deliver<L extends (arg: never) => void>(
  live: ReadonlySet<Entry<L>>,
  payload: Parameters<L>[0],
  onError: ListenerErrorHandler,
  context: { key?: string },
): void {
  const snapshot = Array.from(live);
  for (const entry of snapshot) {
    if (!live.has(entry)) continue; // unsubscribed during this delivery
    try {
      entry.listener(payload as never);
    } catch (error) {
      report(onError, error, context);
    }
  }
}

export class EventHandler<T> {
  private readonly entries = new Set<Entry<(payload: T) => void>>();

  constructor(private readonly onListenerError: ListenerErrorHandler = defaultErrorHandler) {}

  /** Adds a listener. Returns the function that removes exactly this subscription. */
  subscribe(listener: (payload: T) => void): Unsubscribe {
    const entry: Entry<(payload: T) => void> = { listener };
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

/** The last action seen for one id within a batch. */
export interface DataChange {
  id: IndexValue;
  action: DataAction;
}

/**
 * One flushed batch for one key. An invalidation signal: re-read the store,
 * do not apply it incrementally.
 */
export interface DataEventBatch {
  key: string;
  objectType: string;
  /** The last action per id, ids in first-seen order. */
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
   * The objects' state *before* the write, for updates that may have changed
   * a declared foreign key (a reassigned task). Each yields the old bucket's
   * "type/fk/oldValue" key so subscribers to the old bucket are invalidated
   * too. Matched to `objects` by index value; order does not matter.
   */
  previous?: readonly Record<string, unknown>[];
  /** Identity field, from ModelDefinitions[objectType].index. Default "id". */
  index?: string;
  /** Foreign-key field names declared for this type; each yields a "type/fk/value" key. */
  foreignKeys?: readonly string[];
}

/**
 * Escapes one key segment so an id or value containing "/" can never collide
 * with another key shape ("tasks/project_id/42" must only ever mean the
 * foreign-key bucket). Numbers and plain strings are unchanged.
 */
export function keySegment(value: IndexValue): string {
  return String(value).replace(/%/g, "%25").replace(/\//g, "%2F");
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
    return `${selector.objectType}/${keyName}/${keySegment(key)}`;
  }
  if ("id" in selector) {
    if (!isIndexValue(selector.id)) {
      throw new TypeError(`eventKey: selector for "${selector.objectType}" has an undefined id; use { objectType } for the bucket`);
    }
    return `${selector.objectType}/${keySegment(selector.id)}`;
  }
  return selector.objectType;
}

interface Pending {
  objectType: string;
  /** Last action per id; Map preserves first-seen id order. */
  changes: Map<IndexValue, DataAction>;
}

export class DataEventHandler {
  private readonly listeners = new Map<string, Set<Entry<DataEventListener>>>();
  private pending = new Map<string, Pending>();
  private flushScheduled = false;
  private flushing = false;
  private flushRequested = false;

  constructor(private readonly onListenerError: ListenerErrorHandler = defaultErrorHandler) {}

  /** Subscribes to a selector (bucket, object, or foreign-key value). */
  subscribe(selector: DataEventSelector, listener: DataEventListener): Unsubscribe {
    return this.subscribeKey(eventKey(selector), listener);
  }

  /** Subscribes to a raw key string. Each call is its own subscription. */
  subscribeKey(key: string, listener: DataEventListener): Unsubscribe {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    const entry: Entry<DataEventListener> = { listener };
    set.add(entry);
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(entry);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  /**
   * Records a change. Nothing is delivered synchronously: keys accumulate
   * until the next microtask, then each key's listeners are called once.
   * Keys nobody listens to are not queued, so a subscription only ever sees
   * changes broadcast after it was made.
   */
  broadcast({ objectType, action, objects, previous = [], index = "id", foreignKeys = [] }: BroadcastInput): void {
    let enqueued = false;

    for (const object of objects) {
      const id = object[index];
      if (!isIndexValue(id)) continue;
      enqueued = this.enqueue(objectType, objectType, action, id) || enqueued;
      enqueued = this.enqueue(`${objectType}/${keySegment(id)}`, objectType, action, id) || enqueued;
      enqueued = this.enqueueForeignKeys(objectType, action, id, object, foreignKeys) || enqueued;
    }

    // Old-bucket keys: an object that left a foreign-key bucket must notify it.
    for (const object of previous) {
      const id = object[index];
      if (!isIndexValue(id)) continue;
      enqueued = this.enqueueForeignKeys(objectType, action, id, object, foreignKeys) || enqueued;
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

  private deliverPending(): void {
    if (this.pending.size === 0) return;

    // Snapshot and reset first: a listener may broadcast again, which must
    // start a fresh batch delivered after this one.
    const batches = this.pending;
    this.pending = new Map();

    for (const [key, entry] of batches) {
      const listeners = this.listeners.get(key);
      if (!listeners || listeners.size === 0) continue;
      deliver(listeners, toBatch(key, entry), this.onListenerError, { key });
    }
  }

  private enqueueForeignKeys(
    objectType: string,
    action: DataAction,
    id: IndexValue,
    object: Record<string, unknown>,
    foreignKeys: readonly string[],
  ): boolean {
    let enqueued = false;
    for (const fk of foreignKeys) {
      const value = object[fk];
      if (isIndexValue(value)) {
        enqueued = this.enqueue(`${objectType}/${fk}/${keySegment(value)}`, objectType, action, id) || enqueued;
      }
    }
    return enqueued;
  }

  /** Queues `action` for `id` under `key` — only if someone listens to `key`. */
  private enqueue(key: string, objectType: string, action: DataAction, id: IndexValue): boolean {
    if (!this.listeners.has(key)) return false;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { objectType, changes: new Map() };
      this.pending.set(key, entry);
    }
    entry.changes.set(id, action); // last action wins; Map keeps first-seen id order
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
  const changes: DataChange[] = [];
  const ids: IndexValue[] = [];
  const actions: DataAction[] = [];
  for (const [id, action] of entry.changes) {
    changes.push({ id, action });
    ids.push(id);
    if (!actions.includes(action)) actions.push(action);
  }
  return { key, objectType: entry.objectType, changes, ids, actions };
}

function isIndexValue(value: unknown): value is IndexValue {
  return typeof value === "number" || typeof value === "string";
}
