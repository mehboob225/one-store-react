/**
 * DataCacheIndex — one bucket of the store: the objects of one type plus
 * the derived structures reads need.
 *
 * The rules, in the order a write runs them (data-flow §4.3):
 *
 *  1. every written object is checked by the schema's write guard (index and
 *     foreign-key VALUES) before anything is stored — a write is all or
 *     nothing;
 *  2. dedupe by the index field: an object whose id is already stored
 *     REPLACES the stored object whole, in place. Never a field-wise merge:
 *     a server response is the complete state of the object it carries, so
 *     an own `undefined` in a written object is its new value (see
 *     canonicalKey.ts). New ids are appended in the order given;
 *  3. every derived structure of this bucket, and of every bucket named in
 *     `belongsTo`, is dropped (`clearIndexes`). Nothing is patched
 *     incrementally: a write invalidates, the next read rebuilds. The
 *     `belongsTo` part is what keeps `getAssociation` honest — the owner
 *     bucket caches the ids it reads from the join rows, so a join write
 *     must drop that cache;
 *  4. the bus hears `update` (with the replaced objects' previous state, so
 *     a moved foreign key notifies the bucket it left) and `add`.
 *
 * Removes cascade through `relatedObjectType[].cascadeDelete`, walking the
 * DATA with a visited set — a cyclic schema (subtasks by `parent_id`, A→B→A)
 * is legitimate, so the walk terminates on the objects, never on the schema,
 * and an object is removed and broadcast once. The bus is given the stored
 * objects, never id stubs, so their foreign-key buckets hear the remove.
 * `removeAll` does NOT cascade: it exists for a full refresh of one bucket
 * (drop the rows, add the fresh ones), and the children of a refreshed row
 * are not gone.
 *
 * Reads never throw for an id that is not a key value — `getById(undefined)`
 * is "not found", like any lookup. Writes are strict (a bad index or foreign
 * key throws), and so is asking for a structure the schema does not declare
 * (`getGroupedById` on an undeclared foreign key, `addMetaData` on an
 * undeclared key): those are programming errors, not data.
 *
 * Every index is keyed on `canonicalKey(value)`, so `1` and `"1"` are one
 * object (the write guard lets a key hold either).
 */
import { canonicalKey, isKeyValue, ownField } from "./canonicalKey";
import type { DataEventHandler, IndexValue } from "./EventHandler";
import { foreignKeyGuard, type ModelDefinition } from "./ModelDefinitions";
import { hasOwnerSlot, setOwner } from "./storeOwner";

type Row = Record<string, unknown>;

/** What a bucket needs from the store around it (the generated `DataCache`, step 8). */
export interface BucketContext {
  readonly events: DataEventHandler;
  /** The bucket for an object type; `undefined` if the store has none (a schema/wiring error, reported by the caller). */
  bucket(objectType: string): DataCacheIndex<object> | undefined;
  /** The store the buckets belong to. Stamped on every stored model (see storeOwner.ts) so its accessors read this store. */
  readonly owner?: object;
}

/** Something a remove can name: an id, or an object carrying the index field. */
export type Removable = IndexValue | object;

/** The removal plan of one cascade: what each bucket will drop, children before parents. */
type RemovalPlan = Map<DataCacheIndex<object>, object[]>;

const fields = (object: object): Row => object as Row;

export class DataCacheIndex<T extends object> {
  private data: T[] = [];
  /** Side data per object id, per declared metaData key; kept across replaces, dropped on remove. */
  private readonly meta = new Map<string, Map<string, unknown>>();

  // ---- derived structures: built on first read after a write, never patched ----
  private byId: Map<string, T> | undefined;
  private positionsCache: Map<string, number> | undefined;
  private byForeignKey = new Map<string, Map<string, readonly T[]>>();
  private associations = new Map<string, readonly string[]>();
  private allSnapshot: readonly T[] | undefined;

  readonly index: string;
  private readonly foreignKeys: readonly string[];
  /** declared single foreign key → the type it points at */
  private readonly foreignKeyTargets: ReadonlyMap<string, string>;
  private readonly belongsTo: readonly string[];
  private readonly metaDataKeys: ReadonlySet<string>;
  private readonly cascades: readonly { objectType: string; key: string }[];
  private readonly invalidFields: (record: Row) => readonly string[];

  constructor(
    readonly objectType: string,
    definitions: Record<string, ModelDefinition>,
    private readonly context: BucketContext,
  ) {
    // The guard resolves the definition (and throws for an unknown type or an unusable one) before anything else is read.
    this.invalidFields = foreignKeyGuard(objectType, definitions);
    const def = definitions[objectType];
    if (def === undefined) throw new TypeError(`unknown object type "${objectType}"`);
    this.index = def.index;
    this.foreignKeys = Object.freeze(Object.keys(def.foreignKeys ?? {}));
    this.foreignKeyTargets = new Map(Object.entries(def.foreignKeys ?? {}).map(([field, fk]) => [field, fk.objectType]));
    this.belongsTo = Object.freeze([...(def.belongsTo ?? [])]);
    this.metaDataKeys = new Set(def.metaData ?? []);
    this.cascades = Object.freeze(
      Object.values(def.relatedObjectType ?? {})
        .filter((rel) => rel.cascadeDelete === true)
        .map((rel) => ({ objectType: rel.objectType, key: rel.key })),
    );
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  get size(): number {
    return this.data.length;
  }

  /** Every stored object, in insertion order. The same frozen array until the next write, so it is safe to memoise on. */
  getAll(): readonly T[] {
    return (this.allSnapshot ??= Object.freeze([...this.data]));
  }

  getById(id: unknown): T | undefined {
    return isKeyValue(id) ? this.ensureById().get(canonicalKey(id)) : undefined;
  }

  /** The objects for the given ids, in that order; ids that are not stored are skipped. */
  getMultipleByIds(ids: readonly unknown[]): T[] {
    const byId = this.ensureById();
    const found: T[] = [];
    for (const id of ids) {
      const object = isKeyValue(id) ? byId.get(canonicalKey(id)) : undefined;
      if (object !== undefined) found.push(object);
    }
    return found;
  }

  /**
   * The objects whose declared single foreign key `foreignKey` equals
   * `value`, in insertion order (a frozen array). Only declared single
   * foreign keys are indexed; anything else throws. A value that is not a
   * key value (null, undefined) has no bucket: the answer is empty.
   */
  getGroupedById(foreignKey: string, value: unknown): readonly T[] {
    if (!this.foreignKeys.includes(foreignKey)) {
      throw new TypeError(`${this.objectType}.getGroupedById: "${foreignKey}" is not a declared single foreign key (declare it in ModelDefinitions.${this.objectType}.foreignKeys)`);
    }
    if (!isKeyValue(value)) return NO_OBJECTS;
    return this.ensureGrouped(foreignKey).get(canonicalKey(value)) ?? NO_OBJECTS;
  }

  /**
   * Has-many-through: the objects on the other side of the join bucket
   * `through` for the object `thisId` of this bucket. `thisKey` and
   * `otherKey` are the join bucket's foreign keys to this type and to the
   * other; the other bucket is the one `otherKey` is declared to point at.
   * The ids read from the join rows are cached here (dropped by a write to
   * this bucket or to the join bucket via its `belongsTo`); the objects are
   * resolved on every read, so a late-arriving other-side object shows up.
   * Other-side ids that are not stored are skipped.
   */
  getAssociation<O extends object = object>(through: string, thisKey: string, otherKey: string, thisId: unknown): O[] {
    if (!isKeyValue(thisId)) return [];
    const join = this.bucketFor(through, "getAssociation");
    const cacheKey = `${through}/${thisKey}/${otherKey}/${canonicalKey(thisId)}`;
    let otherIds = this.associations.get(cacheKey);
    if (otherIds === undefined) {
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const row of join.getGroupedById(thisKey, thisId)) {
        const otherId = ownField(fields(row), otherKey);
        if (!isKeyValue(otherId)) continue;
        const canon = canonicalKey(otherId);
        if (!seen.has(canon)) {
          seen.add(canon);
          ids.push(canon);
        }
      }
      otherIds = Object.freeze(ids);
      this.associations.set(cacheKey, otherIds);
    }
    const other = this.bucketFor(join.targetOf(otherKey), "getAssociation") as DataCacheIndex<O>;
    return other.getMultipleByIds(otherIds);
  }

  /**
   * The objects matching every criterion. Key fields (the index and the
   * declared single foreign keys) compare by canonical key, and `null`,
   * `undefined` and an absent field are all "no value"; every other field
   * compares with `===`.
   */
  where(criteria: Partial<T>): T[] {
    const entries = Object.entries(criteria);
    return this.data.filter((object) => entries.every(([field, wanted]) => this.matches(object, field, wanted)));
  }

  findWhere(criteria: Partial<T>): T | undefined {
    const entries = Object.entries(criteria);
    return this.data.find((object) => entries.every(([field, wanted]) => this.matches(object, field, wanted)));
  }

  /** Side data attached to an object, by declared metaData key. */
  getMetaData(id: unknown, key: string): unknown {
    this.assertMetaDataKey(key);
    return isKeyValue(id) ? this.meta.get(canonicalKey(id))?.get(key) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Stores objects: replace by index, append the rest, drop the derived
   * structures here and in every `belongsTo` bucket, then broadcast. All or
   * nothing: every object is checked first, and one bad index or foreign
   * key throws before anything is stored. The same id twice in one call is
   * one object (the last one wins, as a later response would).
   */
  add(objects: readonly T[]): void {
    if (objects.length === 0) return;
    for (const object of objects) this.assertWritable(object);
    const owner = this.context.owner;
    if (owner !== undefined) for (const object of objects) if (hasOwnerSlot(object)) setOwner(object, owner);

    const byId = this.ensureById();
    const positions = this.positions();
    const previous = new Map<string, T>(); // pre-write state of every replaced id, once
    const written = new Map<string, T>(); // final object per id, in first-seen order
    const addedIds = new Set<string>();
    for (const object of objects) {
      const canon = this.idOf(object);
      const position = positions.get(canon);
      const stored = byId.get(canon);
      if (position === undefined || stored === undefined) {
        positions.set(canon, this.data.length);
        this.data.push(object);
        addedIds.add(canon);
      } else {
        if (!previous.has(canon) && !addedIds.has(canon)) previous.set(canon, stored);
        this.data[position] = object;
      }
      byId.set(canon, object);
      written.set(canon, object);
    }

    this.invalidate();
    const added: T[] = [];
    const replaced: T[] = [];
    for (const [canon, object] of written) (addedIds.has(canon) ? added : replaced).push(object);
    if (replaced.length > 0) this.broadcast("update", replaced, [...previous.values()]);
    if (added.length > 0) this.broadcast("add", added);
  }

  /** Removes one object by id or by an object carrying the index field, with its cascade. */
  remove(target: Removable): void {
    this.removeObjects([target]);
  }

  /**
   * Removes the named objects and, through `cascadeDelete`, their children,
   * grandchildren, … — each object once, however many paths reach it.
   * Targets that are not stored are ignored. Every affected bucket drops its
   * derived structures and broadcasts `remove` with its stored objects.
   */
  removeObjects(targets: readonly Removable[]): void {
    const objects = this.stored(targets);
    if (objects.length === 0) return;
    const plan: RemovalPlan = new Map();
    this.planRemoval(objects, plan, new Set());
    for (const [bucket, doomed] of plan) bucket.drop(doomed);
  }

  /** Empties the bucket and broadcasts the removal. No cascade (see the header). */
  removeAll(): void {
    if (this.data.length === 0) return;
    this.drop(this.data);
  }

  /**
   * Attaches side data (e.g. a subscription block that arrived with the
   * response) to the object `id` under a declared metaData key, and tells
   * the bus the object changed. The object need not be stored yet; the data
   * waits for it and survives a replace.
   */
  addMetaData(id: IndexValue, key: string, value: unknown): void {
    this.assertMetaDataKey(key);
    if (!isKeyValue(id)) throw new TypeError(`${this.objectType}.addMetaData: id must be a finite number or non-empty string`);
    const canon = canonicalKey(id);
    let entry = this.meta.get(canon);
    if (!entry) this.meta.set(canon, (entry = new Map()));
    entry.set(key, value);
    const stored = this.ensureById().get(canon);
    // an absent object is announced by its id alone: nothing about its foreign keys changed
    const object = stored ?? ({ [this.index]: id } as unknown as T);
    this.broadcast("update", [object], [object]);
  }

  /**
   * Drops every derived structure; the next read rebuilds it. Called on
   * every write here, by writes to buckets that name this one in
   * `belongsTo`, and by the store's reset.
   */
  clearIndexes(): void {
    this.byId = undefined;
    this.positionsCache = undefined;
    this.byForeignKey = new Map();
    this.associations = new Map();
    this.allSnapshot = undefined;
  }

  /** Forgets everything — objects, side data, indexes — WITHOUT a broadcast: the session reset (a new generation, then a reload). */
  clear(): void {
    this.data = [];
    this.meta.clear();
    this.clearIndexes();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** canonical id → position in `data`; rebuilt with the id index. */
  private positions(): Map<string, number> {
    if (!this.positionsCache) {
      const positions = new Map<string, number>();
      this.data.forEach((object, position) => positions.set(this.idOf(object), position));
      this.positionsCache = positions;
    }
    return this.positionsCache;
  }

  private ensureById(): Map<string, T> {
    if (!this.byId) {
      this.byId = new Map();
      for (const object of this.data) this.byId.set(this.idOf(object), object);
    }
    return this.byId;
  }

  private ensureGrouped(foreignKey: string): Map<string, readonly T[]> {
    let grouped = this.byForeignKey.get(foreignKey);
    if (!grouped) {
      const building = new Map<string, T[]>();
      for (const object of this.data) {
        const value = ownField(fields(object), foreignKey);
        if (!isKeyValue(value)) continue; // null/undefined: in no bucket
        const canon = canonicalKey(value);
        const group = building.get(canon);
        if (group) group.push(object);
        else building.set(canon, [object]);
      }
      grouped = new Map<string, readonly T[]>();
      for (const [canon, group] of building) grouped.set(canon, Object.freeze(group));
      this.byForeignKey.set(foreignKey, grouped);
    }
    return grouped;
  }

  /** An object's canonical id. The guard has accepted every stored object, so a bad index here is an invariant failure, not data. */
  private idOf(object: T): string {
    const id = ownField(fields(object), this.index);
    if (!isKeyValue(id)) throw new TypeError(`${this.objectType}: an object without a usable "${this.index}" reached the bucket`);
    return canonicalKey(id);
  }

  private matches(object: T, field: string, wanted: unknown): boolean {
    const value = ownField(fields(object), field);
    if (field === this.index || this.foreignKeys.includes(field)) {
      if (wanted == null) return value == null;
      return isKeyValue(wanted) && isKeyValue(value) && canonicalKey(wanted) === canonicalKey(value);
    }
    return value === wanted;
  }

  private assertWritable(object: T): void {
    const bad = this.invalidFields(fields(object));
    if (bad.length > 0) {
      throw new TypeError(
        `${this.objectType}.add: invalid index/foreign key value(s): ${bad.join(", ")} ` +
          "(the index must be a non-empty string or finite number; single keys may also be null; array keys an array of those)",
      );
    }
  }

  private assertMetaDataKey(key: string): void {
    if (!this.metaDataKeys.has(key)) {
      throw new TypeError(`${this.objectType}: "${key}" is not a declared metaData key (declare it in ModelDefinitions.${this.objectType}.metaData)`);
    }
  }

  /** The bucket for a type the schema names, or a clear error for a store that lacks it. */
  private bucketFor(objectType: string, operation: string): DataCacheIndex<object> {
    const bucket = this.context.bucket(objectType);
    if (!bucket) throw new TypeError(`${this.objectType}.${operation}: the store has no "${objectType}" bucket`);
    return bucket;
  }

  /** The type a declared foreign key of this bucket points at (for a join bucket's other side). */
  private targetOf(foreignKey: string): string {
    const target = this.foreignKeyTargets.get(foreignKey);
    if (target === undefined) throw new TypeError(`${this.objectType}: "${foreignKey}" is not a declared single foreign key`);
    return target;
  }

  /** The stored objects the targets name (ids or objects with the index field); unknown ids are skipped, a target without a usable id throws. */
  private stored(targets: readonly Removable[]): T[] {
    const byId = this.ensureById();
    const found: T[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const id = typeof target === "object" ? ownField(fields(target), this.index) : target;
      if (!isKeyValue(id)) throw new TypeError(`${this.objectType}.remove: a target must be an id or an object with a "${this.index}" field`);
      const canon = canonicalKey(id);
      const object = byId.get(canon);
      if (object !== undefined && !seen.has(canon)) {
        seen.add(canon);
        found.push(object);
      }
    }
    return found;
  }

  /**
   * Adds `objects` (already stored here, not yet visited) and their cascade
   * to the plan, children first. `visited` holds "type\u0000id" for every
   * object already planned, so a cycle in the data or the schema ends here.
   */
  private planRemoval(objects: readonly T[], plan: RemovalPlan, visited: Set<string>): void {
    const fresh: T[] = [];
    for (const object of objects) {
      const mark = `${this.objectType}\u0000${this.idOf(object)}`;
      if (visited.has(mark)) continue;
      visited.add(mark);
      fresh.push(object);
    }
    if (fresh.length === 0) return;
    for (const { objectType, key } of this.cascades) {
      const child = this.bucketFor(objectType, "remove");
      for (const object of fresh) {
        const children = child.getGroupedById(key, ownField(fields(object), this.index));
        if (children.length > 0) child.planRemoval(children, plan, visited);
      }
    }
    const self: DataCacheIndex<object> = this;
    const mine = plan.get(self);
    if (mine) mine.push(...fresh);
    else plan.set(self, [...fresh]);
  }

  /** Removes stored objects from this bucket only (no cascade), then invalidates and broadcasts. */
  private drop(objects: readonly T[]): void {
    const doomed = new Set(objects.map((object) => this.idOf(object)));
    this.data = this.data.filter((object) => !doomed.has(this.idOf(object)));
    for (const canon of doomed) this.meta.delete(canon);
    this.invalidate();
    this.broadcast("remove", objects);
  }

  /** `clearIndexes` here and in every `belongsTo` bucket. */
  private invalidate(): void {
    this.clearIndexes();
    for (const objectType of this.belongsTo) this.bucketFor(objectType, "add").clearIndexes();
  }

  private broadcast(action: "add" | "remove", objects: readonly T[]): void;
  private broadcast(action: "update", objects: readonly T[], previous: readonly T[]): void;
  private broadcast(action: "add" | "update" | "remove", objects: readonly T[], previous: readonly T[] = []): void {
    const base = { objectType: this.objectType, index: this.index, foreignKeys: this.foreignKeys, objects: objects as readonly Row[] };
    if (action === "update") this.context.events.broadcast({ ...base, action, previous: previous as readonly Row[] });
    else this.context.events.broadcast({ ...base, action });
  }
}

const NO_OBJECTS: readonly never[] = Object.freeze([]);
