import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createMockServer, type MockServer } from "../server";
import {
  AuthenticationError,
  AuthenticationServiceClass,
  CREDENTIALS_STORAGE_KEY,
  PERSISTED_STATE_PREFIX,
  RETURN_URL_STORAGE_KEY,
  toCredentials,
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

// ---------------------------------------------------------------------------
// PR #4 review regressions
// ---------------------------------------------------------------------------

const STATE = PERSISTED_STATE_PREFIX;

/** Real sign_in responses for Ada and Grace, obtained up front so tests can replay them in any order. */
async function signInResponseBody(email: string) {
  const res = await fetch(`${apiBase}v1/sign_in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password" }),
  });
  return (await res.json()) as { uuid: string; token: string; user: { id: number } };
}

/** A fetch whose responses are released manually, in whatever order a test wants. */
function controlledFetch() {
  const pending: { url: string; resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
  const fetchImpl = (input: string | URL | Request) =>
    new Promise<Response>((resolve, reject) => pending.push({ url: String(input), resolve, reject }));
  return { fetchImpl, pending };
}

/** Simulates another tab writing to shared localStorage and the resulting storage event. */
function otherTab(local: KeyValueStorage, listeners: ((e: Event) => void)[]) {
  return {
    login(credentials: { uuid: string; token: string; userId: number }) {
      local.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(credentials));
      for (const l of listeners) l({ key: CREDENTIALS_STORAGE_KEY } as StorageEvent);
    },
    logout() {
      local.removeItem(CREDENTIALS_STORAGE_KEY);
      for (const l of listeners) l({ key: CREDENTIALS_STORAGE_KEY } as StorageEvent);
    },
  };
}

function withStorageEvents() {
  const listeners: ((e: Event) => void)[] = [];
  const eventTarget = {
    addEventListener: (_t: string, l: EventListenerOrEventListenerObject) => void listeners.push(l as (e: Event) => void),
  };
  return { listeners, eventTarget };
}

describe("finding 1: persisted UI state is cleared on every logout / account switch", () => {
  test("a logout in another tab clears this tab's _state_* keys but keeps the return URL", () => {
    const local = memoryStorage({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify({ uuid: "a", token: "t", userId: 1 }), [`${STATE}draft`]: "private" });
    const session = memoryStorage({ [`${STATE}tab`]: "tasks", [RETURN_URL_STORAGE_KEY]: "/back" });
    const { listeners, eventTarget } = withStorageEvents();
    const auth = service({ localStorage: local, sessionStorage: session, eventTarget });
    expect(auth.isAuthenticated()).toBe(true);

    otherTab(local, listeners).logout();

    expect(auth.isAuthenticated()).toBe(false);
    expect(local.dump()).toEqual({});
    expect(session.dump()).toEqual({ [RETURN_URL_STORAGE_KEY]: "/back" });
  });

  test("an account switch in another tab clears state before subscribers hear about it, and keeps the new credentials", () => {
    const local = memoryStorage({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify({ uuid: "a", token: "t", userId: 1 }), [`${STATE}draft`]: "ada's" });
    const session = memoryStorage({ [`${STATE}tab`]: "tasks" });
    const { listeners, eventTarget } = withStorageEvents();
    const auth = service({ localStorage: local, sessionStorage: session, eventTarget });
    const seenAtNotify: Record<string, string>[] = [];
    auth.subscribe(() => seenAtNotify.push({ ...local.dump(), ...session.dump() }));

    otherTab(local, listeners).login({ uuid: "g", token: "t2", userId: 2 });

    expect(auth.getCredentials()?.userId).toBe(2);
    expect(seenAtNotify).toHaveLength(1);
    expect(Object.keys(seenAtNotify[0]!)).toEqual([CREDENTIALS_STORAGE_KEY]); // state gone, credentials present
    expect(JSON.parse(local.getItem(CREDENTIALS_STORAGE_KEY)!)).toEqual({ uuid: "g", token: "t2", userId: 2 });
  });

  test("a direct account switch via setCredentials clears state in both storages", () => {
    const local = memoryStorage({ [`${STATE}draft`]: "ada's" });
    const session = memoryStorage({ [`${STATE}tab`]: "tasks" });
    const auth = service({ localStorage: local, sessionStorage: session });
    auth.setCredentials({ uuid: "a", token: "t", userId: 1 });
    expect(local.dump()[`${STATE}draft`]).toBe("ada's"); // login from signed-out keeps pre-login state

    auth.setCredentials({ uuid: "g", token: "t2", userId: 2 });

    expect(local.dump()).toEqual({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify({ uuid: "g", token: "t2", userId: 2 }) });
    expect(session.dump()).toEqual({});
  });

  test("the same user starting a new session (re-login in another tab) keeps state", () => {
    const local = memoryStorage({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify({ uuid: "a1", token: "t", userId: 1 }), [`${STATE}draft`]: "ada's" });
    const { listeners, eventTarget } = withStorageEvents();
    const auth = service({ localStorage: local, eventTarget });

    otherTab(local, listeners).login({ uuid: "a2", token: "t2", userId: 1 });

    expect(auth.authenticationHeader()).toBe("a2:t2");
    expect(local.dump()[`${STATE}draft`]).toBe("ada's");
  });

  test("logout() clears state synchronously, before the server round-trip", async () => {
    const local = memoryStorage({ [`${STATE}draft`]: "x" });
    const { fetchImpl, pending } = controlledFetch();
    const auth = service({ localStorage: local, fetch: fetchImpl });
    auth.setCredentials({ uuid: "a", token: "t", userId: 1 });

    const done = auth.logout();
    expect(auth.isAuthenticated()).toBe(false);
    expect(local.dump()).toEqual({});
    expect(pending).toHaveLength(1);
    expect(pending[0]!.url).toEndWith("v1/sign_out");
    pending[0]!.resolve(Response.json({ ok: true }));
    await done;
  });
});

describe("finding 2: stale async results never overwrite newer authentication decisions", () => {
  test("a login that completes after handleLogout() is discarded", async () => {
    const local = memoryStorage();
    const { fetchImpl, pending } = controlledFetch();
    const auth = service({ localStorage: local, fetch: fetchImpl });
    const ada = await signInResponseBody("ada@example.com");

    const login = auth.login("ada@example.com", "password");
    auth.setCredentials({ uuid: "tmp", token: "t", userId: 1 }); // something changed meanwhile...
    auth.handleLogout(); // ...and the user signed out
    pending[0]!.resolve(Response.json(ada));

    const error = await failing(login);
    expect(error.code).toBe("superseded");
    expect(auth.isAuthenticated()).toBe(false);
    expect(local.dump()).toEqual({});
  });

  test("an older login response does not overwrite a newer successful login", async () => {
    const { fetchImpl, pending } = controlledFetch();
    const auth = service({ fetch: fetchImpl });
    const ada = await signInResponseBody("ada@example.com");
    const grace = await signInResponseBody("grace@example.com");

    const first = auth.login("ada@example.com", "password");
    const second = auth.login("grace@example.com", "password");
    pending[1]!.resolve(Response.json(grace)); // newer resolves first
    await second;
    pending[0]!.resolve(Response.json(ada)); // older arrives late

    const error = await failing(first);
    expect(error.code).toBe("superseded");
    expect(auth.getCredentials()).toEqual({ uuid: grace.uuid, token: grace.token, userId: 2 });
  });

  test("a pending logout cannot delete a newer session started in another tab", async () => {
    const local = memoryStorage();
    const { listeners, eventTarget } = withStorageEvents();
    const { fetchImpl, pending } = controlledFetch();
    const auth = service({ localStorage: local, eventTarget, fetch: fetchImpl });
    auth.setCredentials({ uuid: "a", token: "t", userId: 1 });

    const done = auth.logout(); // local logout happens now; sign_out request is pending
    otherTab(local, listeners).login({ uuid: "g", token: "t2", userId: 2 });
    pending[0]!.resolve(Response.json({ ok: true }));
    await done;

    expect(auth.authenticationHeader()).toBe("g:t2");
    expect(JSON.parse(local.getItem(CREDENTIALS_STORAGE_KEY)!)).toEqual({ uuid: "g", token: "t2", userId: 2 });
  });

  test("handleLogout() leaves another session's stored credentials alone", () => {
    const local = memoryStorage();
    const auth = service({ localStorage: local });
    auth.setCredentials({ uuid: "a", token: "t", userId: 1 });
    // another tab wrote newer credentials but this tab's storage event has not fired yet
    local.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify({ uuid: "g", token: "t2", userId: 2 }));

    auth.handleLogout();

    expect(auth.isAuthenticated()).toBe(false);
    expect(JSON.parse(local.getItem(CREDENTIALS_STORAGE_KEY)!)).toEqual({ uuid: "g", token: "t2", userId: 2 });
  });
});

describe("finding 3: malformed 2xx responses are typed server errors", () => {
  const cases: [string, () => Response][] = [
    ["HTML body", () => new Response("<html>captive portal</html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["empty body", () => new Response("", { status: 200 })],
    ["JSON null", () => Response.json(null)],
    ["JSON array", () => Response.json([1, 2])],
    ["JSON string", () => Response.json("ok")],
    ["user is null", () => Response.json({ uuid: "u", token: "t", user: null })],
  ];
  for (const [name, make] of cases) {
    test(`${name} -> AuthenticationError("server") and stays signed out`, async () => {
      const auth = service({ fetch: async () => make() });
      const error = await failing(auth.login("a", "b"));
      expect(error.code).toBe("server");
      expect(auth.isAuthenticated()).toBe(false);
    });
  }
});

describe("finding 4: blank credentials are never accepted", () => {
  test("a 200 with empty uuid or token is a server error", async () => {
    for (const body of [
      { uuid: "", token: "t", user: { id: 1 } },
      { uuid: "u", token: "   ", user: { id: 1 } },
      { uuid: "u", token: "t", user: { id: NaN } },
    ]) {
      const auth = service({ fetch: async () => Response.json(body) });
      const error = await failing(auth.login("a", "b"));
      expect(error.code).toBe("server");
      expect(auth.isAuthenticated()).toBe(false);
      expect(auth.authenticationHeader()).toBeNull();
    }
  });

  test("stored credentials with blank values are ignored on restore", () => {
    for (const stored of [{ uuid: "", token: "", userId: 1 }, { uuid: " ", token: "t", userId: 1 }]) {
      const auth = service({ localStorage: memoryStorage({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify(stored) }) });
      expect(auth.isAuthenticated()).toBe(false);
      expect(auth.authenticationHeader()).toBeNull();
    }
  });

  test("setCredentials rejects blank values", () => {
    const auth = service();
    expect(() => auth.setCredentials({ uuid: "", token: "t", userId: 1 })).toThrow(TypeError);
    expect(() => auth.setCredentials({ uuid: "u", token: " ", userId: 1 })).toThrow(TypeError);
    expect(auth.isAuthenticated()).toBe(false);
  });

  test("toCredentials is the single validator", () => {
    expect(toCredentials({ uuid: "u", token: "t", userId: 1, extra: true })).toEqual({ uuid: "u", token: "t", userId: 1 });
    expect(toCredentials({ uuid: "u", token: "t", userId: "1" })).toBeNull();
    expect(toCredentials(null)).toBeNull();
    expect(toCredentials("u:t")).toBeNull();
  });
});
