import { describe, expect, mock, test } from "bun:test";
import { DataEventHandler, EventHandler, eventKey, type DataEventBatch } from "./EventHandler";

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

  test("delivery uses a snapshot: (un)subscribing during emit affects the next emit only", () => {
    const bus = new EventHandler<void>();
    const calls: string[] = [];
    let offB: () => void = () => {};
    bus.subscribe(() => {
      calls.push("a");
      offB(); // removes a LATER listener mid-delivery
      bus.subscribe(() => calls.push("c")); // adds one mid-delivery
    });
    offB = bus.subscribe(() => calls.push("b"));

    bus.emit();
    // b was still delivered this time (snapshot), c was not yet
    expect(calls).toEqual(["a", "b"]);

    calls.length = 0;
    bus.emit();
    // now b is gone and one c is present (plus a subscribes another c each emit)
    expect(calls).toEqual(["a", "c"]);
  });
});

describe("eventKey", () => {
  test("three key shapes", () => {
    expect(eventKey({ objectType: "tasks" })).toBe("tasks");
    expect(eventKey({ objectType: "tasks", id: 7 })).toBe("tasks/7");
    expect(eventKey({ objectType: "tasks", id: "abc" })).toBe("tasks/abc");
    expect(eventKey({ objectType: "tasks", keyName: "project_id", key: 42 })).toBe("tasks/project_id/42");
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
    expect(bus.pendingKeys).toEqual(["tasks", "tasks/1", "tasks/project_id/1", "tasks/assignee_id/1", "tasks/2", "tasks/3"]);

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

  test("several writes before the flush are merged into one batch per key, deduplicating ids and collecting actions", async () => {
    const bus = new DataEventHandler();
    const batches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "tasks" }, (b) => batches.push(b));
    bus.subscribe({ objectType: "tasks", id: 1 }, (b) => batches.push(b));

    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }, { id: 2 }] });
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 1 }] });
    bus.broadcast({ objectType: "tasks", action: "remove", objects: [{ id: 2 }] });
    await tick();

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual({ key: "tasks", objectType: "tasks", actions: ["add", "update", "remove"], ids: [1, 2] });
    expect(batches[1]).toEqual({ key: "tasks/1", objectType: "tasks", actions: ["add", "update"], ids: [1] });
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

  test("delivery uses a snapshot of a key's listeners", async () => {
    const bus = new DataEventHandler();
    const calls: string[] = [];
    let offB: () => void = () => {};
    bus.subscribe({ objectType: "tasks" }, () => {
      calls.push("a");
      offB();
      bus.subscribe({ objectType: "tasks" }, () => calls.push("c"));
    });
    offB = bus.subscribe({ objectType: "tasks" }, () => calls.push("b"));

    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }] });
    await tick();
    expect(calls).toEqual(["a", "b"]);

    calls.length = 0;
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 2 }] });
    await tick();
    expect(calls).toEqual(["a", "c"]);
  });

  test("PR #5 review: reassigning a foreign key notifies the OLD bucket too when `previous` is passed", async () => {
    const bus = new DataEventHandler();
    const batches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 1 }, (b) => batches.push(b));
    bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 2 }, (b) => batches.push(b));

    // without previous: only the new bucket hears (the gap the review found)
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 7, assignee_id: 2 }], foreignKeys: ["assignee_id"] });
    await tick();
    expect(batches.map((b) => b.key)).toEqual(["tasks/assignee_id/2"]);

    // with previous: both buckets hear, each with the object's id and the update action
    batches.length = 0;
    bus.broadcast({
      objectType: "tasks",
      action: "update",
      objects: [{ id: 7, assignee_id: 2 }],
      previous: [{ id: 7, assignee_id: 1 }],
      foreignKeys: ["assignee_id"],
    });
    await tick();
    expect(batches.map((b) => b.key).sort()).toEqual(["tasks/assignee_id/1", "tasks/assignee_id/2"]);
    for (const b of batches) expect(b).toMatchObject({ objectType: "tasks", actions: ["update"], ids: [7] });
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

  test("`previous` only adds foreign-key keys; an unchanged FK is deduplicated, and previous alone never adds type/id keys", async () => {
    const bus = new DataEventHandler();
    const keys: string[] = [];
    bus.subscribeKey("tasks", (b) => keys.push(b.key));
    bus.subscribeKey("tasks/7", (b) => keys.push(b.key));
    bus.subscribeKey("tasks/project_id/1", (b) => keys.push(`${b.key}:${b.ids.join(",")}`));

    bus.broadcast({
      objectType: "tasks",
      action: "update",
      objects: [{ id: 7, project_id: 1, title: "b" }],
      previous: [{ id: 7, project_id: 1, title: "a" }],
      foreignKeys: ["project_id"],
    });
    await tick();
    expect(keys).toEqual(["tasks", "tasks/7", "tasks/project_id/1:7"]); // one delivery, not two

    keys.length = 0;
    bus.broadcast({ objectType: "tasks", action: "update", objects: [], previous: [{ id: 9, project_id: 1 }], foreignKeys: ["project_id"] });
    await tick();
    expect(keys).toEqual(["tasks/project_id/1:9"]); // old bucket only; no "tasks" or "tasks/9"
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
});
