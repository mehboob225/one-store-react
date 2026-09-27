/**
 * Review 2, finding 1: a hot reload must not orphan open WebSockets.
 *
 * Two layers:
 *  1. deterministic — `createMockServer({ state })` shares data, sessions and
 *     sockets between two server instances, which is what a reload does.
 *  2. real — spawn `bun --hot` on a throwaway entry, connect, edit the file,
 *     and assert the pre-reload socket still receives events afterwards.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { createBackendState, createMockServer } from "./index";

type Msg = Record<string, unknown>;

function connect(origin: string) {
  const ws = new WebSocket(`${origin.replace("http", "ws")}/push`);
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
  const opened = new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  return { ws, next, opened };
}

async function signIn(origin: string) {
  const res = await fetch(`${origin}/api/v1/sign_in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ada@example.com", password: "password" }),
  });
  const { uuid, token } = (await res.json()) as { uuid: string; token: string };
  return { uuid, token, headers: { authorization: `${uuid}:${token}`, "content-type": "application/json" } };
}

async function loggedInSocket(origin: string, uuid: string, token: string) {
  const client = connect(origin);
  await client.opened;
  client.ws.send(JSON.stringify({ type: "login", uuid, token }));
  await client.next("login_ok");
  return client;
}

describe("hot reload: shared backend state", () => {
  test("a second server built on the same state serves the first server's sessions and sockets", async () => {
    const state = createBackendState({ pingIntervalMs: 60_000 });
    const first = createMockServer({ state });
    const { uuid, token, headers } = await signIn(first.url.origin);
    const socket = await loggedInSocket(first.url.origin, uuid, token);

    // "reload": new handlers, same state
    const second = createMockServer({ state });
    expect(second.push).toBe(first.push);

    // the old token still works against the new handlers
    expect((await fetch(`${second.url.origin}/api/v1/projects`, { headers })).status).toBe(200);

    // a mutation through the new handlers reaches the socket opened before the "reload"
    await fetch(`${second.url.origin}/api/v1/projects/1/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task: { title: "After reload" } }),
    });
    expect(await socket.next("new")).toMatchObject({ type: "new", objectType: "task", data: { title: "After reload" } });

    // stopping a server that borrowed the state leaves the state (and sockets) alive
    await second.stop();
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    expect(state.push.clientCount).toBe(1);

    socket.ws.close();
    await first.stop();
    state.push.stop();
  });

  test("without shared state a new server does not see the old sessions (the bug the fix prevents)", async () => {
    const first = createMockServer({ pingIntervalMs: 60_000 });
    const { headers } = await signIn(first.url.origin);
    const second = createMockServer({ pingIntervalMs: 60_000 });
    expect((await fetch(`${second.url.origin}/api/v1/projects`, { headers })).status).toBe(401);
    await first.stop();
    await second.stop();
  });
});

describe("hot reload: real bun --hot process", () => {
  const dir = mkdtempSync(join(tmpdir(), "one-store-hot-"));
  const entry = join(dir, "entry.ts");
  const devModule = join(import.meta.dir, "dev.ts");
  let proc: Subprocess<"ignore", "pipe", "pipe"> | undefined;

  afterAll(() => {
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("sockets opened before a reload keep receiving events after it", async () => {
    writeFileSync(
      entry,
      [
        `import { startMockServer } from ${JSON.stringify(devModule)};`,
        `const { url } = startMockServer({ port: 0, pingIntervalMs: 60_000 });`,
        `console.log("READY " + url.origin);`,
        `// generation 1`,
        "",
      ].join("\n"),
    );

    proc = Bun.spawn(["bun", "--hot", entry], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "test" } });
    const stdout = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readyLines: string[] = [];

    async function waitForReady(count: number, timeoutMs = 15_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (readyLines.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for READY #${count}; stdout so far:\n${buffer}`);
        const { value, done } = await Promise.race([
          stdout.read(),
          new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 500)),
        ]);
        if (value) {
          buffer += decoder.decode(value);
          readyLines.length = 0;
          for (const line of buffer.split("\n")) if (line.startsWith("READY ")) readyLines.push(line.slice(6).trim());
        } else if (done && proc!.exitCode !== null) {
          throw new Error(`bun --hot exited early (${proc!.exitCode}); stdout:\n${buffer}`);
        }
      }
      return readyLines[count - 1]!;
    }

    const origin = await waitForReady(1);
    const { uuid, token, headers } = await signIn(origin);
    const socket = await loggedInSocket(origin, uuid, token);

    // sanity: events flow before the reload
    await fetch(`${origin}/api/v1/projects/1/tasks`, { method: "POST", headers, body: JSON.stringify({ task: { title: "Before" } }) });
    expect(await socket.next("new")).toMatchObject({ data: { title: "Before" } });

    // trigger a hot reload by editing the entry
    appendFileSync(entry, "// generation 2\n");
    const originAfter = await waitForReady(2);
    expect(originAfter).toBe(origin);

    // the pre-reload token and socket both survive
    expect((await fetch(`${origin}/api/v1/projects`, { headers })).status).toBe(200);
    await fetch(`${origin}/api/v1/projects/1/tasks`, { method: "POST", headers, body: JSON.stringify({ task: { title: "After" } }) });
    expect(await socket.next("new")).toMatchObject({ data: { title: "After" } });
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);

    socket.ws.close();
  }, 30_000);
});
