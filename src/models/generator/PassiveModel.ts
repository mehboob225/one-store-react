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
 */
export abstract class PassiveModel {
  constructor(json?: Record<string, unknown>) {
    if (json !== undefined) this.initializeFromJson(json);
  }

  /** Copies every own field of `json` onto this instance (a response is authoritative: no merging logic here). */
  initializeFromJson(json: Record<string, unknown>): this {
    Object.assign(this, json);
    return this;
  }

  /** A deep copy of the data fields as a new instance of the same class; accessors stay on the prototype. */
  clone(): this {
    const Constructor = this.constructor as new (json: Record<string, unknown>) => this;
    return new Constructor(structuredClone({ ...this } as Record<string, unknown>));
  }
}
