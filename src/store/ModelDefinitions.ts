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
 *   relatedObjectType  children, keyed by RELATION NAME (a type may have several
 *                      relations to the same child type):
 *                      name → { objectType, key, getter, cascadeDelete? }
 *                      key is the child's FK field pointing at this type
 *   hasMany            many-to-many, keyed by relation name:
 *                      name → { objectType, through, thisKey, otherKey, getter }
 *   embeddedObject     response field → objectType; lifted into that bucket
 *   belongsTo          buckets whose derived indexes must be invalidated when
 *                      this type is written (join tables list both sides)
 *   metaData           opt-in keys of per-object side data (saveMetaData)
 *
 * VALUES: the index and every single foreign key must be a non-empty string or
 * a finite number (foreign keys may also be null); `foreignKeysArray` values
 * are arrays of those. Nothing downstream validates this — the event bus
 * accepts any string or number (NaN and "" included) and skips other types
 * without a word — so `assertForeignKeyValues` enforces it on write. Only
 * single foreign keys reach the event bus and the grouped indexes; array keys
 * have accessors but no per-value subscriptions.
 *
 * The exported map is deep-frozen; `definitionFor` returns a readonly view.
 */

export interface ForeignKeyDefinition {
  /** The bucket the value points at. */
  objectType: string;
  /** Name of the generated accessor, e.g. "getProject". */
  getter: string;
}

/** Same shape as a single foreign key; the generated accessor returns an array (e.g. "getMembers"). */
export type ForeignKeysArrayDefinition = ForeignKeyDefinition;

export interface RelatedObjectTypeDefinition {
  /** The child bucket. */
  objectType: string;
  /** The child's foreign-key field that points at this type. */
  key: string;
  /** Name of the generated accessor, e.g. "getTasks". */
  getter: string;
  /** Remove the children when this object is removed. */
  cascadeDelete?: boolean;
}

export interface HasManyDefinition {
  /** The other side's bucket. */
  objectType: string;
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

export const ModelDefinitions = deepFreeze({
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
      tasks: { objectType: "tasks", key: "project_id", getter: "getTasks", cascadeDelete: true },
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
      comments: { objectType: "comments", key: "task_id", getter: "getComments", cascadeDelete: true },
      // the server deletes a task's tag links with it; the client must too
      tagLinks: { objectType: "task_tags_relation", key: "task_id", getter: "getTagLinks", cascadeDelete: true },
    },
    hasMany: {
      tags: { objectType: "tags", through: "task_tags_relation", thisKey: "task_id", otherKey: "tag_id", getter: "getTags" },
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
    relatedObjectType: {
      taskLinks: { objectType: "task_tags_relation", key: "tag_id", getter: "getTaskLinks", cascadeDelete: true },
    },
    hasMany: {
      tasks: { objectType: "tasks", through: "task_tags_relation", thisKey: "tag_id", otherKey: "task_id", getter: "getTasks" },
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
} as const satisfies Record<string, ModelDefinition>);

/** Recursively readonly: what runtime consumers get from `definitionFor`. */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Freezes every reachable object, including children of already-frozen ones. */
function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner, seen);
  }
  return value;
}

/** Every bucket name. Use this wherever an object type is named. */
export type ObjectType = keyof typeof ModelDefinitions;

export const objectTypes: readonly ObjectType[] = Object.freeze(Object.keys(ModelDefinitions) as ObjectType[]);

export function isObjectType(value: unknown): value is ObjectType {
  return typeof value === "string" && Object.hasOwn(ModelDefinitions, value);
}

/** The definition for a bucket, as a readonly view for runtime consumers. */
export function definitionFor(objectType: ObjectType): DeepReadonly<ModelDefinition> {
  return ModelDefinitions[objectType];
}

/** Per-type facts the write path needs, computed once (the schema is frozen). */
interface TypeFacts {
  readonly index: string;
  readonly foreignKeys: readonly string[];
  readonly foreignKeyArrays: readonly string[];
}

const TYPE_FACTS: Readonly<Record<ObjectType, TypeFacts>> = Object.freeze(
  Object.fromEntries(
    objectTypes.map((type) => {
      const def = ModelDefinitions[type] as ModelDefinition;
      return [
        type,
        Object.freeze({
          index: def.index,
          foreignKeys: Object.freeze(Object.keys(def.foreignKeys ?? {})),
          foreignKeyArrays: Object.freeze(Object.keys(def.foreignKeysArray ?? {})),
        }),
      ];
    }),
  ) as Record<ObjectType, TypeFacts>,
);

/** Names of the declared single foreign keys — what the event bus and grouped indexes need. Cached. */
export function foreignKeyNames(objectType: ObjectType): readonly string[] {
  return TYPE_FACTS[objectType].foreignKeys;
}

/** Names of the declared id-array foreign keys. Cached. */
export function foreignKeyArrayNames(objectType: ObjectType): readonly string[] {
  return TYPE_FACTS[objectType].foreignKeyArrays;
}

/**
 * The one canonical form of an index or foreign-key value for use as a Map
 * key. The write guard lets a key hold numbers or strings, and the event bus
 * keys on the string form; every index the cache builds (getById, grouped,
 * association) MUST key on this too, or `1` and `"1"` become two objects.
 */
export function canonicalKey(value: string | number): string {
  return typeof value === "string" ? value : String(value);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Names that are syntactically identifiers but cannot be emitted as a class
 * member, class name or property by the generator: JS reserved words, the
 * members every object/class already has, and PassiveModel's own methods.
 */
const RESERVED = new Set([
  // reserved words (ES2020 + strict mode)
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "let", "static", "implements", "interface", "package", "private", "protected", "public", "await", "arguments", "eval",
  // class / object plumbing
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toString", "toLocaleString", "valueOf",
  // PassiveModel (step 8) instance API
  "initializeFromJson", "clone",
]);

/** Additionally reserved for generated members (getters, relation names): the model's own `id` field. */
const RESERVED_MEMBERS = new Set([...RESERVED, "id"]);

/** Additionally reserved for generated class names: globals a generated `class X` would shadow in its module. */
const RESERVED_CLASS_NAMES = new Set([
  ...RESERVED,
  "Object", "Array", "Function", "String", "Number", "Boolean", "Symbol", "BigInt", "Date", "RegExp", "Error",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect", "JSON", "Math", "PassiveModel",
]);

/** Valid identifier that the generator may emit as a data field, join key or class name. */
function isEmittable(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED.has(name);
}

/**
 * A `__proto__` key in an object literal sets the prototype instead of adding
 * an entry, so the entry vanishes before validation can see it. Detect the
 * symptom: a schema record whose prototype is not the plain one.
 */
function checkPlainRecord(ctx: TypeContext, property: string, record: object | undefined): void {
  if (record !== undefined && Object.getPrototypeOf(record) !== Object.prototype) {
    problem(ctx, `${property} has a non-plain prototype (a "__proto__" key in the literal?) — that entry was silently dropped`);
  }
}

/** Own-property lookup: a field named "constructor" or "toString" must not resolve to Object.prototype. */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

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
  else if (RESERVED_MEMBERS.has(getter)) problem(ctx, `${owner} getter "${getter}" is a reserved name`);
  const previous = ctx.getters.get(getter);
  if (previous) problem(ctx, `getter "${getter}" is declared by both ${previous} and ${owner}`);
  else ctx.getters.set(getter, owner);
}

function checkNameAndIndex(ctx: TypeContext): void {
  if (!IDENTIFIER.test(ctx.type)) ctx.problems.push(`"${ctx.type}" is not a valid object type name`);
  const { index } = ctx.def;
  if (typeof index !== "string" || index === "") problem(ctx, "index must be a non-empty field name");
  else if (!IDENTIFIER.test(index)) problem(ctx, `index "${index}" is not a valid identifier`);
}

function checkModel(ctx: TypeContext): void {
  const { model } = ctx.def;
  if (model === undefined) return;
  if (!IDENTIFIER.test(model)) problem(ctx, `model "${model}" is not a valid identifier`);
  else if (RESERVED_CLASS_NAMES.has(model)) problem(ctx, `model "${model}" is a reserved name`);
  const owner = ctx.models.get(model);
  if (owner) problem(ctx, `model "${model}" is also used by ${owner}`);
  else ctx.models.set(model, ctx.type);
}

/** `foreignKeys` and `foreignKeysArray`: each points at a known type and claims its getter. */
function checkPointers(ctx: TypeContext, property: string, pointers: Record<string, ForeignKeyDefinition> | undefined): void {
  checkPlainRecord(ctx, property, pointers);
  for (const [field, fk] of Object.entries(pointers ?? {})) {
    if (!isEmittable(field)) problem(ctx, `${property} field "${field}" is not a valid identifier or is reserved`);
    if (property === "foreignKeysArray" && own(ctx.def.foreignKeys, field)) {
      problem(ctx, `"${field}" is declared in both foreignKeys and foreignKeysArray`);
    }
    if (property === "foreignKeysArray" && field === ctx.def.index) {
      problem(ctx, `foreignKeysArray.${field} is the index field (the index must be a scalar)`);
    }
    if (!isKnown(ctx, fk.objectType)) problem(ctx, `${property}.${field} points at unknown type "${fk.objectType}"`);
    claimGetter(ctx, fk.getter, `${property}.${field}`);
  }
}

/** Each relation names a child type that declares `key` as a foreign key pointing back at this type. */
function checkRelatedObjectTypes(ctx: TypeContext): void {
  checkPlainRecord(ctx, "relatedObjectType", ctx.def.relatedObjectType);
  for (const [name, rel] of Object.entries(ctx.def.relatedObjectType ?? {})) {
    const label = `relatedObjectType.${name}`;
    if (!isEmittable(name)) problem(ctx, `${label}: relation name is not a valid identifier or is reserved`);
    claimGetter(ctx, rel.getter, label);
    if (!isEmittable(rel.key)) problem(ctx, `${label}.key "${rel.key}" is not a valid identifier or is reserved`);
    if (!isKnown(ctx, rel.objectType)) {
      problem(ctx, `${label}.objectType "${rel.objectType}" is not a known type`);
      continue;
    }
    const childFk = own(ctx.definitions[rel.objectType]!.foreignKeys, rel.key);
    if (!childFk) {
      problem(ctx, `${label}.key "${rel.key}" is not declared in ${rel.objectType}.foreignKeys (grouped index + events need it)`);
    } else if (childFk.objectType !== ctx.type) {
      problem(ctx, `${label}.key "${rel.key}" points at ${childFk.objectType}, not ${ctx.type}`);
    }
  }
}

function checkHasMany(ctx: TypeContext): void {
  checkPlainRecord(ctx, "hasMany", ctx.def.hasMany);
  for (const [name, hm] of Object.entries(ctx.def.hasMany ?? {})) checkHasManyEntry(ctx, name, hm);
}

/** The join bucket must declare both keys, pointing at the right types, and list this type in `belongsTo`. */
function checkHasManyEntry(ctx: TypeContext, name: string, hm: HasManyDefinition): void {
  const label = `hasMany.${name}`;
  const otherType = hm.objectType;
  if (!isEmittable(name)) problem(ctx, `${label}: relation name is not a valid identifier or is reserved`);
  claimGetter(ctx, hm.getter, label);
  let resolvable = true;
  if (!isKnown(ctx, otherType)) {
    problem(ctx, `${label}.objectType "${otherType}" is not a known type`);
    resolvable = false;
  }
  if (!isKnown(ctx, hm.through)) {
    problem(ctx, `${label}.through "${hm.through}" is not a known type`);
    resolvable = false;
  }
  if (!resolvable) return; // join-key checks against an unknown type would only blame the join table
  const through = ctx.definitions[hm.through]!;
  for (const key of [hm.thisKey, hm.otherKey]) {
    if (!isEmittable(key)) problem(ctx, `${label}: join key "${key}" is not a valid identifier or is reserved`);
  }
  if (hm.thisKey === hm.otherKey) problem(ctx, `${label}: thisKey and otherKey are both "${hm.thisKey}"`);
  checkJoinKey(ctx, label, hm.through, through, hm.thisKey, ctx.type);
  checkJoinKey(ctx, label, hm.through, through, hm.otherKey, otherType);
  if (!(through.belongsTo ?? []).includes(ctx.type)) {
    problem(ctx, `${label}: ${hm.through}.belongsTo must include "${ctx.type}" so association caches invalidate`);
  }
}

function checkJoinKey(ctx: TypeContext, label: string, throughType: string, through: ModelDefinition, key: string, expected: string): void {
  const fk = own(through.foreignKeys, key);
  if (!fk) problem(ctx, `${label}: ${throughType} does not declare foreignKeys.${key}`);
  else if (fk.objectType !== expected) problem(ctx, `${label}: ${throughType}.${key} points at ${fk.objectType}, not ${expected}`);
}

/** An embedded field is lifted out of the record, so it must not be a field the record needs. */
function checkEmbeddedObjects(ctx: TypeContext): void {
  const { def } = ctx;
  checkPlainRecord(ctx, "embeddedObject", def.embeddedObject);
  for (const [field, target] of Object.entries(def.embeddedObject ?? {})) {
    if (!isEmittable(field)) problem(ctx, `embeddedObject field "${field}" is not a valid identifier or is reserved`);
    if (field === def.index) problem(ctx, `embeddedObject.${field} is the index field`);
    if (own(def.foreignKeys, field)) problem(ctx, `embeddedObject.${field} is also declared in foreignKeys`);
    if (own(def.foreignKeysArray, field)) problem(ctx, `embeddedObject.${field} is also declared in foreignKeysArray`);
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

/**
 * What a single foreign-key field may hold: a non-empty string, a finite
 * number, or null/undefined. NaN, Infinity and "" would land an object in a
 * bucket nobody subscribes to, silently.
 */
export function isForeignKeyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value !== "";
}

/** What a `foreignKeysArray` field may hold: an array of non-null foreign-key values, or null/undefined. */
export function isForeignKeyArrayValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!Array.isArray(value)) return false;
  // an index loop, not `every`: `every` skips holes, so a sparse array would pass
  for (let i = 0; i < value.length; i++) {
    const v: unknown = value[i];
    if (v === null || v === undefined || !isForeignKeyValue(v)) return false;
  }
  return true;
}

/**
 * Checks one record's index field and declared foreign-key fields (single
 * and array). Returns the offending field names; empty means fine. The
 * cache calls this on write so a boolean, NaN or nested object in one of
 * those fields fails loudly instead of silently never notifying anyone.
 * The index is required and may not be null; foreign keys may be absent
 * (partial update) or null.
 */
export function invalidForeignKeyFields(objectType: ObjectType, record: Record<string, unknown>): string[] {
  const facts = TYPE_FACTS[objectType];
  const bad = new Set<string>();
  const id = own(record, facts.index);
  if (id === null || id === undefined || !isForeignKeyValue(id)) bad.add(facts.index);
  for (const field of facts.foreignKeys) {
    if (Object.hasOwn(record, field) && !isForeignKeyValue(record[field])) bad.add(field);
  }
  for (const field of facts.foreignKeyArrays) {
    if (Object.hasOwn(record, field) && !isForeignKeyArrayValue(record[field])) bad.add(field);
  }
  return [...bad];
}

export function assertForeignKeyValues(objectType: ObjectType, record: Record<string, unknown>): void {
  const bad = invalidForeignKeyFields(objectType, record);
  if (bad.length > 0) {
    throw new TypeError(
      `${objectType} record has invalid index/foreign key value(s): ${bad.join(", ")} ` +
        "(the index must be a non-empty string or finite number; single keys may also be null; array keys an array of those)",
    );
  }
}
