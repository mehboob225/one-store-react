import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createMockServer, type MockServer } from "./index";

let mock: MockServer;
let base: string;

beforeAll(() => {
  mock = createMockServer({ pingIntervalMs: 40 });
  base = mock.url.origin;
});

afterAll(async () => {
  await mock.stop();
});

// Fresh data + sessions per test so tests never depend on ordering.
beforeEach(() => {
  mock.reset();
});

async function signIn(email = "ada@example.com", password = "password") {
  const res = await fetch(`${base}/api/v1/sign_in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return res;
}

async function authHeader(): Promise<Record<string, string>> {
  const { uuid, token } = (await (await signIn()).json()) as { uuid: string; token: string };
  return { authorization: `${uuid}:${token}`, "content-type": "application/json" };
}

async function api(path: string, init: RequestInit = {}, headers?: Record<string, string>) {
  const h = headers ?? (await authHeader());
  return fetch(`${base}/api/v1${path}`, { ...init, headers: { ...h, ...(init.headers ?? {}) } });
}

describe("auth", () => {
  test("sign_in returns uuid, token and the user without a password", async () => {
    const res = await signIn();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.uuid).toBe("string");
    expect(typeof body.token).toBe("string");
    expect((body.user as Record<string, unknown>).email).toBe("ada@example.com");
    expect(body.user as Record<string, unknown>).not.toHaveProperty("password");
  });

  test("wrong password is 401", async () => {
    expect((await signIn("ada@example.com", "nope")).status).toBe(401);
  });

  test("missing or bad Authorization header is 401", async () => {
    expect((await fetch(`${base}/api/v1/projects`)).status).toBe(401);
    const res = await fetch(`${base}/api/v1/projects`, { headers: { authorization: "x:y" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("sign_out revokes the session", async () => {
    const headers = await authHeader();
    expect((await api("/sign_out", { method: "DELETE" }, headers)).status).toBe(200);
    expect((await api("/projects", {}, headers)).status).toBe(401);
  });

  test("unknown /api paths are JSON 404, not HTML", async () => {
    const res = await api("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("users", () => {
  test("GET /users/current returns user and current_user buckets", async () => {
    const body = (await (await api("/users/current")).json()) as Record<string, Record<string, unknown>>;
    expect(body.user!.id).toBe(1);
    expect(body.user).not.toHaveProperty("settings");
    expect(body.current_user!.settings).toEqual({ theme: "dark" });
  });

  test("PUT /users/current/settings merges settings", async () => {
    const res = await api("/users/current/settings", {
      method: "PUT",
      body: JSON.stringify({ settings: { sidebar: "collapsed" } }),
    });
    const body = (await res.json()) as { current_user: { settings: Record<string, unknown> } };
    expect(body.current_user.settings).toEqual({ theme: "dark", sidebar: "collapsed" });
  });
});

describe("projects and tasks", () => {
  test("GET /projects lists projects", async () => {
    const body = (await (await api("/projects")).json()) as { projects: { id: number }[] };
    expect(body.projects.map((p) => p.id)).toEqual([1, 2]);
  });

  test("GET /projects/:id returns a single project or 404", async () => {
    expect(((await (await api("/projects/1")).json()) as { project: { name: string } }).project.name).toBe(
      "Analytical Engine",
    );
    expect((await api("/projects/99")).status).toBe(404);
  });

  test("GET /projects/:id/tasks embeds the assignee", async () => {
    const body = (await (await api("/projects/1/tasks")).json()) as {
      tasks: { id: number; assignee: { id: number; name: string } | null }[];
    };
    expect(body.tasks).toHaveLength(3);
    expect(body.tasks[0]!.assignee).toMatchObject({ id: 1, name: "Ada Lovelace" });
    expect(body.tasks[2]!.assignee).toBeNull();
  });

  test("POST /projects/:id/tasks creates a task", async () => {
    const res = await api("/projects/1/tasks", { method: "POST", body: JSON.stringify({ task: { title: "New" } }) });
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: { id: number; project_id: number; status: string; hash: string } };
    expect(task).toMatchObject({ id: 7, project_id: 1, status: "todo", hash: "t7-1" });
  });

  test("PUT /tasks/:id requires the current hash and bumps it", async () => {
    const before = ((await (await api("/tasks/2")).json()) as { task: { hash: string } }).task;
    const ok = await api("/tasks/2", {
      method: "PUT",
      body: JSON.stringify({ task: { hash: before.hash, status: "done" } }),
    });
    expect(ok.status).toBe(200);
    const { task } = (await ok.json()) as { task: { status: string; hash: string } };
    expect(task.status).toBe("done");
    expect(task.hash).toBe("t2-2");

    const stale = await api("/tasks/2", {
      method: "PUT",
      body: JSON.stringify({ task: { hash: before.hash, status: "todo" } }),
    });
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as { error: string; task: { hash: string } };
    expect(conflict.error).toBe("conflict");
    expect(conflict.task.hash).toBe("t2-2");
  });

  test("DELETE /tasks/:id returns deleted_tasks and deleted_comments and cascades", async () => {
    const res = await api("/tasks/1", { method: "DELETE" });
    expect(await res.json()).toEqual({ deleted_tasks: [1], deleted_comments: [1, 2] });
    expect((await api("/tasks/1")).status).toBe(404);
    expect(((await (await api("/projects/1/tasks")).json()) as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  test("GET /tasks/:id/comments and /tags", async () => {
    const comments = (await (await api("/tasks/2/comments")).json()) as { comments: { id: number }[] };
    expect(comments.comments.map((c) => c.id)).toEqual([3]);
    const tags = (await (await api("/tasks/2/tags")).json()) as { tags: { name: string }[] };
    expect(tags.tags.map((t) => t.name)).toEqual(["hardware", "urgent"]);
  });

  test("POST /projects/:id/tasks/import returns only a count", async () => {
    const body = await (await api("/projects/2/tasks/import", { method: "POST" })).json();
    expect(body).toEqual({ imported: 3 });
    expect(((await (await api("/projects/2/tasks")).json()) as { tasks: unknown[] }).tasks).toHaveLength(6);
  });
});

describe("push", () => {
  type Msg = Record<string, unknown>;

  function connect(): { ws: WebSocket; next: (type?: string) => Promise<Msg> } {
    const ws = new WebSocket(`${mock.url.origin.replace("http", "ws")}/push`);
    const queue: Msg[] = [];
    const waiters: { type?: string; resolve: (m: Msg) => void }[] = [];
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as Msg;
      const i = waiters.findIndex((w) => !w.type || w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
      else queue.push(msg);
    });
    const next = (type?: string) =>
      new Promise<Msg>((resolve) => {
        const i = queue.findIndex((m) => !type || m.type === type);
        if (i >= 0) resolve(queue.splice(i, 1)[0]!);
        else waiters.push({ type, resolve });
      });
    return { ws, next };
  }

  async function open(ws: WebSocket) {
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  }

  test("login with a valid session is acknowledged and receives broadcasts", async () => {
    const headers = await authHeader();
    const [uuid, token] = headers.authorization!.split(":");
    const { ws, next } = connect();
    await open(ws);
    ws.send(JSON.stringify({ type: "login", uuid, token }));
    expect((await next("login_ok")).type).toBe("login_ok");
    expect(mock.push.clientCount).toBe(1);

    const before = ((await (await api("/tasks/3", {}, headers)).json()) as { task: { hash: string } }).task;
    await api("/tasks/3", { method: "PUT", body: JSON.stringify({ task: { hash: before.hash, title: "Renamed" } }) }, headers);
    const update = await next("update");
    expect(update).toMatchObject({ type: "update", objectType: "task", data: { id: 3, title: "Renamed" } });

    await api("/tasks/3", { method: "DELETE" }, headers);
    expect(await next("delete")).toEqual({ type: "delete", objectType: "task", objectId: 3 });

    await api("/projects/1/tasks/import", { method: "POST" }, headers);
    expect(await next("reload")).toEqual({ type: "reload", objectType: "project", objectId: 1 });

    ws.close();
  });

  test("heartbeat pings authenticated clients", async () => {
    const headers = await authHeader();
    const [uuid, token] = headers.authorization!.split(":");
    const { ws, next } = connect();
    await open(ws);
    ws.send(JSON.stringify({ type: "login", uuid, token }));
    await next("login_ok");
    expect((await next("ping")).type).toBe("ping");
    ws.close();
  });

  test("invalid login gets session_invalid and is closed", async () => {
    const { ws, next } = connect();
    await open(ws);
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
    ws.send(JSON.stringify({ type: "login", uuid: "bad", token: "bad" }));
    expect((await next()).type).toBe("session_invalid");
    expect(await closed).toBe(4001);
    expect(mock.push.clientCount).toBe(0);
  });

  test("unauthenticated sockets receive nothing", async () => {
    const { ws, next } = connect();
    await open(ws);
    const headers = await authHeader();
    await api("/projects/1/tasks", { method: "POST", body: JSON.stringify({ task: { title: "Silent" } }) }, headers);
    const raced = await Promise.race([next(), new Promise<"none">((r) => setTimeout(() => r("none"), 100))]);
    expect(raced).toBe("none");
    ws.close();
  });
});
