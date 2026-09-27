/**
 * Dev-server entry helper with hot-reload-safe state.
 *
 * Under `bun --hot`, Bun re-evaluates the whole module graph on every change
 * but keeps the listening server and its open WebSockets. If each evaluation
 * built a fresh database, session table and push hub, existing sockets would
 * be left attached to a hub nothing writes to any more: alive, pinged, and
 * silently missing every event, while their tokens return 401.
 *
 * Module-level state does not survive a reload and `import.meta.hot` is not
 * defined for server code, so the backend state is kept on `globalThis`
 * (the mechanism Bun documents for this). Only the handlers are replaced.
 */
import { createBackendState, createMockServer, type BackendState, type MockServer, type MockServerOptions } from "./index";

const STATE_KEY = Symbol.for("one-store-react.backend-state");

type GlobalWithState = typeof globalThis & { [STATE_KEY]?: BackendState };

export function startMockServer(options: Omit<MockServerOptions, "state"> = {}): MockServer {
  const global = globalThis as GlobalWithState;
  const state = (global[STATE_KEY] ??= createBackendState(options));
  return createMockServer({ ...options, state });
}

/** Drops the persisted state so the next `startMockServer` starts fresh (tests). */
export function resetPersistedState(): void {
  const global = globalThis as GlobalWithState;
  global[STATE_KEY]?.push.stop();
  delete global[STATE_KEY];
}
