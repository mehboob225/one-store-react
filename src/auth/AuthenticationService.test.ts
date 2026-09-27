import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createMockServer, type MockServer } from "../server";
import {
  AuthenticationError,
  AuthenticationServiceClass,
  CREDENTIALS_STORAGE_KEY,
  PERSISTED_STATE_PREFIX,
  RETURN_URL_STORAGE_KEY,
  toCredentials,
  type FetchLike,
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
  test("null options opt out: memory-only storage and no window listener", async () => {
    const original = window.addEventListener;
    let storageListeners = 0;
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "storage") storageListeners++;
      return (original as (...a: unknown[]) => void).call(window, type, ...rest);
    }) as typeof window.addEventListener;
    try {
      window.localStorage.clear();
      const auth = new AuthenticationServiceClass({ apiBase, localStorage: null, sessionStorage: null, eventTarget: null });
      expect(storageListeners).toBe(0);

      await auth.login("ada@example.com", "password");
      expect(auth.isAuthenticated()).toBe(true);
      expect(window.localStorage.getItem(CREDENTIALS_STORAGE_KEY)).toBeNull(); // never touched real storage
      auth.saveReturnUrl("/x");
      expect(auth.consumeReturnUrl()).toBeNull();

      // and `undefined` (omitted) still means "use the window default"
      new AuthenticationServiceClass({ apiBase });
      expect(storageListeners).toBe(1);
    } finally {
      window.addEventListener = original;
    }
  });

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
// PR #4 review regressions (two rounds)
// ---------------------------------------------------------------------------

const STATE = PERSISTED_STATE_PREFIX;
const ADA = { uuid: "a", token: "t", userId: 1 };
const ADA_AGAIN = { uuid: "a2", token: "t2", userId: 1 };
const GRACE = { uuid: "g", token: "t3", userId: 2 };

/** Real sign_in responses, obtained up front so tests can replay them in any order. */
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

/**
 * Two browser tabs: real service instances sharing one localStorage, each
 * with its own sessionStorage. `sync()` delivers the `storage` event the
 * browser would fire after a write; tests call it to control when the other
 * tab finds out. Tabs whose credentials did not change treat it as a no-op.
 */
function twoTabs(shared: Record<string, string> = {}, extra: { fetch?: FetchLike } = {}) {
  const local = memoryStorage(shared);
  const listeners: ((e: Event) => void)[] = [];
  const tab = (initialSession: Record<string, string> = {}) => {
    const session = memoryStorage(initialSession);
    const mine: ((e: Event) => void)[] = [];
    const eventTarget = {
      addEventListener: (_t: string, l: EventListenerOrEventListenerObject) => {
        mine.push(l as (e: Event) => void);
        listeners.push(l as (e: Event) => void);
      },
    };
    const auth = service({ localStorage: local, sessionStorage: session, eventTarget, ...extra });
    return { auth, session };
  };
  const sync = () => {
    for (const l of listeners) l({ key: CREDENTIALS_STORAGE_KEY } as StorageEvent);
  };
  return { local, tab, sync };
}

describe("finding 1 (round 1): persisted UI state is cleared on logout / account switch", () => {
  test("a logout in another tab clears this tab's _state_* keys but keeps the return URL", () => {
    const { local, tab, sync } = twoTabs({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify(ADA), [`${STATE}draft`]: "shared" });
    const a = tab({ [`${STATE}tab`]: "tasks", [RETURN_URL_STORAGE_KEY]: "/back" });
    const b = tab({ [`${STATE}other`]: "x" });
    expect(a.auth.isAuthenticated()).toBe(true);

    b.auth.handleLogout(); // b owns the transition: removes credentials, wipes shared + its own state
    expect(local.dump()).toEqual({});
    expect(b.session.dump()).toEqual({});
    sync(); // a observes it: wipes its own tab state only

    expect(a.auth.isAuthenticated()).toBe(false);
    expect(a.session.dump()).toEqual({ [RETURN_URL_STORAGE_KEY]: "/back" });
  });

  test("an account switch in another tab clears this tab's state before subscribers hear, keeps the new session's data", () => {
    const { local, tab, sync } = twoTabs({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify(ADA), [`${STATE}draft`]: "ada's" });
    const a = tab({ [`${STATE}tab`]: "tasks" });
    const b = tab();
    const seenAtNotify: Record<string, string>[] = [];
    a.auth.subscribe(() => seenAtNotify.push({ ...local.dump(), ...a.session.dump() }));

    b.auth.setCredentials(GRACE); // b wipes shared state, writes Grace
    local.setItem(`${STATE}selectedProject`, "7"); // Grace starts working in b
    sync();

    expect(a.auth.getCredentials()).toEqual(GRACE);
    expect(seenAtNotify).toHaveLength(1);
    expect(seenAtNotify[0]).toEqual({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify(GRACE), [`${STATE}selectedProject`]: "7" });
    expect(a.session.dump()).toEqual({});
    expect(local.dump()[`${STATE}draft`]).toBeUndefined();
  });

  test("a direct account switch via setCredentials clears state in both storages", () => {
    const local = memoryStorage({ [`${STATE}draft`]: "ada's" });
    const session = memoryStorage({ [`${STATE}tab`]: "tasks" });
    const auth = service({ localStorage: local, sessionStorage: session });
    auth.setCredentials(ADA);
    expect(local.dump()[`${STATE}draft`]).toBe("ada's"); // login from signed-out keeps pre-login state

    auth.setCredentials(GRACE);

    expect(local.dump()).toEqual({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify(GRACE) });
    expect(session.dump()).toEqual({});
  });

  test("the same user starting a new session in another tab keeps state everywhere", () => {
    const { local, tab, sync } = twoTabs({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify(ADA), [`${STATE}draft`]: "ada's" });
    const a = tab({ [`${STATE}tab`]: "tasks" });
    const b = tab();

    b.auth.setCredentials(ADA_AGAIN);
    sync();

    expect(a.auth.authenticationHeader()).toBe("a2:t2");
    expect(local.dump()[`${STATE}draft`]).toBe("ada's");
    expect(a.session.dump()).toEqual({ [`${STATE}tab`]: "tasks" });
  });

  test("logout() clears state synchronously, before the server round-trip", async () => {
    const local = memoryStorage({ [`${STATE}draft`]: "x" });
    const { fetchImpl, pending } = controlledFetch();
    const auth = service({ localStorage: local, fetch: fetchImpl });
    auth.setCredentials(ADA);

    const done = auth.logout();
    expect(auth.isAuthenticated()).toBe(false);
    expect(local.dump()).toEqual({});
    expect(pending).toHaveLength(1);
    expect(pending[0]!.url).toEndWith("v1/sign_out");
    pending[0]!.resolve(Response.json({ ok: true }));
    await done;
  });
});

describe("finding 2 (round 1): stale async results never overwrite newer decisions", () => {
  test("a login that completes after handleLogout() is discarded", async () => {
    const local = memoryStorage();
    const { fetchImpl, pending } = controlledFetch();
    const auth = service({ localStorage: local, fetch: fetchImpl });
    const ada = await signInResponseBody("ada@example.com");

    const login = auth.login("ada@example.com", "password");
    auth.setCredentials({ uuid: "tmp", token: "t", userId: 1 });
    auth.handleLogout();
    pending[0]!.resolve(Response.json(ada));

    expect((await failing(login)).code).toBe("superseded");
    expect(auth.isAuthenticated()).toBe(false);
    expect(local.dump()).toEqual({});
  });

  test("an older login response arriving late does not overwrite a newer login", async () => {
    const { fetchImpl, pending } = controlledFetch();
    const auth = service({ fetch: fetchImpl });
    const ada = await signInResponseBody("ada@example.com");
    const grace = await signInResponseBody("grace@example.com");

    const first = auth.login("ada@example.com", "password");
    const second = auth.login("grace@example.com", "password");
    pending[1]!.resolve(Response.json(grace));
    await second;
    pending[0]!.resolve(Response.json(ada));

    expect((await failing(first)).code).toBe("superseded");
    expect(auth.getCredentials()).toEqual({ uuid: grace.uuid, token: grace.token, userId: 2 });
  });

  test("a pending logout cannot delete a newer session started in another tab", async () => {
    const { fetchImpl, pending } = controlledFetch();
    const { local, tab, sync } = twoTabs({}, { fetch: fetchImpl });
    const a = tab();
    const b = tab();
    a.auth.setCredentials(ADA);

    const done = a.auth.logout(); // local logout now; sign_out pending
    b.auth.setCredentials(GRACE);
    sync();
    pending[0]!.resolve(Response.json({ ok: true }));
    await done;

    expect(a.auth.authenticationHeader()).toBe("g:t3");
    expect(JSON.parse(local.getItem(CREDENTIALS_STORAGE_KEY)!)).toEqual(GRACE);
  });

  test("handleLogout() leaves another session's stored credentials alone", () => {
    const local = memoryStorage();
    const auth = service({ localStorage: local });
    auth.setCredentials(ADA);
    local.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(GRACE)); // other tab wrote; event not delivered yet

    auth.handleLogout();

    expect(auth.isAuthenticated()).toBe(false);
    expect(JSON.parse(local.getItem(CREDENTIALS_STORAGE_KEY)!)).toEqual(GRACE);
  });
});

describe("finding 3 (round 1): malformed 2xx responses are typed server errors", () => {
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
      expect((await failing(auth.login("a", "b"))).code).toBe("server");
      expect(auth.isAuthenticated()).toBe(false);
    });
  }
});

describe("finding 4 (round 1): blank credentials are never accepted", () => {
  test("a 200 with empty uuid or token is a server error", async () => {
    for (const body of [
      { uuid: "", token: "t", user: { id: 1 } },
      { uuid: "u", token: "   ", user: { id: 1 } },
      { uuid: "u", token: "t", user: { id: NaN } },
    ]) {
      const auth = service({ fetch: async () => Response.json(body) });
      expect((await failing(auth.login("a", "b"))).code).toBe("server");
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

describe("finding 1 (round 2): an explicit logout while signed out still has effects", () => {
  test("a login started while signed out is discarded if handleLogout() happens first", async () => {
    const { fetchImpl, pending } = controlledFetch();
    const auth = service({ fetch: fetchImpl });
    const ada = await signInResponseBody("ada@example.com");

    const login = auth.login("ada@example.com", "password");
    auth.handleLogout(); // null -> null, but explicit
    pending[0]!.resolve(Response.json(ada));

    expect((await failing(login)).code).toBe("superseded");
    expect(auth.isAuthenticated()).toBe(false);
  });

  test("the same holds for logout()", async () => {
    const { fetchImpl, pending } = controlledFetch();
    const auth = service({ fetch: fetchImpl });
    const ada = await signInResponseBody("ada@example.com");

    const login = auth.login("ada@example.com", "password");
    await auth.logout(); // no header, so no request; must still invalidate
    expect(pending).toHaveLength(1); // only the sign_in
    pending[0]!.resolve(Response.json(ada));

    expect((await failing(login)).code).toBe("superseded");
    expect(auth.isAuthenticated()).toBe(false);
  });

  test("handleLogout() after a failed restore removes corrupt credentials and wipes state", () => {
    const local = memoryStorage({ [CREDENTIALS_STORAGE_KEY]: "{corrupt", [`${STATE}draft`]: "x" });
    const session = memoryStorage({ [`${STATE}tab`]: "y", [RETURN_URL_STORAGE_KEY]: "/back" });
    const auth = service({ localStorage: local, sessionStorage: session });
    expect(auth.isAuthenticated()).toBe(false);

    auth.handleLogout();

    expect(local.dump()).toEqual({});
    expect(session.dump()).toEqual({ [RETURN_URL_STORAGE_KEY]: "/back" });
  });

  test("subscribers are still not notified for a no-op logout", () => {
    const auth = service();
    const events: unknown[] = [];
    auth.subscribe((c) => events.push(c));
    auth.handleLogout();
    auth.handleLogout();
    expect(events).toEqual([]);
  });
});

describe("finding 2 (round 2): the latest login attempt wins regardless of response order", () => {
  test("an older request resolving first is discarded in favour of the newer pending one", async () => {
    const { fetchImpl, pending } = controlledFetch();
    const auth = service({ fetch: fetchImpl });
    const ada = await signInResponseBody("ada@example.com");
    const grace = await signInResponseBody("grace@example.com");

    const first = auth.login("ada@example.com", "password");
    const second = auth.login("grace@example.com", "password");
    pending[0]!.resolve(Response.json(ada)); // older resolves first
    expect((await failing(first)).code).toBe("superseded");
    expect(auth.isAuthenticated()).toBe(false); // nothing applied yet

    pending[1]!.resolve(Response.json(grace));
    await second;
    expect(auth.getCredentials()).toEqual({ uuid: grace.uuid, token: grace.token, userId: 2 });
  });

  test("a change from another tab during a login supersedes it", async () => {
    const { fetchImpl, pending } = controlledFetch();
    const { tab, sync } = twoTabs({}, { fetch: fetchImpl });
    const a = tab();
    const b = tab();
    const ada = await signInResponseBody("ada@example.com");

    const login = a.auth.login("ada@example.com", "password");
    b.auth.setCredentials(GRACE);
    sync();
    pending[0]!.resolve(Response.json(ada));

    expect((await failing(login)).code).toBe("superseded");
    expect(a.auth.getCredentials()).toEqual(GRACE);
  });
});

describe("finding 3 (round 2): a stale logout never wipes a newer session's shared state", () => {
  test("handleLogout() with foreign credentials in storage clears only this tab's state", () => {
    const { local, tab, sync } = twoTabs({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify(ADA), [`${STATE}draft`]: "ada's" });
    const a = tab({ [`${STATE}tab`]: "tasks" });
    const b = tab();

    b.auth.setCredentials(GRACE); // wipes Ada's shared state, writes Grace
    local.setItem(`${STATE}selectedProject`, "7"); // Grace's new shared state
    // a has not received the storage event yet, then gets a 401 for Ada's dead session:
    a.auth.handleLogout();

    expect(a.auth.isAuthenticated()).toBe(false);
    expect(a.session.dump()).toEqual({});
    expect(local.dump()).toEqual({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify(GRACE), [`${STATE}selectedProject`]: "7" });

    sync(); // the event arrives: a becomes Grace, shared state intact
    expect(a.auth.getCredentials()).toEqual(GRACE);
    expect(local.dump()[`${STATE}selectedProject`]).toBe("7");
  });

  test("observing a switch from another tab never wipes shared state (the switching tab already did)", () => {
    const { local, tab, sync } = twoTabs({ [CREDENTIALS_STORAGE_KEY]: JSON.stringify(ADA) });
    const a = tab();
    const b = tab();
    b.auth.setCredentials(GRACE);
    local.setItem(`${STATE}selectedProject`, "7");
    local.setItem(`${STATE}filters`, "open");

    sync();

    expect(a.auth.getCredentials()).toEqual(GRACE);
    expect(local.dump()).toEqual({
      [CREDENTIALS_STORAGE_KEY]: JSON.stringify(GRACE),
      [`${STATE}selectedProject`]: "7",
      [`${STATE}filters`]: "open",
    });
  });

  test("clearBrowserStorage() can be scoped", () => {
    const local = memoryStorage({ [`${STATE}a`]: "1", keep: "2" });
    const session = memoryStorage({ [`${STATE}b`]: "3" });
    const auth = service({ localStorage: local, sessionStorage: session });
    auth.clearBrowserStorage("tab");
    expect(local.dump()).toEqual({ [`${STATE}a`]: "1", keep: "2" });
    expect(session.dump()).toEqual({});
    session.setItem(`${STATE}c`, "4");
    auth.clearBrowserStorage("shared");
    expect(local.dump()).toEqual({ keep: "2" });
    expect(session.dump()).toEqual({ [`${STATE}c`]: "4" });
    auth.clearBrowserStorage();
    expect(session.dump()).toEqual({});
  });
});
