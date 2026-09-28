import { describe, expect, test } from "bun:test";
import { DataCacheIndex, type BucketContext } from "./DataCacheIndex";
import { DataEventHandler, type DataEventSelector } from "./EventHandler";
import { ModelDefinitions, type ModelDefinition } from "./ModelDefinitions";

type Row = Record<string, unknown>;

/** A store the way the generated DataCache (step 8) will build it: one bucket per definition, one bus. */
function store(definitions: Record<string, ModelDefinition> = ModelDefinitions) {
  const events = new DataEventHandler();
  const buckets = new Map<string, DataCacheIndex<object>>();
  const context: BucketContext = { events, bucket: (type) => buckets.get(type) };
  for (const type of Object.keys(definitions)) buckets.set(type, new DataCacheIndex(type, definitions, context));
  const bucket = <T extends object = Row>(type: string) => buckets.get(type) as unknown as DataCacheIndex<T>;
  /** Subscribes and returns the flushed batches as "key:ids" lines. */
  const listen = (...selectors: DataEventSelector[]) => {
    const heard: string[] = [];
    for (const selector of selectors) events.subscribe(selector, (batch) => heard.push(`${batch.key}:${batch.ids.join(",")}`));
    return { heard, flush: () => (events.flush(), heard) };
  };
  return { events, bucket, buckets, listen };
}

const task = (id: number, project_id: number | null = 1, extra: Row = {}): Row => ({ id, project_id, assignee_id: null, title: `t${id}`, ...extra });

describe("DataCacheIndex reads", () => {
  test("add stores in order; getById, getAll, size; a read for a non-key id is not found", () => {
    const tasks = store().bucket("tasks");
    tasks.add([task(2), task(1), task(3)]);
    expect(tasks.size).toBe(3);
    expect(tasks.getAll().map((t) => t.id)).toEqual([2, 1, 3]);
    expect(tasks.getById(1)).toEqual(task(1));
    for (const bad of [undefined, null, NaN, "", " 1", {}]) expect(tasks.getById(bad)).toBeUndefined();
    expect(tasks.getById(99)).toBeUndefined();
  });

  test("getAll is frozen and the same array until the next write (safe to memoise on)", () => {
    const tasks = store().bucket("tasks");
    tasks.add([task(1)]);
    const first = tasks.getAll();
    expect(Object.isFrozen(first)).toBe(true);
    expect(tasks.getAll()).toBe(first);
    tasks.add([task(2)]);
    const second = tasks.getAll();
    expect(second).not.toBe(first);
    expect(second.map((t) => t.id)).toEqual([1, 2]);
    expect(first.map((t) => t.id)).toEqual([1]); // the old snapshot is untouched
  });

  test("getMultipleByIds keeps the asked order and skips ids that are not stored or not keys", () => {
    const tasks = store().bucket("tasks");
    tasks.add([task(1), task(2), task(3)]);
    expect(tasks.getMultipleByIds([3, 99, "1", undefined, 2]).map((t) => t.id)).toEqual([3, 1, 2]);
  });

  test("the grouped index exists per declared single foreign key, is frozen, and rebuilds after a write", () => {
    const tasks = store().bucket("tasks");
    tasks.add([task(1, 1), task(2, 2), task(3, 1, { assignee_id: 7 })]);
    const group = tasks.getGroupedById("project_id", 1);
    expect(group.map((t) => t.id)).toEqual([1, 3]);
    expect(Object.isFrozen(group)).toBe(true);
    expect(tasks.getGroupedById("project_id", 1)).toBe(group); // cached until a write
    expect(tasks.getGroupedById("assignee_id", 7).map((t) => t.id)).toEqual([3]);
    tasks.add([task(4, 1)]);
    expect(tasks.getGroupedById("project_id", 1)).not.toBe(group);
    expect(tasks.getGroupedById("project_id", 1).map((t) => t.id)).toEqual([1, 3, 4]);
    // no bucket for "no value", and nothing for a value nobody has
    expect(tasks.getGroupedById("project_id", null)).toEqual([]);
    expect(tasks.getGroupedById("project_id", undefined)).toEqual([]);
    expect(tasks.getGroupedById("project_id", 42)).toEqual([]);
    expect(tasks.getGroupedById("assignee_id", null)).toEqual([]); // tasks 1 and 2 have assignee null: not a group
  });

  test("getGroupedById throws for anything but a declared single foreign key", () => {
    const { bucket } = store();
    expect(() => bucket("tasks").getGroupedById("title", "x")).toThrow(/"title" is not a declared single foreign key/);
    expect(() => bucket("tasks").getGroupedById("id", 1)).toThrow(/not a declared single foreign key/);
    expect(() => bucket("projects").getGroupedById("member_ids", 1)).toThrow(/not a declared single foreign key/); // an array key
  });

  test("where/findWhere: key fields compare canonically and treat null/undefined/absent alike; other fields use ===", () => {
    const tasks = store().bucket("tasks");
    tasks.add([task(1, 1, { status: "todo" }), task(2, "1" as unknown as number, { status: "done" }), { id: 3, title: "no project" }, task(4, null)]);
    expect(tasks.where({ project_id: 1 }).map((t) => t.id)).toEqual([1, 2]);
    expect(tasks.where({ project_id: "1" as unknown as number }).map((t) => t.id)).toEqual([1, 2]);
    expect(tasks.where({ project_id: 1, status: "done" }).map((t) => t.id)).toEqual([2]);
    expect(tasks.where({ project_id: null }).map((t) => t.id)).toEqual([3, 4]); // absent and null
    expect(tasks.where({ project_id: undefined }).map((t) => t.id)).toEqual([3, 4]);
    expect(tasks.where({ id: "3" as unknown as number }).map((t) => t.id)).toEqual([3]);
    expect(tasks.where({ status: "todo" }).map((t) => t.id)).toEqual([1]);
    expect(tasks.where({ status: undefined }).map((t) => t.id)).toEqual([3, 4]); // a non-key field: === only
    expect(tasks.findWhere({ status: "done" })?.id).toBe(2);
    expect(tasks.findWhere({ status: "nope" })).toBeUndefined();
    expect(tasks.where({})).toHaveLength(4);
  });
});

describe("DataCacheIndex writes", () => {
  test("an object with a stored id REPLACES it whole, in place — never a merge (data-flow §4.3)", () => {
    const { bucket, listen } = store();
    const tasks = bucket("tasks");
    tasks.add([task(1, 1, { assignee_id: 2, title: "first" }), task(2)]);
    const bus = listen({ objectType: "tasks" }, { objectType: "tasks", id: 1 });
    const fresh = { id: 1, project_id: 1, title: "second" }; // no assignee_id at all
    tasks.add([fresh]);
    expect(tasks.size).toBe(2);
    expect(tasks.getById(1)).toBe(fresh); // the very object, not a merged copy
    expect("assignee_id" in tasks.getById(1)!).toBe(false);
    expect(tasks.getAll().map((t) => t.id)).toEqual([1, 2]); // position kept
    expect(bus.flush()).toEqual(["tasks:1", "tasks/1:1"]); // an update, no add
  });

  test("an own undefined foreign key is the new value: the object leaves its old bucket", () => {
    const { bucket, listen } = store();
    const tasks = bucket("tasks");
    tasks.add([task(1, 1)]);
    const bus = listen({ objectType: "tasks", keyName: "project_id", key: 1 });
    tasks.add([{ id: 1, project_id: undefined, title: "detached" }]);
    expect(tasks.getGroupedById("project_id", 1)).toEqual([]);
    expect(tasks.where({ project_id: null }).map((t) => t.id)).toEqual([1]);
    expect(bus.flush()).toEqual(["tasks/project_id/1:1"]); // the bucket it left heard it
  });

  test("1 and \"1\" are one object everywhere (canonical keys)", () => {
    const tasks = store().bucket("tasks");
    tasks.add([task("1" as unknown as number, "7" as unknown as number)]);
    tasks.add([task(1, 7)]);
    expect(tasks.size).toBe(1);
    expect(tasks.getById("1")?.id).toBe(1);
    expect(tasks.getById(1)?.id).toBe(1);
    expect(tasks.getGroupedById("project_id", "7")).toHaveLength(1);
    expect(tasks.getGroupedById("project_id", 7)).toHaveLength(1);
    expect(tasks.getMultipleByIds(["1"])).toHaveLength(1);
  });

  test("a write is all or nothing: one bad index or foreign key throws before anything is stored", () => {
    const { bucket, listen } = store();
    const tasks = bucket("tasks");
    const bus = listen({ objectType: "tasks" });
    expect(() => tasks.add([task(1), { id: NaN, project_id: 1 }])).toThrow(/tasks\.add: invalid index\/foreign key value\(s\): id/);
    expect(() => tasks.add([task(1), task(2, true as unknown as number)])).toThrow(/project_id/);
    expect(() => tasks.add([{ title: "no id" }])).toThrow(/id/);
    expect(() => tasks.add(["nope" as unknown as Row])).toThrow(/record must be an object/);
    expect(tasks.size).toBe(0);
    expect(bus.flush()).toEqual([]);
    expect(() => bucket("projects").add([{ id: 1, member_ids: [1, NaN] }])).toThrow(/member_ids/);
  });

  test("the same id twice in one write is one object, the last one, announced once", () => {
    const { bucket, listen } = store();
    const tasks = bucket("tasks");
    const bus = listen({ objectType: "tasks" }, { objectType: "tasks", id: 1 });
    tasks.add([task(1, 1, { title: "a" }), task(1, 1, { title: "b" })]);
    expect(tasks.size).toBe(1);
    expect(tasks.getById(1)?.title).toBe("b");
    expect(bus.flush()).toEqual(["tasks:1", "tasks/1:1"]);
    // and over a stored object: one update whose `previous` is the stored state, not the in-batch one
    const moved = listen({ objectType: "tasks", keyName: "project_id", key: 1 }, { objectType: "tasks", keyName: "project_id", key: 5 });
    tasks.add([task(1, 5, { title: "c" }), task(1, 9, { title: "d" })]);
    expect(tasks.getById(1)?.project_id).toBe(9);
    expect(moved.flush()).toEqual(["tasks/project_id/1:1"]); // left 1; nobody listened to 9; never "in" 5
  });

  test("an empty write does nothing: no invalidation, no broadcast", () => {
    const { bucket, listen } = store();
    const tasks = bucket("tasks");
    tasks.add([task(1)]);
    const all = tasks.getAll();
    const bus = listen({ objectType: "tasks" });
    tasks.add([]);
    expect(tasks.getAll()).toBe(all);
    expect(bus.flush()).toEqual([]);
  });

  test("broadcast payloads: add and update carry the index and declared foreign keys, so every key shape fires", () => {
    const { bucket, listen } = store();
    const tasks = bucket("tasks");
    const bus = listen(
      { objectType: "tasks" },
      { objectType: "tasks", id: 1 },
      { objectType: "tasks", keyName: "project_id", key: 1 },
      { objectType: "tasks", keyName: "project_id", key: 2 },
      { objectType: "tasks", keyName: "assignee_id", key: 7 },
    );
    tasks.add([task(1, 1, { assignee_id: 7 }), task(2, 2)]);
    // targets are delivered in the order the write first touched them: everything task 1 hits, then task 2's bucket
    expect(bus.flush()).toEqual(["tasks:1,2", "tasks/1:1", "tasks/project_id/1:1", "tasks/assignee_id/7:1", "tasks/project_id/2:2"]);
    bus.heard.length = 0;
    tasks.add([task(1, 2, { assignee_id: null })]); // moved project, lost assignee
    // new bucket first, then the one it left (the bus's order), and the assignee it lost
    expect(bus.flush()).toEqual(["tasks:1", "tasks/1:1", "tasks/project_id/2:1", "tasks/project_id/1:1", "tasks/assignee_id/7:1"]);
  });
});

describe("DataCacheIndex associations and belongsTo", () => {
  const link = (task_id: number, tag_id: number): Row => ({ id: `${task_id}-${tag_id}`, task_id, tag_id });

  test("getAssociation resolves has-many-through the join bucket; a join write is visible via belongsTo", () => {
    const { bucket } = store();
    const tasks = bucket("tasks");
    const tags = bucket("tags");
    const links = bucket("task_tags_relation");
    tasks.add([task(1), task(2)]);
    tags.add([{ id: 1, name: "bug" }, { id: 2, name: "ui" }, { id: 3, name: "later" }]);
    links.add([link(1, 2), link(1, 1), link(2, 3)]);
    const tagsOf = (id: number) => tasks.getAssociation<Row>("task_tags_relation", "task_id", "tag_id", id).map((t) => t.name);
    expect(tagsOf(1)).toEqual(["ui", "bug"]); // join-row order
    expect(tagsOf(2)).toEqual(["later"]);
    expect(tagsOf(99)).toEqual([]);
    expect(tasks.getAssociation("task_tags_relation", "task_id", "tag_id", undefined)).toEqual([]);
    // the other direction, from tags
    expect(tags.getAssociation<Row>("task_tags_relation", "tag_id", "task_id", 1).map((t) => t.id)).toEqual([1]);
    // a join write: task_tags_relation belongsTo tasks and tags, so the cached ids are dropped
    links.add([link(1, 3)]);
    expect(tagsOf(1)).toEqual(["ui", "bug", "later"]);
    links.remove("1-2");
    expect(tagsOf(1)).toEqual(["bug", "later"]);
    // an other-side object that arrives later shows up without a join write (objects resolve on read)
    links.add([link(2, 9)]);
    expect(tagsOf(2)).toEqual(["later"]); // tag 9 unknown: skipped
    tags.add([{ id: 9, name: "new" }]);
    expect(tagsOf(2)).toEqual(["later", "new"]);
    // a replaced other-side object is the one returned
    tags.add([{ id: 9, name: "renamed" }]);
    expect(tagsOf(2)).toEqual(["later", "renamed"]);
  });

  test("belongsTo is what makes a join write visible: without it the owner's cached ids go stale", () => {
    const defs: Record<string, ModelDefinition> = {
      owners: { index: "id" },
      others: { index: "id" },
      links: { index: "id", foreignKeys: { owner_id: { objectType: "owners", getter: "getOwner" }, other_id: { objectType: "others", getter: "getOther" } } },
      // the same join bucket, declared correctly
      good_links: {
        index: "id",
        foreignKeys: { owner_id: { objectType: "owners", getter: "getOwner" }, other_id: { objectType: "others", getter: "getOther" } },
        belongsTo: ["owners", "others"],
      },
    };
    const { bucket } = store(defs);
    bucket("owners").add([{ id: 1 }]);
    bucket("others").add([{ id: 1 }, { id: 2 }]);
    const via = (through: string) => bucket("owners").getAssociation<Row>(through, "owner_id", "other_id", 1).map((o) => o.id);
    bucket("links").add([{ id: "a", owner_id: 1, other_id: 1 }]);
    bucket("good_links").add([{ id: "a", owner_id: 1, other_id: 1 }]);
    expect(via("links")).toEqual([1]);
    expect(via("good_links")).toEqual([1]);
    bucket("links").add([{ id: "b", owner_id: 1, other_id: 2 }]);
    expect(via("links")).toEqual([1]); // stale: the validator rejects this schema for exactly this reason
    bucket("good_links").add([{ id: "b", owner_id: 1, other_id: 2 }]);
    expect(via("good_links")).toEqual([1, 2]);
    expect(via("links")).toEqual([1, 2]); // only because the good join bucket's write cleared the owner
  });

  test("a join write clears every belongsTo bucket's derived structures", () => {
    const { bucket } = store();
    const tasks = bucket("tasks");
    const tags = bucket("tags");
    tasks.add([task(1)]);
    tags.add([{ id: 1, name: "bug" }]);
    const tasksAll = tasks.getAll();
    const tagsAll = tags.getAll();
    bucket("task_tags_relation").add([link(1, 1)]);
    expect(tasks.getAll()).not.toBe(tasksAll);
    expect(tags.getAll()).not.toBe(tagsAll);
    expect(tasks.getAll()).toEqual(tasksAll); // same content, rebuilt
  });

  test("getAssociation through an undeclared key or a bucket the store lacks throws", () => {
    const { bucket } = store();
    bucket("tasks").add([task(1)]);
    expect(() => bucket("tasks").getAssociation("nope", "task_id", "tag_id", 1)).toThrow(/tasks\.getAssociation: the store has no "nope" bucket/);
    expect(() => bucket("tasks").getAssociation("task_tags_relation", "title", "tag_id", 1)).toThrow(/"title" is not a declared single foreign key/);
    expect(() => bucket("tasks").getAssociation("task_tags_relation", "task_id", "id", 1)).toThrow(/"id" is not a declared single foreign key/);
  });
});

describe("DataCacheIndex removes", () => {
  function seeded() {
    const s = store();
    s.bucket("projects").add([{ id: 1, owner_id: 1, member_ids: [1] }, { id: 2, owner_id: 1, member_ids: [1] }]);
    s.bucket("tasks").add([task(1, 1), task(2, 1), task(3, 2)]);
    s.bucket("comments").add([{ id: 1, task_id: 1, author_id: 1 }, { id: 2, task_id: 3, author_id: 1 }]);
    s.bucket("tags").add([{ id: 1, name: "bug" }]);
    s.bucket("task_tags_relation").add([{ id: "1-1", task_id: 1, tag_id: 1 }, { id: "3-1", task_id: 3, tag_id: 1 }]);
    return s;
  }

  test("remove cascades through cascadeDelete, children before parents, and broadcasts the stored objects", () => {
    const s = seeded();
    const bus = s.listen(
      { objectType: "projects" },
      { objectType: "tasks" },
      { objectType: "tasks", keyName: "project_id", key: 1 },
      { objectType: "comments", keyName: "task_id", key: 1 },
      { objectType: "task_tags_relation", keyName: "tag_id", key: 1 },
      { objectType: "tags" },
    );
    s.bucket("projects").remove(1);
    expect(s.bucket("projects").getAll().map((p) => p.id)).toEqual([2]);
    expect(s.bucket("tasks").getAll().map((t) => t.id)).toEqual([3]);
    expect(s.bucket("comments").getAll().map((c) => c.id)).toEqual([2]);
    expect(s.bucket("task_tags_relation").getAll().map((l) => l.id)).toEqual(["3-1"]);
    expect(s.bucket("tags").size).toBe(1); // hasMany is not a cascade
    // the foreign-key buckets heard it: the objects, not id stubs, were broadcast — and children first
    expect(bus.flush()).toEqual(["comments/task_id/1:1", "task_tags_relation/tag_id/1:1-1", "tasks:1,2", "tasks/project_id/1:1,2", "projects:1"]);
  });

  test("removeObjects accepts ids and objects with the index field, ignores unknown ids, and rejects a target without an id", () => {
    const s = seeded();
    const bus = s.listen({ objectType: "tasks" });
    s.bucket("tasks").removeObjects([{ id: 2 }, "3", 99, 2]);
    expect(s.bucket("tasks").getAll().map((t) => t.id)).toEqual([1]);
    expect(bus.flush()).toEqual(["tasks:2,3"]);
    expect(() => s.bucket("tasks").remove(undefined as unknown as number)).toThrow(/a target must be an id or an object with a "id" field/);
    expect(() => s.bucket("tasks").removeObjects([{ title: "x" }])).toThrow(/a target must be an id/);
    bus.heard.length = 0;
    s.bucket("tasks").removeObjects([99]); // nothing to do: no broadcast
    expect(bus.flush()).toEqual([]);
  });

  test("a cyclic schema and cyclic data terminate: each object is removed and broadcast once", () => {
    const defs: Record<string, ModelDefinition> = {
      nodes: {
        index: "id",
        foreignKeys: { parent_id: { objectType: "nodes", getter: "getParent" } },
        relatedObjectType: { children: { objectType: "nodes", key: "parent_id", getter: "getChildren", cascadeDelete: true } },
      },
      // A → B → A
      as: {
        index: "id",
        foreignKeys: { b_id: { objectType: "bs", getter: "getB" } },
        relatedObjectType: { bs: { objectType: "bs", key: "a_id", getter: "getBs", cascadeDelete: true } },
      },
      bs: {
        index: "id",
        foreignKeys: { a_id: { objectType: "as", getter: "getA" } },
        relatedObjectType: { as: { objectType: "as", key: "b_id", getter: "getAs", cascadeDelete: true } },
      },
    };
    const s = store(defs);
    const nodes = s.bucket("nodes");
    // 1 → 2 → 3 → 1 (a cycle in the data), plus 4 under 2, plus an unrelated 5
    nodes.add([{ id: 1, parent_id: 3 }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }, { id: 4, parent_id: 2 }, { id: 5, parent_id: null }]);
    const bus = s.listen({ objectType: "nodes" }, { objectType: "nodes", id: 1 });
    nodes.remove(1);
    expect(nodes.getAll().map((n) => n.id)).toEqual([5]);
    expect(bus.flush()).toEqual(["nodes:3,4,2,1", "nodes/1:1"]); // deepest first; 1 once although reached twice
    s.bucket("as").add([{ id: 1, b_id: 1 }, { id: 2, b_id: 1 }]);
    s.bucket("bs").add([{ id: 1, a_id: 1 }]);
    const ab = s.listen({ objectType: "as" }, { objectType: "bs" });
    s.bucket("bs").remove(1);
    expect(s.bucket("as").size).toBe(0);
    expect(s.bucket("bs").size).toBe(0);
    expect(ab.flush()).toEqual(["as:1,2", "bs:1"]);
  });

  test("removeAll empties the bucket and broadcasts, but does not cascade (a full refresh)", () => {
    const s = seeded();
    const bus = s.listen({ objectType: "projects" }, { objectType: "tasks" });
    s.bucket("projects").removeAll();
    expect(s.bucket("projects").size).toBe(0);
    expect(s.bucket("tasks").size).toBe(3);
    expect(bus.flush()).toEqual(["projects:1,2"]);
    bus.heard.length = 0;
    s.bucket("projects").removeAll(); // already empty: nothing to say
    expect(bus.flush()).toEqual([]);
  });

  test("a cascade into a bucket the store lacks is a wiring error and throws", () => {
    const defs: Record<string, ModelDefinition> = {
      parents: { index: "id", relatedObjectType: { kids: { objectType: "kids", key: "parent_id", getter: "getKids", cascadeDelete: true } } },
    };
    const s = store(defs);
    s.bucket("parents").add([{ id: 1 }]);
    expect(() => s.bucket("parents").remove(1)).toThrow(/parents\.remove: the store has no "kids" bucket/);
  });
});

describe("DataCacheIndex metaData, clear and construction", () => {
  test("metaData is per object and declared key, survives a replace, goes with a remove, and announces the object", () => {
    const { bucket, listen } = store();
    const users = bucket("current_users");
    const bus = listen({ objectType: "current_users", id: 1 });
    users.addMetaData(1, "subscription", { plan: "pro" }); // before the object exists: kept, and announced by id
    expect(users.getMetaData(1, "subscription")).toEqual({ plan: "pro" });
    expect(bus.flush()).toEqual(["current_users/1:1"]);
    bus.heard.length = 0;
    users.add([{ id: 1, name: "Ada" }]);
    expect(users.getMetaData(1, "subscription")).toEqual({ plan: "pro" });
    users.add([{ id: 1, name: "Ada L." }]); // a replace keeps side data from another endpoint
    expect(users.getMetaData(1, "subscription")).toEqual({ plan: "pro" });
    users.addMetaData(1, "subscription", { plan: "free" });
    expect(users.getMetaData(1, "subscription")).toEqual({ plan: "free" });
    expect(users.getMetaData("1", "subscription")).toEqual({ plan: "free" }); // canonical id
    expect(users.getMetaData(2, "subscription")).toBeUndefined();
    expect(users.getMetaData(undefined, "subscription")).toBeUndefined();
    expect(bus.flush()).toEqual(["current_users/1:1"]); // the two replaces and the metaData write, coalesced by the bus
    users.remove(1);
    expect(users.getMetaData(1, "subscription")).toBeUndefined();
  });

  test("an undeclared metaData key or a bad id throws", () => {
    const { bucket } = store();
    expect(() => bucket("current_users").addMetaData(1, "limits", {})).toThrow(/"limits" is not a declared metaData key/);
    expect(() => bucket("current_users").getMetaData(1, "limits")).toThrow(/not a declared metaData key/);
    expect(() => bucket("tasks").addMetaData(1, "subscription", {})).toThrow(/not a declared metaData key/);
    expect(() => bucket("current_users").addMetaData(NaN, "subscription", {})).toThrow(/id must be a finite number or non-empty string/);
  });

  test("clear forgets objects, side data and indexes without a broadcast (the session reset)", () => {
    const { bucket, listen } = store();
    const users = bucket("current_users");
    users.add([{ id: 1 }]);
    users.addMetaData(1, "subscription", {});
    const bus = listen({ objectType: "current_users" });
    bus.flush();
    bus.heard.length = 0;
    users.clear();
    expect(users.size).toBe(0);
    expect(users.getAll()).toEqual([]);
    expect(users.getById(1)).toBeUndefined();
    expect(users.getMetaData(1, "subscription")).toBeUndefined();
    expect(bus.flush()).toEqual([]);
    users.add([{ id: 2 }]); // usable afterwards
    expect(users.getById(2)).toEqual({ id: 2 });
  });

  test("a bucket for a type the map does not define, or an unusable definition, cannot be built", () => {
    const { events, buckets } = store();
    const context: BucketContext = { events, bucket: (type) => buckets.get(type) };
    expect(() => new DataCacheIndex("ghosts", ModelDefinitions, context)).toThrow(/unknown object type "ghosts"/);
    expect(() => new DataCacheIndex("x", { x: { index: 5 as unknown as string } }, context)).toThrow(/not a usable definition/);
  });

  test("the built-in map uses the precomputed facts; a custom map is read once per bucket", () => {
    const events = new DataEventHandler();
    const defs: Record<string, ModelDefinition> = { things: { index: "key" } };
    const things = new DataCacheIndex<Row>("things", defs, { events, bucket: () => undefined });
    things.add([{ key: "a" }]);
    expect(things.getById("a")).toEqual({ key: "a" });
    expect(() => things.add([{ id: 1 }])).toThrow(/key/); // the index is `key` here
  });
});
