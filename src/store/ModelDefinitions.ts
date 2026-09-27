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
 * VALUES: the index and every single foreign key must be a key value as
 * defined in canonicalKey.ts (a finite number or a non-empty, non-padded
 * string; foreign keys may also be null); `foreignKeysArray` values are
 * arrays of those. The event bus applies the same rule and silently skips
 * anything else, so `assertForeignKeyValues` enforces it on write, where a
 * bad value can be reported instead of dropped. Only single foreign keys
 * reach the event bus and the grouped indexes; array keys have accessors but
 * no per-value subscriptions.
 *
 * The exported map is deep-frozen; `definitionFor` returns a readonly view.
 */

import { hasField, isKeyValue, ownField } from "./canonicalKey";

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

function factsFor(def: ModelDefinition): TypeFacts {
  return Object.freeze({
    index: def.index,
    foreignKeys: Object.freeze(keysOf(def.foreignKeys)),
    foreignKeyArrays: Object.freeze(keysOf(def.foreignKeysArray)),
  });
}

const TYPE_FACTS: Readonly<Record<ObjectType, TypeFacts>> = Object.freeze(
  Object.fromEntries(objectTypes.map((type) => [type, factsFor(ModelDefinitions[type] as ModelDefinition)])) as Record<ObjectType, TypeFacts>,
);

/** Names of the declared single foreign keys — what the event bus and grouped indexes need. Cached. */
export function foreignKeyNames(objectType: ObjectType): readonly string[] {
  return TYPE_FACTS[objectType].foreignKeys;
}

/** Names of the declared id-array foreign keys. Cached. */
export function foreignKeyArrayNames(objectType: ObjectType): readonly string[] {
  return TYPE_FACTS[objectType].foreignKeyArrays;
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
  // names that change how every instance behaves: a thenable hangs `await`, toJSON rewrites serialisation
  "then", "toJSON",
  // PassiveModel (step 8) instance API
  "initializeFromJson", "clone",
]);

/** Additionally reserved for generated members (getters, relation names): the model's own `id` field. */
const RESERVED_MEMBERS = new Set([...RESERVED, "id"]);

/** Additionally reserved for bucket names: DataCache's own members (step 8). */
const RESERVED_BUCKET_NAMES = new Set([...RESERVED_MEMBERS, "generation", "reset", "eventsHandler", "updatedHandler"]);

/**
 * Reserved for generated class names: the ECMAScript built-ins a generated
 * `class X` would shadow in its module, plus the base class. Deliberately a
 * static list: a `globalThis` probe would make a schema's verdict depend on
 * the runtime doing the validating (happy-dom registers `Comment`, `Text`,
 * `Image`…; plain Bun does not). Host APIs (`Response`, `URL`) are not
 * reserved — model modules do not use them.
 */
const RESERVED_CLASS_NAMES = new Set([
  ...RESERVED,
  "Object", "Function", "Array", "Number", "Boolean", "String", "Symbol", "BigInt", "Date", "RegExp", "Promise",
  "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Proxy", "Reflect", "JSON", "Math", "Intl",
  "Atomics", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Iterator", "AsyncIterator",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "SuppressedError", "DisposableStack", "AsyncDisposableStack",
  // global functions and values
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent",
  "escape", "unescape", "globalThis", "undefined", "NaN", "Infinity",
  // the generator's own classes and registries (step 8)
  "PassiveModel", "DataCache", "DataCacheIndex", "AppDataFactory", "AppDataModelFactory", "ModelConstructors",
]);

/** The generator emits `<Model>AppData` base classes, so no model may take that suffix itself. */
const GENERATED_SUFFIX = "AppData";



/**
 * Valid identifier that the generator may emit as a data field, join key or
 * metaData key. Takes `unknown`: a missing value must fail, not be coerced
 * to the perfectly valid identifier "undefined" by the regex test.
 */
function isEmittable(name: unknown): name is string {
  return typeof name === "string" && IDENTIFIER.test(name) && !RESERVED.has(name);
}

/**
 * A `__proto__` key in an object literal sets the prototype instead of adding
 * an entry, so the entry vanishes before validation can see it. Detect the
 * symptom: a schema record whose prototype is not the plain one.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(record: object): boolean {
  const proto = Object.getPrototypeOf(record);
  return proto === Object.prototype || proto === null; // null-prototype maps are the safe way to avoid this
}

/**
 * A schema property that must be a record of entries. Reports (instead of
 * throwing on) a non-object value, so the validator stays usable on any
 * input, and reports a non-plain prototype. Returns whether it can be read.
 */
function checkPlainRecord(ctx: TypeContext, property: string, record: unknown): record is Record<string, unknown> {
  if (record === undefined) return false;
  if (!isRecord(record)) {
    problem(ctx, `${property} must be an object`);
    return false;
  }
  if (!isPlainRecord(record)) {
    problem(ctx, `${property} has a non-plain prototype (a "__proto__" key in the literal?) — that entry was silently dropped`);
  }
  return true;
}

/** An entry inside a schema record must itself be an object. */
function checkEntry(ctx: TypeContext, label: string, entry: unknown): entry is Record<string, unknown> {
  if (isRecord(entry)) return true;
  problem(ctx, `${label} must be an object`);
  return false;
}

/** Own-property lookup: a field named "constructor" or "toString" must not resolve to Object.prototype. */
/** Schema records are read with the same own-property rule as data fields (arrays are not records). */
function own<T>(record: Record<string, T> | null | undefined, key: string): T | undefined {
  return Array.isArray(record) ? undefined : ownField(record, key);
}

/** The own keys of a record, or none when the value is not a record (null, a string, …). */
function keysOf(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

/**
 * Checks a definitions map for internal consistency. Returns a list of
 * problems; empty means valid. Checked by a test against the real map so a
 * broken schema fails CI, and usable on any map (tests, tooling).
 */
export function validateModelDefinitions(definitions: Record<string, ModelDefinition>): string[] {
  const problems: string[] = [];
  const models = new Map<string, string>();

  if (!isRecord(definitions)) return ["definitions must be an object"];
  if (!isPlainRecord(definitions)) {
    problems.push('the definitions map has a non-plain prototype (a "__proto__" key in the literal?) — that entry was silently dropped');
  }

  for (const [type, def] of Object.entries(definitions)) {
    if (!isRecord(def)) {
      problems.push(`${type}: definition must be an object`);
      continue;
    }
    const ctx: TypeContext = { definitions, problems, models, type, def, fields: new Map(), members: new Map() };
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
  /** data field name → where it is declared (index / foreignKeys.x / foreignKeysArray.x / embeddedObject.x) */
  fields: Map<string, string>;
  /** generated member name (getter, relation) → the property of this type that declared it first */
  members: Map<string, string>;
}

/** Run in this order for each type, so problems are listed property by property. */
const TYPE_CHECKS: readonly ((ctx: TypeContext) => void)[] = [
  (ctx) => checkPlainRecord(ctx, "definition", ctx.def),
  collectFields,
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

function isKnown(ctx: TypeContext, type: unknown): type is string {
  return typeof type === "string" && Object.hasOwn(ctx.definitions, type);
}

/**
 * A referenced definition, or undefined when it is not a record. A null or
 * mistyped definition is reported once, by the main loop for its own type;
 * references to it just skip the checks that would need to read it.
 */
function referenced(ctx: TypeContext, type: string): ModelDefinition | undefined {
  const def = ctx.definitions[type];
  return isRecord(def) ? (def as ModelDefinition) : undefined;
}

/**
 * The data fields of a type, collected before anything else so every
 * generated member can be checked against all of them, whatever the order
 * of declaration. The index may also be a single foreign key (a 1:1 shape):
 * that is one field, not a clash.
 */
function collectFields(ctx: TypeContext): void {
  const { def, fields } = ctx;
  if (typeof def.index === "string") fields.set(def.index, "index");
  for (const field of keysOf(def.foreignKeys)) if (!fields.has(field)) fields.set(field, `foreignKeys.${field}`);
  for (const field of keysOf(def.foreignKeysArray)) if (!fields.has(field)) fields.set(field, `foreignKeysArray.${field}`);
  for (const field of keysOf(def.embeddedObject)) if (!fields.has(field)) fields.set(field, `embeddedObject.${field}`);
}

/**
 * A generated member (getter or relation name) must be a valid, non-reserved
 * identifier, must not collide with a data field of the same class, and must
 * be unique among the type's members.
 */
function claimMember(ctx: TypeContext, kind: "getter" | "relation name" | "metaData key", name: unknown, owner: string): void {
  if (typeof name !== "string") {
    problem(ctx, `${owner} ${kind} is missing or not a string`);
    return;
  }
  if (!IDENTIFIER.test(name)) problem(ctx, `${owner} ${kind} "${name}" is not a valid identifier`);
  else if (RESERVED_MEMBERS.has(name)) problem(ctx, `${owner} ${kind} "${name}" is a reserved name`);
  const field = ctx.fields.get(name);
  if (field) problem(ctx, `${owner} ${kind} "${name}" collides with the data field declared by ${field}`);
  const previous = ctx.members.get(name);
  if (previous) problem(ctx, `member "${name}" is declared by both ${previous} and ${owner}`);
  else ctx.members.set(name, owner);
}

function checkNameAndIndex(ctx: TypeContext): void {
  if (!IDENTIFIER.test(ctx.type)) ctx.problems.push(`"${ctx.type}" is not a valid object type name`);
  else if (RESERVED_BUCKET_NAMES.has(ctx.type)) ctx.problems.push(`"${ctx.type}" is a reserved object type name`);
  const { index } = ctx.def;
  if (typeof index !== "string" || index === "") problem(ctx, "index must be a non-empty field name");
  else if (!isEmittable(index)) problem(ctx, `index "${index}" is not a valid identifier or is reserved`);
}

function checkModel(ctx: TypeContext): void {
  const { model } = ctx.def;
  if (model === undefined) return;
  if (typeof model !== "string") {
    problem(ctx, "model must be a string");
    return;
  }
  if (!IDENTIFIER.test(model)) problem(ctx, `model "${model}" is not a valid identifier`);
  else if (RESERVED_CLASS_NAMES.has(model)) problem(ctx, `model "${model}" is a reserved name`);
  else if (model.endsWith(GENERATED_SUFFIX)) problem(ctx, `model "${model}" ends with "${GENERATED_SUFFIX}", the suffix of generated base classes`);
  const owner = ctx.models.get(model);
  if (owner) problem(ctx, `model "${model}" is also used by ${owner}`);
  else ctx.models.set(model, ctx.type);
}

/** `foreignKeys` and `foreignKeysArray`: each points at a known type and claims its getter. */
function checkPointers(ctx: TypeContext, property: string, pointers: Record<string, ForeignKeyDefinition> | undefined): void {
  if (!checkPlainRecord(ctx, property, pointers)) return;
  for (const [field, fk] of Object.entries(pointers)) {
    if (!isEmittable(field)) problem(ctx, `${property} field "${field}" is not a valid identifier or is reserved`);
    if (!checkEntry(ctx, `${property}.${field}`, fk)) continue;
    if (property === "foreignKeysArray" && own(ctx.def.foreignKeys, field)) {
      problem(ctx, `"${field}" is declared in both foreignKeys and foreignKeysArray`);
    }
    if (property === "foreignKeysArray" && field === ctx.def.index) {
      problem(ctx, `foreignKeysArray.${field} is the index field (the index must be a scalar)`);
    }
    if (!isKnown(ctx, fk.objectType)) problem(ctx, `${property}.${field} points at unknown type "${String(fk.objectType)}"`);
    claimMember(ctx, "getter", fk.getter, `${property}.${field}`);
  }
}

/** Each relation names a child type that declares `key` as a foreign key pointing back at this type. */
function checkRelatedObjectTypes(ctx: TypeContext): void {
  const relations = ctx.def.relatedObjectType;
  if (!checkPlainRecord(ctx, "relatedObjectType", relations)) return;
  for (const [name, rel] of Object.entries(relations)) {
    const label = `relatedObjectType.${name}`;
    claimMember(ctx, "relation name", name, label);
    if (!checkEntry(ctx, label, rel)) continue;
    claimMember(ctx, "getter", rel.getter, label);
    if (rel.cascadeDelete !== undefined && typeof rel.cascadeDelete !== "boolean") {
      problem(ctx, `${label}.cascadeDelete must be a boolean`);
    }
    const keyOk = isEmittable(rel.key);
    if (!keyOk) problem(ctx, `${label}.key "${String(rel.key)}" is not a valid identifier or is reserved`);
    if (!isKnown(ctx, rel.objectType)) {
      problem(ctx, `${label}.objectType "${String(rel.objectType)}" is not a known type`);
      continue;
    }
    const child = referenced(ctx, rel.objectType);
    if (!child || !keyOk) continue; // the child (or the key) was already reported
    const childFk = isRecord(child.foreignKeys) ? own(child.foreignKeys, rel.key) : undefined;
    if (!childFk) {
      problem(ctx, `${label}.key "${rel.key}" is not declared in ${rel.objectType}.foreignKeys (grouped index + events need it)`);
    } else if (childFk.objectType !== ctx.type) {
      problem(ctx, `${label}.key "${rel.key}" points at ${childFk.objectType}, not ${ctx.type}`);
    }
  }
}

function checkHasMany(ctx: TypeContext): void {
  const relations = ctx.def.hasMany;
  if (!checkPlainRecord(ctx, "hasMany", relations)) return;
  for (const [name, hm] of Object.entries(relations)) {
    if (checkEntry(ctx, `hasMany.${name}`, hm)) checkHasManyEntry(ctx, name, hm);
    else claimMember(ctx, "relation name", name, `hasMany.${name}`);
  }
}

/**
 * The join bucket must declare both keys, pointing at the right types, and
 * list this type in `belongsTo`. Every check that does not need an unknown
 * type still runs, so one validation pass reports everything it can.
 */
function checkHasManyEntry(ctx: TypeContext, name: string, hm: HasManyDefinition): void {
  const label = `hasMany.${name}`;
  const otherType = hm.objectType;
  claimMember(ctx, "relation name", name, label);
  claimMember(ctx, "getter", hm.getter, label);
  const keysOk = { thisKey: isEmittable(hm.thisKey), otherKey: isEmittable(hm.otherKey) };
  for (const role of ["thisKey", "otherKey"] as const) {
    if (!keysOk[role]) problem(ctx, `${label}: ${role} "${String(hm[role])}" is not a valid identifier or is reserved`);
  }
  if (keysOk.thisKey && keysOk.otherKey && hm.thisKey === hm.otherKey) {
    problem(ctx, `${label}: thisKey and otherKey are both "${hm.thisKey}"`);
  }

  const otherKnown = isKnown(ctx, otherType);
  if (!otherKnown) problem(ctx, `${label}.objectType "${String(otherType)}" is not a known type`);
  if (!isKnown(ctx, hm.through)) {
    problem(ctx, `${label}.through "${String(hm.through)}" is not a known type`);
    return; // nothing below can be checked without the join bucket
  }
  const through = referenced(ctx, hm.through);
  if (!through) return; // a null/mistyped join bucket was already reported by its own type
  if (keysOk.thisKey) checkJoinKey(ctx, label, hm.through, through, hm.thisKey, ctx.type);
  // with an unknown target, only check that the key is declared — comparing it to "tagz" would blame a correct join table;
  // identical keys were already reported above, and checking the same field twice would only repeat the message
  if (keysOk.otherKey && hm.otherKey !== hm.thisKey) {
    checkJoinKey(ctx, label, hm.through, through, hm.otherKey, otherKnown ? otherType : undefined);
  }
  const belongsTo = through.belongsTo;
  if (!Array.isArray(belongsTo) || !belongsTo.includes(ctx.type)) {
    problem(ctx, `${label}: ${hm.through}.belongsTo must include "${ctx.type}" so association caches invalidate`);
  }
}

function checkJoinKey(ctx: TypeContext, label: string, throughType: string, through: ModelDefinition, key: string, expected: string | undefined): void {
  const fk = isRecord(through.foreignKeys) ? own(through.foreignKeys, key) : undefined;
  if (!fk) problem(ctx, `${label}: ${throughType} does not declare foreignKeys.${key}`);
  else if (expected !== undefined && fk.objectType !== expected) {
    problem(ctx, `${label}: ${throughType}.${key} points at ${fk.objectType}, not ${expected}`);
  }
}

/** An embedded field is lifted out of the record, so it must not be a field the record needs. */
function checkEmbeddedObjects(ctx: TypeContext): void {
  const { def } = ctx;
  const embedded = def.embeddedObject;
  if (!checkPlainRecord(ctx, "embeddedObject", embedded)) return;
  for (const [field, target] of Object.entries(embedded)) {
    if (!isEmittable(field)) problem(ctx, `embeddedObject field "${field}" is not a valid identifier or is reserved`);
    if (typeof target !== "string") {
      problem(ctx, `embeddedObject.${field} must name a type`);
      continue;
    }
    if (field === def.index) problem(ctx, `embeddedObject.${field} is the index field`);
    if (own(def.foreignKeys, field)) problem(ctx, `embeddedObject.${field} is also declared in foreignKeys`);
    if (own(def.foreignKeysArray, field)) problem(ctx, `embeddedObject.${field} is also declared in foreignKeysArray`);
    if (!isKnown(ctx, target)) problem(ctx, `embeddedObject.${field} points at unknown type "${target}"`);
  }
}

function checkBelongsTo(ctx: TypeContext): void {
  const { belongsTo } = ctx.def;
  if (belongsTo === undefined) return;
  if (!Array.isArray(belongsTo)) {
    problem(ctx, "belongsTo must be an array of type names");
    return;
  }
  const seen = new Set<string>();
  for (const target of belongsTo) {
    if (typeof target !== "string" || !isKnown(ctx, target)) problem(ctx, `belongsTo includes unknown type "${String(target)}"`);
    else if (seen.has(target)) problem(ctx, `belongsTo lists "${target}" twice`);
    else seen.add(target);
  }
}

function checkMetaData(ctx: TypeContext): void {
  const { metaData } = ctx.def;
  if (metaData === undefined) return;
  if (!Array.isArray(metaData)) {
    problem(ctx, "metaData must be an array of keys");
    return;
  }
  const seen = new Set<string>();
  for (const key of metaData) {
    if (typeof key !== "string" || !isEmittable(key)) {
      problem(ctx, `metaData key "${String(key)}" is not a valid identifier or is reserved`);
    } else if (seen.has(key)) {
      problem(ctx, `metaData lists "${key}" twice`);
    } else {
      seen.add(key);
      claimMember(ctx, "metaData key", key, "metaData"); // the generator emits an accessor per key
    }
  }
}

/** Throws with every problem listed if the definitions are inconsistent. */
export function assertValidModelDefinitions(definitions: Record<string, ModelDefinition> = ModelDefinitions): void {
  const problems = validateModelDefinitions(definitions);
  if (problems.length > 0) throw new Error(`ModelDefinitions are invalid:\n  - ${problems.join("\n  - ")}`);
}

/**
 * What a single foreign-key field may hold: a key value as defined in
 * canonicalKey.ts (a finite number or a non-empty, non-padded string), or
 * null/undefined. NaN, Infinity, "" and " 1" would land an object in a bucket
 * nobody subscribes to, silently.
 */
export function isForeignKeyValue(value: unknown): boolean {
  // ids are whatever the server says (a string "1.0" is a different id from 1, not a typo);
  // the rule for what can be a key lives in canonicalKey.ts and is shared with the event bus
  return value === null || value === undefined || isKeyValue(value);
}

/** What a `foreignKeysArray` field may hold: an array of non-null foreign-key values, or null/undefined. */
export function isForeignKeyArrayValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!Array.isArray(value)) return false;
  // an index loop, not `every`: `every` skips holes, so a sparse array would pass
  for (let i = 0; i < value.length; i++) {
    if (!isKeyValue(value[i])) return false;
  }
  return true;
}

/**
 * Resolves the facts for `objectType`, with a clear error for anything that
 * is not a usable definition. The built-in map uses the precomputed table.
 * A custom map (tests, tooling) is read on every call and never cached: a
 * cache keyed on the map cannot know when an inner definition is mutated,
 * and that path is not the hot one.
 */
function factsOf(objectType: string, definitions: Record<string, ModelDefinition> | undefined): TypeFacts {
  if (definitions === undefined) {
    if (!Object.hasOwn(TYPE_FACTS, objectType)) throw new TypeError(`unknown object type "${objectType}" (is it a singular push name?)`);
    return TYPE_FACTS[objectType as ObjectType];
  }
  if (!Object.hasOwn(definitions, objectType)) throw new TypeError(`unknown object type "${objectType}"`);
  const def = definitions[objectType];
  if (!isRecord(def) || typeof def.index !== "string") {
    throw new TypeError(`definition for "${objectType}" is not a usable definition (object with a string index)`);
  }
  return factsFor(def as ModelDefinition);
}

/** Shared result for the common case, so a clean write allocates nothing. */
const NO_BAD_FIELDS: readonly string[] = Object.freeze([]);

/**
 * Checks one record's index field and declared foreign-key fields (single
 * and array). Returns the offending field names; empty means fine. The
 * cache calls this on write so a boolean, NaN or nested object in one of
 * those fields fails loudly instead of silently never notifying anyone.
 * The index is required and may not be null; foreign keys may be absent
 * (partial update) or null. Pass a definitions map to check against a
 * schema other than the built-in one.
 */
export function invalidForeignKeyFields(objectType: ObjectType, record: Record<string, unknown>): readonly string[];
export function invalidForeignKeyFields(objectType: string, record: Record<string, unknown>, definitions: Record<string, ModelDefinition>): readonly string[];
export function invalidForeignKeyFields(objectType: string, record: Record<string, unknown>, definitions?: Record<string, ModelDefinition>): readonly string[] {
  const facts = factsOf(objectType, definitions);
  if (!isRecord(record)) throw new TypeError(`${objectType} record must be an object`);
  // no closure and no array on the clean path: `bad` is created by the first problem
  let bad: string[] | undefined;
  if (!isKeyValue(ownField(record, facts.index))) bad = [facts.index];
  // `hasField`: an own field set to undefined is absent (partial update), like the event bus
  for (const field of facts.foreignKeys) {
    if (hasField(record, field) && !isForeignKeyValue(record[field])) bad = addUnique(bad, field);
  }
  for (const field of facts.foreignKeyArrays) {
    if (hasField(record, field) && !isForeignKeyArrayValue(record[field])) bad = addUnique(bad, field);
  }
  return bad ?? NO_BAD_FIELDS;
}

/** Appends `item` unless present (the index may also be a foreign key: report it once). */
function addUnique(list: string[] | undefined, item: string): string[] {
  if (list === undefined) return [item];
  if (!list.includes(item)) list.push(item);
  return list;
}

export function assertForeignKeyValues(objectType: ObjectType, record: Record<string, unknown>): void;
export function assertForeignKeyValues(objectType: string, record: Record<string, unknown>, definitions: Record<string, ModelDefinition>): void;
export function assertForeignKeyValues(objectType: string, record: Record<string, unknown>, definitions?: Record<string, ModelDefinition>): void {
  const bad = definitions === undefined ? invalidForeignKeyFields(objectType as ObjectType, record) : invalidForeignKeyFields(objectType, record, definitions);
  if (bad.length > 0) {
    throw new TypeError(
      `${objectType} record has invalid index/foreign key value(s): ${bad.join(", ")} ` +
        "(the index must be a non-empty string or finite number; single keys may also be null; array keys an array of those)",
    );
  }
}
