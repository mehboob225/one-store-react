import { describe, expect, test } from "bun:test";
import { CurrentUserModel } from "../models/CurrentUserModel";
import { PassiveModel } from "../models/generator/PassiveModel";
import { TaskModel } from "../models/TaskModel";
import { UserModel } from "../models/UserModel";
import { Database } from "../server/db";
import { AppDataFactory } from "./AppDataFactory";
import { AppDataModelFactory, ModelConstructors, ModelFactory, pluralize } from "./AppDataModelFactory";
import { DataCache } from "./DataCache";
import { definitionFor, objectTypes } from "./ModelDefinitions";

/** A fresh store and its materializer; the singleton is never touched. */
function setup() {
  const store = new DataCache();
  return { store, factory: new ModelFactory(store), db: new Database() };
}

describe("addData", () => {
  test("one tasks response fills tasks AND users: the embedded assignee is lifted out of the task", () => {
    const { store, factory, db } = setup();
    const response = db.listTasks(1).map((t) => db.withAssignee(t)); // exactly what GET /projects/1/tasks returns
    const stored = factory.addData("tasks", response);

    expect(store.tasks.getAll().map((t) => t.id)).toEqual([1, 2, 3]);
    expect(store.users.getAll().map((u) => u.name)).toEqual(["Ada Lovelace", "Grace Hopper"]); // task 3's assignee is null
    for (const task of store.tasks.getAll()) {
      expect(task).toBeInstanceOf(TaskModel);
      expect(Object.hasOwn(task, "assignee")).toBe(false);
    }
    for (const user of store.users.getAll()) expect(user).toBeInstanceOf(UserModel);

    // the returned objects are the stored ones, in the order given, and their accessors resolve in this store
    expect(stored).toEqual([...store.tasks.getAll()]);
    expect(stored[0]).toBe(store.tasks.getById(1)!);
    expect(stored[1]!.getAssignee()?.name).toBe("Grace Hopper");
    expect(stored[2]!.getAssignee()).toBeUndefined();
    expect(stored[1]!.isOverdue(new Date(2026, 9, 2))).toBe(true); // domain behaviour on the stored model
  });

  test("a single object works like a one-element array, and the caller's JSON is never mutated", () => {
    const { store, factory, db } = setup();
    const response = db.withAssignee(db.getTask(2)!);
    const snapshot = structuredClone(response);
    const [task] = factory.addData("tasks", response);
    expect(response).toEqual(snapshot); // `assignee` is still there: the lift happens on a copy
    expect(task).toBe(store.tasks.getById(2)!);
    expect(store.users.getById(2)?.name).toBe("Grace Hopper");
  });

  test("a write replaces the stored object whole, like the bucket, and returns the stored one", () => {
    const { store, factory } = setup();
    factory.addData("tasks", { id: 1, project_id: 1, title: "old", status: "todo", due_on: "2026-01-01", hash: "a" });
    const [task] = factory.addData("tasks", { id: 1, project_id: 1, title: "new", status: "done", hash: "b" });
    expect(store.tasks.size).toBe(1);
    expect(task!.title).toBe("new");
    expect(Object.hasOwn(task!, "due_on")).toBe(false); // replaced, not merged
    // the same id twice in one response: one object, the last one wins (the returned list names it twice)
    const twice = factory.addData("tasks", [{ id: 1, title: "x" }, { id: 1, title: "y" }]);
    expect(twice.map((t) => t.title)).toEqual(["y", "y"]);
  });

  test("plain-row buckets stay plain objects; model buckets hold instances of the registered class", () => {
    const { store, factory, db } = setup();
    factory.addData("comments", db.listComments(1));
    for (const comment of store.comments.getAll()) {
      expect(Object.getPrototypeOf(comment)).toBe(Object.prototype);
      expect(Object.getOwnPropertySymbols(comment)).toEqual([]); // not stamped with the store
    }
    factory.addData("current_users", db.getCurrentUser(1));
    expect(store.current_users.getById(1)).toBeInstanceOf(CurrentUserModel);
  });

  test("all or nothing across buckets: a bad record anywhere writes nothing, not even the lifted assignee", () => {
    const { store, factory, db } = setup();
    const heard: string[] = [];
    store.updatedHandler.subscribe((type) => heard.push(type));
    const good = db.withAssignee(db.getTask(1)!);
    const cases: unknown[] = [
      [good, { ...good, id: 2, project_id: { id: 1 } }], // a bad foreign key in the second task
      [good, { ...good, id: 2, isDone: true }], // a field that would shadow a model method
      [good, { ...good, id: 2, assignee: { id: Number.NaN, name: "?" } }], // a bad index on an embedded user
      [good, 42], // not a record
    ];
    for (const data of cases) expect(() => factory.addData("tasks", data)).toThrow();
    expect(store.tasks.size).toBe(0);
    expect(store.users.size).toBe(0);
    store.eventsHandler.flush();
    expect(heard).toEqual([]);
  });

  test("an unknown object type and a null or missing payload throw", () => {
    const { factory } = setup();
    expect(() => factory.addData("task" as never, [])).toThrow(/unknown object type "task"/);
    expect(() => factory.addData("tasks", null)).toThrow(/a tasks record must be an object, got null/);
    expect(() => factory.addData("tasks", undefined)).toThrow(/got undefined/);
    expect(factory.addData("tasks", [])).toEqual([]); // an empty list is a valid, empty response
  });

  test("buckets are written children first, so every bucket has landed before its parent's listeners run", () => {
    const { store, factory, db } = setup();
    const order: string[] = [];
    store.updatedHandler.subscribe((type) => order.push(type));
    factory.addData("tasks", db.listTasks(2).map((t) => db.withAssignee(t)));
    store.eventsHandler.flush();
    expect(order).toEqual(["users", "tasks"]);
  });

  test("AppDataModelFactory writes into the app's store", () => {
    expect(AppDataModelFactory.store).toBe(AppDataFactory);
  });
});

describe("ModelConstructors", () => {
  test("has one class per `model:` name, and each builds the model named after it", () => {
    const names = objectTypes.flatMap((type) => {
      const model = definitionFor(type).model;
      return model === undefined ? [] : [model];
    });
    expect(Object.keys(ModelConstructors).sort()).toEqual(names.sort());
    for (const [name, Constructor] of Object.entries(ModelConstructors)) {
      const model = new Constructor({ id: 1 });
      expect(model).toBeInstanceOf(PassiveModel);
      expect(model.constructor.name).toBe(name);
    }
  });

  test("every demo record from the server loads into its model (no server field collides with a model member)", () => {
    const { store, factory, db } = setup();
    factory.addData("users", db.listUsers());
    factory.addData("current_users", db.getCurrentUser(1));
    factory.addData("projects", db.listProjects());
    for (const project of db.listProjects()) factory.addData("tasks", db.listTasks(project.id).map((t) => db.withAssignee(t)));
    factory.addData("tags", db.listTagsForTask(2));
    expect(store.users.size).toBe(3);
    expect(store.projects.size).toBe(2);
    expect(store.tasks.size).toBe(6);
    expect(store.tags.size).toBe(2);
  });
});

describe("pluralize", () => {
  test("maps the singular names push messages use to bucket names", () => {
    expect(pluralize("task")).toBe("tasks");
    expect(pluralize("project")).toBe("projects");
    expect(pluralize("current_user")).toBe("current_users");
    expect(pluralize("comment")).toBe("comments");
  });

  test("irregulars come from the table", () => {
    expect(pluralize("task_tags_relation")).toBe("task_tags_relation");
    expect(pluralize("constructor")).toBe("constructors"); // own entries only: nothing inherited is an irregular
  });

  test("every bucket is reachable from a singular name (add an irregular when a new bucket is not)", () => {
    for (const type of objectTypes) {
      const singular = type.endsWith("s") ? type.slice(0, -1) : type;
      expect(pluralize(singular)).toBe(type);
    }
  });
});
