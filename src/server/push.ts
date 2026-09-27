/**
 * WebSocket push hub.
 *
 * Protocol (JSON messages):
 *   client -> server  { type: "login", uuid, token }
 *   server -> client  { type: "login_ok" } | { type: "session_invalid" }
 *   server -> client  { type: "ping" }                       (heartbeat)
 *   client -> server  { type: "pong" }                       (optional)
 *   server -> client  { type: "new" | "update", objectType, data }
 *   server -> client  { type: "delete", objectType, objectId }
 *   server -> client  { type: "reload", objectType, objectId } (refetch scope)
 *
 * Only sockets that completed `login` receive broadcasts. `objectType` is the
 * singular entity name (`"task"`) — the client pluralizes it to the bucket.
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { Sessions } from "./auth";

export interface SocketData {
  userId: number | null;
}

export type PushMessage =
  | { type: "new" | "update"; objectType: string; data: unknown }
  | { type: "delete"; objectType: string; objectId: number }
  | { type: "reload"; objectType: string; objectId: number };

type Socket = ServerWebSocket<SocketData>;

export interface PushHubOptions {
  /** Heartbeat interval; defaults to 25 s. */
  pingIntervalMs?: number;
}

export class PushHub {
  private readonly clients = new Set<Socket>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly sessions: Sessions,
    options: PushHubOptions = {},
  ) {
    const interval = options.pingIntervalMs ?? 25_000;
    this.timer = setInterval(() => this.broadcastRaw({ type: "ping" }), interval);
    this.timer.unref?.();
  }

  /** Number of authenticated sockets. */
  get clientCount(): number {
    return this.clients.size;
  }

  broadcast(message: PushMessage): void {
    this.broadcastRaw(message);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const ws of this.clients) ws.close(1001, "server stopping");
    this.clients.clear();
  }

  /** Bun.serve `websocket` handler. */
  get handler(): WebSocketHandler<SocketData> {
    return {
      open: () => {
        // Nothing until login.
      },
      message: (ws, raw) => this.onMessage(ws, raw),
      close: (ws) => {
        this.clients.delete(ws);
      },
    };
  }

  private onMessage(ws: Socket, raw: string | Buffer): void {
    let message: { type?: string; uuid?: string; token?: string };
    try {
      message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }

    switch (message.type) {
      case "login": {
        const session = this.sessions.verify(message.uuid, message.token);
        if (!session) {
          ws.send(JSON.stringify({ type: "session_invalid" }));
          ws.close(4001, "session invalid");
          return;
        }
        ws.data.userId = session.userId;
        this.clients.add(ws);
        ws.send(JSON.stringify({ type: "login_ok" }));
        return;
      }
      case "pong":
        return;
      default:
        return;
    }
  }

  private broadcastRaw(message: object): void {
    const payload = JSON.stringify(message);
    for (const ws of this.clients) ws.send(payload);
  }
}
