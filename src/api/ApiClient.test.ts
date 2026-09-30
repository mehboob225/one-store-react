import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AxiosError, type AxiosProgressEvent, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { createMockServer, type MockServer } from "../server/index";
import { ModelFactory } from "../store/AppDataModelFactory";
import { DataCache } from "../store/DataCache";
import { APIClient, compositeId } from "./ApiClient";
import { APIService } from "./ApiService";

interface Reply {
  status?: number;
  data?: unknown;
}

/**
 * A client on a fresh store whose adapter answers with `reply` (axios is
 * mocked at the adapter, so interceptors, URL building and error dispatch
 * run for real). A non-2xx reply rejects the way axios does.
 */
function setup(reply: (config: InternalAxiosRequestConfig) => Reply | Promise<Reply> = () => ({ data: {} })) {
  const store = new DataCache();
  const requests: InternalAxiosRequestConfig[] = [];
  let header: string | null = "uuid-1:token-1";
  const client = new APIClient("/api/", {
    models: new ModelFactory(store),
    auth: { authenticationHeader: () => header },
    adapter: async (config) => {
      requests.push(config);
      const { status = 200, data = {} } = await reply(config);
      const response: AxiosResponse = { data, status, statusText: String(status), headers: {}, config };
      if (status >= 200 && status < 300) return response;
      throw new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
    },
  });
  const signOut = () => (header = null);
  return { store, client, requests, signOut, url: (config: InternalAxiosRequestConfig) => client.axios.getUri(config) };
}

/** Answers with `data` for every request. */
const answering = (data: unknown) => setup(() => ({ data }));

/** A reply the test releases by hand, to interleave a response with a store reset. */
function deferred() {
  let release!: (reply: Reply) => void;
  const reply = new Promise<Reply>((resolve) => (release = resolve));
  return { reply, release };
}

const task = (id: number, extra: Record<string, unknown> = {}) => ({ id, project_id: 1, title: `task ${id}`, status: "todo", hash: `h${id}`, ...extra });

describe("requests", () => {
  test("every request carries the credentials header read at request time, under the base URL", async () => {
    const { client, requests, signOut, url } = setup();
    await client.get("v1/projects");
    await client.post("v1/projects/1/tasks", { task: { title: "x" } });
    signOut();
    await client.delete("v1/tasks/1");

    expect(requests.map((r) => [r.method, url(r)])).toEqual([
      ["get", "/api/v1/projects"],
      ["post", "/api/v1/projects/1/tasks"],
      ["delete", "/api/v1/tasks/1"],
    ]);
    expect(requests[0]!.headers.get("Authorization")).toBe("uuid-1:token-1");
    expect(requests[1]!.headers.get("Authorization")).toBe("uuid-1:token-1");
    expect(requests[1]!.data).toBe(JSON.stringify({ task: { title: "x" } }));
    expect(requests[2]!.headers.has("Authorization")).toBe(false); // signed out: no header at all
  });

  test("an absolute URL stays under the base, so the credentials never reach another host", async () => {
    const { client, requests, url } = setup();
    await client.get("https://evil.example/steal");
    await client.get("//evil.example/steal");
    expect(requests.map(url)).toEqual(["/api/https://evil.example/steal", "/api/evil.example/steal"]);
  });

  test("put and patch send their body; request options pass through", async () => {
    const { client, requests } = setup();
    await client.put("v1/tasks/1", { task: { hash: "h" } }, { params: { q: 1 } });
    await client.patch("v1/tasks/1", { a: 1 });
    expect(requests.map((r) => r.method)).toEqual(["put", "patch"]);
    expect(requests[0]!.params).toEqual({ q: 1 });
    expect(requests[1]!.data).toBe(JSON.stringify({ a: 1 }));
  });

  test("the app's APIService targets DomainConfiguration.api", () => {
    expect(APIService.axios.defaults.baseURL).toBe("/api/");
  });
});

describe("saveAppData", () => {
  test("a list response fills the bucket and, through embedded objects, other buckets", async () => {
    const assignee = { id: 2, name: "Grace Hopper" };
    const { client, store } = answering({ tasks: [task(1, { assignee_id: 2, assignee }), task(2, { assignee: null })] });
    const response = await client.get("v1/projects/1/tasks").saveAppData("tasks");
    expect(store.tasks.getAll().map((t) => t.id)).toEqual([1, 2]);
    expect(store.users.getById(2)?.name).toBe("Grace Hopper");
    expect(store.tasks.getById(1)?.getAssignee()?.name).toBe("Grace Hopper");
    expect(response.data).toEqual({ tasks: [task(1, { assignee_id: 2, assignee }), task(2, { assignee: null })] }); // the chain resolves to the untouched response
  });

  test("a single object is found under the singular name, and writes chain", async () => {
    const { client, store } = answering({ user: { id: 1, name: "Ada" }, current_user: { id: 1, name: "Ada", email: "ada@example.com", settings: {} } });
    await client.get("v1/users/current").saveAppData("users").saveAppData("current_users");
    expect(store.users.getById(1)?.name).toBe("Ada");
    expect(store.current_users.getById(1)?.email).toBe("ada@example.com");
  });

  test("a bare array body, and a named property", async () => {
    const bare = answering([task(1), task(2)]);
    await bare.client.get("v1/x").saveAppData("tasks");
    expect(bare.store.tasks.size).toBe(2);

    const named = answering({ task: task(1), changed_tasks: [task(3), task(4)] });
    await named.client.put("v1/tasks/1", {}).saveAppData("tasks", "changed_tasks").saveAppData("tasks");
    expect(named.store.tasks.getAll().map((t) => t.id)).toEqual([3, 4, 1]);
  });

  test("ids in deleted_<type> are removed, with their cascade", async () => {
    const { client, store } = answering({ deleted_tasks: [1], deleted_comments: [10, 11] });
    new ModelFactory(store).addData("tasks", [task(1), task(2)]);
    new ModelFactory(store).addData("comments", [{ id: 10, task_id: 1 }, { id: 11, task_id: 1 }, { id: 12, task_id: 2 }]);

    await client.delete("v1/tasks/1").saveAppData("tasks");
    expect(store.tasks.getAll().map((t) => t.id)).toEqual([2]);
    expect(store.comments.getAll().map((c) => c.id)).toEqual([12]); // the cascade already took 10 and 11

    await client.delete("v1/tasks/1").saveAppData("comments"); // ids that are gone are ignored
    expect(store.comments.size).toBe(1);
  });

  test("records and deleted ids in one response: the records are stored, then the ids removed", async () => {
    const { client, store } = answering({ tasks: [task(2, { title: "new" })], deleted_tasks: [1] });
    new ModelFactory(store).addData("tasks", [task(1), task(2)]);
    await client.get("v1/x").saveAppData("tasks");
    expect(store.tasks.getAll().map((t) => [t.id, t.title])).toEqual([[2, "new"]]);
  });

  test("a response without the records or deleted_<type> rejects: a wrong bucket name fails loudly", async () => {
    const { client, store } = answering({ projects: [] });
    await expect(client.get("v1/projects").saveAppData("tasks")).rejects.toThrow("the response carries no tasks and no deleted_tasks");
    await expect(client.get("v1/projects").saveAppData("tasks", "task")).rejects.toThrow('the response carries no "task"');
    const empty = setup(() => ({ status: 204, data: "" }));
    await expect(empty.client.delete("v1/x").saveAppData("tasks")).rejects.toThrow("carries no tasks");
    expect(store.tasks.size).toBe(0);
  });

  test("the bucket under both its names is ambiguous and rejects", async () => {
    const { client, store } = answering({ task: task(1), tasks: [task(2)] });
    await expect(client.get("v1/x").saveAppData("tasks")).rejects.toThrow('the response carries tasks under both "task" and "tasks"');
    expect(store.tasks.size).toBe(0);
  });

  test("all or nothing: a bad record or a bad deleted list writes nothing, and later writes in the chain are skipped", async () => {
    const badRecord = answering({ tasks: [task(3), { title: "no id" }], deleted_tasks: [1], comments: [{ id: 1 }] });
    new ModelFactory(badRecord.store).addData("tasks", [task(1)]);
    const chain = badRecord.client.get("v1/x").saveAppData("tasks").saveAppData("comments");
    await expect(chain).rejects.toThrow();
    await chain.catch(() => {});
    expect(badRecord.store.tasks.getAll().map((t) => t.id)).toEqual([1]); // task 3 not added, task 1 not removed
    expect(badRecord.store.comments.size).toBe(0);

    const badDeleted = answering({ tasks: [task(3)], deleted_tasks: "1" });
    await expect(badDeleted.client.get("v1/x").saveAppData("tasks")).rejects.toThrow('"deleted_tasks" must be an array of ids');
    expect(badDeleted.store.tasks.size).toBe(0);
  });
});

describe("saveMetaData", () => {
  test("attaches the named response field to the parent object", async () => {
    const { client, store } = answering({ subscription: { plan: "pro" } });
    new ModelFactory(store).addData("current_users", { id: 1, name: "Ada" });
    await client.get("v1/subscription").saveMetaData("current_users", 1, "subscription");
    expect(store.current_users.getMetaData(1, "subscription")).toEqual({ plan: "pro" });
    expect(store.current_users.getById(1)?.getSubscription()).toEqual({ plan: "pro" });
  });

  test("a missing field or an undeclared key rejects", async () => {
    const { client, store } = answering({ other: 1 });
    await expect(client.get("v1/x").saveMetaData("current_users", 1, "subscription")).rejects.toThrow('the response carries no "subscription"');
    await expect(client.get("v1/x").saveMetaData("current_users", 1, "other")).rejects.toThrow();
    expect(store.current_users.getMetaData(1, "subscription")).toBeUndefined();
  });
});

describe("saveObjectsBelongingTo", () => {
  const tags = (...ids: number[]) => ({ tags: ids.map((id) => ({ id, name: `tag ${id}` })) });

  test("stores the objects and synthesises one join row per object, with a composite id", async () => {
    const { client, store } = answering(tags(1, 3));
    new ModelFactory(store).addData("tasks", [task(5)]);
    await client.get("v1/tasks/5/tags").saveObjectsBelongingTo("task_tags_relation", "tasks", 5, "tags");

    expect(store.tags.getAll().map((t) => t.name)).toEqual(["tag 1", "tag 3"]);
    expect([...store.task_tags_relation.getAll()]).toEqual([
      { id: "5-1", task_id: 5, tag_id: 1 },
      { id: "5-3", task_id: 5, tag_id: 3 },
    ]);
    expect(store.tasks.getById(5)?.getTags().map((t) => t.id)).toEqual([1, 3]);
    expect(store.tags.getById(3)?.getTasks().map((t) => t.id)).toEqual([5]);
  });

  test("the list is the owner's complete set: links it no longer names are removed, other owners' links and the objects stay", async () => {
    let body = tags(1, 2);
    const { client, store } = setup(() => ({ data: body }));
    const load = (taskId: number) => client.get(`v1/tasks/${taskId}/tags`).saveObjectsBelongingTo("task_tags_relation", "tasks", taskId, "tags");
    await load(5);
    await load(6);

    body = tags(2);
    await load(5);
    expect(store.task_tags_relation.getAll().map((r) => r.id)).toEqual(["5-2", "6-1", "6-2"]);
    expect(store.tags.size).toBe(2); // tag 1 is only unlinked from task 5

    body = tags();
    await load(5);
    expect(store.task_tags_relation.getAll().map((r) => r.id)).toEqual(["6-1", "6-2"]);
  });

  test("an undeclared relation, a bad owner id or a missing list rejects before any write", async () => {
    const { client, store } = answering(tags(1));
    await expect(client.get("v1/x").saveObjectsBelongingTo("task_tags_relation", "projects", 1, "tags")).rejects.toThrow(
      "projects declares no hasMany of tags through task_tags_relation",
    );
    await expect(client.get("v1/x").saveObjectsBelongingTo("task_tags_relation", "tasks", Number.NaN, "tags")).rejects.toThrow("the tasks id must be");
    const missing = answering({ other: [] });
    await expect(missing.client.get("v1/x").saveObjectsBelongingTo("task_tags_relation", "tasks", 1, "tags")).rejects.toThrow("the response carries no tags");
    expect(store.tags.size + store.task_tags_relation.size).toBe(0);
  });

  test("compositeId follows the given order and is unambiguous for ids holding the separator", () => {
    expect(compositeId([5, 1])).toBe("5-1");
    expect(compositeId(["5", 1])).toBe("5-1"); // canonical: 5 and "5" are one key
    expect(compositeId(["a-b", "c"])).not.toBe(compositeId(["a", "b-c"]));
    expect(compositeId(["a%2Db", "c"])).not.toBe(compositeId(["a-b", "c"]));
  });
});

describe("deleteAppData", () => {
  test("removes the named object with its cascade once the request succeeds", async () => {
    const { client, store } = answering({});
    const models = new ModelFactory(store);
    models.addData("tasks", [task(1), task(2), task(3)]);
    models.addData("comments", [{ id: 10, task_id: 1 }, { id: 11, task_id: 3 }]);

    await client.delete("v1/tasks/1").deleteAppData("tasks", 1);
    expect(store.tasks.getAll().map((t) => t.id)).toEqual([2, 3]);
    expect(store.comments.getAll().map((c) => c.id)).toEqual([11]);

    await client.delete("v1/tasks").deleteAppDataArray("tasks", [2, store.tasks.getById(3)!]);
    expect(store.tasks.size + store.comments.size).toBe(0);
  });

  test("a failed request removes nothing", async () => {
    const { client, store } = setup(() => ({ status: 403, data: { error: "not a member of this project" } }));
    new ModelFactory(store).addData("tasks", [task(1)]);
    await expect(client.delete("v1/tasks/1").deleteAppData("tasks", 1)).rejects.toBeInstanceOf(AxiosError);
    expect(store.tasks.size).toBe(1);
  });
});

describe("generation guard", () => {
  test("a response to a request made before a store reset never lands; the chain still resolves", async () => {
    const pending = deferred();
    const { client, store } = setup(() => pending.reply);
    const late = client.get("v1/projects/1/tasks").saveAppData("tasks").saveAppData("users");

    store.reset(); // the session ends while the request is in flight
    pending.release({ data: { tasks: [task(1)], users: [{ id: 1, name: "Ada" }] } });
    const response = await late;

    expect(response.status).toBe(200);
    expect(store.tasks.size + store.users.size).toBe(0);
  });

  test("the generation is captured when the request is made, not when it is chained or answered", async () => {
    const { client, store } = answering({ tasks: [task(1)] });
    store.reset();
    await client.get("v1/x").saveAppData("tasks"); // made after the reset: the new session's request
    expect(store.tasks.size).toBe(1);

    const pending = deferred();
    const slow = setup(() => pending.reply);
    const request = slow.client.get("v1/x");
    slow.store.reset();
    const chained = request.saveAppData("tasks"); // chained after the reset, but made before it
    pending.release({ data: { tasks: [task(1)] } });
    await chained;
    expect(slow.store.tasks.size).toBe(0);
  });

  test("the previous session's 401 is not dispatched: it must not sign the new session out", async () => {
    const pending = deferred();
    const { client, store } = setup(() => pending.reply);
    const heard: AxiosError[] = [];
    client.errorHandler.subscribe((error) => heard.push(error));

    const stale = client.get("v1/projects");
    store.reset();
    pending.release({ status: 401, data: { error: "unauthorized" } });
    await expect(stale).rejects.toBeInstanceOf(AxiosError); // the caller still hears it
    await stale.catch(() => {});
    expect(heard).toEqual([]);
  });
});

describe("errorHandler", () => {
  test("a 401 is emitted as an AxiosError, rejects the chain and skips its writes", async () => {
    const { client, store } = setup(() => ({ status: 401, data: { error: "unauthorized" } }));
    const heard: AxiosError[] = [];
    client.errorHandler.subscribe((error) => heard.push(error));

    const chain = client.get("v1/projects").saveAppData("projects");
    const error = await chain.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AxiosError);
    expect(heard).toEqual([error as AxiosError]);
    expect(heard[0]!.response?.status).toBe(401);
    expect(store.projects.size).toBe(0);
  });

  test("a network failure is emitted; a failed store write is not (it is the caller's contract error, not the server's)", async () => {
    const network = setup(() => {
      throw new AxiosError("Network Error", AxiosError.ERR_NETWORK);
    });
    const heard: AxiosError[] = [];
    network.client.errorHandler.subscribe((error) => heard.push(error));
    await network.client.get("v1/x").catch(() => {});
    expect(heard.map((e) => e.code)).toEqual([AxiosError.ERR_NETWORK]);

    const contract = answering({ other: [] });
    contract.client.errorHandler.subscribe((error) => heard.push(error));
    await contract.client.get("v1/x").saveAppData("tasks").catch(() => {});
    expect(heard).toHaveLength(1);
  });
});

describe("callbacks", () => {
  test("addCallback runs in chain order, sees the writes before it, and keeps the chain", async () => {
    const { client, store } = answering({ tasks: [task(1)], comments: [{ id: 1, task_id: 1 }] });
    const seen: string[] = [];
    await client
      .get("v1/x")
      .saveAppData("tasks")
      .addCallback((response) => seen.push(`tasks=${store.tasks.size} comments=${store.comments.size} status=${response.status}`))
      .saveAppData("comments")
      .addCallback(() => seen.push(`comments=${store.comments.size}`));
    expect(seen).toEqual(["tasks=1 comments=0 status=200", "comments=1"]);
  });

  test("addOnProgressCallback hears the request's upload progress; requests without a body register no upload listener", async () => {
    const progress: AxiosProgressEvent = { loaded: 5, total: 10, bytes: 5, lengthComputable: true, upload: true };
    const { client, requests } = setup((config) => {
      config.onUploadProgress?.(progress);
      return { data: {} };
    });
    const heard: AxiosProgressEvent[] = [];
    await client.post("v1/upload", "payload").addOnProgressCallback((event) => heard.push(event)).saveAppData("tasks").catch(() => {});
    expect(heard).toEqual([progress]);

    await client.get("v1/x");
    expect(requests[1]!.onUploadProgress).toBeUndefined();
  });
});

describe("against the mock server", () => {
  let mock: MockServer;
  beforeAll(() => {
    mock = createMockServer();
  });
  afterAll(async () => {
    await mock.stop();
  });
  beforeEach(() => mock.reset());

  async function signedInClient() {
    const res = await fetch(new URL("/api/v1/sign_in", mock.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: "password" }),
    });
    const { uuid, token } = (await res.json()) as { uuid: string; token: string };
    let header: string | null = `${uuid}:${token}`;
    const store = new DataCache();
    const client = new APIClient(new URL("/api/", mock.url).href, { models: new ModelFactory(store), auth: { authenticationHeader: () => header }, adapter: "fetch" });
    return { client, store, signOut: () => (header = null) };
  }

  test("a read, a many-to-many read and a delete go through the real contract into the store", async () => {
    const { client, store } = await signedInClient();
    await client.get("v1/projects/1/tasks").saveAppData("tasks");
    expect(store.tasks.getAll().map((t) => t.id)).toEqual([1, 2, 3]);
    expect(store.users.getAll().map((u) => u.name)).toEqual(["Ada Lovelace", "Grace Hopper"]); // lifted assignees

    await client.get("v1/tasks/2/tags").saveObjectsBelongingTo("task_tags_relation", "tasks", 2, "tags");
    expect(store.tasks.getById(2)?.getTags().map((t) => t.name)).toEqual(["hardware", "urgent"]);

    await client.get("v1/tasks/1/comments").saveAppData("comments");
    expect(store.comments.size).toBe(2);
    await client.delete("v1/tasks/1").saveAppData("tasks").saveAppData("comments");
    expect(store.tasks.getAll().map((t) => t.id)).toEqual([2, 3]);
    expect(store.comments.size).toBe(0);
  });

  test("a 401 from the server reaches errorHandler", async () => {
    const { client, signOut } = await signedInClient();
    const heard: number[] = [];
    client.errorHandler.subscribe((error) => heard.push(error.response?.status ?? 0));
    signOut();
    await client.get("v1/projects").saveAppData("projects").catch(() => {});
    expect(heard).toEqual([401]);
  });
});
