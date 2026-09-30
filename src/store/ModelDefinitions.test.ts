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
  type ForeignKeyDefinition,
  type HasManyDefinition,
  type ModelDefinition,
  type ObjectType,
  type RelatedObjectTypeDefinition,
  metaDataGetterName,
  pascalCase,
  recordTypeName,
} from "./ModelDefinitions";
import { canonicalKey, isKeyValue, isRecord } from "./canonicalKey";

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

  test("deepFreeze recurses through already-frozen sub-objects (review 3, finding 8)", () => {
    // every nested object in the real map is frozen, including ones two levels down
    expect(Object.isFrozen(ModelDefinitions.projects.foreignKeys.owner_id)).toBe(true);
    expect(Object.isFrozen(ModelDefinitions.tasks.hasMany.tags)).toBe(true);
    const walk = (value: unknown, path: string): string[] => {
      if (typeof value !== "object" || value === null) return [];
      const here = Object.isFrozen(value) ? [] : [path];
      return here.concat(...Object.entries(value).map(([k, v]) => walk(v, `${path}.${k}`)));
    };
    expect(walk(ModelDefinitions, "ModelDefinitions")).toEqual([]);
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
    ).toEqual(['users: relatedObjectType.my tasks relation name "my tasks" is not a valid identifier', 'users: relatedObjectType.my tasks.objectType "taskz" is not a known type']);
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
      'tasks: member "getProject" is declared by both foreignKeys.project_id and foreignKeys.owner_id',
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
        'tasks: foreignKeys field "project/id" is not a valid identifier or is reserved',
        'tasks: foreignKeysArray field "watcher ids" is not a valid identifier or is reserved',
        'comments: foreignKeys field "task-id" is not a valid identifier or is reserved',
        'users: relatedObjectType.comments.key "task-id" is not a valid identifier or is reserved',
        // an invalid key is not also looked up in the child (review 6)
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
      'tasks: embeddedObject field "bad name" is not a valid identifier or is reserved',
    ]);
  });

  test("index, type names and metaData keys are checked; the index must be an identifier (review 2, finding 7)", () => {
    expect(validateModelDefinitions({ "bad-name": { index: "", metaData: ["ok", "not ok"] } })).toEqual([
      '"bad-name" is not a valid object type name',
      "bad-name: index must be a non-empty field name",
      'bad-name: metaData key "not ok" is not a valid identifier or is reserved',
    ]);
    expect(validateModelDefinitions({ things: { index: "task-id" } })).toEqual(['things: index "task-id" is not a valid identifier or is reserved']);
    expect(validateModelDefinitions({ things: { index: "my id" } })).toEqual(['things: index "my id" is not a valid identifier or is reserved']);
  });

  test("fields named like Object.prototype members are looked up as own properties, and rejected as reserved (review 2 finding 5, review 3 finding 2)", () => {
    expect(
      withDefs({
        tasks: {
          index: "id",
          foreignKeys: { constructor: { objectType: "users", getter: "getConstructor" } },
          foreignKeysArray: { toString: { objectType: "users", getter: "getToStrings" } },
          embeddedObject: { valueOf: "users" },
        },
      }),
    ).toEqual([
      'tasks: foreignKeys field "constructor" is not a valid identifier or is reserved',
      'tasks: foreignKeysArray field "toString" is not a valid identifier or is reserved',
      'tasks: embeddedObject field "valueOf" is not a valid identifier or is reserved',
    ]);
    // the lookups themselves stay own-property: an inherited "constructor" never counts as declared
    expect(
      withDefs({
        tasks: { index: "id", hasMany: { tags: { objectType: "users", through: "joins", thisKey: "constructor", otherKey: "valueOf", getter: "getTags" } } },
        joins: { index: "id", belongsTo: ["tasks"] },
      }),
    ).toEqual([
      'tasks: hasMany.tags: thisKey "constructor" is not a valid identifier or is reserved',
      'tasks: hasMany.tags: otherKey "valueOf" is not a valid identifier or is reserved',
    ]); // an invalid key is not also looked up in the join bucket
  });

  test("getters, model names and relation names may not be reserved words or class plumbing (review 3, finding 2)", () => {
    expect(
      withDefs({
        tasks: {
          index: "id",
          model: "Object",
          foreignKeys: { owner_id: { objectType: "users", getter: "constructor" }, creator_id: { objectType: "users", getter: "delete" } },
          relatedObjectType: { __proto__x: { objectType: "users", key: "id", getter: "getX" } },
        },
      }).filter((m) => m.includes("reserved")),
    ).toEqual([
      'tasks: model "Object" is a reserved name',
      'tasks: foreignKeys.owner_id getter "constructor" is a reserved name',
      'tasks: foreignKeys.creator_id getter "delete" is a reserved name',
    ]);
    expect(withDefs({ things: { index: "id", foreignKeys: { x: { objectType: "users", getter: "clone" } } } })).toEqual([
      'things: foreignKeys.x getter "clone" is a reserved name',
    ]);
    for (const model of ["Map", "Promise", "PassiveModel", "class"]) {
      expect(withDefs({ things: { index: "id", model } })).toEqual([`things: model "${model}" is a reserved name`]);
    }
    expect(withDefs({ things: { index: "id", foreignKeys: { x: { objectType: "users", getter: "id" } } } })).toEqual([
      'things: foreignKeys.x getter "id" is a reserved name',
      'things: foreignKeys.x getter "id" collides with the data field declared by index',
    ]);
    // "id" is fine as a FIELD name (it is the usual index, and a 1:1 FK on the index is legal)
    expect(withDefs({ things: { index: "id", foreignKeys: { id: { objectType: "users", getter: "getUser" } } } })).toEqual([]);
    // a data field named like a model method would shadow it
    expect(withDefs({ things: { index: "id", foreignKeys: { clone: { objectType: "users", getter: "getClone" } } } })).toEqual([
      'things: foreignKeys field "clone" is not a valid identifier or is reserved',
    ]);
  });

  test("a __proto__ key in a schema literal is detected as a non-plain record (review 3, finding 3)", () => {
    const relatedObjectType = { __proto__: { objectType: "nope", key: "x", getter: "getX" } } as unknown as ModelDefinition["relatedObjectType"];
    expect(withDefs({ users: { index: "id", model: "UserModel", relatedObjectType } })).toEqual([
      'users: relatedObjectType has a non-plain prototype (a "__proto__" key in the literal?) — that entry was silently dropped',
    ]);
    const foreignKeys = { __proto__: { objectType: "users", getter: "getX" } } as unknown as ModelDefinition["foreignKeys"];
    expect(withDefs({ things: { index: "id", foreignKeys } })).toEqual([
      'things: foreignKeys has a non-plain prototype (a "__proto__" key in the literal?) — that entry was silently dropped',
    ]);
  });

  test("the index name, type names and metaData keys go through the reserved check (review 4, findings 1, 4)", () => {
    for (const index of ["clone", "constructor", "__proto__", "toString"]) {
      expect(validateModelDefinitions({ things: { index } })).toEqual([`things: index "${index}" is not a valid identifier or is reserved`]);
    }
    expect(validateModelDefinitions({ things: { index: "id" } })).toEqual([]); // "id" is fine as a field
    for (const type of ["constructor", "hasOwnProperty", "__proto__x".replace("x", ""), "id", "generation", "reset"]) {
      expect(validateModelDefinitions({ [type]: { index: "id" } })).toEqual([`"${type}" is a reserved object type name`]);
    }
    expect(validateModelDefinitions({ things: { index: "id", metaData: ["__proto__", "ok"] } })).toEqual([
      'things: metaData key "__proto__" is not a valid identifier or is reserved',
    ]);
  });

  test("relation names use the member tier: `id` is refused (review 4, finding 2)", () => {
    expect(
      withDefs({
        tasks: { index: "id", foreignKeys: { owner_id: { objectType: "users", getter: "getOwner" } } },
        users: { index: "id", model: "UserModel", relatedObjectType: { id: { objectType: "tasks", key: "owner_id", getter: "getTasks" } } },
      }),
    ).toEqual(['users: relatedObjectType.id relation name "id" is a reserved name', 'users: relatedObjectType.id relation name "id" collides with the data field declared by index']);
  });

  test("getters may not collide with data fields, and relation names are unique across relatedObjectType and hasMany (review 4, finding 3)", () => {
    expect(
      withDefs({
        tasks: {
          index: "id",
          foreignKeys: { assignee_id: { objectType: "users", getter: "assignee" } },
          embeddedObject: { assignee: "users" }, // declared AFTER the getter: still caught
        },
      }),
    ).toEqual(['tasks: foreignKeys.assignee_id getter "assignee" collides with the data field declared by embeddedObject.assignee']);
    expect(
      withDefs({
        tasks: { index: "id", foreignKeys: { project_id: { objectType: "projects", getter: "id" } } },
      }),
    ).toEqual(['tasks: foreignKeys.project_id getter "id" is a reserved name', 'tasks: foreignKeys.project_id getter "id" collides with the data field declared by index']);
    expect(
      withDefs({
        tags: { index: "id", model: "TagModel", foreignKeys: { task_id: { objectType: "tasks", getter: "getTask" } } },
        joins: { index: "id", foreignKeys: { task_id: { objectType: "tasks", getter: "getTask" }, tag_id: { objectType: "tags", getter: "getTag" } }, belongsTo: ["tasks"] },
        tasks: {
          index: "id",
          relatedObjectType: { tags: { objectType: "tags", key: "task_id", getter: "getTagRows" } },
          hasMany: { tags: { objectType: "tags", through: "joins", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } },
        },
      }),
    ).toEqual(['tasks: member "tags" is declared by both relatedObjectType.tags and hasMany.tags']);
  });

  test("null-prototype maps are plain; the top-level map and each definition are checked too (review 4, finding 5)", () => {
    const foreignKeys = Object.assign(Object.create(null) as Record<string, ForeignKeyDefinition>, { owner_id: { objectType: "users", getter: "getOwner" } });
    expect(withDefs({ things: { index: "id", foreignKeys } })).toEqual([]);

    const top = { __proto__: { ghosts: { index: "id" } }, users: { index: "id", model: "UserModel" } } as unknown as Record<string, ModelDefinition>;
    expect(validateModelDefinitions(top)).toEqual([
      'the definitions map has a non-plain prototype (a "__proto__" key in the literal?) — that entry was silently dropped',
    ]);

    const def = { index: "id", __proto__: { foreignKeys: { x: { objectType: "nope", getter: "getX" } } } } as unknown as ModelDefinition;
    expect(validateModelDefinitions({ things: def }).filter((m) => m.includes("non-plain"))).toEqual([
      'things: definition has a non-plain prototype (a "__proto__" key in the literal?) — that entry was silently dropped',
    ]);
  });

  test("model-name verdicts do not depend on the runtime: ECMAScript built-ins are refused, host globals are not (review 5, findings 1, 8)", () => {
    for (const model of ["Object", "Map", "Promise", "Uint8Array", "Intl", "TypeError", "globalThis", "PassiveModel"]) {
      expect(withDefs({ things: { index: "id", model } })).toEqual([`things: model "${model}" is a reserved name`]);
    }
    // happy-dom registers these on globalThis under `bun test`; plain bun and the generator do not — same verdict here
    for (const model of ["Comment", "Text", "Image", "Response", "URL", "ThingModel"]) {
      expect(withDefs({ things: { index: "id", model } })).toEqual([]);
    }
    expect(Object.hasOwn(globalThis, "Comment")).toBe(true); // proves the environment would have flipped the old check
  });

  test("the validator reports instead of throwing on null or wrongly typed entries (review 5, findings 4, 7)", () => {
    expect(validateModelDefinitions({ things: null as unknown as ModelDefinition })).toEqual(["things: definition must be an object"]);
    expect(withDefs({ things: { index: "id", foreignKeys: { x: null as unknown as ForeignKeyDefinition } } })).toEqual(["things: foreignKeys.x must be an object"]);
    expect(withDefs({ things: { index: "id", foreignKeys: "nope" as unknown as ModelDefinition["foreignKeys"] } })).toEqual(["things: foreignKeys must be an object"]);
    expect(withDefs({ things: { index: "id", relatedObjectType: { t: null as unknown as RelatedObjectTypeDefinition } } })).toEqual(["things: relatedObjectType.t must be an object"]);
    expect(withDefs({ things: { index: "id", hasMany: { t: 5 as unknown as HasManyDefinition } } })).toEqual(["things: hasMany.t must be an object"]);
    expect(withDefs({ things: { index: "id", embeddedObject: { a: 1 as unknown as string } } })).toEqual(["things: embeddedObject.a must name a type"]);
    expect(withDefs({ things: { index: "id", belongsTo: "users" as unknown as string[] } })).toEqual(["things: belongsTo must be an array of type names"]);
    expect(withDefs({ things: { index: "id", metaData: "x" as unknown as string[] } })).toEqual(["things: metaData must be an array of keys"]);
    // a string belongsTo on the join bucket no longer satisfies hasMany through String.prototype.includes
    expect(
      withDefs({
        tags: { index: "id", model: "TagModel" },
        tasks: { index: "id", hasMany: { tags: { objectType: "tags", through: "joins", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } } },
        joins: {
          index: "id",
          foreignKeys: { task_id: { objectType: "tasks", getter: "getTask" }, tag_id: { objectType: "tags", getter: "getTag" } },
          belongsTo: "tasks,tags" as unknown as string[],
        },
      }),
    ).toEqual([
      'tasks: hasMany.tags: joins.belongsTo must include "tasks" so association caches invalidate',
      "joins: belongsTo must be an array of type names",
    ]);
  });

  test("an unknown hasMany target still gets every check that does not need it (review 5, finding 5)", () => {
    expect(
      withDefs({
        tasks: { index: "id", hasMany: { tags: { objectType: "tagz", through: "task_tags", thisKey: "task_id", otherKey: "task_id", getter: "getTags" } } },
        task_tags: { index: "id", foreignKeys: { tag_id: { objectType: "users", getter: "getTag" } } },
      }),
    ).toEqual([
      'tasks: hasMany.tags: thisKey and otherKey are both "task_id"',
      'tasks: hasMany.tags.objectType "tagz" is not a known type',
      "tasks: hasMany.tags: task_tags does not declare foreignKeys.task_id",
      'tasks: hasMany.tags: task_tags.belongsTo must include "tasks" so association caches invalidate',
    ]);
  });

  test("a missing getter, key or model is reported, never accepted as the name \"undefined\" (review 6, finding 1)", () => {
    expect(withDefs({ tasks: { index: "id", foreignKeys: { owner_id: { objectType: "users" } as unknown as ForeignKeyDefinition } } })).toEqual([
      "tasks: foreignKeys.owner_id getter is missing or not a string",
    ]);
    expect(
      withDefs({
        tasks: { index: "id", foreignKeys: { undefined: { objectType: "users", getter: "getU" } } },
        users: { index: "id", model: "UserModel", relatedObjectType: { tasks: { objectType: "tasks", getter: "getTasks" } as unknown as RelatedObjectTypeDefinition } },
      }),
    ).toEqual(['users: relatedObjectType.tasks.key "undefined" is not a valid identifier or is reserved']);
    expect(
      withDefs({
        tags: { index: "id", model: "TagModel" },
        joins: { index: "id", foreignKeys: { undefined: { objectType: "tasks", getter: "getT" } }, belongsTo: ["tasks"] },
        tasks: { index: "id", hasMany: { tags: { objectType: "tags", through: "joins", getter: "getTags" } as unknown as HasManyDefinition } },
      }),
    ).toEqual([
      'tasks: hasMany.tags: thisKey "undefined" is not a valid identifier or is reserved',
      'tasks: hasMany.tags: otherKey "undefined" is not a valid identifier or is reserved',
    ]);
    expect(withDefs({ things: { index: "id", model: null as unknown as string } })).toEqual(["things: model must be a string"]);
    expect(withDefs({ things: { index: "id", foreignKeys: { x: { getter: "getX" } as unknown as ForeignKeyDefinition } } })).toEqual([
      'things: foreignKeys.x points at unknown type "undefined"',
    ]);
  });

  test("a null definition reached through a reference is reported once and never crashes the validator (review 6, finding 2)", () => {
    expect(
      validateModelDefinitions({
        users: { index: "id", relatedObjectType: { tasks: { objectType: "tasks", key: "owner_id", getter: "getTasks" } } },
        tasks: null as unknown as ModelDefinition,
      }),
    ).toEqual(["tasks: definition must be an object"]);
    expect(
      validateModelDefinitions({
        tags: { index: "id" },
        tasks: { index: "id", hasMany: { tags: { objectType: "tags", through: "joins", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } } },
        joins: "nope" as unknown as ModelDefinition,
      }),
    ).toEqual(["joins: definition must be an object"]);
    expect(
      validateModelDefinitions({
        tags: { index: "id" },
        tasks: { index: "id", hasMany: { tags: { objectType: "tags", through: "joins", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } } },
        joins: { index: "id", foreignKeys: "nope" as unknown as ModelDefinition["foreignKeys"], belongsTo: ["tasks"] },
      }),
    ).toEqual([
      "tasks: hasMany.tags: joins does not declare foreignKeys.task_id",
      "tasks: hasMany.tags: joins does not declare foreignKeys.tag_id",
      "joins: foreignKeys must be an object",
    ]);
  });

  test("the custom-map guard rejects unusable definitions clearly and never caches, so any mutation is seen (review 6 findings 6, 7; review 7 finding 2)", () => {
    // a frozen outer map with a mutable inner definition: the case a frozen-map cache would miss
    const inner: ModelDefinition = { index: "id" };
    const outerFrozen = Object.freeze({ t: inner }) as Record<string, ModelDefinition>;
    expect(invalidForeignKeyFields("t", { id: 1, fk: NaN }, outerFrozen)).toEqual([]);
    inner.foreignKeys = { fk: { objectType: "t", getter: "getFk" } };
    expect(invalidForeignKeyFields("t", { id: 1, fk: NaN }, outerFrozen)).toEqual(["fk"]);

    expect(() => invalidForeignKeyFields("x", { id: 1 }, { x: null as unknown as ModelDefinition })).toThrow(/definition for "x" is not a usable definition/);
    expect(() => invalidForeignKeyFields("x", { id: 1 }, { x: { index: 5 as unknown as string } })).toThrow(/not a usable definition/);
    expect(invalidForeignKeyFields("x", { id: 1, "0": true }, { x: { index: "id", foreignKeys: "nope" as unknown as ModelDefinition["foreignKeys"] } })).toEqual([]);

    // mutable map: a foreign key added after the first call is seen by the next
    const mutable: Record<string, ModelDefinition> = { tasks: { index: "id", foreignKeys: {} } };
    expect(invalidForeignKeyFields("tasks", { id: 1, owner_id: NaN }, mutable)).toEqual([]);
    mutable.tasks!.foreignKeys!.owner_id = { objectType: "users", getter: "getOwner" };
    expect(invalidForeignKeyFields("tasks", { id: 1, owner_id: NaN }, mutable)).toEqual(["owner_id"]);

  });

  test("the guard allocates nothing for a clean record and reports the index once when it is also a foreign key (review 7, findings 7, 10)", () => {
    const clean = invalidForeignKeyFields("tasks", { id: 1, project_id: 1 });
    expect(clean).toEqual([]);
    expect(Object.isFrozen(clean)).toBe(true);
    expect(invalidForeignKeyFields("tasks", { id: 2, project_id: 1 })).toBe(clean); // the shared empty result
    const oneToOne: Record<string, ModelDefinition> = { users: { index: "id" }, profiles: { index: "id", foreignKeys: { id: { objectType: "users", getter: "getUser" } } } };
    expect(invalidForeignKeyFields("profiles", { id: NaN }, oneToOne)).toEqual(["id"]);
    expect(invalidForeignKeyFields("profiles", { id: null }, oneToOne)).toEqual(["id"]); // the index may not be null even as a FK
  });

  test("null or mistyped foreignKeys / foreignKeysArray are reported, never thrown on, and produce no false clash (review 7, finding 1)", () => {
    expect(
      withDefs({ t: { index: "id", foreignKeys: null as unknown as ModelDefinition["foreignKeys"], foreignKeysArray: { m: { objectType: "users", getter: "getM" } } } }),
    ).toEqual(["t: foreignKeys must be an object"]);
    expect(
      withDefs({ t: { index: "id", foreignKeysArray: null as unknown as ModelDefinition["foreignKeysArray"], embeddedObject: { a: "users" } } }),
    ).toEqual(["t: foreignKeysArray must be an object"]);
    expect(
      withDefs({ t: { index: "id", foreignKeys: "ab" as unknown as ModelDefinition["foreignKeys"], foreignKeysArray: { "0": { objectType: "users", getter: "getZero" } } } }),
    ).toEqual(["t: foreignKeys must be an object", 't: foreignKeysArray field "0" is not a valid identifier or is reserved']);
  });

  test("a non-object definitions map is reported, not thrown on (review 7, finding 6)", () => {
    for (const bad of [null, undefined, "nope", 42, [] as unknown]) {
      expect(validateModelDefinitions(bad as unknown as Record<string, ModelDefinition>)).toEqual(["definitions must be an object"]);
    }
  });

  test("model names may not clash with the generator's own classes or its AppData suffix (review 8, finding 8)", () => {
    for (const model of ["DataCache", "DataCacheIndex", "AppDataFactory", "AppDataModelFactory", "ModelFactory", "ModelConstructors"]) {
      expect(withDefs({ things: { index: "id", model } })).toEqual([`things: model "${model}" is a reserved name`]);
    }
    expect(withDefs({ a: { index: "id", model: "X" }, b: { index: "id", model: "XAppData" } })).toEqual([
      'b: model "XAppData" ends with "AppData", the suffix of generated base classes',
    ]);
  });

  test("duplicate belongsTo and metaData entries are reported (review 8, finding 9)", () => {
    expect(withDefs({ t: { index: "id", belongsTo: ["users", "users"], metaData: ["a", "a"] } })).toEqual([
      't: belongsTo lists "users" twice',
      't: metaData lists "a" twice',
    ]);
  });

  test("a metaData key gets a getX() accessor, which is a member; the key itself may not be a data field (review 10 finding 9, step 8 review finding 1)", () => {
    expect(
      withDefs({
        things: { index: "id", foreignKeys: { owner_id: { objectType: "users", getter: "getOwner" } }, metaData: ["owner", "owner_id", "limits"] },
      }),
    ).toEqual([
      'things: member "getOwner" is declared by both foreignKeys.owner_id and metaData.owner',
      'things: metaData key "owner_id" is also the data field declared by foreignKeys.owner_id',
    ]);
    expect(withDefs({ things: { index: "id", metaData: ["id"] } })).toEqual(['things: metaData key "id" is also the data field declared by index']);
    // the accessor name, not the key, is what must be a valid member: a key named like another getter is fine
    expect(withDefs({ things: { index: "id", foreignKeys: { owner_id: { objectType: "users", getter: "getOwner" } }, metaData: ["getOwner"] } })).toEqual([]);
    expect(metaDataGetterName("subscription_limits")).toBe("getSubscriptionLimits");
  });

  test("generated record names must be derivable and unique, or TypeScript would merge the interfaces (step 8 review, finding 5)", () => {
    expect(withDefs({ task_tags: { index: "id" }, taskTags: { index: "id" } })).toEqual(['taskTags: generated record name "TaskTagsRecord" is also generated for "task_tags"']);
    expect(withDefs({ comments: { index: "id" }, Comments: { index: "id" } })).toEqual(['Comments: generated record name "CommentsRecord" is also generated for "comments"']);
    expect(withDefs({ _: { index: "id" } })).toEqual(["_: no generated record name can be derived (the name has no letters or digits)"]);
    // model classes are named by `model`, so two such types never collide on a record name
    expect(withDefs({ task_tags: { index: "id", model: "LinkModel" }, taskTags: { index: "id" } })).toEqual([]);
    expect(recordTypeName("task_tags_relation")).toBe("TaskTagsRelationRecord");
    expect(pascalCase("current_users")).toBe("CurrentUsers");
  });

  test("a Symbol objectType reached through a reference is reported, not thrown (review 16, finding 1)", () => {
    // the child's own pointer check reports the symbol; the parent's key check must not throw on it
    const symbol = Symbol("users") as unknown as string;
    expect(
      withDefs({
        people: { index: "id", relatedObjectType: { tasks: { objectType: "tasks", key: "owner_id", getter: "getTasks" } } },
        tasks: { index: "id", foreignKeys: { owner_id: { objectType: symbol, getter: "getOwner" } } },
      }),
    ).toEqual([
      'people: relatedObjectType.tasks.key "owner_id" points at Symbol(users), not people',
      'tasks: foreignKeys.owner_id points at unknown type "Symbol(users)"',
    ]);
    // the same through a hasMany join key
    expect(
      withDefs({
        tasks: {
          index: "id",
          hasMany: { tags: { objectType: "tags", through: "links", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } },
        },
        tags: { index: "id" },
        links: { index: "id", belongsTo: ["tasks"], foreignKeys: { task_id: { objectType: symbol, getter: "getTask" }, tag_id: { objectType: "tags", getter: "getTag" } } },
      }),
    ).toEqual([
      'tasks: hasMany.tags: links.task_id points at Symbol(users), not tasks',
      'links: foreignKeys.task_id points at unknown type "Symbol(users)"',
    ]);
  });

  test("the schema validator and the server's body validators share one record predicate (review 16, finding 5)", () => {
    for (const notRecord of [null, undefined, [], "x", 1, true]) expect(isRecord(notRecord)).toBe(false);
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    // a definitions map that is an array is not a record, exactly as a request body that is an array is not
    expect(validateModelDefinitions([] as unknown as Record<string, ModelDefinition>)).toEqual(["definitions must be an object"]);
  });

  test("the write guard throws its own clear error for a non-object record (review 10, finding 3)", () => {
    for (const record of [null, undefined, "row", 42, [1]]) {
      expect(() => invalidForeignKeyFields("tasks", record as unknown as Record<string, unknown>)).toThrow(/tasks record must be an object/);
    }
  });

  test("an own foreign key set to undefined means 'no value', like null: the guard accepts both (review 10 finding 4, review 12 finding 2)", () => {
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: undefined })).toEqual([]);
    expect(invalidForeignKeyFields("tasks", { id: 1, project_id: null })).toEqual([]);
    expect(invalidForeignKeyFields("tasks", { id: 1 })).toEqual([]);
  });

  test("a mistyped join foreign-key entry is reported once, by the join type, not blamed by hasMany (review 14, finding 9)", () => {
    expect(
      withDefs({
        tags: { index: "id", model: "TagModel" },
        tasks: { index: "id", hasMany: { tags: { objectType: "tags", through: "joins", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } } },
        joins: { index: "id", foreignKeys: { task_id: "tasks" as unknown as ForeignKeyDefinition, tag_id: { objectType: "tags", getter: "getTag" } }, belongsTo: ["tasks"] },
      }),
    ).toEqual(["joins: foreignKeys.task_id must be an object"]);
  });

  test("cascadeDelete must be a boolean (review 7, finding 5)", () => {
    expect(
      withDefs({
        tasks: { index: "id", foreignKeys: { owner_id: { objectType: "users", getter: "getOwner" } } },
        users: { index: "id", model: "UserModel", relatedObjectType: { tasks: { objectType: "tasks", key: "owner_id", getter: "getTasks", cascadeDelete: "false" as unknown as boolean } } },
      }),
    ).toEqual(["users: relatedObjectType.tasks.cascadeDelete must be a boolean"]);
  });

  test("`then` and `toJSON` are reserved everywhere a name becomes a member or field (review 9, finding 6)", () => {
    expect(withDefs({ things: { index: "id", foreignKeys: { then: { objectType: "users", getter: "getThen" } } } })).toEqual([
      'things: foreignKeys field "then" is not a valid identifier or is reserved',
    ]);
    expect(withDefs({ things: { index: "id", foreignKeys: { x: { objectType: "users", getter: "toJSON" } } } })).toEqual([
      'things: foreignKeys.x getter "toJSON" is a reserved name',
    ]);
    expect(
      withDefs({
        tasks: { index: "id", foreignKeys: { owner_id: { objectType: "users", getter: "getOwner" } } },
        users: { index: "id", model: "UserModel", relatedObjectType: { then: { objectType: "tasks", key: "owner_id", getter: "getTasks" } } },
      }),
    ).toEqual(['users: relatedObjectType.then relation name "then" is a reserved name']);
  });

  test("newer built-ins and global functions are reserved class names too (review 6, finding 10)", () => {
    for (const model of ["Float16Array", "SuppressedError", "DisposableStack", "parseInt", "isNaN", "encodeURIComponent", "escape"]) {
      expect(withDefs({ things: { index: "id", model } })).toEqual([`things: model "${model}" is a reserved name`]);
    }
  });

  test("the write guard rejects unknown and prototype-named types clearly, on both paths (review 5, finding 2)", () => {
    expect(() => invalidForeignKeyFields("project" as ObjectType, { id: 1 })).toThrow(/unknown object type "project" \(is it a singular push name\?\)/);
    expect(() => invalidForeignKeyFields("toString" as ObjectType, { id: 1 })).toThrow(/unknown object type "toString"/);
    expect(() => assertForeignKeyValues("constructor" as ObjectType, { id: 1 })).toThrow(/unknown object type/);
    const defs: Record<string, ModelDefinition> = { things: { index: "id" } };
    expect(() => invalidForeignKeyFields("toString", { id: 1 }, defs)).toThrow(/unknown object type "toString"/);
    expect(() => assertForeignKeyValues("nope", { id: 1 }, defs)).toThrow(/unknown object type "nope"/);
    expect(invalidForeignKeyFields("things", { id: 1 }, defs)).toEqual([]);
  });

  test("the event bus and the write guard share one key rule (review 5, finding 3)", () => {
    for (const bad of [NaN, Infinity, "", " 1", "1 "]) {
      expect(isKeyValue(bad)).toBe(false);
      expect(isForeignKeyValue(bad)).toBe(false);
    }
    for (const ok of [1, "1", "a b"]) {
      expect(isKeyValue(ok)).toBe(true);
      expect(isForeignKeyValue(ok)).toBe(true);
    }
    expect(isKeyValue(null)).toBe(false); // a key is never null…
    expect(isForeignKeyValue(null)).toBe(true); // …but a foreign key may be
  });

  test("the index may not be declared as an array foreign key (review 3, finding 1)", () => {
    expect(withDefs({ things: { index: "id", foreignKeysArray: { id: { objectType: "users", getter: "getIds" } } } })).toEqual([
      "things: foreignKeysArray.id is the index field (the index must be a scalar)",
    ]);
    // …but a 1:1 single foreign key on the index is a legal shape
    expect(withDefs({ things: { index: "id", foreignKeys: { id: { objectType: "users", getter: "getUser" } } } })).toEqual([]);
  });

  test("an unknown hasMany target does not also blame a correct join table (review 3, finding 9)", () => {
    expect(
      withDefs({
        tags: { index: "id", model: "TagModel" },
        tasks: { index: "id", hasMany: { tags: { objectType: "tagz", through: "task_tags", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" } } },
        task_tags: {
          index: "id",
          foreignKeys: { task_id: { objectType: "tasks", getter: "getTask" }, tag_id: { objectType: "tags", getter: "getTag" } },
          belongsTo: ["tasks", "tags"],
        },
      }),
    ).toEqual(['tasks: hasMany.tags.objectType "tagz" is not a known type']);
  });

  test("assertValidModelDefinitions throws with every problem listed", () => {
    expect(() => assertValidModelDefinitions({ a: { index: "id", foreignKeys: { b_id: { objectType: "b", getter: "getB" } } } })).toThrow(
      /unknown type "b"/,
    );
  });
});

describe("foreign-key values", () => {
  test("single keys: non-empty strings, finite numbers and null pass; NaN, Infinity, \"\", padded strings and non-scalars fail (review findings 2, 3; review 4 finding 9)", () => {
    for (const ok of [1, 0, -5, -0, 1.5, "1", "1.0", "abc", "a b", null, undefined]) expect(isForeignKeyValue(ok)).toBe(true);
    for (const bad of [NaN, Infinity, -Infinity, "", " 1", "1 ", "\t1", true, false, {}, { id: 1 }, [1], 1n]) expect(isForeignKeyValue(bad)).toBe(false);
  });

  test("array keys: arrays of non-null scalars pass; anything else fails, including sparse arrays (review 3, finding 5)", () => {
    for (const ok of [[], [1, 2], ["a", 1], null, undefined]) expect(isForeignKeyArrayValue(ok)).toBe(true);
    for (const bad of ["1,2", 3, [{ id: 1 }], [1, null], [NaN], [""], {}]) expect(isForeignKeyArrayValue(bad)).toBe(false);
    // eslint-disable-next-line no-sparse-arrays
    expect(isForeignKeyArrayValue([1, , 2])).toBe(false);
    expect(isForeignKeyArrayValue(new Array(3))).toBe(false);
    const grown: number[] = [1];
    grown.length = 3;
    expect(isForeignKeyArrayValue(grown)).toBe(false);
  });

  test("a bad index that is also a 1:1 foreign key is reported once (review 3 finding 10, review 4 finding 6)", () => {
    const defs: Record<string, ModelDefinition> = {
      users: { index: "id", model: "UserModel" },
      profiles: { index: "id", foreignKeys: { id: { objectType: "users", getter: "getUser" } } },
    };
    expect(validateModelDefinitions(defs)).toEqual([]);
    expect(invalidForeignKeyFields("profiles", { id: NaN }, defs)).toEqual(["id"]);
    expect(invalidForeignKeyFields("profiles", { id: 1 }, defs)).toEqual([]);
    expect(() => invalidForeignKeyFields("nope", { id: 1 }, defs)).toThrow(/unknown object type/);
    // and the real-map path still dedupes
    expect(invalidForeignKeyFields("tasks", { id: NaN, project_id: NaN })).toEqual(["id", "project_id"]);
  });

  test("canonicalKey is the one string form for map keys, imported from its own module (review 3 finding 4, review 4 finding 8, review 9 finding 7)", () => {
    expect(canonicalKey(1)).toBe("1");
    expect(canonicalKey("1")).toBe("1");
    expect(canonicalKey("7-3")).toBe("7-3");
    expect(canonicalKey(1)).toBe(canonicalKey("1"));
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
