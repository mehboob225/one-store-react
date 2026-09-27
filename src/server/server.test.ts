import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { seed } from "./fixtures";
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

async function authHeaderFor(email: string): Promise<Record<string, string>> {
  const { uuid, token } = (await (await signIn(email)).json()) as { uuid: string; token: string };
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
    expect(body.user).toEqual({ id: 1, name: "Ada Lovelace" }); // public: no email, password or settings
  });

  test("sign_in rejects non-string or missing credentials with 400", async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/v1/sign_in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const body of [{}, { email: 1, password: "password" }, { email: "ada@example.com", password: ["p"] }, "ada", null]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post({ email: "", password: "password" })).status).toBe(400);
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
  test("GET /users lists every workspace user as id and name only (workspace model: names visible, emails never)", async () => {
    const expected = [
      { id: 1, name: "Ada Lovelace" },
      { id: 2, name: "Grace Hopper" },
      { id: 3, name: "Alan Turing" },
    ];
    expect(((await (await api("/users")).json()) as { users: unknown[] }).users).toEqual(expected);
    // the same for a user on no project: every owner/member/assignee/author key resolves for everyone
    const alan = await authHeaderFor("alan@example.com");
    expect(((await (await api("/users", {}, alan)).json()) as { users: unknown[] }).users).toEqual(expected);
  });

  test("no public representation anywhere carries an email", async () => {
    const grace = await authHeaderFor("grace@example.com");
    const { user } = (await (await api("/users/current", {}, grace)).json()) as { user: Record<string, unknown>; current_user: Record<string, unknown> };
    expect(user).toEqual({ id: 2, name: "Grace Hopper" });
    const { task } = (await (await api("/tasks/1", {}, grace)).json()) as { task: { assignee: Record<string, unknown> } };
    expect(task.assignee).toEqual({ id: 1, name: "Ada Lovelace" });
  });

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

  test("PUT /users/current/settings rejects non-object settings without writing (review 2, finding 3)", async () => {
    const headers = await authHeader();
    const before = ((await (await api("/users/current", {}, headers)).json()) as { current_user: { settings: unknown } })
      .current_user.settings;

    for (const settings of ["dark", ["dark"], true, 42, null]) {
      const res = await api("/users/current/settings", { method: "PUT", body: JSON.stringify({ settings }) }, headers);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("settings");
    }
    expect((await api("/users/current/settings", { method: "PUT", body: JSON.stringify({}) }, headers)).status).toBe(400);

    const after = ((await (await api("/users/current", {}, headers)).json()) as { current_user: { settings: unknown } })
      .current_user.settings;
    expect(after).toEqual(before);
    expect(after).toEqual({ theme: "dark" });
  });

  test("public user representations never include settings (finding 4)", async () => {
    const grace = await authHeaderFor("grace@example.com");

    // sign_in payload
    const signedIn = (await (await signIn()).json()) as { user: Record<string, unknown> };
    expect(signedIn.user).not.toHaveProperty("settings");

    // `user` bucket in /users/current
    const me = (await (await api("/users/current", {}, grace)).json()) as { user: Record<string, unknown> };
    expect(me.user).not.toHaveProperty("settings");

    // embedded assignee seen by another user (task 1 is assigned to Ada)
    const { task } = (await (await api("/tasks/1", {}, grace)).json()) as {
      task: { assignee: Record<string, unknown> };
    };
    expect(task.assignee).toMatchObject({ id: 1, name: "Ada Lovelace" });
    expect(task.assignee).not.toHaveProperty("settings");
    expect(task.assignee).not.toHaveProperty("password");

    const { tasks } = (await (await api("/projects/1/tasks", {}, grace)).json()) as {
      tasks: { assignee: Record<string, unknown> | null }[];
    };
    for (const t of tasks) if (t.assignee) expect(t.assignee).not.toHaveProperty("settings");
  });
});

describe("projects and tasks", () => {
  test("GET /projects lists projects with owner_id and member_ids", async () => {
    const body = (await (await api("/projects")).json()) as { projects: { id: number; owner_id: number; member_ids: number[] }[] };
    expect(body.projects.map((p) => p.id)).toEqual([1, 2]);
    expect(body.projects.map((p) => [p.owner_id, p.member_ids])).toEqual([
      [1, [1, 2]],
      [2, [2, 1]],
    ]);
  });

  test("GET /projects/:id returns a single project (with owner_id and member_ids) or 404", async () => {
    const { project } = (await (await api("/projects/1")).json()) as { project: Record<string, unknown> };
    expect(project).toMatchObject({ name: "Analytical Engine", owner_id: 1, member_ids: [1, 2] });
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

  test("every task assignee in the seed is a member of its project", async () => {
    const projects = ((await (await api("/projects")).json()) as { projects: { id: number; owner_id: number; member_ids: number[] }[] }).projects;
    for (const p of projects) {
      const tasks = ((await (await api(`/projects/${p.id}/tasks`)).json()) as { tasks: { assignee_id: number | null }[] }).tasks;
      for (const t of tasks) if (t.assignee_id !== null) expect([p.owner_id, ...p.member_ids]).toContain(t.assignee_id);
    }
  });

  test("assignee_id must be the project owner or a member, on create and update", async () => {
    const post = (task: object) => api("/projects/1/tasks", { method: "POST", body: JSON.stringify({ task }) });
    for (const assignee_id of [999, 3]) {
      // 999 does not exist; 3 (Alan) exists but is on no project
      const created = await post({ title: "x", assignee_id });
      expect(created.status).toBe(400);
      expect(((await created.json()) as { error: string }).error).toContain("project owner or a project member");
    }
    expect((await post({ title: "x", assignee_id: 2 })).status).toBe(201); // Grace is a member of project 1

    const { hash } = ((await (await api("/tasks/1")).json()) as { task: { hash: string } }).task;
    expect((await api("/tasks/1", { method: "PUT", body: JSON.stringify({ task: { hash, assignee_id: 3 } }) })).status).toBe(400);

    const ok = await api("/tasks/1", { method: "PUT", body: JSON.stringify({ task: { hash, assignee_id: 2 } }) });
    expect(ok.status).toBe(200);
    const after = ((await ok.json()) as { task: { hash: string; assignee: { id: number } } }).task;
    expect(after.assignee.id).toBe(2);
    const cleared = await api("/tasks/1", { method: "PUT", body: JSON.stringify({ task: { hash: after.hash, assignee_id: null } }) });
    expect(cleared.status).toBe(200);
  });

  test("PUT /tasks/:id decides 404 → 403 → 400 malformed → 409 → 400 values, in that order, atomically (docs/API.md)", async () => {
    const put = (id: number, task: unknown) => api(`/tasks/${id}`, { method: "PUT", body: JSON.stringify({ task }) });
    // 1. unknown task: 404 whatever the body
    for (const task of [{ hash: "x", assignee_id: 3 }, { hash: "x", status: "bogus" }, {}, "nope", null]) {
      expect((await put(999, task)).status).toBe(404);
    }
    // 2. not a member: 403 before any body check, even with a stale hash or a bad body
    const alan = await authHeaderFor("alan@example.com");
    for (const task of [{ hash: "stale" }, {}, { hash: "t1-1", status: "bogus" }]) {
      expect((await api("/tasks/1", { method: "PUT", body: JSON.stringify({ task }) }, alan)).status).toBe(403);
    }
    expect((await api("/tasks/999", { method: "PUT", body: JSON.stringify({ task: {} }) }, alan)).status).toBe(404); // 404 still first
    // 3. malformed: no task object, or no string hash — a broken request, never a conflict
    for (const [task, message] of [
      [{}, "task.hash must be a string"],
      [{ hash: 5 }, "task.hash must be a string"],
      [{ status: "done" }, "task.hash must be a string"],
      ["nope", "task must be an object"],
      [null, "task must be an object"],
    ] as const) {
      const res = await put(1, task);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(message);
    }
    // 4. stale hash: 409 carrying the current task, even with a bad body or assignee
    for (const task of [{ hash: "stale", assignee_id: 3 }, { hash: "stale", status: "bogus" }, { hash: "stale" }]) {
      const res = await put(1, task);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { task: { id: number; hash: string } }).task).toMatchObject({ id: 1, hash: "t1-1" });
    }
    // 5. current hash: only now are the values and the assignee checked; nothing was written so far
    expect((await put(1, { hash: "t1-1", status: "bogus" })).status).toBe(400);
    expect((await put(1, { hash: "t1-1", assignee_id: 3 })).status).toBe(400);
    expect(((await (await api("/tasks/1")).json()) as { task: { hash: string } }).task.hash).toBe("t1-1");
    // 6. and the write is atomic with the hash check: the same hash cannot be spent twice
    expect((await put(1, { hash: "t1-1", status: "done" })).status).toBe(200);
    expect((await put(1, { hash: "t1-1", status: "todo" })).status).toBe(409);
  });

  test("validation and the assignee rule are enforced by the data layer, not only by the routes", () => {
    expect(mock.db.createTask(1, { title: "x", assignee_id: 3 }, 1)).toEqual({ kind: "invalid", error: expect.stringContaining("owner or a project member") });
    expect(mock.db.createTask(1, { title: "x", assignee_id: 1 }, 1).kind).toBe("created"); // the owner (always a member)
    expect(mock.db.createTask(1, "nope", 1)).toEqual({ kind: "invalid", error: "task must be an object" });
    expect(mock.db.createTask(1, { title: "" }, 1)).toEqual({ kind: "invalid", error: "task.title must be a non-empty string" });
    expect(mock.db.createTask(999, { title: "x" }, 1).kind).toBe("missing");
    expect(mock.db.createTask(1, { title: "x" }, 3).kind).toBe("forbidden"); // Alan is not on project 1
    expect(mock.db.updateTask(1, { hash: "t1-1", status: "bogus" }, 1)).toMatchObject({ kind: "invalid" });
    expect(mock.db.updateTask(1, "nope", 1)).toEqual({ kind: "invalid", error: "task must be an object" });
    expect(mock.db.updateTask(1, { hash: "t1-1" }, 3).kind).toBe("forbidden");
    expect(mock.db.deleteTask(1, 3).kind).toBe("forbidden");
    expect(mock.db.canWriteProject(1, 3)).toBe("forbidden");
    expect(mock.db.canWriteProject(2, 1)).toBe("ok");
    expect(mock.db.canWriteProject(999, 1)).toBe("missing");
  });

  test("an unchanged assignee never blocks an unrelated edit, even after that user left the project (review 11, finding 1)", async () => {
    // Ada (1) is assigned task 5 in project 2; take her off the project's members
    const data = seed();
    data.projects.find((p) => p.id === 2)!.member_ids = [2];
    mock.db.reset(data);
    expect(mock.db.canWriteProject(2, 1)).toBe("forbidden");

    const grace = await authHeaderFor("grace@example.com"); // still on project 2; Ada no longer is, so she may not write to it
    const put = (task: object) => api("/tasks/5", { method: "PUT", body: JSON.stringify({ task }) }, grace);
    // saving the whole task back with the same assignee: fine
    let res = await put({ hash: "t5-1", title: "renamed", assignee_id: 1 });
    expect(res.status).toBe(200);
    const { hash } = ((await res.json()) as { task: { hash: string } }).task;
    // changing to another non-participant: refused
    expect((await put({ hash, assignee_id: 3 })).status).toBe(400);
    // re-assigning the same non-participant explicitly is not a change either
    expect((await put({ hash, assignee_id: 1, status: "done" })).status).toBe(200);
  });

  test("writes to a project's tasks require membership; reads are workspace-wide (review 13, finding 1)", async () => {
    const alan = await authHeaderFor("alan@example.com"); // on no project
    expect((await api("/projects/1/tasks", {}, alan)).status).toBe(200); // read: fine
    expect((await api("/tasks/1", {}, alan)).status).toBe(200);
    const post = await api("/projects/1/tasks", { method: "POST", body: JSON.stringify({ task: { title: "x" } }) }, alan);
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: "not a member of this project" });
    expect((await api("/tasks/1", { method: "PUT", body: JSON.stringify({ task: { hash: "t1-1", title: "y" } }) }, alan)).status).toBe(403);
    expect((await api("/tasks/1", { method: "DELETE" }, alan)).status).toBe(403);
    expect((await api("/projects/1/tasks/import", { method: "POST" }, alan)).status).toBe(403);
    expect((await api("/projects/999/tasks/import", { method: "POST" }, alan)).status).toBe(404); // 404 before 403
    // the import authorizes once, before any write: Alan's refused import created nothing
    expect(((await (await api("/projects/1/tasks")).json()) as { tasks: { title: string }[] }).tasks.some((t) => t.title.startsWith("Imported:"))).toBe(false);
    // nothing was written or broadcast for Alan's attempts
    expect(((await (await api("/projects/1/tasks")).json()) as { tasks: unknown[] }).tasks).toHaveLength(3);
    // a member may do all of it
    expect((await api("/projects/1/tasks", { method: "POST", body: JSON.stringify({ task: { title: "x" } }) })).status).toBe(201);
  });

  test("seed invariants are asserted at load: owner membership and every reference (review 13 finding 3, review 14 finding 1)", () => {
    const broken = (mutate: (d: ReturnType<typeof seed>) => void) => {
      const data = seed();
      mutate(data);
      return () => mock.db.reset(data);
    };
    expect(broken((d) => (d.projects[0]!.member_ids = [2]))).toThrow(/project 1 owner 1 must be in member_ids/);
    expect(broken((d) => d.tasks.push({ id: 99, project_id: 42, assignee_id: null, title: "orphan", status: "todo", due_on: null, hash: "t99-1" }))).toThrow(
      /task 99 belongs to missing project 42/,
    );
    expect(broken((d) => (d.tasks[0]!.assignee_id = 999))).toThrow(/task 1 assignee 999 is not a user/);
    expect(broken((d) => d.comments.push({ id: 99, task_id: 42, author_id: 1, body: "x", created_at: "" }))).toThrow(/comment 99 belongs to missing task 42/);
    expect(broken((d) => d.task_tags.push({ task_id: 1, tag_id: 42 }))).toThrow(/task_tags link 1-42 references a missing row/);
    expect(broken((d) => d.projects[0]!.member_ids.push(42))).toThrow(/project 1 member 42 is not a user/);
    // NOT an invariant: an assignee who has left the project (the write rule applies to a changed assignee only)
    expect(broken((d) => (d.projects.find((p) => p.id === 2)!.member_ids = [2]))).not.toThrow();
    mock.db.reset(); // back to a valid seed for the next test
    for (const p of mock.db.listProjects()) expect(p.member_ids).toContain(p.owner_id);
  });

  test("the import route reports what was written and broadcasts only then (review 11 finding 2, review 12 findings 3, 7)", async () => {
    const broadcasts: unknown[] = [];
    const originalBroadcast = mock.push.broadcast.bind(mock.push);
    const originalCreate = mock.db.createTask.bind(mock.db);
    mock.push.broadcast = (message) => {
      broadcasts.push(message);
      originalBroadcast(message);
    };
    try {
      // the normal case: everything created, one reload
      const body = (await (await api("/projects/2/tasks/import", { method: "POST" })).json()) as { imported: number };
      expect(body.imported).toBe(3);
      expect(broadcasts).toEqual([{ type: "reload", objectType: "project", objectId: 2 }]);

      // the titles are server constants, so a rejected one is a server bug: 500, not a quiet short count
      broadcasts.length = 0;
      let calls = 0;
      mock.db.createTask = (projectId, body, actorId) => (++calls === 2 ? { kind: "invalid", error: "stubbed" } : originalCreate(projectId, body, actorId));
      const originalError = console.error;
      console.error = () => {}; // the server logs the deliberate exception; keep the runner output clean
      try {
        const res = await api("/projects/2/tasks/import", { method: "POST" });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "internal error" });
      } finally {
        console.error = originalError;
      }
      expect(broadcasts).toEqual([]);
    } finally {
      mock.db.createTask = originalCreate;
      mock.push.broadcast = originalBroadcast;
    }
    expect((await api("/projects/999/tasks/import", { method: "POST" })).status).toBe(404);
  });

  test("POST /projects/:id/tasks/import returns only a count", async () => {
    const body = await (await api("/projects/2/tasks/import", { method: "POST" })).json();
    expect(body).toEqual({ imported: 3 });
    expect(((await (await api("/projects/2/tasks")).json()) as { tasks: unknown[] }).tasks).toHaveLength(6);
  });

  test("POST /projects/:id/tasks validates like PUT and persists nothing on failure (review 2, finding 2)", async () => {
    const headers = await authHeader();
    const count = async () =>
      (((await (await api("/projects/1/tasks", {}, headers)).json()) as { tasks: unknown[] }).tasks).length;
    const before = await count();

    const bad = async (task: unknown) => {
      const res = await api("/projects/1/tasks", { method: "POST", body: JSON.stringify({ task }) }, headers);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await bad({ title: { bad: true } })).toContain("task.title");
    expect(await bad({ title: "   " })).toContain("task.title");
    expect(await bad({})).toContain("task.title");
    expect(await bad({ title: "ok", status: "archived" })).toContain("task.status");
    expect(await bad({ title: "ok", assignee_id: "1" })).toContain("task.assignee_id");
    expect(await bad({ title: "ok", due_on: 42 })).toContain("task.due_on");
    expect(await bad("just a string")).toContain("task");
    expect(await bad(null)).toContain("task");
    expect(await count()).toBe(before);

    // server-owned and unknown fields are dropped on create too
    const res = await api(
      "/projects/1/tasks",
      { method: "POST", body: JSON.stringify({ task: { title: "Clean", id: 999, project_id: 2, hash: "x", bogus: 1, status: "doing" } }) },
      headers,
    );
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: Record<string, unknown> };
    expect(task).toMatchObject({ id: 7, project_id: 1, hash: "t7-1", title: "Clean", status: "doing" });
    expect(task).not.toHaveProperty("bogus");
  });

  test("PUT /tasks/:id ignores immutable and unknown fields (finding 1)", async () => {
    const { hash } = ((await (await api("/tasks/1")).json()) as { task: { hash: string } }).task;
    const res = await api("/tasks/1", {
      method: "PUT",
      body: JSON.stringify({ task: { hash, id: 2, project_id: 999, bogus: true, title: "Renamed" } }),
    });
    expect(res.status).toBe(200);
    const { task } = (await res.json()) as { task: Record<string, unknown> };
    expect(task).toMatchObject({ id: 1, project_id: 1, title: "Renamed", hash: "t1-2" });
    expect(task).not.toHaveProperty("bogus");

    // task 1 still exists under its own id; task 2 is untouched
    expect((await api("/tasks/1")).status).toBe(200);
    const two = ((await (await api("/tasks/2")).json()) as { task: { title: string } }).task;
    expect(two.title).toBe("Punch the cards");
  });

  test("PUT /tasks/:id validates field values", async () => {
    const { hash } = ((await (await api("/tasks/1")).json()) as { task: { hash: string } }).task;
    const bad = async (task: Record<string, unknown>) => {
      const res = await api("/tasks/1", { method: "PUT", body: JSON.stringify({ task: { hash, ...task } }) });
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await bad({ status: "archived" })).toContain("task.status");
    expect(await bad({ title: "" })).toContain("task.title");
    expect(await bad({ assignee_id: "1" })).toContain("task.assignee_id");
    expect(await bad({ due_on: 42 })).toContain("task.due_on");
    // no string hash = malformed request (400), not a conflict — see the ordering test
    expect((await api("/tasks/1", { method: "PUT", body: JSON.stringify({ task: {} }) })).status).toBe(400);
    expect((await api("/tasks/1", { method: "PUT", body: JSON.stringify({ task: "nope" }) })).status).toBe(400);

    // nothing was written: hash unchanged
    const after = ((await (await api("/tasks/1")).json()) as { task: { hash: string } }).task;
    expect(after.hash).toBe(hash);
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

  async function loggedIn(headers: Record<string, string>) {
    const [uuid, token] = headers.authorization!.split(":");
    const client = connect();
    await open(client.ws);
    client.ws.send(JSON.stringify({ type: "login", uuid, token }));
    await client.next("login_ok");
    return { ...client, uuid };
  }

  test("sign_out invalidates and closes that session's socket (finding 2)", async () => {
    const ada = await authHeaderFor("ada@example.com");
    const grace = await authHeaderFor("grace@example.com");
    const adaSocket = await loggedIn(ada);
    const graceSocket = await loggedIn(grace);
    expect(mock.push.clientCount).toBe(2);

    const closed = new Promise<number>((resolve) => adaSocket.ws.addEventListener("close", (e) => resolve(e.code)));
    expect((await api("/sign_out", { method: "DELETE" }, ada)).status).toBe(200);

    expect((await adaSocket.next("session_invalid")).type).toBe("session_invalid");
    expect(await closed).toBe(4001);
    expect(mock.push.clientCount).toBe(1);

    // Grace's mutation reaches Grace but not Ada's dead socket
    await api("/projects/2/tasks", { method: "POST", body: JSON.stringify({ task: { title: "After" } }) }, grace);
    expect((await graceSocket.next("new")).type).toBe("new");
    const leaked = await Promise.race([adaSocket.next("new"), new Promise<"none">((r) => setTimeout(() => r("none"), 100))]);
    expect(leaked).toBe("none");

    graceSocket.ws.close();
  });

  test("settings updates reach only the owner's sockets (finding 3)", async () => {
    const ada = await authHeaderFor("ada@example.com");
    const adaAgain = await authHeaderFor("ada@example.com"); // second tab / device
    const grace = await authHeaderFor("grace@example.com");
    const tab1 = await loggedIn(ada);
    const tab2 = await loggedIn(adaAgain);
    const graceSocket = await loggedIn(grace);

    await api("/users/current/settings", { method: "PUT", body: JSON.stringify({ settings: { sidebar: "collapsed" } }) }, ada);

    for (const tab of [tab1, tab2]) {
      const msg = await tab.next("update");
      expect(msg).toMatchObject({ objectType: "current_user", data: { id: 1, settings: { theme: "dark", sidebar: "collapsed" } } });
    }
    const leaked = await Promise.race([graceSocket.next("update"), new Promise<"none">((r) => setTimeout(() => r("none"), 100))]);
    expect(leaked).toBe("none");

    for (const c of [tab1, tab2, graceSocket]) c.ws.close();
  });

  test("malformed frames are ignored and the socket keeps working (review 2, finding 4)", async () => {
    const headers = await authHeader();
    const [uuid, token] = headers.authorization!.split(":");
    const { ws, next } = connect();
    await open(ws);

    for (const frame of ["null", "42", '"login"', "[]", "[1,2]", "{not json", "", '{"type":null}', '{"type":"nope"}']) {
      ws.send(frame);
    }
    // give the server a tick to process them all; nothing should have been sent back except possibly a ping
    await new Promise((r) => setTimeout(r, 30));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(mock.push.clientCount).toBe(0);

    ws.send(JSON.stringify({ type: "login", uuid, token }));
    expect((await next("login_ok")).type).toBe("login_ok");
    expect(mock.push.clientCount).toBe(1);
    ws.close();
  });

  test("rejected writes emit no push messages", async () => {
    const headers = await authHeader();
    const socket = await loggedIn(headers);

    await api("/projects/1/tasks", { method: "POST", body: JSON.stringify({ task: { title: "" } }) }, headers);
    await api("/users/current/settings", { method: "PUT", body: JSON.stringify({ settings: "dark" }) }, headers);
    const { hash } = ((await (await api("/tasks/1", {}, headers)).json()) as { task: { hash: string } }).task;
    await api("/tasks/1", { method: "PUT", body: JSON.stringify({ task: { hash, status: "archived" } }) }, headers);

    const quiet = await Promise.race([
      socket.next("new"),
      socket.next("update"),
      new Promise<"none">((r) => setTimeout(() => r("none"), 100)),
    ]);
    expect(quiet).toBe("none");
    socket.ws.close();
  });
});
