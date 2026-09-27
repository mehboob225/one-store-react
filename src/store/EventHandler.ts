/**
 * The typed broadcast bus.
 *
 * Two classes:
 *
 *  - `EventHandler<T>`: plain subscribe/emit. Used for app-level signals
 *    (API errors, "some bucket changed").
 *
 *  - `DataEventHandler`: the store's change bus. A subscription selects one of
 *    three shapes, and every write to a bucket notifies all three:
 *
 *        { objectType: "tasks" }                              the bucket changed at all
 *        { objectType: "tasks", id: 7 }                       object 7 changed
 *        { objectType: "tasks", keyName: "project_id", key: 42 }
 *                                                             an object with project_id=42 changed
 *                                                             (one per foreign key the caller declares)
 *
 *    Listeners are indexed structurally (per type → bucket / id / foreign-key
 *    value), so there is nothing to escape or parse and a broadcast only does
 *    work for ids and values somebody is watching.
 *
 *    A change that moves an object OUT of a foreign-key bucket must notify the
 *    old bucket too, so an `update` broadcast carries `previous`: the written
 *    objects' state before the write, matched by id. A `remove` must broadcast
 *    the stored objects, never id-only stubs, so their buckets hear it.
 *
 *    Changes are collected per subscription and flushed in a microtask, so a
 *    500-object write produces ONE callback per subscription. Nothing here
 *    consults the schema: the cache (step 7) passes the index field and
 *    foreign-key names from ModelDefinitions.
 *
 * Batches are INVALIDATION SIGNALS and nothing more: "these ids changed under
 * the key you subscribed to — re-read the store". They carry no actions,
 * because a bus cannot know whether an update after a remove is stale or a
 * re-creation; the store can. Listeners never apply a batch to a local copy.
 *
 * Delivery contract (both classes):
 *  - each `subscribe` call is its own subscription, even for the same function;
 *  - a listener unsubscribed during a delivery is not called in that delivery
 *    (an unmount cleanup must silence its listener immediately);
 *  - a listener subscribed during a delivery is not called by the pass in
 *    progress;
 *  - whether a listener hears a change broadcast *before* it subscribed is not
 *    specified (it does if the change was queued for that subscription target,
 *    which depends on who else was listening). SUBSCRIBERS MUST RE-READ THE
 *    STORE ONCE AFTER SUBSCRIBING — the timestamp atoms do this on mount;
 *  - a throwing listener never stops the others;
 *  - a `flush()` requested from inside a flush runs after the current one,
 *    so batches are always delivered in the order they were queued.
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

export type IndexValue = string | number;

/** What a subscription selects. */
export type DataEventSelector =
  /** every change to the bucket */
  | { objectType: string }
  /** one object */
  | { objectType: string; id: IndexValue }
  /** every object whose foreign key `keyName` equals `key` */
  | { objectType: string; keyName: string; key: IndexValue };

/** One flushed batch for one subscription target. Frozen. */
export interface DataEventBatch {
  /** Label of the subscription that fired, e.g. "tasks", "tasks/7", "tasks/project_id/42". */
  readonly key: string;
  readonly objectType: string;
  /** Ids whose state changed under this key, deduplicated, in first-seen order. */
  readonly ids: readonly IndexValue[];
}

export type DataEventListener = (batch: DataEventBatch) => void;

type Row = Record<string, unknown>;

interface BroadcastBase {
  objectType: string;
  /** Identity field, from ModelDefinitions[objectType].index. Default "id". */
  index?: string;
  /** Foreign-key field names declared for this type; each notifies its "type/fk/value" subscribers. */
  foreignKeys?: readonly string[];
}

export type BroadcastInput =
  | (BroadcastBase & { action: "add"; objects: readonly Row[] })
  /**
   * `previous` is the pre-write state of `objects`, matched by index value
   * (unmatched entries are ignored). For each declared foreign key present in
   * the written object whose value changed, the old bucket is notified too.
   * A foreign key absent from the written object (partial update) is
   * unchanged and its bucket is taken from `previous`.
   */
  | (BroadcastBase & { action: "update"; objects: readonly Row[]; previous: readonly Row[] })
  /** `objects` must be the STORED objects (with their foreign keys), never id-only stubs. */
  | (BroadcastBase & { action: "remove"; objects: readonly Row[] });

/**
 * Human-readable label for a selector; also validates it. Defined values
 * decide the shape, so an id selector that also carries `keyName: undefined`
 * is an id selector. A selector whose only discriminator is present but
 * undefined throws: it would type-check (it matches the bare bucket shape)
 * and then never fire. Subscribe conditionally instead.
 */
export function eventKey(selector: DataEventSelector): string {
  const { objectType, id, keyName, key } = selector as { objectType: string; id?: IndexValue; keyName?: string; key?: IndexValue };
  if (keyName !== undefined || key !== undefined) {
    if (typeof keyName !== "string" || !isIndexValue(key)) {
      throw new TypeError(`eventKey: selector for "${objectType}" needs both keyName and key`);
    }
    return `${objectType}/${keyName}/${String(key)}`;
  }
  if (id !== undefined) return `${objectType}/${String(id)}`;
  if ("id" in selector || "key" in selector || "keyName" in selector) {
    throw new TypeError(`eventKey: selector for "${objectType}" has an undefined id; use { objectType } for the bucket`);
  }
  return objectType;
}

type Target = Set<Entry<DataEventBatch>>;

/** All subscriptions for one objectType, by shape. Ids and values are keyed by their string form. */
interface TypeIndex {
  bucket: Target;
  ids: Map<string, Target>;
  fks: Map<string, Map<string, Target>>;
}

interface Pending {
  key: string;
  objectType: string;
  /** canonical id → id as first seen */
  ids: Map<string, IndexValue>;
}

export class DataEventHandler {
  private readonly types = new Map<string, TypeIndex>();
  /** Queued changes per subscription target, in first-touched order. */
  private pending = new Map<Target, Pending>();
  private flushScheduled = false;
  private flushing = false;
  private flushRequested = false;

  constructor(private readonly onListenerError: ListenerErrorHandler = defaultErrorHandler) {}

  /** Subscribes to a selector (bucket, object, or foreign-key value). Each call is its own subscription. */
  subscribe(selector: DataEventSelector, listener: DataEventListener): Unsubscribe {
    eventKey(selector); // validates
    const entry: Entry<DataEventBatch> = { listener };
    const target = this.targetFor(selector, true)!;
    target.add(entry);
    return () => {
      if (!target.delete(entry)) return; // already unsubscribed
      if (target.size === 0) this.prune(selector);
    };
  }

  /**
   * Records a change. Nothing is delivered synchronously: changes accumulate
   * per subscription target until the next microtask, then each target's
   * listeners are called once.
   */
  broadcast(input: BroadcastInput): void {
    const type = this.types.get(input.objectType);
    if (!type) return; // nobody listens to this type: do nothing at all

    const { objectType, objects, index = "id", foreignKeys = [] } = input;
    const previousById = input.action === "update" && foreignKeys.length > 0 ? indexById(input.previous, index) : undefined;
    let enqueued = false;

    for (const object of objects) {
      const id = object[index];
      if (!isIndexValue(id)) continue;
      const canon = String(id);

      if (type.bucket.size > 0) enqueued = this.enqueue(type.bucket, objectType, objectType, id) || enqueued;

      const byId = type.ids.get(canon);
      if (byId) enqueued = this.enqueue(byId, `${objectType}/${canon}`, objectType, id) || enqueued;

      if (type.fks.size > 0) {
        const before = previousById?.get(canon);
        for (const fk of foreignKeys) {
          const values = type.fks.get(fk);
          if (!values) continue; // nobody watches this foreign key on this type: never read it
          enqueued = this.enqueueForeignKey(values, objectType, fk, id, object, before) || enqueued;
        }
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

  /** Number of listeners for a selector (or in total). Mostly for tests and diagnostics. */
  listenerCount(selector?: DataEventSelector): number {
    if (selector) return this.targetFor(selector, false)?.size ?? 0;
    let total = 0;
    for (const type of this.types.values()) {
      total += type.bucket.size;
      for (const t of type.ids.values()) total += t.size;
      for (const values of type.fks.values()) for (const t of values.values()) total += t.size;
    }
    return total;
  }

  /** Labels of the subscription targets with changes not yet delivered. */
  get pendingKeys(): string[] {
    return [...this.pending.values()].map((p) => p.key);
  }

  // ---- internals ----------------------------------------------------------

  private targetFor(selector: DataEventSelector, create: boolean): Target | undefined {
    let type = this.types.get(selector.objectType);
    if (!type) {
      if (!create) return undefined;
      this.types.set(selector.objectType, (type = { bucket: new Set(), ids: new Map(), fks: new Map() }));
    }
    if ("keyName" in selector && selector.keyName !== undefined) {
      let values = type.fks.get(selector.keyName);
      if (!values) {
        if (!create) return undefined;
        type.fks.set(selector.keyName, (values = new Map()));
      }
      return getOrCreate(values, String(selector.key), create);
    }
    if ("id" in selector && selector.id !== undefined) return getOrCreate(type.ids, String(selector.id), create);
    return type.bucket;
  }

  /** Drops empty containers after the last unsubscribe so `types` stays small. */
  private prune(selector: DataEventSelector): void {
    const type = this.types.get(selector.objectType);
    if (!type) return;
    if ("keyName" in selector && selector.keyName !== undefined) {
      const values = type.fks.get(selector.keyName);
      if (values?.get(String(selector.key))?.size === 0) values.delete(String(selector.key));
      if (values?.size === 0) type.fks.delete(selector.keyName);
    } else if ("id" in selector && selector.id !== undefined) {
      if (type.ids.get(String(selector.id))?.size === 0) type.ids.delete(String(selector.id));
    }
    if (type.bucket.size === 0 && type.ids.size === 0 && type.fks.size === 0) this.types.delete(selector.objectType);
  }

  /**
   * Notifies the bucket the object is in now (or, for a partial update
   * missing the field, the bucket `previous` says it is in) and — when the
   * value changed — the bucket it left.
   */
  private enqueueForeignKey(values: Map<string, Target>, objectType: string, fk: string, id: IndexValue, object: Row, before: Row | undefined): boolean {
    const present = fk in object;
    const current = present ? object[fk] : before?.[fk];
    let enqueued = false;

    if (isIndexValue(current)) {
      const target = values.get(String(current));
      if (target) enqueued = this.enqueue(target, `${objectType}/${fk}/${String(current)}`, objectType, id) || enqueued;
    }
    if (present && before !== undefined) {
      const old = before[fk];
      if (isIndexValue(old) && (!isIndexValue(current) || String(old) !== String(current))) {
        const target = values.get(String(old));
        if (target) enqueued = this.enqueue(target, `${objectType}/${fk}/${String(old)}`, objectType, id) || enqueued;
      }
    }
    return enqueued;
  }

  private enqueue(target: Target, key: string, objectType: string, id: IndexValue): boolean {
    let entry = this.pending.get(target);
    if (!entry) this.pending.set(target, (entry = { key, objectType, ids: new Map() }));
    const canon = String(id);
    if (!entry.ids.has(canon)) entry.ids.set(canon, id);
    return true;
  }

  private deliverPending(): void {
    if (this.pending.size === 0) return;

    // Snapshot and reset first: a listener may broadcast again, which must
    // start a fresh batch delivered after this one.
    const batches = this.pending;
    this.pending = new Map();

    for (const [target, entry] of batches) {
      if (target.size === 0) continue;
      const batch: DataEventBatch = Object.freeze({
        key: entry.key,
        objectType: entry.objectType,
        ids: Object.freeze([...entry.ids.values()]),
      });
      deliver(target, batch, this.onListenerError, { key: entry.key });
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      if (this.flushScheduled) this.flush();
    });
  }
}

function getOrCreate(map: Map<string, Target>, key: string, create: boolean): Target | undefined {
  let target = map.get(key);
  if (!target && create) map.set(key, (target = new Set()));
  return target;
}

function indexById(objects: readonly Row[], index: string): Map<string, Row> {
  const map = new Map<string, Row>();
  for (const object of objects) {
    const id = object[index];
    if (isIndexValue(id)) map.set(String(id), object);
  }
  return map;
}

function isIndexValue(value: unknown): value is IndexValue {
  return typeof value === "number" || typeof value === "string";
}
