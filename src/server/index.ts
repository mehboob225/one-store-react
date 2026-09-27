/**
 * Mock backend factory.
 *
 * Used by `src/index.ts` (with the HTML entry, hot reload) and by tests
 * (port 0, no HTML). Everything is in-process and in-memory.
 */
import { serve, type BunRequest, type Server } from "bun";
import { Sessions } from "./auth";
import { Database } from "./db";
import { PushHub, type PushHubOptions, type SocketData } from "./push";
import { createRoutes } from "./routes";

/** The stateful half of the backend: data, sessions and connected sockets. */
export interface BackendState {
  db: Database;
  sessions: Sessions;
  push: PushHub;
}

export function createBackendState(options: PushHubOptions = {}): BackendState {
  const db = new Database();
  const sessions = new Sessions(db);
  const push = new PushHub(sessions, options);
  return { db, sessions, push };
}

export interface MockServerOptions extends PushHubOptions {
  port?: number;
  /** Extra routes, e.g. `{ "/*": index }` for the HTML entry. */
  routes?: Record<string, unknown>;
  development?: Parameters<typeof serve>[0]["development"];
  /**
   * Reuse existing state instead of creating fresh state. The dev entry
   * passes state kept in `import.meta.hot.data` so a hot reload swaps the
   * handlers but keeps data, sessions and open sockets.
   */
  state?: BackendState;
}

export interface MockServer {
  server: Server<SocketData>;
  db: Database;
  sessions: Sessions;
  push: PushHub;
  url: URL;
  /** Restores seed data and drops all sessions (tests). */
  reset(): void;
  stop(): Promise<void>;
}

export function createMockServer(options: MockServerOptions = {}): MockServer {
  const ownsState = options.state === undefined;
  const { db, sessions, push } = options.state ?? createBackendState({ pingIntervalMs: options.pingIntervalMs });

  const server = serve<SocketData>({
    port: options.port ?? 0,
    routes: {
      ...createRoutes({ db, sessions, push }),
      // Named route so the HTML catch-all ("/*") never shadows the upgrade.
      "/push": (req: BunRequest<"/push">, server: Server<SocketData>) => {
        const upgraded = server.upgrade(req, { data: { userId: null, sessionUuid: null } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      ...options.routes,
    },
    fetch() {
      return new Response("not found", { status: 404 });
    },
    // A route that throws is a server bug: answer 500 as JSON (never the HTML fallback) and log it.
    error(error) {
      console.error("mock server: unhandled route error", error);
      return Response.json({ error: "internal error" }, { status: 500 });
    },
    websocket: push.handler,
    development: options.development ?? false,
  });

  return {
    server,
    db,
    sessions,
    push,
    url: server.url,
    reset() {
      db.reset();
      sessions.clear();
    },
    async stop() {
      // Shared state outlives any one server; only stop what we created.
      if (ownsState) push.stop();
      await server.stop(true);
    },
  };
}
