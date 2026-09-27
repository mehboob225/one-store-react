/**
 * Bundles DomainConfiguration for the browser the same way `bun run build`
 * does and evaluates it with no `process` global. Bun inlines only the
 * BUN_PUBLIC_* variables that are set; unset ones stay as `process.env`
 * reads, which would throw in a browser if unguarded.
 *
 * The bundle is produced by a `bun build` subprocess with an explicitly
 * constructed environment and a fresh temp working directory. Both matter:
 * `Bun.build` in-process snapshots the environment at startup (so a
 * developer's BUN_PUBLIC_* values or `.env` would leak into the test), and
 * the `bun build` CLI auto-loads a `.env` from its working directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "DomainConfiguration.ts");
const cleanCwd = mkdtempSync(join(tmpdir(), "one-store-bundle-"));

afterAll(() => rmSync(cleanCwd, { recursive: true, force: true }));

async function bundleWithEnv(env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(
    [process.execPath, "build", entry, "--target=browser", "--format=esm", "--env=BUN_PUBLIC_*"],
    {
      cwd: cleanCwd,
      // Replace the environment entirely; keep only what the bun binary needs to run.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`bun build failed (${exitCode}):\n${stderr}`);
  return code;
}

async function bundleAndRun(env: Record<string, string>, location: object) {
  let code = await bundleWithEnv(env);
  // Turn the ESM output into something we can evaluate in a function scope:
  // capture the named exports on a `__exports` object instead of `export {}`.
  code = code.replace(/export\s*\{([^}]*)\};?\s*$/m, (_m, names: string) => {
    const pairs = names
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => {
        const [local, exported = local] = n.split(/\s+as\s+/).map((x) => x.trim());
        return `${exported}: ${local}`;
      });
    return `__exports = { ${pairs.join(", ")} };`;
  });
  // `process` as a parameter shadows Bun's global; passing undefined simulates a browser.
  const run = new Function("process", "window", "__exports", `${code}\nreturn __exports;`);
  return run(undefined, { location }, {}) as { DomainConfiguration: { api: string; sock: string } };
}

const location = { protocol: "https:", host: "app.example.com", hostname: "app.example.com" };

describe("DomainConfiguration in a browser bundle", () => {
  test("the bundle env is controlled: no BUN_PUBLIC_* reaches the build unless the test sets it", async () => {
    const code = await bundleWithEnv({});
    expect(code).toContain("process.env.BUN_PUBLIC_API_URL"); // left as a read, not inlined
    expect(code).toContain("process.env.BUN_PUBLIC_SOCK_URL");
  });

  test("with no BUN_PUBLIC_* set it does not touch `process` and falls back to same-origin", async () => {
    const { DomainConfiguration } = await bundleAndRun({}, location);
    expect(DomainConfiguration).toEqual({ api: "/api/", sock: "wss://app.example.com/push" });
  });

  test("set BUN_PUBLIC_* values are inlined and win", async () => {
    const { DomainConfiguration } = await bundleAndRun(
      { BUN_PUBLIC_API_URL: "https://api.example.com/api", BUN_PUBLIC_SOCK_URL: "wss://api.example.com/push" },
      location,
    );
    expect(DomainConfiguration).toEqual({ api: "https://api.example.com/api/", sock: "wss://api.example.com/push" });
  });

  test("each variable is independent: only the set one is inlined", async () => {
    const { DomainConfiguration } = await bundleAndRun({ BUN_PUBLIC_API_URL: "https://api.example.com/api" }, location);
    expect(DomainConfiguration).toEqual({ api: "https://api.example.com/api/", sock: "wss://app.example.com/push" });
  });
});
