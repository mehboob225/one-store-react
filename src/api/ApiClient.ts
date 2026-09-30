/**
 * APIClient — the only network path, and the reason responses write
 * themselves into the store.
 *
 * Every request method returns an `ApiPromise`: the axios promise with
 * store-writing extensions attached (`wrapPromise`), each of which returns
 * another `ApiPromise` resolving to the same response, so writes chain:
 *
 *   APIService.get("v1/users/current")
 *     .saveAppData("users")            // {user}         → users
 *     .saveAppData("current_users");   // {current_user} → current_users
 *
 * Extensions (data-flow §2 Step 3):
 *
 *   saveAppData(type, prop?)         the records for `type` → `addData`, then
 *                                    the ids in `deleted_<type>` are removed
 *   saveMetaData(parentType, id, k)  `body[k]` → `addMetaData(id, k, …)`
 *   saveObjectsBelongingTo(join, ownerType, ownerId, type)
 *                                    the owner's complete list of `type` →
 *                                    `addData`, plus one synthesised join row
 *                                    per object; links the list no longer
 *                                    names are removed
 *   deleteAppData(type, target)      remove one object (with its cascade)
 *   deleteAppDataArray(type, targets)
 *   addCallback(cb)                  a `.then` that keeps the chain
 *   addOnProgressCallback(cb)        upload progress of this request
 *
 * Where a response keeps its records (`saveAppData` / `saveObjectsBelongingTo`):
 * `body[prop]` when a property is named; otherwise a bare array body, or the
 * one own key of an object body that names the bucket (`tasks`) or its
 * singular (`task`: `pluralize(key) === type`). A response that carries
 * neither the records nor `deleted_<type>` is a contract error: the write
 * throws and the chain rejects, so a factory naming the wrong bucket fails
 * loudly instead of storing nothing.
 *
 * Two guards (data-flow §2 Step 3, §4.5):
 *
 *  - Session guard: the store's `generation` is captured when the request is
 *    made. Every store write of the chain runs through `unlessStoreReset`,
 *    which drops it (and resolves anyway) if the store was reset since, so a
 *    response issued in one session never lands in the next.
 *  - Error dispatch: a failed request is emitted on `errorHandler` (the app
 *    shell turns a 401 into a logout, step 15) and rejects the chain. A
 *    failure of a request issued before a reset is not emitted: the previous
 *    session's 401 must not sign the new session out.
 *
 * Only store WRITES are guarded; `addCallback` always runs. Extensions write
 * all or nothing per call: everything a call reads from the response is
 * checked before its first store write.
 */
import axios, { AxiosError, type AxiosInstance, type AxiosProgressEvent, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { AuthenticationService } from "../auth/AuthenticationService";
import { AppDataModelFactory, pluralize, type ModelFactory } from "../store/AppDataModelFactory";
import { canonicalKey, hasField, isKeyValue, isRecord } from "../store/canonicalKey";
import type { DataCache } from "../store/DataCache";
import type { DataCacheIndex, Removable } from "../store/DataCacheIndex";
import { EventHandler, type IndexValue } from "../store/EventHandler";
import { definitionFor, type ObjectType } from "../store/ModelDefinitions";

export type ProgressCallback = (event: AxiosProgressEvent) => void;

/** An axios response promise that can write its response into the store. Every extension returns a new `ApiPromise` of the same response. */
export interface ApiPromise<T = unknown> extends Promise<AxiosResponse<T>> {
  /** Stores the records for `objectType` (see the header for where they are found) and removes the ids in `deleted_<objectType>`. */
  saveAppData(objectType: ObjectType, dataProperty?: string): ApiPromise<T>;
  /** Attaches `body[key]` to the `parentType` object `parentId` under the declared metaData key `key`. */
  saveMetaData(parentType: ObjectType, parentId: IndexValue, key: string): ApiPromise<T>;
  /**
   * Stores the owner's complete list of `objectType` and the join rows of
   * `relation` linking them to it (one per object, with a composite id);
   * the owner's links to objects the list no longer names are removed.
   * `ownerType` must declare a `hasMany` of `objectType` through `relation`.
   */
  saveObjectsBelongingTo(relation: ObjectType, ownerType: ObjectType, ownerId: IndexValue, objectType: ObjectType): ApiPromise<T>;
  /** Removes one object (an id, or an object carrying the index) with its cascade. The caller names it: a DELETE response need not carry it. */
  deleteAppData(objectType: ObjectType, target: Removable): ApiPromise<T>;
  /** Removes several objects with their cascades. */
  deleteAppDataArray(objectType: ObjectType, targets: readonly Removable[]): ApiPromise<T>;
  /** Runs `callback` with the response and keeps the chain (the callback's result is ignored). */
  addCallback(callback: (response: AxiosResponse<T>) => void): ApiPromise<T>;
  /** Hears this request's upload progress. Only requests with a body (post/put/patch) report any. */
  addOnProgressCallback(callback: ProgressCallback): ApiPromise<T>;
}

/** Per-request options; the client owns the URL, method, body, base URL and upload progress. */
export type RequestOptions = Omit<AxiosRequestConfig, "url" | "method" | "data" | "baseURL" | "allowAbsoluteUrls" | "onUploadProgress">;

/** Where the client reads the credentials header; `null` sends no header. */
export interface AuthorizationSource {
  authenticationHeader(): string | null;
}

export interface APIClientOptions {
  /** The materializer (and through it, the store) responses are written into. Defaults to the app's. */
  models?: ModelFactory;
  /** Defaults to the app's AuthenticationService. */
  auth?: AuthorizationSource;
  /** An axios adapter; tests pass a fake, the default is axios's own choice. */
  adapter?: AxiosRequestConfig["adapter"];
}

/** What one request's chain shares: the generation it was made in, and its progress listeners. */
interface RequestContext {
  readonly generation: number;
  readonly progress: Set<ProgressCallback>;
}

type Row = Record<string, unknown>;

export class APIClient {
  /** Failed requests of the current session, as axios errors. */
  readonly errorHandler = new EventHandler<AxiosError>();
  /** The underlying instance, for defaults such as a platform header (the app shell sets it). */
  readonly axios: AxiosInstance;
  private readonly models: ModelFactory;
  private readonly store: DataCache;

  constructor(baseURL: string, options: APIClientOptions = {}) {
    this.models = options.models ?? AppDataModelFactory;
    this.store = this.models.store;
    const auth = options.auth ?? AuthenticationService;
    // Never absolute: every path is under the configured backend, so the credentials header cannot reach another host.
    this.axios = axios.create({ baseURL, allowAbsoluteUrls: false, adapter: options.adapter });
    this.axios.interceptors.request.use((config) => {
      const header = auth.authenticationHeader();
      if (header !== null) config.headers.set("Authorization", header);
      return config;
    });
  }

  get<T = unknown>(path: string, options?: RequestOptions): ApiPromise<T> {
    return this.request<T>({ ...options, method: "get", url: path });
  }

  delete<T = unknown>(path: string, options?: RequestOptions): ApiPromise<T> {
    return this.request<T>({ ...options, method: "delete", url: path });
  }

  post<T = unknown>(path: string, data?: unknown, options?: RequestOptions): ApiPromise<T> {
    return this.request<T>({ ...options, method: "post", url: path, data }, true);
  }

  put<T = unknown>(path: string, data?: unknown, options?: RequestOptions): ApiPromise<T> {
    return this.request<T>({ ...options, method: "put", url: path, data }, true);
  }

  patch<T = unknown>(path: string, data?: unknown, options?: RequestOptions): ApiPromise<T> {
    return this.request<T>({ ...options, method: "patch", url: path, data }, true);
  }

  /**
   * Wraps `update` so it runs only if the store is still in `generation`.
   * The wrapped function passes the response through either way.
   */
  unlessStoreReset<R>(generation: number, update: (response: R) => void): (response: R) => R {
    return (response) => {
      if (this.store.generation === generation) update(response);
      return response;
    };
  }

  private request<T>(config: AxiosRequestConfig, hasBody = false): ApiPromise<T> {
    const request: RequestContext = { generation: this.store.generation, progress: new Set() };
    // Upload listeners only where there is an upload: on a cross-origin GET one would force a CORS preflight.
    if (hasBody) config.onUploadProgress = (event) => this.deliverProgress(request, event);
    const promise = this.axios.request<T>(config).catch((error: unknown) => {
      if (error instanceof AxiosError && this.store.generation === request.generation) this.errorHandler.emit(error);
      throw error;
    });
    return this.wrapPromise(promise, request);
  }

  /** Attaches the extensions to `promise`; each continues the chain with a new wrapped promise of the same response. */
  private wrapPromise<T>(promise: Promise<AxiosResponse<T>>, request: RequestContext): ApiPromise<T> {
    const write = (update: (body: unknown) => void): ApiPromise<T> =>
      this.wrapPromise(promise.then(this.unlessStoreReset(request.generation, (response: AxiosResponse<T>) => update(response.data))), request);
    const wrapped: ApiPromise<T> = Object.assign(promise, {
      saveAppData: (objectType: ObjectType, dataProperty?: string) => write((body) => this.saveAppData(body, objectType, dataProperty)),
      saveMetaData: (parentType: ObjectType, parentId: IndexValue, key: string) => write((body) => this.saveMetaData(body, parentType, parentId, key)),
      saveObjectsBelongingTo: (relation: ObjectType, ownerType: ObjectType, ownerId: IndexValue, objectType: ObjectType) =>
        write((body) => this.saveObjectsBelongingTo(body, relation, ownerType, ownerId, objectType)),
      deleteAppData: (objectType: ObjectType, target: Removable) => write(() => this.bucketOf(objectType).remove(target)),
      deleteAppDataArray: (objectType: ObjectType, targets: readonly Removable[]) => write(() => this.bucketOf(objectType).removeObjects(targets)),
      addCallback: (callback: (response: AxiosResponse<T>) => void) =>
        this.wrapPromise(
          promise.then((response) => {
            callback(response);
            return response;
          }),
          request,
        ),
      addOnProgressCallback: (callback: ProgressCallback) => {
        request.progress.add(callback);
        return wrapped;
      },
    });
    return wrapped;
  }

  private deliverProgress(request: RequestContext, event: AxiosProgressEvent): void {
    for (const callback of request.progress) callback(event);
  }

  // ---------------------------------------------------------------------------
  // Store writes (run inside unlessStoreReset)
  // ---------------------------------------------------------------------------

  private saveAppData(body: unknown, objectType: ObjectType, dataProperty: string | undefined): void {
    const deleted = deletedIds(body, objectType);
    const records = recordsIn(body, objectType, dataProperty);
    if (records === NONE && deleted === NONE) throw new TypeError(`saveAppData: the response carries no ${missing(objectType, dataProperty)}`);
    if (records !== NONE) this.models.addData(objectType, records);
    if (deleted !== NONE) this.bucketOf(objectType).removeObjects(deleted);
  }

  private saveMetaData(body: unknown, parentType: ObjectType, parentId: IndexValue, key: string): void {
    if (!isRecord(body) || !hasField(body, key)) throw new TypeError(`saveMetaData: the response carries no "${key}"`);
    this.bucketOf(parentType).addMetaData(parentId, key, body[key]);
  }

  private saveObjectsBelongingTo(body: unknown, relation: ObjectType, ownerType: ObjectType, ownerId: IndexValue, objectType: ObjectType): void {
    const link = Object.values(definitionFor(ownerType).hasMany ?? {}).find((h) => h.through === relation && h.objectType === objectType);
    if (link === undefined) throw new TypeError(`saveObjectsBelongingTo: ${ownerType} declares no hasMany of ${objectType} through ${relation}`);
    if (!isKeyValue(ownerId)) throw new TypeError(`saveObjectsBelongingTo: the ${ownerType} id must be a finite number or non-empty string`);
    const records = recordsIn(body, objectType, undefined);
    if (records === NONE) throw new TypeError(`saveObjectsBelongingTo: the response carries no ${objectType}`);

    const joinIndex = definitionFor(relation).index;
    const otherIndex = definitionFor(objectType).index;
    // the composite id follows the join's declared key order, so both sides of the relation build the same id for a link
    const idOrder = Object.keys(definitionFor(relation).foreignKeys ?? {}).filter((key) => key === link.thisKey || key === link.otherKey);
    const stored = this.models.addData(objectType, records);
    const rows = stored.map((object): Row => {
      const row: Row = { [link.thisKey]: ownerId, [link.otherKey]: (object as Row)[otherIndex] };
      row[joinIndex] = compositeId(idOrder.map((key) => row[key] as IndexValue));
      return row;
    });
    const linked = new Set(rows.map((row) => canonicalKey(row[joinIndex] as IndexValue)));
    const join = this.bucketOf(relation);
    const stale = join.getGroupedById(link.thisKey, ownerId).filter((row) => !linked.has(canonicalKey((row as Row)[joinIndex] as IndexValue)));
    this.models.addData(relation, rows);
    join.removeObjects(stale);
  }

  private bucketOf(objectType: ObjectType): DataCacheIndex<object> {
    const bucket = this.store.bucket(objectType);
    if (bucket === undefined) throw new TypeError(`the store has no "${objectType}" bucket`); // unreachable: DataCache is generated from the schema
    return bucket;
  }
}

/** "Not in the response" — distinct from any value the response can hold (`null` included). */
const NONE: unique symbol = Symbol("none");

/** Where the records for `objectType` are in `body` (see the header), or NONE. */
function recordsIn(body: unknown, objectType: ObjectType, dataProperty: string | undefined): unknown {
  if (dataProperty !== undefined) return isRecord(body) && hasField(body, dataProperty) ? body[dataProperty] : NONE;
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return NONE;
  const keys = Object.keys(body).filter((key) => key === objectType || pluralize(key) === objectType);
  if (keys.length > 1) throw new TypeError(`the response carries ${objectType} under both ${keys.map((k) => `"${k}"`).join(" and ")}`);
  return keys.length === 1 ? body[keys[0] as string] : NONE;
}

/** The ids in `body["deleted_<objectType>"]`, or NONE. Throws for anything but an array of key values. */
function deletedIds(body: unknown, objectType: ObjectType): readonly IndexValue[] | typeof NONE {
  const key = `deleted_${objectType}`;
  if (!isRecord(body) || !hasField(body, key)) return NONE;
  const ids = body[key];
  if (!Array.isArray(ids) || !ids.every(isKeyValue)) throw new TypeError(`"${key}" must be an array of ids`);
  return ids;
}

function missing(objectType: ObjectType, dataProperty: string | undefined): string {
  return dataProperty === undefined ? `${objectType} and no deleted_${objectType}` : `"${dataProperty}" and no deleted_${objectType}`;
}

/**
 * A join row's id from its key values: "3-7". Each part is escaped ("%" and
 * "-") so the id is unambiguous whatever the parts hold ("a-b" + "c" and
 * "a" + "b-c" differ); numeric ids read as written.
 */
export function compositeId(parts: readonly IndexValue[]): string {
  return parts.map((part) => canonicalKey(part).replace(/[%-]/g, (c) => (c === "%" ? "%25" : "%2D"))).join("-");
}
