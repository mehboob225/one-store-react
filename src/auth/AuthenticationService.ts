/**
 * AuthenticationService — the token provider.
 *
 * Owns login/logout and the stored credentials, and produces the
 * `uuid:token` header every API request needs. It runs *before* the API
 * client and the store exist, so it uses plain `fetch` and never writes to
 * the store: the current user is loaded by a loader after login.
 *
 * Credentials are persisted in localStorage under one key and cached in
 * memory so `authenticationHeader()` is synchronous. Another tab logging in
 * or out is picked up through the `storage` event. If browser storage is
 * unavailable (private mode, blocked), the service degrades to memory-only.
 *
 * `handleLogout()` also wipes every `_state_*` key from localStorage and
 * sessionStorage: those are the persisted UI atoms (step 14), which must
 * never survive an account switch.
 */
import { DomainConfiguration } from "../config/DomainConfiguration";

export interface Credentials {
  uuid: string;
  token: string;
  userId: number;
}

export type AuthenticationErrorCode = "invalid_credentials" | "network" | "server";

export class AuthenticationError extends Error {
  constructor(
    public readonly code: AuthenticationErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** A `fetch`-shaped function; injectable for tests. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The subset of `Storage` the service needs; injectable for tests. */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export interface AuthenticationServiceOptions {
  /** REST base, ends with "/". Defaults to DomainConfiguration.api. */
  apiBase?: string;
  /** Defaults to window.localStorage (credentials + persisted state). */
  localStorage?: KeyValueStorage | null;
  /** Defaults to window.sessionStorage (return URL + persisted state). */
  sessionStorage?: KeyValueStorage | null;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Window to listen on for cross-tab `storage` events; defaults to `window`. */
  eventTarget?: Pick<Window, "addEventListener"> | null;
}

export const CREDENTIALS_STORAGE_KEY = "one-store-react.credentials";
export const RETURN_URL_STORAGE_KEY = "one-store-react.return_url";
/** Prefix of every persisted UI-state key (see atoms/utils/storage in step 14). */
export const PERSISTED_STATE_PREFIX = "_state_";

type Listener = (credentials: Credentials | null) => void;

export class AuthenticationServiceClass {
  private readonly apiBase: string;
  private readonly local: KeyValueStorage | null;
  private readonly session: KeyValueStorage | null;
  private readonly fetchImpl: FetchLike;
  private readonly listeners = new Set<Listener>();
  private credentials: Credentials | null;

  constructor(options: AuthenticationServiceOptions = {}) {
    this.apiBase = options.apiBase ?? DomainConfiguration.api;
    this.local = orDefault(options.localStorage, () => defaultStorage("localStorage"));
    this.session = orDefault(options.sessionStorage, () => defaultStorage("sessionStorage"));
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.credentials = this.readCredentials();

    const target = orDefault(options.eventTarget, defaultWindow);
    target?.addEventListener("storage", (event) => {
      if ((event as StorageEvent).key === CREDENTIALS_STORAGE_KEY || (event as StorageEvent).key === null) {
        this.setCredentialsInMemory(this.readCredentials());
      }
    });
  }

  // ---- reading -----------------------------------------------------------

  isAuthenticated(): boolean {
    return this.credentials !== null;
  }

  getCredentials(): Credentials | null {
    return this.credentials;
  }

  /** `"uuid:token"`, or null when signed out. Synchronous and cheap. */
  authenticationHeader(): string | null {
    return this.credentials ? `${this.credentials.uuid}:${this.credentials.token}` : null;
  }

  /** Notifies on login/logout (including from another tab). Returns unsubscribe. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- login / logout ----------------------------------------------------

  async login(email: string, password: string): Promise<Credentials> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}v1/sign_in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    } catch (error) {
      throw new AuthenticationError("network", `sign_in request failed: ${(error as Error).message}`);
    }

    if (response.status === 401) throw new AuthenticationError("invalid_credentials", "invalid email or password", 401);
    if (!response.ok) throw new AuthenticationError("server", `sign_in failed with status ${response.status}`, response.status);

    const body = (await response.json()) as { uuid?: unknown; token?: unknown; user?: { id?: unknown } };
    if (typeof body.uuid !== "string" || typeof body.token !== "string" || typeof body.user?.id !== "number") {
      throw new AuthenticationError("server", "sign_in response is missing uuid, token or user.id");
    }

    const credentials: Credentials = { uuid: body.uuid, token: body.token, userId: body.user.id };
    this.setCredentials(credentials);
    return credentials;
  }

  /**
   * Stores credentials obtained elsewhere (e.g. a single-sign-on token in the
   * URL) as if `login()` had returned them.
   */
  setCredentials(credentials: Credentials): void {
    safe(() => this.local?.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(credentials)));
    this.setCredentialsInMemory(credentials);
  }

  /**
   * Signs out: best-effort `DELETE sign_out` on the server (failures are
   * ignored — the session may already be gone), then local cleanup.
   */
  async logout(): Promise<void> {
    const header = this.authenticationHeader();
    if (header) {
      try {
        await this.fetchImpl(`${this.apiBase}v1/sign_out`, { method: "DELETE", headers: { authorization: header } });
      } catch {
        // ignore: local logout proceeds regardless
      }
    }
    this.handleLogout();
  }

  /**
   * Local logout only: drops credentials and wipes persisted UI state. Used
   * directly when the server has already rejected the session (401, push
   * `session_invalid`). Does not navigate — the app shell does that.
   */
  handleLogout(): void {
    safe(() => this.local?.removeItem(CREDENTIALS_STORAGE_KEY));
    this.clearBrowserStorage();
    this.setCredentialsInMemory(null);
  }

  /** Removes every `_state_*` key from localStorage and sessionStorage. */
  clearBrowserStorage(): void {
    for (const storage of [this.local, this.session]) {
      if (!storage) continue;
      safe(() => {
        const doomed: string[] = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key?.startsWith(PERSISTED_STATE_PREFIX)) doomed.push(key);
        }
        for (const key of doomed) storage.removeItem(key);
      });
    }
  }

  // ---- return URL ---------------------------------------------------------

  /** Remembers where to go after the next successful login (per tab). */
  saveReturnUrl(url: string): void {
    safe(() => this.session?.setItem(RETURN_URL_STORAGE_KEY, url));
  }

  /** Returns and clears the saved return URL. */
  consumeReturnUrl(): string | null {
    return (
      safe(() => {
        const url = this.session?.getItem(RETURN_URL_STORAGE_KEY) ?? null;
        if (url !== null) this.session?.removeItem(RETURN_URL_STORAGE_KEY);
        return url;
      }) ?? null
    );
  }

  // ---- internals ----------------------------------------------------------

  private readCredentials(): Credentials | null {
    return (
      safe(() => {
        const raw = this.local?.getItem(CREDENTIALS_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<Credentials>;
        if (typeof parsed.uuid !== "string" || typeof parsed.token !== "string" || typeof parsed.userId !== "number") {
          return null;
        }
        return { uuid: parsed.uuid, token: parsed.token, userId: parsed.userId };
      }) ?? null
    );
  }

  private setCredentialsInMemory(credentials: Credentials | null): void {
    const changed =
      (this.credentials === null) !== (credentials === null) ||
      this.credentials?.uuid !== credentials?.uuid ||
      this.credentials?.token !== credentials?.token;
    this.credentials = credentials;
    if (changed) for (const listener of this.listeners) listener(credentials);
  }
}

/** Runs `fn`, returning undefined if storage throws (private mode, quota, blocked). */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** `undefined` means "use the default"; `null` is an explicit opt-out and is kept. */
function orDefault<T>(value: T | undefined, fallback: () => T): T {
  if (value === undefined) return fallback();
  return value;
}

function defaultStorage(name: "localStorage" | "sessionStorage"): KeyValueStorage | null {
  return safe(() => (typeof window !== "undefined" ? window[name] : null)) ?? null;
}

function defaultWindow(): Pick<Window, "addEventListener"> | null {
  return typeof window !== "undefined" ? window : null;
}

export const AuthenticationService = new AuthenticationServiceClass();
