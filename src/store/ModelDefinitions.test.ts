import { describe, expect, test } from "bun:test";
import {
  ModelDefinitions,
  assertForeignKeyValues,
  assertValidModelDefinitions,
  definitionFor,
  foreignKeyArrayNames,
  foreignKeyNames,
  isForeignKeyArrayValue,
  isForeignKeyValue,
  invalidForeignKeyFields,
  isObjectType,
  objectTypes,
  validateModelDefinitions,
  type ModelDefinition,
  type ObjectType,
} from "./ModelDefinitions";

describe("the real ModelDefinitions", () => {
  test("are internally consistent", () => {
    expect(validateModelDefinitions(ModelDefinitions)).toEqual([]);
    expect(() => assertValidModelDefinitions()).not.toThrow();
  });

  test("declare the seven demo buckets", () => {
    expect(objectTypes).toEqual(["users", "current_users", "projects", "tasks", "comments", "tags", "task_tags_relation"]);
  });

  test("ObjectType is the key union and isObjectType narrows to it", () => {
    const t: ObjectType = "tasks";
    expect(isObjectType(t)).toBe(true);
    expect(isObjectType("nope")).toBe(false);
    expect(isObjectType(42)).toBe(false);
    // @ts-expect-error not a bucket name
    const wrong: ObjectType = "task";
    expect(wrong as string).toBe("task");
  });

  test("exercise every property at least once", () => {
    const defs = Object.values(ModelDefinitions) as ModelDefinition[];
    const has = (p: keyof ModelDefinition) => defs.some((d) => d[p] !== undefined);
    for (const p of ["index", "model", "foreignKeys", "foreignKeysArray", "relatedObjectType", "hasMany", "embeddedObject", "belongsTo", "metaData"] as const) {
      expect(has(p)).toBe(true);
    }
    expect(defs.some((d) => d.model === undefined)).toBe(true); // plain rows exist too
    expect(defs.some((d) => Object.values(d.relatedObjectType ?? {}).some((r) => r.cascadeDelete))).toBe(true);
  });

  test("helpers read the map", () => {
    expect(foreignKeyNames("tasks")).toEqual(["project_id", "assignee_id"]);
    expect(foreignKeyNames("users")).toEqual([]);
    expect(foreignKeyArrayNames("projects")).toEqual(["member_ids"]);
    expect(definitionFor("task_tags_relation").belongsTo).toEqual(["tasks", "tags"]);
  });

  test("deleting a task or a tag cascades to its join rows, matching the server (review finding 1)", () => {
    expect(definitionFor("tasks").relatedObjectType?.tagLinks).toEqual({ objectType: "task_tags_relation", key: "task_id", getter: "getTagLinks", cascadeDelete: true });
    expect(definitionFor("tags").relatedObjectType?.taskLinks).toEqual({ objectType: "task_tags_relation", key: "tag_id", getter: "getTaskLinks", cascadeDelete: true });
  });

  test("objectTypes is frozen (review finding 9)", () => {
    expect(Object.isFrozen(objectTypes)).toBe(true);
    // @ts-expect-error readonly
    expect(() => objectTypes.push("ghosts")).toThrow();
  });

  test("the schema is deep-frozen and definitionFor returns a readonly view (review 2, finding 6)", () => {
    expect(Object.isFrozen(ModelDefinitions)).toBe(true);
    expect(Object.isFrozen(ModelDefinitions.tasks.foreignKeys)).toBe(true);
    expect(Object.isFrozen(ModelDefinitions.task_tags_relation.belongsTo)).toBe(true);
    const def = definitionFor("tasks");
    // @ts-expect-error readonly
    expect(() => (def.foreignKeys!.x = { objectType: "users", getter: "getX" })).toThrow(TypeError);
    // @ts-expect-error readonly
    expect(() => delete definitionFor("projects").relatedObjectType).toThrow(TypeError);
    expect(validateModelDefinitions(ModelDefinitions)).toEqual([]); // still intact
  });

  test("a type may declare several relations to the same child type (review 2, finding 4)", () => {
    expect(
      validateModelDefinitions({
        users: {
          index: "id",
          model: "UserModel",
          relatedObjectType: {
            assignedTasks: { objectType: "tasks", key: "assignee_id", getter: "getAssignedTasks" },
            createdTasks: { objectType: "tasks", key: "creator_id", getter: "getCreatedTasks" },
          },
        },
        tasks: {
          index: "id",
          foreignKeys: {
            assignee_id: { objectType: "users", getter: "getAssignee" },
            creator_id: { objectType: "users", getter: "getCreator" },
          },
        },
      }),
    ).toEqual([]);
  });
});

describe("validateModelDefinitions", () => {
  const base: Record<string, ModelDefinition> = {
    users: { index: "id", model: "UserModel" },
    projects: { index: "id", model: "ProjectModel", foreignKeys: { owner_id: { objectType: "users", getter: "getOwner" } } },
  };
  const withDefs = (extra: Record<string, ModelDefinition>) => validateModelDefinitions({ ...base, ...extra });

  test("a consistent map has no problems", () => {
    expect(validateModelDefinitions(base)).toEqual([]);
  });

  test("unresolved references are reported for every property that references a type", () => {
    const problems = withDefs({
      tasks: {
        index: "id",
        foreignKeys: { project_id: { objectType: "projectz", getter: "getProject" } },
        foreignKeysArray: { watcher_ids: { objectType: "people", getter: "getWatchers" } },
        relatedObjectType: { comments: { objectType: "commentz", key: "task_id", getter: "getComments" } },
        hasMany: { tags: { objectType: "tagz", through: "nope", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } },
        embeddedObject: { assignee: "nobody" },
        belongsTo: ["ghosts"],
      },
    });
    expect(problems).toEqual([
      'tasks: foreignKeys.project_id points at unknown type "projectz"',
      'tasks: foreignKeysArray.watcher_ids points at unknown type "people"',
      'tasks: relatedObjectType.comments.objectType "commentz" is not a known type',
      'tasks: hasMany.tags.objectType "tagz" is not a known type',
      'tasks: hasMany.tags.through "nope" is not a known type',
      'tasks: embeddedObject.assignee points at unknown type "nobody"',
      'tasks: belongsTo includes unknown type "ghosts"',
    ]);
  });

  test("relatedObjectType requires a known child that declares the key as a foreign key pointing back", () => {
    expect(
      withDefs({
        tasks: { index: "id", foreignKeys: { owner_id: { objectType: "users", getter: "getOwner" } } },
        users: { index: "id", model: "UserModel", relatedObjectType: { tasks: { objectType: "tasks", key: "assignee_id", getter: "getTasks" } } },
      }),
    ).toEqual(['users: relatedObjectType.tasks.key "assignee_id" is not declared in tasks.foreignKeys (grouped index + events need it)']);

    expect(
      withDefs({
        tasks: { index: "id", foreignKeys: { project_id: { objectType: "projects", getter: "getProject" } } },
        users: { index: "id", model: "UserModel", relatedObjectType: { tasks: { objectType: "tasks", key: "project_id", getter: "getTasks" } } },
      }),
    ).toEqual(['users: relatedObjectType.tasks.key "project_id" points at projects, not users']);

    expect(
      withDefs({
        users: { index: "id", model: "UserModel", relatedObjectType: { "my tasks": { objectType: "taskz", key: "owner_id", getter: "getTasks" } } },
      }),
    ).toEqual(["users: relatedObjectType.my tasks: relation name is not a valid identifier", 'users: relatedObjectType.my tasks.objectType "taskz" is not a known type']);
  });

  test("hasMany requires the join bucket to declare both keys, pointing at the right types, and belongsTo", () => {
    const join = (fks: ModelDefinition["foreignKeys"], belongsTo?: string[]): ModelDefinition => ({ index: "id", foreignKeys: fks, belongsTo });
    const tags: ModelDefinition = { index: "id", model: "TagModel" };
    const tasks: ModelDefinition = {
      index: "id",
      hasMany: { tags: { objectType: "tags", through: "task_tags", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } },
    };

    expect(withDefs({ tasks, tags, task_tags: join({}) })).toEqual([
      "tasks: hasMany.tags: task_tags does not declare foreignKeys.task_id",
      "tasks: hasMany.tags: task_tags does not declare foreignKeys.tag_id",
      'tasks: hasMany.tags: task_tags.belongsTo must include "tasks" so association caches invalidate',
    ]);

    expect(
      withDefs({
        tasks,
        tags,
        task_tags: join(
          { task_id: { objectType: "tags", getter: "getTask" }, tag_id: { objectType: "tasks", getter: "getTag" } },
          ["tasks", "tags"],
        ),
      }),
    ).toEqual([
      "tasks: hasMany.tags: task_tags.task_id points at tags, not tasks",
      "tasks: hasMany.tags: task_tags.tag_id points at tasks, not tags",
    ]);

    expect(
      withDefs({
        tasks,
        tags,
        task_tags: join(
          { task_id: { objectType: "tasks", getter: "getTask" }, tag_id: { objectType: "tags", getter: "getTag" } },
          ["tasks", "tags"],
        ),
      }),
    ).toEqual([]);
  });

  test("getters must be unique per entity and valid identifiers; model names unique across entities", () => {
    expect(
      withDefs({
        tasks: {
          index: "id",
          model: "UserModel",
          foreignKeys: { project_id: { objectType: "projects", getter: "getProject" }, owner_id: { objectType: "users", getter: "getProject" } },
          foreignKeysArray: { watcher_ids: { objectType: "users", getter: "get-watchers" } },
        },
      }),
    ).toEqual([
      'tasks: model "UserModel" is also used by users',
      'tasks: getter "getProject" is declared by both foreignKeys.project_id and foreignKeys.owner_id',
      'tasks: foreignKeysArray.watcher_ids getter "get-watchers" is not a valid identifier',
    ]);
  });

  test("field names must be identifiers everywhere they become code or labels (review finding 6)", () => {
    expect(
      withDefs({
        tasks: {
          index: "id",
          foreignKeys: { "project/id": { objectType: "projects", getter: "getProject" } },
          foreignKeysArray: { "watcher ids": { objectType: "users", getter: "getWatchers" } },
        },
        comments: { index: "id", foreignKeys: { "task-id": { objectType: "tasks", getter: "getTask" } } },
        users: { index: "id", model: "UserModel", relatedObjectType: { comments: { objectType: "comments", key: "task-id", getter: "getComments" } } },
      }).sort(),
    ).toEqual(
      [
        'tasks: foreignKeys field "project/id" is not a valid identifier',
        'tasks: foreignKeysArray field "watcher ids" is not a valid identifier',
        'comments: foreignKeys field "task-id" is not a valid identifier',
        'users: relatedObjectType.comments.key "task-id" is not a valid identifier',
        'users: relatedObjectType.comments.key "task-id" points at tasks, not users',
      ].sort(),
    );
  });

  test("a field cannot be both kinds of foreign key; a self-join needs two distinct keys (review finding 7)", () => {
    expect(
      withDefs({
        projects: {
          index: "id",
          model: "ProjectModel",
          foreignKeys: { member_ids: { objectType: "users", getter: "getMember" } },
          foreignKeysArray: { member_ids: { objectType: "users", getter: "getMembers" } },
        },
      }),
    ).toEqual(['projects: "member_ids" is declared in both foreignKeys and foreignKeysArray']);

    expect(
      withDefs({
        users: {
          index: "id",
          model: "UserModel",
          hasMany: { friends: { objectType: "users", through: "friendships", thisKey: "user_id", otherKey: "user_id", getter: "getFriends" } },
        },
        friendships: { index: "id", foreignKeys: { user_id: { objectType: "users", getter: "getUser" } }, belongsTo: ["users"] },
      }),
    ).toEqual(['users: hasMany.friends: thisKey and otherKey are both "user_id"']);
  });

  test("an embedded field must not be the index or a foreign-key field (review finding 4)", () => {
    expect(
      withDefs({
        tasks: {
          index: "id",
          foreignKeys: { assignee_id: { objectType: "users", getter: "getAssignee" } },
          foreignKeysArray: { watcher_ids: { objectType: "users", getter: "getWatchers" } },
          embeddedObject: { assignee_id: "users", id: "users", watcher_ids: "users", "bad name": "users", assignee: "users" },
        },
      }),
    ).toEqual([
      "tasks: embeddedObject.assignee_id is also declared in foreignKeys",
      "tasks: embeddedObject.id is the index field",
      "tasks: embeddedObject.watcher_ids is also declared in foreignKeysArray",
      'tasks: embeddedObject field "bad name" is not a valid identifier',
    ]);
  });

  test("index, type names and metaData keys are checked; the index must be an identifier (review 2, finding 7)", () => {
    expect(validateModelDefinitions({ "bad-name": { index: "", metaData: ["ok", "not ok"] } })).toEqual([
      '"bad-name" is not a valid object type name',
      "bad-name: index must be a non-empty field name",
      'bad-name: metaData key "not ok" is not a valid identifier',
    ]);
    expect(validateModelDefinitions({ things: { index: "task-id" } })).toEqual(['things: index "task-id" is not a valid identifier']);
    expect(validateModelDefinitions({ things: { index: "my id" } })).toEqual(['things: index "my id" is not a valid identifier']);
  });

  test("fields named like Object.prototype members are looked up as own properties (review 2, finding 5)", () => {
    expect(
      withDefs({
        tasks: {
          index: "id",
          foreignKeys: { constructor: { objectType: "users", getter: "getConstructor" } },
          foreignKeysArray: { toString: { objectType: "users", getter: "getToStrings" } },
          embeddedObject: { valueOf: "users" },
        },
      }),
    ).toEqual([]);
    expect(
      withDefs({
        tasks: { index: "id", hasMany: { tags: { objectType: "users", through: "joins", thisKey: "constructor", otherKey: "valueOf", getter: "getTags" } } },
        joins: { index: "id", belongsTo: ["tasks"] },
      }),
    ).toEqual(["tasks: hasMany.tags: joins does not declare foreignKeys.constructor", "tasks: hasMany.tags: joins does not declare foreignKeys.valueOf"]);
  });

  test("assertValidModelDefinitions throws with every problem listed", () => {
    expect(() => assertValidModelDefinitions({ a: { index: "id", foreignKeys: { b_id: { objectType: "b", getter: "getB" } } } })).toThrow(
      /unknown type "b"/,
    );
  });
});

describe("foreign-key values", () => {
  test("single keys: non-empty strings, finite numbers and null pass; NaN, Infinity, \"\" and non-scalars fail (review findings 2, 3)", () => {
    for (const ok of [1, 0, -5, "1", "abc", null, undefined]) expect(isForeignKeyValue(ok)).toBe(true);
    for (const bad of [NaN, Infinity, -Infinity, "", true, false, {}, { id: 1 }, [1], 1n]) expect(isForeignKeyValue(bad)).toBe(false);
  });

  test("array keys: arrays of non-null scalars pass; anything else fails", () => {
    for (const ok of [[], [1, 2], ["a", 1], null, undefined]) expect(isForeignKeyArrayValue(ok)).toBe(true);
    for (const bad of ["1,2", 3, [{ id: 1 }], [1, null], [NaN], [""], {}]) expect(isForeignKeyArrayValue(bad)).toBe(false);
  });

  test("the index is required and checked with the same rules (review 2, finding 3)", () => {
    for (const id of [NaN, "", null, undefined, { id: 1 }, [1], true]) {
      expect(invalidForeignKeyFields("tasks", { id, project_id: 1 })).toEqual(["id"]);
    }
    expect(invalidForeignKeyFields("tasks", { project_id: 1 })).toEqual(["id"]); // absent
    expect(invalidForeignKeyFields("task_tags_relation", { id: "7-3", task_id: 7, tag_id: 3 })).toEqual([]);
    expect(invalidForeignKeyFields("tasks", Object.create({ id: 1 }) as Record<string, unknown>)).toEqual(["id"]); // inherited id does not count
    expect(() => assertForeignKeyValues("tasks", { id: NaN })).toThrow(/invalid index\/foreign key value\(s\): id/);
  });

  test("invalidForeignKeyFields covers both kinds and ignores absent foreign keys", () => {
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: 1, assignee_id: null })).toEqual([]);
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: "1" })).toEqual([]);
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: { id: 1 }, assignee_id: true })).toEqual(["project_id", "assignee_id"]);
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: NaN })).toEqual(["project_id"]);
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: "" })).toEqual(["project_id"]);
    expect(invalidForeignKeyFields("projects", { id: 1, owner_id: 1, member_ids: [1, 2] })).toEqual([]);
    expect(invalidForeignKeyFields("projects", { id: 1, member_ids: "1,2" })).toEqual(["member_ids"]);
    expect(invalidForeignKeyFields("projects", { id: 1, member_ids: [{ id: 1 }] })).toEqual(["member_ids"]);
    expect(invalidForeignKeyFields("users", { id: 1, anything: { nested: true } })).toEqual([]);
  });

  test("assertForeignKeyValues names the fields", () => {
    expect(() => assertForeignKeyValues("tasks", { id: 1, project_id: false })).toThrow(/tasks record has invalid index\/foreign key value\(s\): project_id/);
    expect(() => assertForeignKeyValues("projects", { id: 1, member_ids: 3 })).toThrow(/member_ids/);
    expect(() => assertForeignKeyValues("tasks", { id: 1, project_id: 2 })).not.toThrow();
  });
});
