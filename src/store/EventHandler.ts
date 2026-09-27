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
 *    500-object write produces ONE callback per subscription, carrying the
 *    ids and actions that were batched into it. Nothing here consults the
 *    schema: the cache (step 7) passes the index field and foreign-key names
 *    from ModelDefinitions.
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

export class EventHandler<T> {
  private readonly listeners = new Set<(payload: T) => void>();

  constructor(private readonly onListenerError: ListenerErrorHandler = defaultErrorHandler) {}

  /** Adds a listener. Returns the function that removes it. */
  subscribe(listener: (payload: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Calls every listener synchronously. A throwing listener does not stop the others. */
  emit(payload: T): void {
    // Deliberate copy, not iteration of the live Set: a listener may subscribe
    // or unsubscribe others during emit, and this delivery must be unaffected.
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) {
      try {
        listener(payload);
      } catch (error) {
        report(this.onListenerError, error, {});
      }
    }
  }

  get size(): number {
    return this.listeners.size;
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

/** One flushed batch for one key. */
export interface DataEventBatch {
  key: string;
  objectType: string;
  /** Actions seen in this batch, in first-seen order. */
  actions: DataAction[];
  /** Ids of the objects in this batch, deduplicated, in first-seen order. */
  ids: IndexValue[];
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

/** Builds the string key for a selector. */
export function eventKey(selector: DataEventSelector): string {
  if ("keyName" in selector) return `${selector.objectType}/${selector.keyName}/${String(selector.key)}`;
  if ("id" in selector) return `${selector.objectType}/${String(selector.id)}`;
  return selector.objectType;
}

interface Pending {
  objectType: string;
  actions: Set<DataAction>;
  ids: Set<IndexValue>;
}

export class DataEventHandler {
  private readonly listeners = new Map<string, Set<DataEventListener>>();
  private pending = new Map<string, Pending>();
  private flushScheduled = false;

  constructor(private readonly onListenerError: ListenerErrorHandler = defaultErrorHandler) {}

  /** Subscribes to a selector (bucket, object, or foreign-key value). */
  subscribe(selector: DataEventSelector, listener: DataEventListener): Unsubscribe {
    return this.subscribeKey(eventKey(selector), listener);
  }

  /** Subscribes to a raw key string. */
  subscribeKey(key: string, listener: DataEventListener): Unsubscribe {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  /**
   * Records a change. Nothing is delivered synchronously: keys accumulate
   * until the next microtask, then each key's listeners are called once.
   */
  broadcast({ objectType, action, objects, previous = [], index = "id", foreignKeys = [] }: BroadcastInput): void {
    let enqueued = false;

    for (const object of objects) {
      const id = object[index];
      if (!isIndexValue(id)) continue;
      enqueued = true;

      this.enqueue(objectType, objectType, action, id);
      this.enqueue(`${objectType}/${String(id)}`, objectType, action, id);
      this.enqueueForeignKeys(objectType, action, id, object, foreignKeys);
    }

    // Old-bucket keys: an object that left a foreign-key bucket must notify it.
    for (const object of previous) {
      const id = object[index];
      if (!isIndexValue(id)) continue;
      enqueued = true;
      this.enqueueForeignKeys(objectType, action, id, object, foreignKeys);
    }

    if (enqueued) this.scheduleFlush();
  }

  /**
   * Delivers everything pending right now, synchronously. Normally the
   * microtask does this; tests and "read your own write" paths may call it.
   */
  flush(): void {
    this.flushScheduled = false;
    if (this.pending.size === 0) return;

    // Snapshot and reset first: a listener may broadcast again, which must
    // start a fresh batch delivered after this one.
    const batches = this.pending;
    this.pending = new Map();

    for (const [key, entry] of batches) {
      const listeners = this.listeners.get(key);
      if (!listeners || listeners.size === 0) continue;
      const batch: DataEventBatch = {
        key,
        objectType: entry.objectType,
        actions: [...entry.actions],
        ids: [...entry.ids],
      };
      // Same deliberate copy as EventHandler.emit: listeners may change the set.
      const snapshot = Array.from(listeners);
      for (const listener of snapshot) {
        try {
          listener(batch);
        } catch (error) {
          report(this.onListenerError, error, { key });
        }
      }
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

  private enqueueForeignKeys(
    objectType: string,
    action: DataAction,
    id: IndexValue,
    object: Record<string, unknown>,
    foreignKeys: readonly string[],
  ): void {
    for (const fk of foreignKeys) {
      const value = object[fk];
      if (isIndexValue(value)) this.enqueue(`${objectType}/${fk}/${String(value)}`, objectType, action, id);
    }
  }

  private enqueue(key: string, objectType: string, action: DataAction, id: IndexValue): void {
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { objectType, actions: new Set(), ids: new Set() };
      this.pending.set(key, entry);
    }
    entry.actions.add(action);
    entry.ids.add(id);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      if (this.flushScheduled) this.flush();
    });
  }
}

function isIndexValue(value: unknown): value is IndexValue {
  return typeof value === "number" || typeof value === "string";
}
