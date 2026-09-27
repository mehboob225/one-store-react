/**
 * ModelDefinitions — the schema registry.
 *
 * One entry per entity type (bucket). This is the single declarative source
 * the rest of the store is derived from:
 *
 *   - the generator (step 8) reads it to emit DataCache buckets and the
 *     `*AppData` model bases with their accessors;
 *   - DataCacheIndex (step 7) reads `index`, `foreignKeys`, `belongsTo` and
 *     `relatedObjectType[].cascadeDelete` at runtime;
 *   - AppDataModelFactory (step 9) reads `model` and `embeddedObject`;
 *   - the event bus (step 5) is handed `index` and the foreign-key names.
 *
 * Property reference:
 *
 *   index              identity field, used for dedupe and getById
 *   model              model class name registered in ModelConstructors;
 *                      omitted → records stay plain objects (join rows, comments)
 *   foreignKeys        single FKs: field → { objectType, getter }
 *                      → getX() accessor, grouped index, "type/fk/value" events.
 *                      DECLARE EVERY FK YOU WILL FILTER OR SUBSCRIBE BY.
 *   foreignKeysArray   id arrays: field → { objectType, getter } → getX(): Model[]
 *   relatedObjectType  children: childType → { key, getter, cascadeDelete? }
 *                      key is the child's FK field pointing at this type
 *   hasMany            many-to-many: otherType → { through, thisKey, otherKey, getter }
 *   embeddedObject     response field → objectType; lifted into that bucket
 *   belongsTo          buckets whose derived indexes must be invalidated when
 *                      this type is written (join tables list both sides)
 *   metaData           opt-in keys of per-object side data (saveMetaData)
 *
 * Foreign-key VALUES must be strings, numbers or null: the event bus ignores
 * anything else, silently. `assertForeignKeyValues` enforces this on write.
 */

export interface ForeignKeyDefinition {
  /** The bucket the value points at. */
  objectType: string;
  /** Name of the generated accessor, e.g. "getProject". */
  getter: string;
}

export interface ForeignKeysArrayDefinition {
  objectType: string;
  /** Name of the generated accessor returning an array, e.g. "getMembers". */
  getter: string;
}

export interface RelatedObjectTypeDefinition {
  /** The child's foreign-key field that points at this type. */
  key: string;
  /** Name of the generated accessor, e.g. "getTasks". */
  getter: string;
  /** Remove the children when this object is removed. */
  cascadeDelete?: boolean;
}

export interface HasManyDefinition {
  /** The join bucket. */
  through: string;
  /** Join field pointing at this type. */
  thisKey: string;
  /** Join field pointing at the other type. */
  otherKey: string;
  /** Name of the generated accessor, e.g. "getTags". */
  getter: string;
}

export interface ModelDefinition {
  index: string;
  model?: string;
  foreignKeys?: Record<string, ForeignKeyDefinition>;
  foreignKeysArray?: Record<string, ForeignKeysArrayDefinition>;
  relatedObjectType?: Record<string, RelatedObjectTypeDefinition>;
  hasMany?: Record<string, HasManyDefinition>;
  embeddedObject?: Record<string, string>;
  belongsTo?: readonly string[];
  metaData?: readonly string[];
}

// ---------------------------------------------------------------------------
// The demo domain. Delete these entries (and the demo server) when you start
// your own project; keep the shape. Every property above is exercised here.
// ---------------------------------------------------------------------------

export const ModelDefinitions = {
  users: {
    index: "id",
    model: "UserModel",
  },

  /** The logged-in user with `settings`; one record, id = the user's id. */
  current_users: {
    index: "id",
    model: "CurrentUserModel",
    metaData: ["subscription"],
  },

  projects: {
    index: "id",
    model: "ProjectModel",
    foreignKeys: {
      owner_id: { objectType: "users", getter: "getOwner" },
    },
    foreignKeysArray: {
      member_ids: { objectType: "users", getter: "getMembers" },
    },
    relatedObjectType: {
      tasks: { key: "project_id", getter: "getTasks", cascadeDelete: true },
    },
  },

  tasks: {
    index: "id",
    model: "TaskModel",
    foreignKeys: {
      project_id: { objectType: "projects", getter: "getProject" },
      assignee_id: { objectType: "users", getter: "getAssignee" },
    },
    relatedObjectType: {
      comments: { key: "task_id", getter: "getComments", cascadeDelete: true },
    },
    hasMany: {
      tags: { through: "task_tags_relation", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" },
    },
    embeddedObject: {
      assignee: "users",
    },
  },

  /** Plain rows: no model class. */
  comments: {
    index: "id",
    foreignKeys: {
      task_id: { objectType: "tasks", getter: "getTask" },
      author_id: { objectType: "users", getter: "getAuthor" },
    },
  },

  tags: {
    index: "id",
    model: "TagModel",
    hasMany: {
      tasks: { through: "task_tags_relation", thisKey: "tag_id", otherKey: "task_id", getter: "getTasks" },
    },
  },

  /** Join rows synthesised by the client (`saveObjectsBelongingTo`); composite string id "task-tag". */
  task_tags_relation: {
    index: "id",
    foreignKeys: {
      task_id: { objectType: "tasks", getter: "getTask" },
      tag_id: { objectType: "tags", getter: "getTag" },
    },
    belongsTo: ["tasks", "tags"],
  },
} as const satisfies Record<string, ModelDefinition>;

/** Every bucket name. Use this wherever an object type is named. */
export type ObjectType = keyof typeof ModelDefinitions;

export const objectTypes = Object.keys(ModelDefinitions) as ObjectType[];

export function isObjectType(value: unknown): value is ObjectType {
  return typeof value === "string" && Object.hasOwn(ModelDefinitions, value);
}

/** The definition for a bucket, typed loosely for runtime consumers. */
export function definitionFor(objectType: ObjectType): ModelDefinition {
  return ModelDefinitions[objectType];
}

/** Names of the declared single foreign keys — what the event bus and grouped indexes need. */
export function foreignKeyNames(objectType: ObjectType): string[] {
  return Object.keys(definitionFor(objectType).foreignKeys ?? {});
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Checks a definitions map for internal consistency. Returns a list of
 * problems; empty means valid. Checked by a test against the real map so a
 * broken schema fails CI, and usable on any map (tests, tooling).
 */
export function validateModelDefinitions(definitions: Record<string, ModelDefinition>): string[] {
  const problems: string[] = [];
  const models = new Map<string, string>();

  for (const [type, def] of Object.entries(definitions)) {
    const ctx: TypeContext = { definitions, problems, models, type, def, getters: new Map() };
    for (const check of TYPE_CHECKS) check(ctx);
  }

  return problems;
}

/** State for validating one type. `problems` and `models` are shared across the whole map. */
interface TypeContext {
  definitions: Record<string, ModelDefinition>;
  problems: string[];
  /** model class name → the type that declared it first */
  models: Map<string, string>;
  type: string;
  def: ModelDefinition;
  /** getter name → the property of this type that declared it first */
  getters: Map<string, string>;
}

/** Run in this order for each type, so problems are listed property by property. */
const TYPE_CHECKS: readonly ((ctx: TypeContext) => void)[] = [
  checkNameAndIndex,
  checkModel,
  (ctx) => checkPointers(ctx, "foreignKeys", ctx.def.foreignKeys),
  (ctx) => checkPointers(ctx, "foreignKeysArray", ctx.def.foreignKeysArray),
  checkRelatedObjectTypes,
  checkHasMany,
  checkEmbeddedObjects,
  checkBelongsTo,
  checkMetaData,
];

function problem(ctx: TypeContext, what: string): void {
  ctx.problems.push(`${ctx.type}: ${what}`);
}

function isKnown(ctx: TypeContext, type: string): boolean {
  return Object.hasOwn(ctx.definitions, type);
}

/** A getter must be a valid identifier and unique within its type. */
function claimGetter(ctx: TypeContext, getter: string, owner: string): void {
  if (!IDENTIFIER.test(getter)) problem(ctx, `${owner} getter "${getter}" is not a valid identifier`);
  const previous = ctx.getters.get(getter);
  if (previous) problem(ctx, `getter "${getter}" is declared by both ${previous} and ${owner}`);
  else ctx.getters.set(getter, owner);
}

function checkNameAndIndex(ctx: TypeContext): void {
  if (!IDENTIFIER.test(ctx.type)) ctx.problems.push(`"${ctx.type}" is not a valid object type name`);
  if (typeof ctx.def.index !== "string" || ctx.def.index === "") problem(ctx, "index must be a non-empty field name");
}

function checkModel(ctx: TypeContext): void {
  const { model } = ctx.def;
  if (model === undefined) return;
  if (!IDENTIFIER.test(model)) problem(ctx, `model "${model}" is not a valid identifier`);
  const owner = ctx.models.get(model);
  if (owner) problem(ctx, `model "${model}" is also used by ${owner}`);
  else ctx.models.set(model, ctx.type);
}

/** `foreignKeys` and `foreignKeysArray`: each points at a known type and claims its getter. */
function checkPointers(ctx: TypeContext, property: string, pointers: Record<string, ForeignKeyDefinition> | undefined): void {
  for (const [field, fk] of Object.entries(pointers ?? {})) {
    if (!isKnown(ctx, fk.objectType)) problem(ctx, `${property}.${field} points at unknown type "${fk.objectType}"`);
    claimGetter(ctx, fk.getter, `${property}.${field}`);
  }
}

/** Each child type must declare `key` as a foreign key pointing back at this type. */
function checkRelatedObjectTypes(ctx: TypeContext): void {
  for (const [childType, rel] of Object.entries(ctx.def.relatedObjectType ?? {})) {
    claimGetter(ctx, rel.getter, `relatedObjectType.${childType}`);
    if (!isKnown(ctx, childType)) {
      problem(ctx, `relatedObjectType.${childType} is not a known type`);
      continue;
    }
    const childFk = ctx.definitions[childType]!.foreignKeys?.[rel.key];
    if (!childFk) {
      problem(ctx, `relatedObjectType.${childType}.key "${rel.key}" is not declared in ${childType}.foreignKeys (grouped index + events need it)`);
    } else if (childFk.objectType !== ctx.type) {
      problem(ctx, `relatedObjectType.${childType}.key "${rel.key}" points at ${childFk.objectType}, not ${ctx.type}`);
    }
  }
}

function checkHasMany(ctx: TypeContext): void {
  for (const [otherType, hm] of Object.entries(ctx.def.hasMany ?? {})) checkHasManyEntry(ctx, otherType, hm);
}

/** The join bucket must declare both keys, pointing at the right types, and list this type in `belongsTo`. */
function checkHasManyEntry(ctx: TypeContext, otherType: string, hm: HasManyDefinition): void {
  const label = `hasMany.${otherType}`;
  claimGetter(ctx, hm.getter, label);
  if (!isKnown(ctx, otherType)) problem(ctx, `${label} is not a known type`);
  if (!isKnown(ctx, hm.through)) {
    problem(ctx, `${label}.through "${hm.through}" is not a known type`);
    return;
  }
  const through = ctx.definitions[hm.through]!;
  checkJoinKey(ctx, label, hm.through, through, hm.thisKey, ctx.type);
  checkJoinKey(ctx, label, hm.through, through, hm.otherKey, otherType);
  if (!(through.belongsTo ?? []).includes(ctx.type)) {
    problem(ctx, `${label}: ${hm.through}.belongsTo must include "${ctx.type}" so association caches invalidate`);
  }
}

function checkJoinKey(ctx: TypeContext, label: string, throughType: string, through: ModelDefinition, key: string, expected: string): void {
  const fk = through.foreignKeys?.[key];
  if (!fk) problem(ctx, `${label}: ${throughType} does not declare foreignKeys.${key}`);
  else if (fk.objectType !== expected) problem(ctx, `${label}: ${throughType}.${key} points at ${fk.objectType}, not ${expected}`);
}

function checkEmbeddedObjects(ctx: TypeContext): void {
  for (const [field, target] of Object.entries(ctx.def.embeddedObject ?? {})) {
    if (!isKnown(ctx, target)) problem(ctx, `embeddedObject.${field} points at unknown type "${target}"`);
  }
}

function checkBelongsTo(ctx: TypeContext): void {
  for (const target of ctx.def.belongsTo ?? []) {
    if (!isKnown(ctx, target)) problem(ctx, `belongsTo includes unknown type "${target}"`);
  }
}

function checkMetaData(ctx: TypeContext): void {
  for (const key of ctx.def.metaData ?? []) {
    if (!IDENTIFIER.test(key)) problem(ctx, `metaData key "${key}" is not a valid identifier`);
  }
}

/** Throws with every problem listed if the definitions are inconsistent. */
export function assertValidModelDefinitions(definitions: Record<string, ModelDefinition> = ModelDefinitions): void {
  const problems = validateModelDefinitions(definitions);
  if (problems.length > 0) throw new Error(`ModelDefinitions are invalid:\n  - ${problems.join("\n  - ")}`);
}

/** What a foreign-key field may hold. The event bus keys on string/number and ignores the rest. */
export function isForeignKeyValue(value: unknown): value is string | number | null | undefined {
  return value === null || value === undefined || typeof value === "string" || typeof value === "number";
}

/**
 * Checks one record's declared foreign-key fields. Returns the offending
 * field names; empty means fine. The cache calls this on write so a boolean
 * or nested object in a foreign-key field fails loudly instead of silently
 * never notifying anyone.
 */
export function invalidForeignKeyFields(objectType: ObjectType, record: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const field of foreignKeyNames(objectType)) {
    if (field in record && !isForeignKeyValue(record[field])) bad.push(field);
  }
  return bad;
}

export function assertForeignKeyValues(objectType: ObjectType, record: Record<string, unknown>): void {
  const bad = invalidForeignKeyFields(objectType, record);
  if (bad.length > 0) {
    throw new TypeError(`${objectType} record has non-scalar foreign key value(s): ${bad.join(", ")} (must be string, number or null)`);
  }
}
