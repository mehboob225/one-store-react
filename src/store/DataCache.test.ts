import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PassiveModel } from "../models/generator/PassiveModel";
import { CurrentUserModelAppData } from "../models/appdata/CurrentUserModelAppData";
import { ProjectModelAppData } from "../models/appdata/ProjectModelAppData";
import { TagModelAppData } from "../models/appdata/TagModelAppData";
import { TaskModelAppData } from "../models/appdata/TaskModelAppData";
import { UserModelAppData } from "../models/appdata/UserModelAppData";
import { AppDataFactory } from "./AppDataFactory";
import { DataCache } from "./DataCache";
import { objectTypes } from "./ModelDefinitions";

describe("DataCache", () => {
  test("has one typed bucket per definition, in definition order, reachable by name too", () => {
    const cache = new DataCache();
    expect(cache.objectTypes).toEqual([...objectTypes]);
    for (const type of objectTypes) {
      expect(cache.bucket(type)).toBe(cache[type]);
      expect(cache[type].objectType).toBe(type);
      expect(cache[type].size).toBe(0);
    }
    expect(cache.bucket("ghosts")).toBeUndefined();
    expect(cache.tasks.index).toBe("id");
  });

  test("reset bumps the generation and empties every bucket without a broadcast", () => {
    const cache = new DataCache();
    const heard: string[] = [];
    cache.eventsHandler.subscribe({ objectType: "tasks" }, (b) => heard.push(b.key));
    cache.updatedHandler.subscribe((type) => heard.push(`updated:${type}`));
    cache.projects.add([new ProjectModelAppData({ id: 1, owner_id: 1, member_ids: [1] })]);
    cache.tasks.add([new TaskModelAppData({ id: 1, project_id: 1 })]);
    cache.current_users.addMetaData(1, "subscription", { plan: "pro" });
    cache.eventsHandler.flush();
    heard.length = 0;
    expect(cache.generation).toBe(0);
    cache.reset();
    expect(cache.generation).toBe(1);
    for (const type of objectTypes) expect(cache[type].size).toBe(0);
    expect(cache.current_users.getMetaData(1, "subscription")).toBeUndefined();
    cache.eventsHandler.flush();
    expect(heard).toEqual([]);
    cache.reset();
    expect(cache.generation).toBe(2);
  });

  test("updatedHandler emits the object type once per flush for every written bucket", () => {
    const cache = new DataCache();
    const updated: string[] = [];
    cache.updatedHandler.subscribe((type) => updated.push(type));
    cache.projects.add([new ProjectModelAppData({ id: 1 })]);
    cache.tasks.add([new TaskModelAppData({ id: 1, project_id: 1 }), new TaskModelAppData({ id: 2, project_id: 1 })]);
    cache.tasks.add([new TaskModelAppData({ id: 3, project_id: 1 })]);
    expect(updated).toEqual([]); // nothing until the microtask flush
    cache.eventsHandler.flush();
    expect(updated).toEqual(["projects", "tasks"]);
    cache.projects.remove(1); // cascades into tasks
    cache.eventsHandler.flush();
    expect(updated).toEqual(["projects", "tasks", "tasks", "projects"]); // children first, as the buckets broadcast
  });

  test("a listener error handler reaches both buses", () => {
    const errors: unknown[] = [];
    const cache = new DataCache(undefined, (error) => errors.push(error));
    cache.updatedHandler.subscribe(() => {
      throw new Error("updated listener");
    });
    cache.eventsHandler.subscribe({ objectType: "tags" }, () => {
      throw new Error("events listener");
    });
    cache.tags.add([new TagModelAppData({ id: 1 })]);
    cache.eventsHandler.flush();
    expect(errors.map((e) => (e as Error).message).sort()).toEqual(["events listener", "updated listener"]);
  });
});

describe("AppDataFactory and the generated accessors", () => {
  // The singleton is shared by every test file; leave it as found.
  beforeEach(() => AppDataFactory.reset());
  afterEach(() => AppDataFactory.reset());

  const row = <T>(fields: Record<string, unknown>) => fields as T;
  /** The bases type only the key fields (step 9's models add the rest), so a data field is read through the record. */
  const nameOf = (model: object | undefined) => (model as { name?: string } | undefined)?.name;

  test("is a DataCache on the built-in schema", () => {
    expect(AppDataFactory).toBeInstanceOf(DataCache);
    expect(AppDataFactory.objectTypes).toEqual([...objectTypes]);
  });

  test("foreignKeys, foreignKeysArray, relatedObjectType and hasMany accessors read the store", () => {
    AppDataFactory.users.add([new UserModelAppData({ id: 1, name: "Ada" }), new UserModelAppData({ id: 2, name: "Grace" })]);
    AppDataFactory.projects.add([new ProjectModelAppData({ id: 1, owner_id: 1, member_ids: [1, 2, 99] })]);
    AppDataFactory.tasks.add([new TaskModelAppData({ id: 1, project_id: 1, assignee_id: 2 }), new TaskModelAppData({ id: 2, project_id: 1, assignee_id: null })]);
    AppDataFactory.comments.add([row({ id: 1, task_id: 1, author_id: 1 }), row({ id: 2, task_id: 2, author_id: 1 })]);
    AppDataFactory.tags.add([new TagModelAppData({ id: 1, name: "bug" }), new TagModelAppData({ id: 2, name: "ui" })]);
    AppDataFactory.task_tags_relation.add([row({ id: "1-2", task_id: 1, tag_id: 2 }), row({ id: "1-1", task_id: 1, tag_id: 1 })]);

    const project = AppDataFactory.projects.getById(1)!;
    expect(nameOf(project.getOwner())).toBe("Ada");
    expect(project.getMembers().map(nameOf)).toEqual(["Ada", "Grace"]); // 99 is unknown: skipped
    expect(project.getTasks().map((t) => t.id)).toEqual([1, 2]);

    const task = AppDataFactory.tasks.getById(1)!;
    expect(task).toBeInstanceOf(TaskModelAppData);
    expect(task.getProject()).toBe(project);
    expect(nameOf(task.getAssignee())).toBe("Grace");
    expect(AppDataFactory.tasks.getById(2)?.getAssignee()).toBeUndefined();
    expect(task.getComments().map((c) => c.id)).toEqual([1]);
    expect(task.getTagLinks().map((l) => l.id)).toEqual(["1-2", "1-1"]);
    expect(task.getTags().map(nameOf)).toEqual(["ui", "bug"]);
    expect(AppDataFactory.tags.getById(1)?.getTasks().map((t) => t.id)).toEqual([1]);

    // accessors follow the store, not a snapshot
    AppDataFactory.task_tags_relation.remove("1-2");
    expect(task.getTags().map(nameOf)).toEqual(["bug"]);
    AppDataFactory.projects.add([new ProjectModelAppData({ id: 1, owner_id: 2, member_ids: [2] })]);
    expect(nameOf(task.getProject()?.getOwner())).toBe("Grace");
  });

  test("a metaData key is a getter on the model", () => {
    AppDataFactory.current_users.add([new CurrentUserModelAppData({ id: 1, name: "Ada" })]);
    const me = AppDataFactory.current_users.getById(1)!;
    expect(me.subscription).toBeUndefined();
    AppDataFactory.current_users.addMetaData(1, "subscription", { plan: "pro" });
    expect(me.subscription).toEqual({ plan: "pro" });
  });
});

describe("PassiveModel", () => {
  class Thing extends PassiveModel {
    declare id: number;
    declare name?: string;
    shout(): string {
      return `${this.name ?? "?"}!`;
    }
  }

  test("the constructor copies the JSON and `declare`d fields keep their values", () => {
    const thing = new Thing({ id: 1, name: "a", extra: true });
    expect(thing.id).toBe(1);
    expect(thing.name).toBe("a");
    expect((thing as unknown as Record<string, unknown>).extra).toBe(true);
    expect(thing.shout()).toBe("a!");
    expect(new Thing().id).toBeUndefined();
    expect(new Thing().initializeFromJson({ id: 2 }).id).toBe(2);
  });

  test("clone is a deep copy of the data as a new instance of the same class", () => {
    const thing = new Thing({ id: 1, name: "a", nested: { list: [1] } });
    const copy = thing.clone();
    expect(copy).toBeInstanceOf(Thing);
    expect(copy).not.toBe(thing);
    expect(copy).toEqual(thing);
    expect((copy as unknown as { nested: { list: number[] } }).nested).not.toBe((thing as unknown as { nested: unknown }).nested);
    expect(copy.shout()).toBe("a!");
  });

  test("the generated bases are PassiveModels with accessors on the prototype, not own data", () => {
    const task = new TaskModelAppData({ id: 1, project_id: 1 });
    expect(task).toBeInstanceOf(PassiveModel);
    expect(Object.keys(task)).toEqual(["id", "project_id"]); // getProject etc. are not own fields
    expect(JSON.parse(JSON.stringify(task))).toEqual({ id: 1, project_id: 1 });
  });
});
