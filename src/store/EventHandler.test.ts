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
      expect(errors).toHaveLength(2);
    } finally {
      console.error = original;
    }
  });

  test("a listener unsubscribed during delivery is not called; one subscribed during delivery waits for the next", () => {
    const bus = new EventHandler<void>();
    const calls: string[] = [];
    let offB: () => void = () => {};
    bus.subscribe(() => {
      calls.push("a");
      offB();
      bus.subscribe(() => calls.push("c"));
    });
    offB = bus.subscribe(() => calls.push("b"));
    bus.emit();
    expect(calls).toEqual(["a"]);
    calls.length = 0;
    bus.emit();
    expect(calls).toEqual(["a", "c"]);
  });

  test("the same function subscribed twice is two subscriptions", () => {
    const bus = new EventHandler<number>();
    const seen: number[] = [];
    const shared = (n: number) => seen.push(n);
    const offFirst = bus.subscribe(shared);
    const offSecond = bus.subscribe(shared);
    bus.emit(1);
    offFirst();
    bus.emit(2);
    offSecond();
    bus.emit(3);
    expect(seen).toEqual([1, 1, 2]);
  });
});

describe("eventKey", () => {
  test("labels for the three shapes", () => {
    expect(eventKey({ objectType: "tasks" })).toBe("tasks");
    expect(eventKey({ objectType: "tasks", id: 7 })).toBe("tasks/7");
    expect(eventKey({ objectType: "tasks", keyName: "project_id", key: 42 })).toBe("tasks/project_id/42");
  });

  test("defined values decide the shape; a lone undefined discriminator throws", () => {
    expect(eventKey({ objectType: "tasks", id: 7, keyName: undefined, key: undefined } as never)).toBe("tasks/7");
    expect(() => eventKey({ objectType: "tasks", id: undefined } as never)).toThrow(/undefined id/);
    expect(() => eventKey({ objectType: "tasks", keyName: "project_id", key: undefined } as never)).toThrow(/both keyName and key/);
    const bus = new DataEventHandler();
    expect(() => bus.subscribe({ objectType: "tasks", id: undefined as unknown as number }, () => {})).toThrow(TypeError);
  });

  test("selectors that would never fire throw: null or non-scalar id/key, and id together with a foreign key", () => {
    expect(() => eventKey({ objectType: "tasks", id: null } as never)).toThrow(/undefined id/);
    expect(() => eventKey({ objectType: "tasks", id: {} } as never)).toThrow(/finite number or non-empty string id/);
    expect(() => eventKey({ objectType: "tasks", keyName: "project_id", key: {} } as never)).toThrow(/both keyName and key/);
    expect(() => eventKey({ objectType: "tasks", id: 7, keyName: "project_id", key: 1 } as never)).toThrow(/both an id and a foreign key/);
    expect(eventKey({ objectType: "tasks", id: 7, keyName: null, key: null } as never)).toBe("tasks/7");
  });
});

describe("DataEventHandler", () => {
  const tasks = (n: number, projectId = 1) =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, project_id: projectId, assignee_id: i % 2 === 0 ? 1 : null }));

  test("a write notifies the bucket, the object and the foreign-key value subscriptions, in a microtask", async () => {
    const bus = new DataEventHandler();
    const received: string[] = [];
    bus.subscribe({ objectType: "tasks" }, (b) => received.push(b.key));
    bus.subscribe({ objectType: "tasks", id: 2 }, (b) => received.push(b.key));
    bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, (b) => received.push(b.key));
    bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 1 }, (b) => received.push(b.key));

    bus.broadcast({ objectType: "tasks", action: "add", objects: tasks(3), foreignKeys: ["project_id", "assignee_id"] });
    expect(received).toEqual([]);
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
    expect((all.mock.calls[0] as [DataEventBatch])[0].ids).toHaveLength(500);
  });

  test("several writes before the flush merge into one batch per target with deduplicated ids", async () => {
    const bus = new DataEventHandler();
    const batches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "tasks" }, (b) => batches.push(b));
    bus.subscribe({ objectType: "tasks", id: 1 }, (b) => batches.push(b));
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }, { id: 2 }] });
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 1 }], previous: [{ id: 1 }] });
    bus.broadcast({ objectType: "tasks", action: "remove", objects: [{ id: 2 }] });
    await tick();
    expect(batches).toEqual([
      { key: "tasks", objectType: "tasks", ids: [1, 2] },
      { key: "tasks/1", objectType: "tasks", ids: [1] },
    ]);
  });

  test("batches are frozen: one listener cannot corrupt what the next receives", async () => {
    const bus = new DataEventHandler();
    const second: IndexValueList[] = [];
    bus.subscribe({ objectType: "tasks" }, (b) => {
      expect(Object.isFrozen(b)).toBe(true);
      expect(Object.isFrozen(b.ids)).toBe(true);
      expect(() => (b.ids as number[]).sort((x, y) => y - x)).toThrow();
    });
    bus.subscribe({ objectType: "tasks" }, (b) => second.push([...b.ids]));
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }, { id: 2 }] });
    await tick();
    expect(second).toEqual([[1, 2]]);
  });
  type IndexValueList = (number | string)[];

  test("numeric and string forms of an id are one entry", async () => {
    const bus = new DataEventHandler();
    const batches: DataEventBatch[] = [];
    bus.subscribe({ objectType: "tasks", id: 7 }, (b) => batches.push(b));
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 7 }] });
    bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: "7" }], previous: [{ id: "7" }] });
    await tick();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.ids).toEqual([7]);
  });

  test("keys follow the shared rule: NaN, empty and padded ids are skipped on broadcast and refused on subscribe (review 5, finding 3)", async () => {
    const bus = new DataEventHandler();
    const ids: unknown[] = [];
    bus.subscribe({ objectType: "tasks" }, (b) => ids.push(...b.ids));
    bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: NaN }, { id: "" }, { id: " 1" }, { id: 2 }] });
    await tick();
    expect(ids).toEqual([2]);
    expect(() => bus.subscribe({ objectType: "tasks", id: NaN }, () => {})).toThrow(/finite number or non-empty string/);
    expect(() => bus.subscribe({ objectType: "tasks", id: "" }, () => {})).toThrow(TypeError);
    expect(() => bus.subscribe({ objectType: "tasks", keyName: "project_id", key: " 1" }, () => {})).toThrow(TypeError);
  });

  test("a custom index field is honoured and objects without an index value are skipped", async () => {
    const bus = new DataEventHandler();
    const ids: unknown[] = [];
    bus.subscribe({ objectType: "task_tags" }, (b) => ids.push(...b.ids));
    bus.broadcast({ objectType: "task_tags", action: "add", index: "composite_id", objects: [{ composite_id: "1-2" }, { composite_id: "1-3" }, { nope: 1 }] });
    await tick();
    expect(ids).toEqual(["1-2", "1-3"]);
  });

  describe("foreign keys", () => {
    test("only declared foreign keys and only present scalar values notify", async () => {
      const bus = new DataEventHandler();
      const keys: string[] = [];
      bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, (b) => keys.push(b.key));
      bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 1 }, (b) => keys.push(b.key));
      bus.broadcast({
        objectType: "tasks",
        action: "add",
        objects: [{ id: 1, project_id: 1, assignee_id: 1 }, { id: 2, project_id: 1, assignee_id: null }, { id: 3, project_id: 1 }],
        foreignKeys: ["project_id"], // assignee_id NOT declared
      });
      await tick();
      expect(keys).toEqual(["tasks/project_id/1"]);
    });

    test("reassigning a foreign key notifies the old bucket and the new bucket (update carries `previous`)", async () => {
      const bus = new DataEventHandler();
      const keys: string[] = [];
      bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 1 }, (b) => keys.push(b.key));
      bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 2 }, (b) => keys.push(b.key));
      bus.broadcast({
        objectType: "tasks",
        action: "update",
        objects: [{ id: 7, assignee_id: 2 }],
        previous: [{ id: 7, assignee_id: 1 }],
        foreignKeys: ["assignee_id"],
      });
      await tick();
      expect(keys.sort()).toEqual(["tasks/assignee_id/1", "tasks/assignee_id/2"]);
    });

    test("set from null and cleared to null notify the one bucket involved", async () => {
      const bus = new DataEventHandler();
      const keys: string[] = [];
      bus.subscribe({ objectType: "tasks", keyName: "assignee_id", key: 1 }, (b) => keys.push(b.key));
      bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 7, assignee_id: 1 }], previous: [{ id: 7, assignee_id: null }], foreignKeys: ["assignee_id"] });
      bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 8, assignee_id: null }], previous: [{ id: 8, assignee_id: 1 }], foreignKeys: ["assignee_id"] });
      await tick();
      expect(keys).toEqual(["tasks/assignee_id/1"]);
      // and both ids are in it: 7 entered, 8 left
      // (one batch because both writes hit the same target before the flush)
    });

    test("a foreign key absent from a partial update is unchanged: its bucket is taken from `previous`", async () => {
      const bus = new DataEventHandler();
      const batches: DataEventBatch[] = [];
      bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 42 }, (b) => batches.push(b));
      bus.broadcast({
        objectType: "tasks",
        action: "update",
        objects: [{ id: 7, title: "renamed" }],
        previous: [{ id: 7, project_id: 42, title: "old" }],
        foreignKeys: ["project_id"],
      });
      await tick();
      expect(batches.map((b) => [b.key, b.ids])).toEqual([["tasks/project_id/42", [7]]]);
    });

    test("only OWN foreign-key fields count as present, like the write guard (review 8, finding 4)", async () => {
      const bus = new DataEventHandler();
      const keys: string[] = [];
      bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 42 }, (b) => keys.push(b.key));
      bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 43 }, (b) => keys.push(b.key));
      // project_id inherited from the prototype: not a data field, so not "present" → the object stays in bucket 42
      const object = Object.assign(Object.create({ project_id: 43 }) as Record<string, unknown>, { id: 7, title: "x" });
      bus.broadcast({ objectType: "tasks", action: "update", objects: [object], previous: [{ id: 7, project_id: 42 }], foreignKeys: ["project_id"] });
      await tick();
      expect(keys).toEqual(["tasks/project_id/42"]);
    });

    test("the index is read as an OWN property too: an inherited or accessor id is not an id (review 9, finding 2)", async () => {
      const bus = new DataEventHandler();
      const ids: unknown[] = [];
      bus.subscribe({ objectType: "tasks" }, (b) => ids.push(...b.ids));
      const inherited = Object.assign(Object.create({ id: 7 }) as Record<string, unknown>, { title: "x" });
      const accessor = Object.defineProperty({ title: "y" } as Record<string, unknown>, "id", { get: () => 8, enumerable: true });
      const own = { id: 9 };
      bus.broadcast({ objectType: "tasks", action: "add", objects: [inherited, accessor, own] });
      await tick();
      expect(ids).toEqual([8, 9]); // an accessor defined on the object itself is an own property; an inherited id is not
    });

    test("`previous` entries whose id is not in `objects` are ignored", async () => {
      const bus = new DataEventHandler();
      const batches: DataEventBatch[] = [];
      bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, (b) => batches.push(b));
      bus.broadcast({
        objectType: "tasks",
        action: "update",
        objects: [{ id: 7, project_id: 1 }],
        previous: [{ id: 7, project_id: 1 }, { id: 8, project_id: 1 }, { id: 9, project_id: 1 }],
        foreignKeys: ["project_id"],
      });
      await tick();
      expect(batches.map((b) => b.ids)).toEqual([[7]]);
    });

    test("a remove broadcast with the stored object notifies its foreign-key bucket; an id-only stub does not", async () => {
      const bus = new DataEventHandler();
      const keys: string[] = [];
      bus.subscribe({ objectType: "tasks" }, (b) => keys.push(b.key));
      bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 42 }, (b) => keys.push(b.key));

      bus.broadcast({ objectType: "tasks", action: "remove", objects: [{ id: 7 }], foreignKeys: ["project_id"] });
      await tick();
      expect(keys).toEqual(["tasks"]);

      keys.length = 0;
      bus.broadcast({ objectType: "tasks", action: "remove", objects: [{ id: 7, project_id: 42 }], foreignKeys: ["project_id"] });
      await tick();
      expect(keys).toEqual(["tasks", "tasks/project_id/42"]);
    });

    test("an update must carry `previous` (compile-time)", () => {
      const bus = new DataEventHandler();
      // @ts-expect-error previous is required for updates
      const input: Parameters<typeof bus.broadcast>[0] = { objectType: "tasks", action: "update", objects: [{ id: 1 }] };
      expect(input).toBeDefined();
    });
  });

  describe("gating: work only for what is watched", () => {
    test("no listeners on the type at all: nothing is queued or scheduled, no field is read", async () => {
      const bus = new DataEventHandler();
      let reads = 0;
      const object = new Proxy({ id: 1, project_id: 1 } as Record<string, unknown>, {
        get: (t, p, r) => (reads++, Reflect.get(t, p, r)),
      });
      bus.broadcast({ objectType: "tasks", action: "add", objects: [object], foreignKeys: ["project_id"] });
      expect(bus.pendingKeys).toEqual([]);
      expect(reads).toBe(0);
    });

    test("one id listener does not make a 500-object write queue 500 id targets", async () => {
      const bus = new DataEventHandler();
      bus.subscribe({ objectType: "tasks" }, () => {});
      const watched = mock(() => {});
      bus.subscribe({ objectType: "tasks", id: 250 }, watched);
      bus.subscribe({ objectType: "tasks", id: 999 }, () => {});
      bus.broadcast({ objectType: "tasks", action: "add", objects: tasks(500) });
      expect(bus.pendingKeys).toEqual(["tasks", "tasks/250"]);
      await tick();
      expect(watched).toHaveBeenCalledTimes(1);
    });

    test("an unwatched foreign key is never read; an unwatched value is never queued", async () => {
      const bus = new DataEventHandler();
      bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 2 }, () => {});
      let assigneeReads = 0;
      const object = new Proxy({ id: 1, project_id: 1, assignee_id: 1 } as Record<string, unknown>, {
        get(target, prop, receiver) {
          if (prop === "assignee_id") assigneeReads++;
          return Reflect.get(target, prop, receiver);
        },
      });
      bus.broadcast({ objectType: "tasks", action: "add", objects: [object], foreignKeys: ["project_id", "assignee_id"] });
      expect(bus.pendingKeys).toEqual([]);
      expect(assigneeReads).toBe(0);
    });

    test("after the last unsubscribe the type index is pruned", () => {
      const bus = new DataEventHandler();
      const offs = [
        bus.subscribe({ objectType: "tasks" }, () => {}),
        bus.subscribe({ objectType: "tasks", id: 1 }, () => {}),
        bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, () => {}),
      ];
      expect(bus.listenerCount()).toBe(3);
      expect(bus.listenerCount({ objectType: "tasks", id: 1 })).toBe(1);
      for (const off of offs) off();
      expect(bus.listenerCount()).toBe(0);
      expect(bus.listenerCount({ objectType: "tasks", id: 1 })).toBe(0);
      bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1, project_id: 1 }], foreignKeys: ["project_id"] });
      expect(bus.pendingKeys).toEqual([]);
    });

    test("unsubscribe prunes the target it subscribed to, even if the caller mutated the selector since", () => {
      const bus = new DataEventHandler();
      const selector = { objectType: "tasks", id: 7 };
      const off = bus.subscribe(selector, () => {});
      selector.id = 8;
      off();
      bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 7 }] });
      expect(bus.pendingKeys).toEqual([]);
    });

    test("with no foreign-key listeners, an update never reads `previous`", () => {
      const bus = new DataEventHandler();
      bus.subscribe({ objectType: "tasks" }, () => {});
      let reads = 0;
      const previous = new Proxy({ id: 1, project_id: 1 } as Record<string, unknown>, {
        get: (t, p, r) => (reads++, Reflect.get(t, p, r)),
      });
      bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 1 }], previous: [previous], foreignKeys: ["project_id"] });
      expect(reads).toBe(0);
    });
  });

  describe("delivery", () => {
    test("unsubscribe stops delivery, including for a batch already pending", async () => {
      const bus = new DataEventHandler();
      const seen = mock(() => {});
      const off = bus.subscribe({ objectType: "tasks" }, seen);
      bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }] });
      off();
      await tick();
      expect(seen).not.toHaveBeenCalled();
    });

    test("a listener unsubscribed during a flush is not called, even on the same target", async () => {
      const bus = new DataEventHandler();
      const calls: string[] = [];
      let offB: () => void = () => {};
      bus.subscribe({ objectType: "tasks" }, () => {
        calls.push("a");
        offB();
      });
      offB = bus.subscribe({ objectType: "tasks" }, () => calls.push("b"));
      bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1 }] });
      await tick();
      expect(calls).toEqual(["a"]);
    });

    test("a listener subscribed during a pass is not called by it, even on a target delivered later in that pass", async () => {
      const bus = new DataEventHandler();
      const calls: string[] = [];
      bus.subscribe({ objectType: "tasks" }, () => {
        calls.push("bucket");
        bus.subscribe({ objectType: "tasks", id: 7 }, () => calls.push("late"));
      });
      bus.subscribe({ objectType: "tasks", id: 7 }, () => calls.push("existing"));
      bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 7 }] });
      await tick();
      expect(calls).toEqual(["bucket", "existing"]);
    });

    test("the same function subscribed twice to one selector is two subscriptions", async () => {
      const bus = new DataEventHandler();
      const seen: string[] = [];
      const shared = (b: DataEventBatch) => seen.push(b.key);
      const offFirst = bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, shared);
      bus.subscribe({ objectType: "tasks", keyName: "project_id", key: 1 }, shared);
      expect(bus.listenerCount({ objectType: "tasks", keyName: "project_id", key: 1 })).toBe(2);
      offFirst();
      bus.broadcast({ objectType: "tasks", action: "add", objects: [{ id: 1, project_id: 1 }], foreignKeys: ["project_id"] });
      await tick();
      expect(seen).toEqual(["tasks/project_id/1"]);
    });

    test("a write queued for a target reaches a listener that joins that target before the flush (not a guarantee — see contract)", async () => {
      const bus = new DataEventHandler();
      const early = mock(() => {});
      const late = mock(() => {});
      bus.subscribe({ objectType: "tasks", id: 1 }, early);
      bus.broadcast({ objectType: "tasks", action: "update", objects: [{ id: 1 }], previous: [{ id: 1 }] });
      bus.subscribe({ objectType: "tasks", id: 1 }, late);
      await tick();
      expect(early).toHaveBeenCalledTimes(1);
      expect(late).toHaveBeenCalledTimes(1);
    });

    test("a listener that throws is reported and does not block other targets or listeners", async () => {
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
      expect((onError.mock.calls[0] as unknown[])[1]).toEqual({ key: "tasks" });
    });
  });

  describe("flush", () => {
    test("targets are delivered in first-touched order; a broadcast from inside a listener starts a new batch", async () => {
      const bus = new DataEventHandler();
      const order: string[] = [];
      const bBatches: (readonly (number | string)[])[] = [];
      bus.subscribe({ objectType: "b" }, (x) => {
        order.push(`b:${x.ids.join(",")}`);
        bBatches.push(x.ids);
      });
      bus.subscribe({ objectType: "a" }, (x) => {
        order.push(`a:${x.ids.join(",")}`);
        if (x.ids.includes(1)) bus.broadcast({ objectType: "b", action: "add", objects: [{ id: 99 }] });
      });
      bus.broadcast({ objectType: "a", action: "add", objects: [{ id: 1 }] });
      bus.broadcast({ objectType: "b", action: "add", objects: [{ id: 2 }] });
      await tick();
      await tick();
      expect(order).toEqual(["a:1", "b:2", "b:99"]);
      expect(bBatches).toEqual([[2], [99]]);
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

    test("a flush() requested from inside a listener runs after the current flush, preserving order", async () => {
      const bus = new DataEventHandler();
      const bBatches: (readonly (number | string)[])[] = [];
      bus.subscribe({ objectType: "b" }, (x) => bBatches.push(x.ids));
      bus.subscribe({ objectType: "a" }, () => {
        bus.broadcast({ objectType: "b", action: "add", objects: [{ id: 99 }] });
        bus.flush();
      });
      bus.broadcast({ objectType: "a", action: "add", objects: [{ id: 1 }] });
      bus.broadcast({ objectType: "b", action: "add", objects: [{ id: 2 }] });
      bus.flush();
      expect(bBatches).toEqual([[2], [99]]);
      await tick();
      expect(bBatches).toEqual([[2], [99]]);
    });

    test("empty writes cost nothing", () => {
      const bus = new DataEventHandler();
      bus.subscribe({ objectType: "tasks" }, () => {});
      bus.broadcast({ objectType: "tasks", action: "add", objects: [] });
      bus.broadcast({ objectType: "tasks", action: "add", objects: [{ nope: 1 }] });
      expect(bus.pendingKeys).toEqual([]);
    });
  });
});
