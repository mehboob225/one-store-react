/**
 * Bundles DomainConfiguration for the browser the same way `bun run build`
 * does and evaluates it with no `process` global. Bun inlines only the
 * BUN_PUBLIC_* variables that are set; unset ones stay as `process.env`
 * reads, which would throw in a browser if unguarded.
 */
import { describe, expect, test } from "bun:test";

async function bundleAndRun(env: Record<string, string>, location: object) {
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/DomainConfiguration.ts`],
    target: "browser",
    format: "esm",
    minify: false,
    env: "BUN_PUBLIC_*",
    define: Object.fromEntries(Object.entries(env).map(([k, v]) => [`process.env.${k}`, JSON.stringify(v)])),
  });
  expect(result.success).toBe(true);
  let code = await result.outputs[0]!.text();
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
});
