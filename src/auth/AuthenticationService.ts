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
 * Every change goes through one `commit()` path, which:
 *   - bumps a generation counter (also bumped when a login *starts*), so an
 *     async login or logout that finishes after a newer change is discarded
 *     instead of overwriting it — the same idea as the store's generation
 *     guard, and "latest attempt wins" for overlapping logins;
 *   - wipes `_state_*` keys — the persisted UI atoms (step 14) — when the
 *     signed-in *user* changes or signs out. Ownership rule: per-tab
 *     sessionStorage state is cleared by every tab that observes the
 *     transition; shared localStorage state is cleared only by the tab that
 *     *performs* it (writes or removes the credentials). A tab whose session
 *     is already superseded in storage by another tab is not the owner and
 *     must not wipe the newer session's shared state;
 *   - notifies subscribers after the storage is consistent, and only when
 *     the credentials actually changed. Side effects are never deduplicated:
 *     an explicit logout while signed out still invalidates pending logins.
 */
import { DomainConfiguration } from "../config/DomainConfiguration";

export interface Credentials {
  uuid: string;
  token: string;
  userId: number;
}

export type AuthenticationErrorCode =
  /** 401 from sign_in: wrong email or password. */
  | "invalid_credentials"
  /** The request never got a response. */
  | "network"
  /** Non-401 failure, or a 2xx whose body is not a valid sign_in payload. */
  | "server"
  /** Authentication changed while the request was in flight; the result was discarded. */
  | "superseded";

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

/**
 * The one credential validator, shared by login responses, restored storage
 * and externally supplied credentials. Blank strings are not credentials.
 */
export function toCredentials(value: unknown): Credentials | null {
  if (typeof value !== "object" || value === null) return null;
  const { uuid, token, userId } = value as Record<string, unknown>;
  if (!isNonBlankString(uuid) || !isNonBlankString(token)) return null;
  if (typeof userId !== "number" || !Number.isFinite(userId)) return null;
  return { uuid, token, userId };
}

export class AuthenticationServiceClass {
  private readonly apiBase: string;
  private readonly local: KeyValueStorage | null;
  private readonly session: KeyValueStorage | null;
  private readonly fetchImpl: FetchLike;
  private readonly listeners = new Set<Listener>();
  private credentials: Credentials | null;
  /** Bumped on every committed change; async operations compare before committing. */
  private generation = 0;

  constructor(options: AuthenticationServiceOptions = {}) {
    this.apiBase = options.apiBase ?? DomainConfiguration.api;
    this.local = options.localStorage === undefined ? defaultStorage("localStorage") : options.localStorage;
    this.session = options.sessionStorage === undefined ? defaultStorage("sessionStorage") : options.sessionStorage;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.credentials = this.readStoredCredentials();

    const target = options.eventTarget === undefined ? defaultWindow() : options.eventTarget;
    target?.addEventListener("storage", (event) => {
      const key = (event as StorageEvent).key;
      // key === null means the other tab called storage.clear()
      if (key === CREDENTIALS_STORAGE_KEY || key === null) this.commit(this.readStoredCredentials(), { persist: false });
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

  /** Notifies on login/logout/account switch (including from another tab). Returns unsubscribe. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- login / logout ----------------------------------------------------

  /**
   * Signs in. Rejects with an AuthenticationError for every failure,
   * including a response that arrives after authentication changed
   * (`superseded`) — that result is discarded, not applied.
   */
  async login(email: string, password: string): Promise<Credentials> {
    // A new attempt supersedes any pending one, whatever order responses arrive in.
    const generation = ++this.generation;

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

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AuthenticationError("server", "sign_in response is not JSON", response.status);
    }
    const payload = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const user = typeof payload.user === "object" && payload.user !== null ? (payload.user as Record<string, unknown>) : {};
    const credentials = toCredentials({ uuid: payload.uuid, token: payload.token, userId: user.id });
    if (!credentials) throw new AuthenticationError("server", "sign_in response is missing uuid, token or user.id", response.status);

    if (generation !== this.generation) {
      throw new AuthenticationError("superseded", "authentication changed while signing in; result discarded");
    }
    this.commit(credentials, { persist: true });
    return credentials;
  }

  /**
   * Stores credentials obtained elsewhere (e.g. a single-sign-on token in the
   * URL) as if `login()` had returned them. Throws on malformed input.
   */
  setCredentials(credentials: Credentials): void {
    const valid = toCredentials(credentials);
    if (!valid) throw new TypeError("setCredentials: uuid and token must be non-blank strings and userId a number");
    this.commit(valid, { persist: true });
  }

  /**
   * Signs out. Local state is cleared *first* (synchronously), then the
   * server session is revoked best-effort with the captured header. Nothing
   * is mutated after the await, so a slow sign_out can never clobber a
   * session started in the meantime (here or in another tab).
   */
  async logout(): Promise<void> {
    const header = this.authenticationHeader();
    this.handleLogout();
    if (!header) return;
    try {
      await this.fetchImpl(`${this.apiBase}v1/sign_out`, { method: "DELETE", headers: { authorization: header } });
    } catch {
      // ignore: the session may already be gone, and local logout already happened
    }
  }

  /**
   * Local logout only: drops credentials and wipes persisted UI state. Used
   * directly when the server has already rejected the session (401, push
   * `session_invalid`). Does not navigate — the app shell does that.
   */
  handleLogout(): void {
    this.commit(null, { persist: true, force: true });
  }

  /** Removes every `_state_*` key from localStorage and sessionStorage (or just one of them). */
  clearBrowserStorage(scope: { shared?: boolean; tab?: boolean } = { shared: true, tab: true }): void {
    const targets = [scope.shared ? this.local : null, scope.tab ? this.session : null];
    for (const storage of targets) {
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

  /**
   * The single write path. `persist: false` is for changes observed from
   * another tab, whose storage writes are already done and must not be
   * undone here. `force` runs the side effects even when nothing changed
   * (explicit logout while signed out).
   */
  private commit(next: Credentials | null, { persist, force = false }: { persist: boolean; force?: boolean }): void {
    const prev = this.credentials;
    const unchanged = sameCredentials(prev, next);
    if (unchanged && !force) return;

    this.generation++;

    // Do we own the shared (localStorage) state? Only the tab performing the
    // transition does — and not if storage already holds a different session,
    // which means another tab performed a newer transition and owns it.
    let ownsShared = persist;
    if (persist) {
      if (next) {
        safe(() => this.local?.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(next)));
      } else {
        const stored = this.readStoredCredentials(); // null when absent or corrupt
        const foreign = stored !== null && stored.uuid !== prev?.uuid;
        if (foreign) ownsShared = false;
        else safe(() => this.local?.removeItem(CREDENTIALS_STORAGE_KEY)); // ours, or corrupt: remove
      }
    }

    // Signed out (or explicitly logging out), or a different user signed in:
    // persisted UI state must go — this tab's always, the shared one only if we own it.
    const signedOut = next === null && (prev !== null || force);
    const userChanged = prev !== null && next !== null && prev.userId !== next.userId;
    if (signedOut || userChanged) this.clearBrowserStorage({ tab: true, shared: ownsShared });

    this.credentials = next;
    if (!unchanged) for (const listener of this.listeners) listener(next);
  }

  private readStoredCredentials(): Credentials | null {
    return (
      safe(() => {
        const raw = this.local?.getItem(CREDENTIALS_STORAGE_KEY);
        return raw ? toCredentials(JSON.parse(raw)) : null;
      }) ?? null
    );
  }
}

function sameCredentials(a: Credentials | null, b: Credentials | null): boolean {
  if (a === null || b === null) return a === b;
  return a.uuid === b.uuid && a.token === b.token && a.userId === b.userId;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Runs `fn`, returning undefined if storage throws (private mode, quota, blocked). */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function defaultStorage(name: "localStorage" | "sessionStorage"): KeyValueStorage | null {
  return safe(() => (typeof window !== "undefined" ? window[name] : null)) ?? null;
}

function defaultWindow(): Pick<Window, "addEventListener"> | null {
  return typeof window !== "undefined" ? window : null;
}

export const AuthenticationService = new AuthenticationServiceClass();
