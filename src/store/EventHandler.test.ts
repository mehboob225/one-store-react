import { describe, expect, mock, test } from "bun:test";
import { DataEventHandler, EventHandler, eventKey, fkKey, idKey, keySegment, type DataEventBatch } from "./EventHandler";

const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe("EventHandler", () => {
  test("subscribe/emit and unsubscribe", () => {
    const bus = new EventHandler<number>();
    const seen: number[] = [];
    const off = bus.subscribe((n) => seen.push(n));
    bus.emit(1);
    bus.emit(2);
    off();
    bus.emit(3);
    expect(seen).toEqual([1, 2]);
    expect(bus.size).toBe(0);
  });

  test("a throwing listener does not stop the others and is reported", () => {
    const onError = mock(() => {});
    const bus = new EventHandler<string>(onError);
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((s) => seen.push(s));
    bus.emit("x");
    expect(seen).toEqual(["x"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Error);
  });

  test("a listener unsubscribed during delivery is NOT called; one subscribed during delivery waits for the next", () => {
    const bus = new EventHandler<void>();
    const calls: string[] = [];
    let offB: () => void = () => {};
    bus.subscribe(() => {
      calls.push("a");
      offB(); // removes a LATER listener mid-delivery (an unmount cleanup)
      bus.subscribe(() => calls.push("c")); // adds one mid-delivery
    });
    offB = bus.subscribe(() => calls.push("b"));

    bus.emit();
    expect(calls).toEqual(["a"]); // b silenced immediately, c not yet

    calls.length = 0;
    bus.emit();
    expect(calls).toEqual(["a", "c"]);
  });

  test("the same function subscribed twice is two subscriptions (review finding 1)", () => {
    const bus = new EventHandler<number>();
    const seen: number[] = [];
    const shared = (n: number) => seen.push(n);
    const offFirst = bus.subscribe(shared);
    const offSecond = bus.subscribe(shared);
    expect(bus.size).toBe(2);

    bus.emit(1);
    offFirst(); // the first subscriber unmounts…
    bus.emit(2); // …the second still hears
    offSecond();
    bus.emit(3);
    expect(seen).toEqual([1, 1, 2]);
    expect(bus.size).toBe(0);
  });
});

describe("eventKey", () => {
  test("three key shapes", () => {
    expect(eventKey({ objectType: "tasks" })).toBe("tasks");
    expect(eventKey({ objectType: "tasks", id: 7 })).toBe("tasks/7");
    expect(eventKey({ objectType: "tasks", id: "abc" })).toBe("tasks/abc");
    expect(eventKey({ objectType: "tasks", keyName: "project_id", key: 42 })).toBe("tasks/project_id/42");
  });

  test("an undefined id or key throws instead of subscribing to a key that never fires (review finding 2)", () => {
    const maybeId = undefined as number | undefined;
    expect(() => eventKey({ objectType: "tasks", id: maybeId as number })).toThrow(TypeError);
    expect(() => eventKey({ objectType: "tasks", keyName: "project_id", key: maybeId as number })).toThrow(TypeError);
    expect(() => eventKey({ objectType: "tasks", keyName: undefined as unknown as string, key: 1 })).toThrow(TypeError);
    const bus = new DataEventHandler();
    expect(() => bus.subscribe({ objectType: "tasks", id: maybeId as number }, () => {})).toThrow(/undefined id/);
  });

  test("ids and values containing '/' are escaped so key shapes cannot collide (review finding 5)", () => {
    expect(keySegment(7)).toBe("7");
    expect(keySegment("plain")).toBe("plain");
    expect(keySegment("project_id/42")).toBe("project_id%2F42");
    expect(keySegment("a%2Fb")).toBe("a%252Fb"); // escaping is reversible: '%' is escaped first
    expect(eventKey({ objectType: "tasks", id: "project_id/42" })).toBe("tasks/project_id%2F42");
    expect(eventKey({ objectType: "tasks", id: "project_id/42" })).not.toBe(
      eventKey({ objectType: "tasks", keyName: "project_id", key: 42 }),
    );
    expect(eventKey({ objectType: "tasks", keyName: "path", key: "a/b" })).toBe("tasks/path/a%2Fb");
  });
});

describe("DataEventHandler", () => {
  const tasks = (n: number, projectId = 1) =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, project_id: projectId, assignee_id: i % 2 === 0 ? 1 : null }));

  test("a write emits type, type/id and type/fk/value keys, delivered in a microtask", async () => {
    const bus = new DataEventHandler();
    const received: string[] = [];
    bus.subscribe({ objectType: "tasks" }, (b) => received.push(b.key));
    bus.subscribe({ objectType: "tasks", id: 2 }, (b) => received.push(b.key));
    bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, (b) => received.push(b.key));
    bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 1 }, (b) => received.push(b.key));

    bus.broadcast({ objectType: "tasks", action: "add", objects: tasks(3), foreignKeys: ["project_id", "assignee_id"] });
    expect(received).toEqual([]); // nothing synchronous
    // only keys somebody listens to are queued (tasks/1, tasks/3 are not)
    expect(bus.pendingKeys).toEqual(["tasks", "tasks/project_id/1", "tasks/assignee_id/1", "tasks/2"]);

    await tick();
    expect(received).toEqual(["tasks", "tasks/project_id/1", "tasks/assignee_id/1", "tasks/2"]);
    expect(bus.pendingKeys).toEqual([]);
  });

  test("500 objects in one write → exactly one callback per subscription, carrying all ids", async () => {
    const bus = new DataEventHandler();
    const all = mock((_b: DataEventBatch) => {});
    const byProject = mock((_b: DataEventBatch) => {});
    bus.subscribe({ objectType: "tasks" }, all);
    bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, byProject);

    bus.broadcast({ objectType: "tasks", action: "add", objects: tasks(500), foreignKeys: ["project_id"] });
    await tick();

    expect(all).toHaveBeenCalledTimes(1);
    expect(byProject).toHaveBeenCalledTimes(1);
    const batch = (all.mock.calls[0] as [DataEventBatch])[0];
    expect(batch.ids).toHaveLength(500);
    expect(batch.actions).toEqual(["add"]);
  });

  test("several writes before the flush merge into one batch per key with NET actions per id (review 2, finding 3)", async () => {
    const bus = new DataEventHandler();
    const batches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "tasks" }, (b) => batches.push(b));
    bus.subscribe({ objectType: "tasks", id: 1 }, (b) => batches.push(b));

    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }, { id: 2 }] });
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 1 }] }); // add+update → still new
    bus.broadcast({ objectType: "tasks", action: "remove", objects: [{ id: 2 }] }); // add+remove → cancels out
    await tick();

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual({ key: "tasks", objectType: "tasks", changes: [{ id: 1, action: "add" }], ids: [1], actions: ["add"] });
    expect(batches[1]).toEqual({ key: "tasks/1", objectType: "tasks", changes: [{ id: 1, action: "add" }], ids: [1], actions: ["add"] });
  });

  test("a batch whose ids all cancelled out is not delivered", async () => {
    const bus = new DataEventHandler();
    const seen = mock(() => {});
    bus.subscribe({ objectType: "tasks" }, seen);
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 9 }] });
    bus.broadcast({ objectType: "tasks", action: "remove", objects: [{ id: 9 }] });
    await tick();
    expect(seen).not.toHaveBeenCalled();
  });

  test("the optimistic-create case: add then update in one tick still reports `add`", async () => {
    const bus = new DataEventHandler();
    const batches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, (b) => batches.push(b));
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 9, project_id: 1 }], foreignKeys: ["project_id"] });
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 9, project_id: 1 }], foreignKeys: ["project_id"] });
    await tick();
    expect(batches[0]!.changes).toEqual([{ id: 9, action: "add" }]);
  });

  test("remove → add → remove within one tick reports the final state: removed (review finding 3)", async () => {
    const bus = new DataEventHandler();
    const batches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "tasks", id: 7 }, (b) => batches.push(b));
    bus.broadcast({ objectType: "tasks", action: "remove", objects: [{ id: 7 }] });
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 7 }] });
    bus.broadcast({ objectType: "tasks", action: "remove", objects: [{ id: 7 }] });
    await tick();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.changes).toEqual([{ id: 7, action: "remove" }]);
    expect(batches[0]!.actions).toEqual(["remove"]);
  });

  test("foreign-key keys are emitted only for declared FKs and only for present values", async () => {
    const bus = new DataEventHandler();
    const keys: string[] = [];
    for (const k of ["tasks/project_id/1", "tasks/assignee_id/1", "tasks/assignee_id/null", "tasks/assignee_id/undefined"]) {
      bus.subscribeKey(k, (b) => keys.push(b.key));
    }
    bus.broadcast({
      objectType: "tasks",
      action: "add",
      objects: [{ id: 1, project_id: 1, assignee_id: 1 }, { id: 2, project_id: 1, assignee_id: null }, { id: 3, project_id: 1 }],
      foreignKeys: ["project_id"], // assignee_id NOT declared
    });
    await tick();
    expect(keys).toEqual(["tasks/project_id/1"]);

    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 2, assignee_id: null }, { id: 3 }], foreignKeys: ["assignee_id"] });
    await tick();
    expect(keys).toEqual(["tasks/project_id/1"]); // null/undefined values never produce a key
  });

  test("a custom index field is honoured and objects without an index value are skipped", async () => {
    const bus = new DataEventHandler();
    const ids: unknown[] = [];
    bus.subscribe({ objectType: "task_tags" }, (b) => ids.push(...b.ids));
    bus.broadcast({ objectType: "task_tags", action: "add", index: "composite_id", objects: [{ composite_id: "1-2" }, { composite_id: "1-3" }, { nope: 1 }] });
    await tick();
    expect(ids).toEqual(["1-2", "1-3"]);
  });

  test("unsubscribe stops delivery, including for a batch already pending", async () => {
    const bus = new DataEventHandler();
    const seen = mock(() => {});
    const off = bus.subscribe({ objectType: "tasks" }, seen);
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }] });
    off();
    await tick();
    expect(seen).not.toHaveBeenCalled();
    expect(bus.listenerCount("tasks")).toBe(0);
    expect(bus.listenerCount()).toBe(0);
  });

  test("flush ordering: keys are delivered in first-seen order; a broadcast from inside a listener starts a new batch", async () => {
    const bus = new DataEventHandler();
    const order: string[] = [];
    const bBatches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "b" }, (x) => {
      order.push(`b:${x.ids.join(",")}`);
      bBatches.push(x);
    });
    bus.subscribe({ objectType: "a" }, (x) => {
      order.push(`a:${x.ids.join(",")}`);
      // issued while "b" (id 2) is still pending in the batch being flushed
      if (x.ids.includes(1)) bus.broadcast({ objectType: "b", action: "update", objects: [{ id: 99 }] });
    });

    bus.broadcast({ objectType: "a", action: "add", objects: [{ id: 1 }] });
    bus.broadcast({ objectType: "b", action: "add", objects: [{ id: 2 }] });
    await tick();
    await tick();

    // "a" before "b" (first-seen order), and the nested write was NOT merged
    // into the pending "b" batch: it arrived as a separate, later delivery.
    expect(order).toEqual(["a:1", "b:2", "b:99"]);
    expect(bBatches.map((b) => b.ids)).toEqual([[2], [99]]);
    expect(bBatches.map((b) => b.actions)).toEqual([["add"], ["update"]]);
  });

  test("flush() delivers synchronously and the scheduled microtask becomes a no-op", async () => {
    const bus = new DataEventHandler();
    const seen = mock(() => {});
    bus.subscribe({ objectType: "tasks" }, seen);
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }] });
    bus.flush();
    expect(seen).toHaveBeenCalledTimes(1);
    await tick();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  test("a listener that throws is reported and does not block other keys or listeners", async () => {
    const onError = mock(() => {});
    const bus = new DataEventHandler(onError);
    const seen: string[] = [];
    bus.subscribe({ objectType: "tasks" }, () => {
      throw new Error("boom");
    });
    bus.subscribe({ objectType: "tasks" }, (b) => seen.push(b.key));
    bus.subscribe({ objectType: "tasks", id: 1 }, (b) => seen.push(b.key));
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }] });
    await tick();
    expect(seen).toEqual(["tasks", "tasks/1"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0] as unknown[])[1]).toEqual({ key: "tasks" });
  });

  test("a listener unsubscribed during a flush is NOT called, even for the same key (review finding 6)", async () => {
    const bus = new DataEventHandler();
    const calls: string[] = [];
    let offB: () => void = () => {};
    bus.subscribe({ objectType: "tasks" }, () => {
      calls.push("a");
      offB(); // e.g. a React commit unmounts the component that owns "b"
      bus.subscribe({ objectType: "tasks" }, () => calls.push("c"));
    });
    offB = bus.subscribe({ objectType: "tasks" }, () => calls.push("b"));

    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }] });
    await tick();
    expect(calls).toEqual(["a"]);

    calls.length = 0;
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 2 }] });
    await tick();
    expect(calls).toEqual(["a", "c"]);
  });

  test("the same function subscribed twice to one key is two subscriptions (review finding 1)", async () => {
    const bus = new DataEventHandler();
    const seen: string[] = [];
    const shared = (b: DataEventBatch) => seen.push(b.key);
    const offFirst = bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, shared);
    bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, shared);
    expect(bus.listenerCount("tasks/project_id/1")).toBe(2);

    offFirst();
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1, project_id: 1 }], foreignKeys: ["project_id"] });
    await tick();
    expect(seen).toEqual(["tasks/project_id/1"]); // the second subscriber still hears
  });

  test("a flush() requested from inside a listener runs after the current flush, preserving order (review finding 7)", async () => {
    const bus = new DataEventHandler();
    const bBatches: number[][] = [];
    bus.subscribe({ objectType: "b" }, (x) => bBatches.push(x.ids as number[]));
    bus.subscribe({ objectType: "a" }, () => {
      bus.broadcast({ objectType: "b", action: "update", objects: [{ id: 99 }] });
      bus.flush(); // "read your own write": must not jump the queue
    });

    bus.broadcast({ objectType: "a", action: "add", objects: [{ id: 1 }] });
    bus.broadcast({ objectType: "b", action: "add", objects: [{ id: 2 }] });
    bus.flush();

    // the older pending "b" batch (id 2) is delivered before the nested one (id 99),
    // and both were delivered synchronously by the outer flush()
    expect(bBatches).toEqual([[2], [99]]);
    await tick();
    expect(bBatches).toEqual([[2], [99]]); // nothing left for the microtask
  });

  test("keys nobody listens to are never queued; a subscription only sees later broadcasts (review finding 8)", async () => {
    const bus = new DataEventHandler();
    bus.broadcast({ objectType: "tasks", action: "add", objects: tasks(500), foreignKeys: ["project_id"] });
    expect(bus.pendingKeys).toEqual([]); // no listeners at all: nothing queued, nothing scheduled

    const seen = mock(() => {});
    bus.subscribe({ objectType: "tasks" }, seen);
    bus.broadcast({ objectType: "tasks", action: "add", objects: tasks(500), foreignKeys: ["project_id"] });
    expect(bus.pendingKeys).toEqual(["tasks"]); // not 500 "tasks/<id>" entries

    const late = mock(() => {});
    bus.subscribe({ objectType: "tasks", id: 1 }, late); // subscribed after the broadcast, before the flush
    await tick();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
  });

  test("reassigning a foreign key: the old bucket hears `remove`, the new bucket hears `add` (review 2, finding 4)", async () => {
    const bus = new DataEventHandler();
    const batches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 1 }, (b) => batches.push(b));
    bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 2 }, (b) => batches.push(b));

    // without previous: only the new bucket hears, with the write's own action (the gap the first review found)
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 7, assignee_id: 2 }], foreignKeys: ["assignee_id"] });
    await tick();
    expect(batches.map((b) => [b.key, b.changes])).toEqual([["tasks/assignee_id/2", [{ id: 7, action: "update" }]]]);

    // with previous: bucket-relative actions
    batches.length = 0;
    bus.broadcast({
      objectType: "tasks",
      action: "update",
      objects: [{ id: 7, assignee_id: 2 }],
      previous: [{ id: 7, assignee_id: 1 }],
      foreignKeys: ["assignee_id"],
    });
    await tick();
    const byKey = Object.fromEntries(batches.map((b) => [b.key, b.changes]));
    expect(byKey).toEqual({
      "tasks/assignee_id/2": [{ id: 7, action: "add" }],
      "tasks/assignee_id/1": [{ id: 7, action: "remove" }],
    });
  });

  test("foreign key set from null, and cleared to null, are `add` and `remove` for the one bucket involved", async () => {
    const bus = new DataEventHandler();
    const batches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 1 }, (b) => batches.push(b));

    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 7, assignee_id: 1 }], previous: [{ id: 7, assignee_id: null }], foreignKeys: ["assignee_id"] });
    await tick();
    expect(batches.map((b) => b.changes)).toEqual([[{ id: 7, action: "add" }]]);

    batches.length = 0;
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 7, assignee_id: null }], previous: [{ id: 7, assignee_id: 1 }], foreignKeys: ["assignee_id"] });
    await tick();
    expect(batches.map((b) => b.changes)).toEqual([[{ id: 7, action: "remove" }]]);
  });

  test("PR #5 review: a remove broadcast with the stored object notifies the foreign-key bucket", async () => {
    const bus = new DataEventHandler();
    const keys: string[] = [];
    bus.subscribe({ objectType: "tasks" }, (b) => keys.push(b.key));
    bus.subscribe({ objectType: "tasks", id: 7 }, (b) => keys.push(b.key));
    bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 42 }, (b) => keys.push(b.key));

    // id-only stub (what the server's delete push carries): the project bucket is NOT told
    bus.broadcast({ objectType: "tasks", action: "remove", objects: [{ id: 7 }], foreignKeys: ["project_id"] });
    await tick();
    expect(keys).toEqual(["tasks", "tasks/7"]);

    // the stored copy (what the cache must pass): the project bucket hears the remove
    keys.length = 0;
    bus.broadcast({ objectType: "tasks", action: "remove", objects: [{ id: 7, project_id: 42 }], foreignKeys: ["project_id"] });
    await tick();
    expect(keys).toEqual(["tasks", "tasks/7", "tasks/project_id/42"]);
  });

  test("`previous` is matched by id: an unchanged FK yields one delivery with the write's action; unmatched entries are ignored (review 2, finding 7)", async () => {
    const bus = new DataEventHandler();
    const keys: string[] = [];
    bus.subscribeKey("tasks", (b) => keys.push(b.key));
    bus.subscribeKey("tasks/7", (b) => keys.push(b.key));
    bus.subscribeKey("tasks/project_id/1", (b) => keys.push(`${b.key}:${b.changes.map((c) => `${c.id}=${c.action}`).join(",")}`));

    bus.broadcast({
      objectType: "tasks",
      action: "update",
      objects: [{ id: 7, project_id: 1, title: "b" }],
      previous: [{ id: 7, project_id: 1, title: "a" }],
      foreignKeys: ["project_id"],
    });
    await tick();
    expect(keys).toEqual(["tasks", "tasks/7", "tasks/project_id/1:7=update"]);

    // a whole-bucket snapshot as previous: ids not in `objects` produce nothing
    keys.length = 0;
    bus.broadcast({
      objectType: "tasks",
      action: "update",
      objects: [{ id: 7, project_id: 1 }],
      previous: [{ id: 7, project_id: 1 }, { id: 8, project_id: 1 }, { id: 9, project_id: 1 }],
      foreignKeys: ["project_id"],
    });
    await tick();
    expect(keys).toEqual(["tasks", "tasks/7", "tasks/project_id/1:7=update"]);
  });

  test("a throwing onListenerError handler does not escape delivery", () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const bus = new EventHandler<void>(() => {
        throw new Error("handler broke");
      });
      const seen: string[] = [];
      bus.subscribe(() => {
        throw new Error("listener broke");
      });
      bus.subscribe(() => seen.push("ok"));
      expect(() => bus.emit()).not.toThrow();
      expect(seen).toEqual(["ok"]);
      expect(errors).toHaveLength(2); // the listener error (fallback) + the handler error
    } finally {
      console.error = original;
    }
  });

  test("empty writes and keys without listeners cost nothing", async () => {
    const bus = new DataEventHandler();
    bus.broadcast({ objectType: "tasks", action: "add", objects: [] });
    expect(bus.pendingKeys).toEqual([]);
    // objects without an index value enqueue nothing and schedule nothing
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ nope: 1 }] });
    expect(bus.pendingKeys).toEqual([]);
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }] });
    await tick();
    expect(bus.pendingKeys).toEqual([]);
  });

  test("a subscriber never receives changes queued before it subscribed, even when another listener already queued the key (review 2, finding 1)", async () => {
    const bus = new DataEventHandler();
    const early = mock(() => {});
    const late = mock(() => {});
    bus.subscribe({ objectType: "tasks", id: 1 }, early); // makes "tasks/1" a queued key
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 1 }] });
    bus.subscribe({ objectType: "tasks", id: 1 }, late); // same tick, after the change
    await tick();
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();

    // but a change broadcast after it subscribed, merged into the same batch, does reach it
    const later = mock(() => {});
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 1 }] });
    bus.subscribe({ objectType: "tasks", id: 1 }, later);
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 1 }] });
    await tick();
    expect(later).toHaveBeenCalledTimes(1);
  });

  test("StrictMode-style unsubscribe/resubscribe between a broadcast and its flush does not replay the change", async () => {
    const bus = new DataEventHandler();
    const other = mock(() => {});
    const seen = mock(() => {});
    bus.subscribe({ objectType: "tasks" }, other);
    const off = bus.subscribe({ objectType: "tasks" }, seen);
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 1 }] });
    off();
    bus.subscribe({ objectType: "tasks" }, seen); // remount
    await tick();
    expect(other).toHaveBeenCalledTimes(1);
    expect(seen).not.toHaveBeenCalled();
  });

  test("a listener subscribed during a flush to a LATER key in that flush is not called (review 2, finding 2)", async () => {
    const bus = new DataEventHandler();
    const child = mock(() => {});
    bus.subscribe({ objectType: "tasks", id: 7 }, () => {}); // "tasks/7" is already a queued key
    bus.subscribe({ objectType: "tasks" }, () => {
      bus.subscribe({ objectType: "tasks", id: 7 }, child); // parent listener mounts a child
    });
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 7 }] });
    await tick();
    expect(child).not.toHaveBeenCalled();

    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 7 }] });
    await tick();
    expect(child).toHaveBeenCalledTimes(1);
  });

  test("numeric and string forms of an id are one change entry (review 2, finding 5)", async () => {
    const bus = new DataEventHandler();
    const batches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "tasks", id: 7 }, (b) => batches.push(b));
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 7 }] });
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: "7" }] }); // e.g. a push payload
    await tick();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.changes).toEqual([{ id: 7, action: "add" }]); // first-seen form, net action
  });

  test("objectType and keyName segments are escaped too, so no shape can collide (review 2, finding 6)", async () => {
    expect(idKey("tasks/project_id", 42)).toBe("tasks%2Fproject_id/42");
    expect(fkKey("tasks", "project_id", 42)).toBe("tasks/project_id/42");
    expect(idKey("tasks/project_id", 42)).not.toBe(fkKey("tasks", "project_id", 42));
    expect(fkKey("tasks", "a/b", 1)).toBe("tasks/a%2Fb/1");

    const bus = new DataEventHandler();
    const wrong = mock(() => {});
    const right = mock(() => {});
    bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 42 }, wrong);
    bus.subscribe({ objectType: "tasks/project_id", id: 42 }, right);
    bus.broadcast({ objectType: "tasks/project_id", action: "update", objects: [{ id: 42 }] });
    await tick();
    expect(wrong).not.toHaveBeenCalled();
    expect(right).toHaveBeenCalledTimes(1);
  });

  test("subscribe and broadcast build keys through the same helpers (review 2, finding 8)", async () => {
    const bus = new DataEventHandler();
    const seen: string[] = [];
    bus.subscribe({ objectType: "odd/type", id: "a/b" }, (b) => seen.push(b.key));
    bus.subscribe({ objectType: "odd/type", keyName: "x/y", key: "1/2" }, (b) => seen.push(b.key));
    bus.broadcast({ objectType: "odd/type", action: "add", objects: [{ id: "a/b", "x/y": "1/2" }], foreignKeys: ["x/y"] });
    await tick();
    expect(seen).toEqual([idKey("odd/type", "a/b"), fkKey("odd/type", "x/y", "1/2")]);
  });

  test("per-id and per-FK keys are not even built when no listener of that shape exists for the type (review 2, finding 9)", async () => {
    const bus = new DataEventHandler();
    let fkReads = 0;
    const object = new Proxy({ id: 1, project_id: 1 } as Record<string, unknown>, {
      get(target, prop, receiver) {
        if (prop === "project_id") fkReads++;
        return Reflect.get(target, prop, receiver);
      },
    });

    // no listeners at all: nothing is read
    bus.broadcast({ objectType: "tasks", action: "add", objects: [object], foreignKeys: ["project_id"] });
    expect(fkReads).toBe(0);

    // a bucket listener only: the FK field is still never read
    bus.subscribe({ objectType: "tasks" }, () => {});
    bus.broadcast({ objectType: "tasks", action: "add", objects: [object], foreignKeys: ["project_id"] });
    expect(fkReads).toBe(0);

    // an FK listener on another value of the same type: the field must be read to know
    const off = bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 999 }, () => {});
    bus.broadcast({ objectType: "tasks", action: "add", objects: [object], foreignKeys: ["project_id"] });
    expect(fkReads).toBe(1);

    // and after it unsubscribes the count drops back to zero
    off();
    bus.broadcast({ objectType: "tasks", action: "add", objects: [object], foreignKeys: ["project_id"] });
    expect(fkReads).toBe(1);
    await tick();
  });
});
