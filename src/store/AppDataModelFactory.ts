/**
 * AppDataModelFactory — the bridge from a response to typed models in the
 * store. `saveAppData` (step 10) and push (step 17) call `addData`; nothing
 * else turns raw JSON into stored objects.
 *
 * `addData(objectType, data)` runs two phases (data-flow §2 Step 9):
 *
 *  1. processData — walks `ModelDefinitions[type].embeddedObject`,
 *     recursively: an embedded field (`task.assignee`) is lifted into its own
 *     bucket (`users`) and deleted from the parent, so one response can fill
 *     many buckets. `null` means "none" and is just dropped. The caller's
 *     JSON is never mutated: each record is copied before a field is lifted.
 *  2. addFlattenedData — wraps every record in its model class
 *     (`ModelConstructors[definition.model]`; a type without `model` stays a
 *     plain row) and adds each bucket, children first.
 *
 * All or nothing ACROSS buckets: every record is wrapped and passes the
 * schema's write guard before any bucket is written, so a bad task can never
 * leave its assignee behind in `users`.
 *
 * `pluralize()` maps the singular names push messages use (`task`,
 * `current_user`) to bucket names.
 */
import { AppDataFactory } from "./AppDataFactory";
import { hasField, isRecord } from "./canonicalKey";
import type { DataCache } from "./DataCache";
import type { DataCacheIndex } from "./DataCacheIndex";
import { assertForeignKeyValues, definitionFor, isObjectType, type ModelDefinitions, type ObjectType } from "./ModelDefinitions";
import { CurrentUserModel } from "../models/CurrentUserModel";
import { ProjectModel } from "../models/ProjectModel";
import { TagModel } from "../models/TagModel";
import { TaskModel } from "../models/TaskModel";
import { UserModel } from "../models/UserModel";

/** What the bucket for `K` stores: its model class, or its generated record type. */
export type StoredObject<K extends ObjectType> = DataCache[K] extends DataCacheIndex<infer T> ? T : never;

type ModelNameOf<K extends ObjectType> = (typeof ModelDefinitions)[K] extends { readonly model: infer M extends string } ? M : never;

/** Exactly one constructor per `model:` name, building what that model's bucket stores. */
type ModelConstructorMap = { readonly [K in ObjectType as ModelNameOf<K>]: new (json: Record<string, unknown>) => StoredObject<K> };

/**
 * Model name → class. Register every handwritten model here: a missing,
 * extra or mismatched entry is a type error.
 */
export const ModelConstructors: ModelConstructorMap = Object.freeze({
  UserModel,
  CurrentUserModel,
  ProjectModel,
  TaskModel,
  TagModel,
});

type Row = Record<string, unknown>;

/** Records per bucket, in the order the buckets were first reached (children before their parents). */
type Flattened = Map<ObjectType, Row[]>;

export class ModelFactory {
  constructor(readonly store: DataCache) {}

  /**
   * Stores one record or an array of records of `objectType`, with every
   * embedded object lifted into its own bucket. Returns the stored objects
   * for the top-level records, in the order given. Throws (and writes
   * nothing) for an unknown type, a non-record, a bad index or foreign key,
   * or a field that would shadow a model member.
   */
  addData<K extends ObjectType>(objectType: K, data: unknown): StoredObject<K>[] {
    if (!isObjectType(objectType)) throw new TypeError(`addData: unknown object type "${String(objectType)}"`);
    const flattened: Flattened = new Map();
    const top = this.processData(objectType, data, flattened);
    this.addFlattenedData(flattened);
    const bucket = this.store.bucket(objectType) as DataCacheIndex<StoredObject<K>>;
    const index = definitionFor(objectType).index;
    return top.map((record) => bucket.getById(record[index]) as StoredObject<K>);
  }

  /** Phase 1: copies `data`'s records into `flattened`, lifting embedded objects (recursively) into their buckets. */
  private processData(objectType: ObjectType, data: unknown, flattened: Flattened): Row[] {
    const records = Array.isArray(data) ? data : [data];
    const embedded = Object.entries(definitionFor(objectType).embeddedObject ?? {});
    const copies: Row[] = [];
    for (const record of records) {
      if (!isRecord(record)) throw new TypeError(`addData: a ${objectType} record must be an object, got ${record === null ? "null" : typeof record}`);
      const copy: Row = { ...record };
      for (const [field, target] of embedded) {
        if (!hasField(copy, field)) continue;
        const value = copy[field];
        delete copy[field];
        // the validator guarantees `target` is a bucket
        if (value !== null && value !== undefined) this.processData(target as ObjectType, value, flattened);
      }
      let rows = flattened.get(objectType);
      if (rows === undefined) flattened.set(objectType, (rows = []));
      rows.push(copy);
      copies.push(copy);
    }
    return copies;
  }

  /** Phase 2: wraps and checks every record of every bucket, then writes the buckets. */
  private addFlattenedData(flattened: Flattened): void {
    const writes: [DataCacheIndex<object>, object[]][] = [];
    for (const [objectType, records] of flattened) {
      const bucket = this.store.bucket(objectType);
      if (bucket === undefined) throw new TypeError(`addData: the store has no "${objectType}" bucket`); // unreachable: DataCache is generated from the schema
      const objects = records.map((record) => {
        const object = this.wrap(objectType, record);
        assertForeignKeyValues(objectType, object as Row);
        return object;
      });
      writes.push([bucket, objects]);
    }
    for (const [bucket, objects] of writes) bucket.add(objects);
  }

  private wrap(objectType: ObjectType, record: Row): object {
    const model = definitionFor(objectType).model;
    if (model === undefined) return record;
    const Constructor = ModelConstructors[model as keyof ModelConstructorMap] as new (json: Row) => object;
    return new Constructor(record);
  }
}

/** The materializer for the app's store. */
export const AppDataModelFactory = new ModelFactory(AppDataFactory);

/**
 * Singular names whose bucket is not the name plus "s". Add an entry
 * whenever a new bucket's name is not the regular plural of what the server
 * calls one of its objects.
 */
const IRREGULAR_PLURALS: Readonly<Record<string, ObjectType>> = Object.freeze({
  // a join bucket is named after the relation, not pluralized
  task_tags_relation: "task_tags_relation",
});

/** The bucket name for a singular server name (`task` → `tasks`, `current_user` → `current_users`). Not necessarily a bucket: check with `isObjectType`. */
export function pluralize(name: string): string {
  return Object.hasOwn(IRREGULAR_PLURALS, name) ? (IRREGULAR_PLURALS[name] as string) : `${name}s`;
}
