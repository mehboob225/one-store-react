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
 *    so batches are always delivered in the order they were queued;
 *  - a selector that can never fire (undefined/NaN/"" id or key, half a
 *    foreign key) is a bug: `subscribe` reports it through the error handler
 *    and returns a no-op unsubscribe rather than throwing mid-render;
 *    `eventKey` throws, for tests and callers that want the exception.
 */

import { canonicalKey, hasField, isKeyValue, ownField } from "./canonicalKey";

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
function deliver<P>(
  live: ReadonlySet<Entry<P>>,
  payload: P,
  onError: ListenerErrorHandler,
  context: { key?: string },
  snapshot: readonly Entry<P>[] = Array.from(live),
): void {
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
   * A foreign key that is not an own property of the written object (a
   * partial write) is unchanged and its bucket is taken from `previous`; an
   * own `undefined` or `null` means the object has no value there.
   */
  | (BroadcastBase & { action: "update"; objects: readonly Row[]; previous: readonly Row[] })
  /** `objects` must be the STORED objects (with their foreign keys), never id-only stubs. */
  | (BroadcastBase & { action: "remove"; objects: readonly Row[] });

/** A validated selector. Ids and values are in their canonical string form. */
type Resolved =
  | { kind: "bucket"; objectType: string; label: string }
  | { kind: "id"; objectType: string; id: string; label: string }
  | { kind: "fk"; objectType: string; keyName: string; value: string; label: string };

/**
 * The one place a selector's shape is decided. Non-null values decide the
 * shape, so an id selector that also carries `keyName: undefined` is an id
 * selector. Everything that would type-check (or slip in at runtime) and then
 * never fire throws instead: a lone undefined/null discriminator, a non-scalar
 * id or key, half a foreign-key selector, or an id together with a foreign key.
 * Subscribe conditionally instead.
 */
function resolve(selector: DataEventSelector): Resolved {
  const { objectType, id, keyName, key } = selector as { objectType: string; id?: unknown; keyName?: unknown; key?: unknown };
  const hasId = id != null;
  const hasForeignKey = keyName != null || key != null;
  if (hasId && hasForeignKey) {
    throw new TypeError(`eventKey: selector for "${objectType}" has both an id and a foreign key; pick one`);
  }
  if (hasForeignKey) {
    if (typeof keyName !== "string" || !isKeyValue(key)) {
      throw new TypeError(`eventKey: selector for "${objectType}" needs both keyName and key (a finite number or non-empty string)`);
    }
    const value = canonicalKey(key);
    return { kind: "fk", objectType, keyName, value, label: `${objectType}/${keyName}/${value}` };
  }
  if (hasId) {
    if (!isKeyValue(id)) throw new TypeError(`eventKey: selector for "${objectType}" needs a finite number or non-empty string id`);
    const canon = canonicalKey(id);
    return { kind: "id", objectType, id: canon, label: `${objectType}/${canon}` };
  }
  if ("id" in selector || "key" in selector || "keyName" in selector) {
    throw new TypeError(`eventKey: selector for "${objectType}" has an undefined id or key; use { objectType } for the bucket`);
  }
  return { kind: "bucket", objectType, label: objectType };
}

/** Human-readable label for a selector; also validates it (see `resolve`). */
export function eventKey(selector: DataEventSelector): string {
  return resolve(selector).label;
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
    // Resolved once: unsubscribe must not re-read a selector the caller may have mutated since.
    let resolved: Resolved;
    try {
      resolved = resolve(selector);
    } catch (error) {
      // A selector that can never fire (NaN or "" from an unparsed route param, half a foreign
      // key…) is a bug, but not one worth taking a render tree down for: report it loudly through
      // the bus's error handler and hand back a no-op unsubscribe. `eventKey` still throws, for
      // callers that want the exception.
      report(this.onListenerError, error, { key: describeSelector(selector) });
      return () => {};
    }
    const entry: Entry<DataEventBatch> = { listener };
    const target = this.targetFor(resolved, true)!;
    target.add(entry);
    return () => {
      if (!target.delete(entry)) return; // already unsubscribed
      if (target.size === 0) this.prune(resolved);
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
    // Declared foreign keys somebody watches on this type; the others are never read.
    const watchedForeignKeys = foreignKeys.flatMap((fk) => {
      const values = type.fks.get(fk);
      return values ? [{ fk, values }] : [];
    });
    const previousById = input.action === "update" && watchedForeignKeys.length > 0 ? indexById(input.previous, index) : undefined;

    for (const object of objects) {
      const id = ownField(object, index);
      if (!isKeyValue(id)) continue;
      const canon = canonicalKey(id);

      if (type.bucket.size > 0) this.enqueue(type.bucket, objectType, objectType, id);

      const byId = type.ids.get(canon);
      if (byId) this.enqueue(byId, `${objectType}/${canon}`, objectType, id);

      const before = previousById?.get(canon);
      for (const { fk, values } of watchedForeignKeys) this.enqueueForeignKey(values, objectType, fk, id, object, before);
    }
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
    if (selector) return this.targetFor(resolve(selector), false)?.size ?? 0;
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

  private targetFor(resolved: Resolved, create: boolean): Target | undefined {
    let type = this.types.get(resolved.objectType);
    if (!type) {
      if (!create) return undefined;
      type = { bucket: new Set(), ids: new Map(), fks: new Map() };
      this.types.set(resolved.objectType, type);
    }
    switch (resolved.kind) {
      case "bucket":
        return type.bucket;
      case "id":
        return getOrCreate(type.ids, resolved.id, create);
      case "fk": {
        let values = type.fks.get(resolved.keyName);
        if (!values) {
          if (!create) return undefined;
          values = new Map();
          type.fks.set(resolved.keyName, values);
        }
        return getOrCreate(values, resolved.value, create);
      }
    }
  }

  /** Drops empty containers after the last unsubscribe so `types` stays small. */
  private prune(resolved: Resolved): void {
    const type = this.types.get(resolved.objectType);
    if (!type) return;
    if (resolved.kind === "fk") {
      const values = type.fks.get(resolved.keyName);
      if (values?.get(resolved.value)?.size === 0) values.delete(resolved.value);
      if (values?.size === 0) type.fks.delete(resolved.keyName);
    } else if (resolved.kind === "id") {
      if (type.ids.get(resolved.id)?.size === 0) type.ids.delete(resolved.id);
    }
    if (type.bucket.size === 0 && type.ids.size === 0 && type.fks.size === 0) this.types.delete(resolved.objectType);
  }

  /**
   * Notifies the bucket the object is in now (or, when the field is not an
   * own property of the write, the bucket `previous` says it is in) and —
   * when the value changed — the bucket it left.
   */
  private enqueueForeignKey(values: Map<string, Target>, objectType: string, fk: string, id: IndexValue, object: Row, before: Row | undefined): void {
    const present = hasField(object, fk); // own property, whatever its value — the same meaning as the write guard
    const current = present ? object[fk] : ownField(before, fk);
    this.enqueueForeignValue(values, objectType, fk, current, id);

    // Only a field present in the write can have moved the object out of its old bucket.
    const old = present ? ownField(before, fk) : undefined;
    if (isKeyValue(old) && (!isKeyValue(current) || canonicalKey(old) !== canonicalKey(current))) {
      this.enqueueForeignValue(values, objectType, fk, old, id);
    }
  }

  /** Queues `id` for the subscribers of `fk = value`, if `value` is a scalar somebody watches. */
  private enqueueForeignValue(values: Map<string, Target>, objectType: string, fk: string, value: unknown, id: IndexValue): void {
    if (!isKeyValue(value)) return;
    const canon = canonicalKey(value);
    const target = values.get(canon);
    if (target) this.enqueue(target, `${objectType}/${fk}/${canon}`, objectType, id);
  }

  /** Adds `id` to the target's pending batch and makes sure a flush is scheduled. */
  private enqueue(target: Target, key: string, objectType: string, id: IndexValue): void {
    let entry = this.pending.get(target);
    if (!entry) {
      entry = { key, objectType, ids: new Map() };
      this.pending.set(target, entry);
    }
    const canon = canonicalKey(id);
    if (!entry.ids.has(canon)) entry.ids.set(canon, id);
    this.scheduleFlush();
  }

  private deliverPending(): void {
    if (this.pending.size === 0) return;

    // Snapshot and reset first: a listener may broadcast again, which must
    // start a fresh batch delivered after this one.
    const batches = this.pending;
    this.pending = new Map();

    // Snapshot every target's subscriptions before calling anyone: a listener
    // that an earlier target's listener subscribes to a later target must wait
    // for the next pass, like one subscribed to the target being delivered.
    const work = [...batches].map(([target, entry]) => ({ target, entry, snapshot: Array.from(target) }));

    for (const { target, entry, snapshot } of work) {
      if (snapshot.length === 0) continue;
      const batch: DataEventBatch = Object.freeze({
        key: entry.key,
        objectType: entry.objectType,
        ids: Object.freeze([...entry.ids.values()]),
      });
      deliver(target, batch, this.onListenerError, { key: entry.key }, snapshot);
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
  if (!target && create) {
    target = new Set();
    map.set(key, target);
  }
  return target;
}

/** Best-effort label for an invalid selector in an error report. */
function describeSelector(selector: DataEventSelector): string {
  const { objectType, id, keyName, key } = selector as { objectType: string; id?: unknown; keyName?: unknown; key?: unknown };
  return `${objectType}${id !== undefined ? `/${String(id)}` : ""}${keyName !== undefined || key !== undefined ? `/${String(keyName)}/${String(key)}` : ""}`;
}

function indexById(objects: readonly Row[], index: string): Map<string, Row> {
  const map = new Map<string, Row>();
  for (const object of objects) {
    const id = ownField(object, index);
    if (isKeyValue(id)) map.set(canonicalKey(id), object);
  }
  return map;
}

