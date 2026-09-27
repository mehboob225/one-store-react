import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createMockServer, type MockServer } from "../server";
import {
  AuthenticationError,
  AuthenticationServiceClass,
  CREDENTIALS_STORAGE_KEY,
  PERSISTED_STATE_PREFIX,
  RETURN_URL_STORAGE_KEY,
  type KeyValueStorage,
} from "./AuthenticationService";

let mock: MockServer;
let apiBase: string;

beforeAll(() => {
  mock = createMockServer({ pingIntervalMs: 60_000 });
  apiBase = `${mock.url.origin}/api/`;
});

afterAll(async () => {
  await mock.stop();
});

/** A tiny in-memory Storage so tests never share state through happy-dom's globals. */
function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    dump: () => Object.fromEntries(map),
  };
}

function throwingStorage(): KeyValueStorage {
  const boom = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  return { getItem: boom, setItem: boom, removeItem: boom, key: boom, length: 0 };
}

/** Awaits a promise that must reject with an AuthenticationError. */
async function failing(promise: Promise<unknown>): Promise<AuthenticationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthenticationError) return error;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

function service(overrides: Partial<ConstructorParameters<typeof AuthenticationServiceClass>[0]> = {}) {
  return new AuthenticationServiceClass({
    apiBase,
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    eventTarget: null,
    ...overrides,
  });
}

beforeEach(() => mock.reset());

describe("login", () => {
  test("stores credentials and produces a uuid:token header", async () => {
    const local = memoryStorage();
    const auth = service({ localStorage: local });
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.authenticationHeader()).toBeNull();

    const credentials = await auth.login("ada@example.com", "password");
    expect(credentials.userId).toBe(1);
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.authenticationHeader()).toBe(`${credentials.uuid}:${credentials.token}`);
    expect(auth.authenticationHeader()).toMatch(/^[0-9a-f-]{36}:[0-9a-f]{32}$/);

    // persisted under one key, as JSON
    expect(JSON.parse(local.getItem(CREDENTIALS_STORAGE_KEY)!)).toEqual(credentials);

    // the header is accepted by the server
    const res = await fetch(`${apiBase}v1/users/current`, { headers: { authorization: auth.authenticationHeader()! } });
    expect(res.status).toBe(200);
  });

  test("wrong password throws invalid_credentials and leaves the service signed out", async () => {
    const auth = service();
    const error = await failing(auth.login("ada@example.com", "nope"));
    expect(error.code).toBe("invalid_credentials");
    expect(error.status).toBe(401);
    expect(auth.isAuthenticated()).toBe(false);
  });

  test("a non-401 failure throws server; a thrown fetch throws network", async () => {
    const server = await failing(service({ apiBase: `${mock.url.origin}/nowhere/` }).login("ada@example.com", "password"));
    expect(server.code).toBe("server");
    expect(server.status).toBe(404);

    const network = await failing(
      service({ fetch: () => Promise.reject(new TypeError("Failed to fetch")) }).login("ada@example.com", "password"),
    );
    expect(network.code).toBe("network");
  });

  test("a malformed sign_in response throws server", async () => {
    const auth = service({ fetch: async () => Response.json({ uuid: "x" }) });
    const error = await failing(auth.login("a", "b"));
    expect(error.code).toBe("server");
    expect(auth.isAuthenticated()).toBe(false);
  });

  test("setCredentials stores externally obtained credentials", () => {
    const auth = service();
    auth.setCredentials({ uuid: "u", token: "t", userId: 9 });
    expect(auth.authenticationHeader()).toBe("u:t");
    expect(auth.getCredentials()?.userId).toBe(9);
  });
});

describe("persistence", () => {
  test("a new instance restores credentials from storage (page reload)", async () => {
    const local = memoryStorage();
    const first = service({ localStorage: local });
    await first.login("ada@example.com", "password");

    const second = service({ localStorage: local });
    expect(second.authenticationHeader()).toBe(first.authenticationHeader());
  });

  test("corrupt or partial stored credentials are ignored", () => {
    for (const raw of ["not json", "{}", JSON.stringify({ uuid: "u", token: "t" }), JSON.stringify({ uuid: 1, token: 2, userId: 3 })]) {
      const auth = service({ localStorage: memoryStorage({ [CREDENTIALS_STORAGE_KEY]: raw }) });
      expect(auth.isAuthenticated()).toBe(false);
    }
  });

  test("works memory-only when storage throws", async () => {
    const auth = service({ localStorage: throwingStorage(), sessionStorage: throwingStorage() });
    await auth.login("ada@example.com", "password");
    expect(auth.isAuthenticated()).toBe(true);
    auth.saveReturnUrl("/x");
    expect(auth.consumeReturnUrl()).toBeNull();
    auth.handleLogout();
    expect(auth.isAuthenticated()).toBe(false);
  });

  test("another tab's login/logout is picked up through the storage event", () => {
    const local = memoryStorage();
    const listeners: ((e: Event) => void)[] = [];
    const eventTarget = { addEventListener: (_t: string, l: EventListenerOrEventListenerObject) => void listeners.push(l as (e: Event) => void) };
    const auth = service({ localStorage: local, eventTarget });
    const seen: (string | null)[] = [];
    auth.subscribe((c) => seen.push(c ? c.uuid : null));

    // other tab logs in
    local.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify({ uuid: "other", token: "t", userId: 2 }));
    for (const l of listeners) l({ key: CREDENTIALS_STORAGE_KEY } as StorageEvent);
    expect(auth.authenticationHeader()).toBe("other:t");

    // unrelated key: ignored
    for (const l of listeners) l({ key: "something-else" } as StorageEvent);
    expect(auth.authenticationHeader()).toBe("other:t");

    // other tab logs out (removeItem) and `clear()` (key === null)
    local.removeItem(CREDENTIALS_STORAGE_KEY);
    for (const l of listeners) l({ key: null } as StorageEvent);
    expect(auth.isAuthenticated()).toBe(false);

    expect(seen).toEqual(["other", null]);
  });
});

describe("logout", () => {
  test("logout() revokes the server session and clears locally", async () => {
    const auth = service();
    await auth.login("ada@example.com", "password");
    const header = auth.authenticationHeader()!;

    await auth.logout();
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.authenticationHeader()).toBeNull();
    const res = await fetch(`${apiBase}v1/projects`, { headers: { authorization: header } });
    expect(res.status).toBe(401);
  });

  test("logout() still clears locally when the server call fails", async () => {
    const auth = service({ fetch: async (input, init) => {
      if (String(input).endsWith("sign_out")) throw new TypeError("offline");
      return fetch(input, init);
    } });
    await auth.login("ada@example.com", "password");
    await auth.logout();
    expect(auth.isAuthenticated()).toBe(false);
  });

  test("handleLogout wipes _state_* keys in both storages but nothing else", async () => {
    const local = memoryStorage({ [`${PERSISTED_STATE_PREFIX}sidebar`]: "open", theme: "dark" });
    const session = memoryStorage({ [`${PERSISTED_STATE_PREFIX}tab`]: "tasks", [RETURN_URL_STORAGE_KEY]: "/projects/1" });
    const auth = service({ localStorage: local, sessionStorage: session });
    await auth.login("ada@example.com", "password");
    expect(local.dump()[CREDENTIALS_STORAGE_KEY]).toBeDefined(); // key contains a dot: no toHaveProperty

    auth.handleLogout();

    expect(local.dump()).toEqual({ theme: "dark" });
    expect(session.dump()).toEqual({ [RETURN_URL_STORAGE_KEY]: "/projects/1" });
    expect(auth.isAuthenticated()).toBe(false);
  });

  test("subscribers are notified once per change", async () => {
    const auth = service();
    const events: (number | null)[] = [];
    const unsubscribe = auth.subscribe((c) => events.push(c?.userId ?? null));
    await auth.login("ada@example.com", "password");
    auth.handleLogout();
    auth.handleLogout(); // no-op: already signed out
    unsubscribe();
    await auth.login("ada@example.com", "password");
    expect(events).toEqual([1, null]);
  });
});

describe("return URL", () => {
  test("saveReturnUrl / consumeReturnUrl round-trip once", () => {
    const auth = service();
    expect(auth.consumeReturnUrl()).toBeNull();
    auth.saveReturnUrl("/projects/2/tasks?tab=done");
    expect(auth.consumeReturnUrl()).toBe("/projects/2/tasks?tab=done");
    expect(auth.consumeReturnUrl()).toBeNull();
  });

  test("the return URL survives handleLogout (it is set on 401 to come back after re-login)", () => {
    const auth = service();
    auth.saveReturnUrl("/projects/2");
    auth.handleLogout();
    expect(auth.consumeReturnUrl()).toBe("/projects/2");
  });
});

describe("defaults", () => {
  test("the default instance uses window storage and DomainConfiguration.api", async () => {
    const { AuthenticationService, CREDENTIALS_STORAGE_KEY: key } = await import("./AuthenticationService");
    window.localStorage.clear();
    expect(AuthenticationService.isAuthenticated()).toBe(false);
    AuthenticationService.setCredentials({ uuid: "u", token: "t", userId: 1 });
    expect(window.localStorage.getItem(key)).toContain('"uuid":"u"');
    AuthenticationService.handleLogout();
    expect(window.localStorage.getItem(key)).toBeNull();
  });
});
