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

export interface MockServerOptions extends PushHubOptions {
  port?: number;
  /** Extra routes, e.g. `{ "/*": index }` for the HTML entry. */
  routes?: Record<string, unknown>;
  development?: Parameters<typeof serve>[0]["development"];
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
  const db = new Database();
  const sessions = new Sessions(db);
  const push = new PushHub(sessions, { pingIntervalMs: options.pingIntervalMs });

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
      push.stop();
      await server.stop(true);
    },
  };
}
