/**
 * REST routes for the mock backend.
 *
 * Conventions (see docs/API.md):
 *   - base path `/api/v1`, header `Authorization: <uuid>:<token>`
 *   - every response is an object keyed by bucket name
 *       list   -> { tasks: [...] }
 *       single -> { task: {...} }
 *   - mutations may include `deleted_<bucket>: [ids]`
 *   - every mutation broadcasts a push message
 */
import type { BunRequest } from "bun";
import type { Database } from "./db";
import { validateCredentials, validateSettings } from "./validation";
import { unauthorized, type Sessions } from "./auth";
import type { PushHub } from "./push";

export interface RouteContext {
  db: Database;
  sessions: Sessions;
  push: PushHub;
}

type Handler<P extends string> = (req: BunRequest<P>) => Response | Promise<Response>;

const notFound = (what: string) => Response.json({ error: `${what} not found` }, { status: 404 });
const badRequest = (message: string) => Response.json({ error: message }, { status: 400 });
const forbidden = () => Response.json({ error: "not a member of this project" }, { status: 403 });

async function json<T>(req: Request): Promise<T | undefined> {
  try {
    return (await req.json()) as T;
  } catch {
    return undefined;
  }
}

export function createRoutes(ctx: RouteContext) {
  const { db, sessions, push } = ctx;

  /** Wraps a handler so it runs only for authenticated requests. */
  function authed<P extends string>(
    handler: (req: BunRequest<P>, userId: number) => Response | Promise<Response>,
  ): Handler<P> {
    return (req) => {
      const session = sessions.fromRequest(req);
      if (!session) return unauthorized();
      return handler(req, session.userId);
    };
  }

  return {
    // ---- auth ------------------------------------------------------------

    "/api/v1/sign_in": {
      POST: async (req: BunRequest<"/api/v1/sign_in">) => {
        const body = validateCredentials(await json(req));
        if (!body.ok) return badRequest(body.error);
        const result = sessions.signIn(body.value.email, body.value.password);
        if (!result) return unauthorized();
        return Response.json({ uuid: result.session.uuid, token: result.session.token, user: result.user });
      },
    },

    "/api/v1/sign_out": {
      DELETE: authed<"/api/v1/sign_out">((req) => {
        const uuid = (req.headers.get("authorization") ?? "").split(":")[0];
        if (uuid) sessions.revoke(uuid);
        return Response.json({ ok: true });
      }),
    },

    // ---- users -----------------------------------------------------------

    "/api/v1/users": {
      GET: authed<"/api/v1/users">(() => Response.json({ users: db.listUsers() })),
    },

    "/api/v1/users/current": {
      GET: authed<"/api/v1/users/current">((_req, userId) => {
        const user = db.getUser(userId);
        const current = db.getCurrentUser(userId);
        if (!user || !current) return notFound("user");
        return Response.json({ user, current_user: current });
      }),
    },

    "/api/v1/users/current/settings": {
      PUT: authed<"/api/v1/users/current/settings">(async (req, userId) => {
        const body = await json<{ settings?: unknown }>(req);
        const settings = validateSettings(body?.settings);
        if (!settings.ok) return badRequest(settings.error);
        const user = db.updateUserSettings(userId, settings.value);
        if (!user) return notFound("user");
        // Personal data: only this user's other sessions/tabs should hear about it.
        push.sendToUser(userId, { type: "update", objectType: "current_user", data: user });
        return Response.json({ current_user: user });
      }),
    },

    // ---- projects --------------------------------------------------------

    "/api/v1/projects": {
      GET: authed<"/api/v1/projects">(() => Response.json({ projects: db.listProjects() })),
    },

    "/api/v1/projects/:id": {
      GET: authed<"/api/v1/projects/:id">((req) => {
        const project = db.getProject(Number(req.params.id));
        return project ? Response.json({ project }) : notFound("project");
      }),
    },

    "/api/v1/projects/:id/tasks": {
      GET: authed<"/api/v1/projects/:id/tasks">((req) => {
        const projectId = Number(req.params.id);
        if (!db.hasProject(projectId)) return notFound("project");
        const tasks = db.listTasks(projectId).map((t) => db.withAssignee(t));
        return Response.json({ tasks });
      }),
      POST: authed<"/api/v1/projects/:id/tasks">(async (req, userId) => {
        const projectId = Number(req.params.id);
        const body = await json<{ task?: unknown }>(req);
        // The db authorizes, validates and applies the assignee rule itself: 404, 403, 400, then the write.
        const outcome = db.createTask(projectId, body?.task, userId);
        switch (outcome.kind) {
          case "missing":
            return notFound("project");
          case "forbidden":
            return forbidden();
          case "invalid":
            return badRequest(outcome.error);
          case "created": {
            const task = db.withAssignee(outcome.task);
            push.broadcast({ type: "new", objectType: "task", data: task });
            return Response.json({ task }, { status: 201 });
          }
        }
      }),
    },

    /**
     * Bulk import. Deliberately returns only a count, not the created rows —
     * the client must clear its loaders and refetch (the "clear then reload"
     * case in the plan).
     */
    "/api/v1/projects/:id/tasks/import": {
      POST: authed<"/api/v1/projects/:id/tasks/import">((req, userId) => {
        const projectId = Number(req.params.id);
        const titles = ["Imported: triage backlog", "Imported: write docs", "Imported: plan release"];
        // All or nothing in the db: authorized once, every title validated before any row is written.
        const outcome = db.importTasks(projectId, titles.map((title) => ({ title })), userId);
        switch (outcome.kind) {
          case "missing":
            return notFound("project");
          case "forbidden":
            return forbidden();
          case "invalid":
            // The titles are server constants: a rejected one is a server bug, not a client error — and nothing was written.
            throw new Error(`import: a server-owned title was rejected: ${outcome.error}`);
          case "imported": {
            const imported = outcome.tasks.length;
            if (imported > 0) push.broadcast({ type: "reload", objectType: "project", objectId: projectId });
            return Response.json({ imported });
          }
        }
      }),
    },

    // ---- tasks -----------------------------------------------------------

    "/api/v1/tasks/:id": {
      GET: authed<"/api/v1/tasks/:id">((req) => {
        const task = db.getTask(Number(req.params.id));
        return task ? Response.json({ task: db.withAssignee(task) }) : notFound("task");
      }),
      PUT: authed<"/api/v1/tasks/:id">(async (req, userId) => {
        const id = Number(req.params.id);
        const body = await json<{ task?: unknown }>(req);
        // The db decides everything in one atomic step, in the documented order
        // (docs/API.md): 404, 403, 400 malformed, 409 with the current task, 400 bad values.
        const outcome = db.updateTask(id, body?.task, userId);
        switch (outcome.kind) {
          case "missing":
            return notFound("task");
          case "forbidden":
            return forbidden();
          case "conflict":
            return Response.json({ error: "conflict", task: db.withAssignee(outcome.current) }, { status: 409 });
          case "invalid":
            return badRequest(outcome.error);
          case "updated": {
            const task = db.withAssignee(outcome.task);
            push.broadcast({ type: "update", objectType: "task", data: task });
            return Response.json({ task });
          }
        }
      }),
      DELETE: authed<"/api/v1/tasks/:id">((req, userId) => {
        const id = Number(req.params.id);
        const outcome = db.deleteTask(id, userId);
        if (outcome.kind === "missing") return notFound("task");
        if (outcome.kind === "forbidden") return forbidden();
        push.broadcast({ type: "delete", objectType: "task", objectId: id });
        return Response.json({
          deleted_tasks: [outcome.task.id],
          deleted_comments: outcome.comments.map((c) => c.id),
        });
      }),
    },

    "/api/v1/tasks/:id/comments": {
      GET: authed<"/api/v1/tasks/:id/comments">((req) => {
        const id = Number(req.params.id);
        if (!db.hasTask(id)) return notFound("task");
        return Response.json({ comments: db.listComments(id) });
      }),
    },

    /** Returns tags only; the client synthesises the join rows. */
    "/api/v1/tasks/:id/tags": {
      GET: authed<"/api/v1/tasks/:id/tags">((req) => {
        const id = Number(req.params.id);
        if (!db.hasTask(id)) return notFound("task");
        return Response.json({ tags: db.listTagsForTask(id) });
      }),
    },

    // Anything else under /api is a JSON 404, never the HTML fallback.
    "/api/*": () => Response.json({ error: "not found" }, { status: 404 }),
  };
}
