/**
 * Token sessions for the mock backend.
 *
 * Header format is `Authorization: <uuid>:<token>` — the same shape the
 * client's AuthenticationService.authenticationHeader() produces.
 */
import type { Database, PublicUser } from "./db";

export interface Session {
  uuid: string;
  token: string;
  userId: number;
}

export class Sessions {
  private readonly byUuid = new Map<string, Session>();
  private readonly revokeListeners = new Set<(session: Session) => void>();

  constructor(private readonly db: Database) {}

  /** Called whenever a session is revoked (sign-out, clear). */
  onRevoke(listener: (session: Session) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  signIn(email: string, password: string): { session: Session; user: PublicUser } | undefined {
    const user = this.db.findUserByEmail(email);
    if (user?.password !== password) return undefined;

    const session: Session = {
      uuid: crypto.randomUUID(),
      token: crypto.randomUUID().replaceAll("-", ""),
      userId: user.id,
    };
    this.byUuid.set(session.uuid, session);
    return { session, user: this.db.getUser(user.id)! };
  }

  /** Verifies a `uuid:token` pair. */
  verify(uuid: string | undefined, token: string | undefined): Session | undefined {
    if (!uuid || !token) return undefined;
    const session = this.byUuid.get(uuid);
    return session?.token === token ? session : undefined;
  }

  /** Parses the Authorization header and verifies it. */
  fromRequest(req: Request): Session | undefined {
    const header = req.headers.get("authorization") ?? "";
    const [uuid, token] = header.split(":");
    return this.verify(uuid, token);
  }

  revoke(uuid: string): void {
    const session = this.byUuid.get(uuid);
    if (!session) return;
    this.byUuid.delete(uuid);
    for (const listener of this.revokeListeners) listener(session);
  }

  clear(): void {
    for (const uuid of this.byUuid.keys()) this.revoke(uuid);
  }
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
