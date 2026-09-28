/**
 * PassiveModel — the base of every model class.
 *
 * A model is a plain data holder: the server's JSON copied onto the instance
 * (`initializeFromJson`), plus the accessors the generator emits on the
 * `*AppData` base (step 8) and whatever domain behaviour the handwritten
 * model adds (step 9). It never talks to the server and never writes to the
 * store; factories do that.
 *
 * Field declarations in subclasses MUST use `declare` (`declare id: number`),
 * never a plain field or an initializer: the constructor assigns the JSON
 * first, and with `useDefineForClassFields` (our ESNext target) a plain field
 * would then be re-defined as `undefined` after the base constructor returns.
 *
 * JSON is untrusted for NAMES as well as values: a field that would shadow a
 * member of the model (a method, an accessor, `constructor`, …), a name that
 * changes how an instance behaves (`then`, `toJSON`) or an own `__proto__`
 * key throws instead of being copied. The schema validator enforces the same
 * rule for declared fields; this is the runtime half for fields it cannot see.
 *
 * `S` is the store the model's accessors read from (the generated `DataCache`
 * for generated bases). The bucket that stores a model sets it; `storeOf`
 * throws for a model no store holds, because its relations would resolve
 * against nothing.
 */
import { isInstanceBehaviourName } from "../../store/ModelDefinitions";
import { declareOwnerSlot, ownerOf, setOwner } from "../../store/storeOwner";

export abstract class PassiveModel<S extends object = object> {
  constructor(json?: Record<string, unknown>) {
    declareOwnerSlot(this);
    if (json !== undefined) this.initializeFromJson(json);
  }

  /**
   * Copies every own field of `json` onto this instance (a response is
   * authoritative: no merging logic here). Throws for a field that would
   * shadow a member of the model or replace its prototype.
   */
  initializeFromJson(json: Record<string, unknown>): this {
    const prototype = Object.getPrototypeOf(this) as object;
    const own = this as unknown as Record<string, unknown>;
    for (const key of Object.keys(json)) {
      // `prototype` cannot hurt an instance, but it is on the validator's reserved list, so the runtime rule matches exactly
      if (key === "__proto__" || key === "prototype" || key in prototype || isInstanceBehaviourName(key)) {
        throw new TypeError(`${this.constructor.name}: JSON field "${key}" would shadow a model member; it cannot be a data field`);
      }
      own[key] = json[key];
    }
    return this;
  }

  /** A deep copy of the data fields as a new instance of the same class, held by the same store; accessors stay on the prototype. */
  clone(): this {
    const Constructor = this.constructor as new (json: Record<string, unknown>) => this;
    const copy = new Constructor(structuredClone({ ...this } as Record<string, unknown>));
    setOwner(copy, ownerOf(this));
    return copy;
  }

  /** The store's type, for `storeOf`; never a runtime value. */
  declare readonly __store?: S;
}

/** The store that holds `model` (set by the bucket on `add`, kept by `clone`); throws for a model no store holds. */
export function storeOf<S extends object>(model: PassiveModel<S>): S {
  const owner = ownerOf(model);
  if (owner === undefined) {
    throw new Error(`${model.constructor.name}: this model is not held by a store, so its relations cannot be resolved; add it to a bucket first`);
  }
  return owner as S;
}
