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
  private byUuid = new Map<string, Session>();

  constructor(private db: Database) {}

  signIn(email: string, password: string): { session: Session; user: PublicUser } | undefined {
    const user = this.db.findUserByEmail(email);
    if (!user || user.password !== password) return undefined;

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
    return session && session.token === token ? session : undefined;
  }

  /** Parses the Authorization header and verifies it. */
  fromRequest(req: Request): Session | undefined {
    const header = req.headers.get("authorization") ?? "";
    const [uuid, token] = header.split(":");
    return this.verify(uuid, token);
  }

  revoke(uuid: string): void {
    this.byUuid.delete(uuid);
  }

  clear(): void {
    this.byUuid.clear();
  }
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
