import { describe, expect, test } from "bun:test";
import {
  ModelDefinitions,
  assertForeignKeyValues,
  assertValidModelDefinitions,
  definitionFor,
  foreignKeyNames,
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
    expect(definitionFor("task_tags_relation").belongsTo).toEqual(["tasks", "tags"]);
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
        relatedObjectType: { commentz: { key: "task_id", getter: "getComments" } },
        hasMany: { tags: { through: "nope", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } },
        embeddedObject: { assignee: "nobody" },
        belongsTo: ["ghosts"],
      },
    });
    expect(problems).toEqual([
      'tasks: foreignKeys.project_id points at unknown type "projectz"',
      'tasks: foreignKeysArray.watcher_ids points at unknown type "people"',
      "tasks: relatedObjectType.commentz is not a known type",
      "tasks: hasMany.tags is not a known type",
      'tasks: hasMany.tags.through "nope" is not a known type',
      'tasks: embeddedObject.assignee points at unknown type "nobody"',
      'tasks: belongsTo includes unknown type "ghosts"',
    ]);
  });

  test("relatedObjectType requires the child to declare the key as a foreign key pointing back", () => {
    expect(
      withDefs({
        tasks: { index: "id", foreignKeys: { owner_id: { objectType: "users", getter: "getOwner" } } },
        users: { index: "id", model: "UserModel", relatedObjectType: { tasks: { key: "assignee_id", getter: "getTasks" } } },
      }),
    ).toEqual(['users: relatedObjectType.tasks.key "assignee_id" is not declared in tasks.foreignKeys (grouped index + events need it)']);

    expect(
      withDefs({
        tasks: { index: "id", foreignKeys: { project_id: { objectType: "projects", getter: "getProject" } } },
        users: { index: "id", model: "UserModel", relatedObjectType: { tasks: { key: "project_id", getter: "getTasks" } } },
      }),
    ).toEqual(['users: relatedObjectType.tasks.key "project_id" points at projects, not users']);
  });

  test("hasMany requires the join bucket to declare both keys, pointing at the right types, and belongsTo", () => {
    const join = (fks: ModelDefinition["foreignKeys"], belongsTo?: string[]): ModelDefinition => ({ index: "id", foreignKeys: fks, belongsTo });
    const tags: ModelDefinition = { index: "id", model: "TagModel" };
    const tasks: ModelDefinition = {
      index: "id",
      hasMany: { tags: { through: "task_tags", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } },
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

  test("index, type names and metaData keys are checked", () => {
    expect(validateModelDefinitions({ "bad-name": { index: "" , metaData: ["ok", "not ok"] } })).toEqual([
      '"bad-name" is not a valid object type name',
      "bad-name: index must be a non-empty field name",
      'bad-name: metaData key "not ok" is not a valid identifier',
    ]);
  });

  test("assertValidModelDefinitions throws with every problem listed", () => {
    expect(() => assertValidModelDefinitions({ a: { index: "id", foreignKeys: { b_id: { objectType: "b", getter: "getB" } } } })).toThrow(
      /unknown type "b"/,
    );
  });
});

describe("foreign-key values", () => {
  test("scalars and null are fine; booleans, objects, arrays and bigints are not", () => {
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: 1, assignee_id: null })).toEqual([]);
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: "1" })).toEqual([]); // absent assignee_id is fine
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: { id: 1 }, assignee_id: true })).toEqual(["project_id", "assignee_id"]);
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: [1] })).toEqual(["project_id"]);
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: 1n as unknown })).toEqual(["project_id"]);
    expect(invalidForeignKeyFields("users", { id: 1, anything: { nested: true } })).toEqual([]); // no FKs declared
  });

  test("assertForeignKeyValues names the fields", () => {
    expect(() => assertForeignKeyValues("tasks", { id: 1, project_id: false })).toThrow(/tasks record has non-scalar foreign key value\(s\): project_id/);
    expect(() => assertForeignKeyValues("tasks", { id: 1, project_id: 2 })).not.toThrow();
  });
});
