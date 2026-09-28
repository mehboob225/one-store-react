/**
 * `bun run generate-models`          writes every generated file and deletes orphans (see
 *                                    src/models/generator/generate.ts for what is generated and owned)
 * `bun run generate-models --check`  writes nothing; exits 1 if a committed file differs from what the
 *                                    generator would emit, is missing, or is an orphan the current schema
 *                                    no longer produces (CI runs this so generated output is never stale)
 */
import { readdir, unlink } from "node:fs/promises";
import { ModelDefinitions } from "../src/store/ModelDefinitions";
import { generateModels, OWNED_DIRECTORIES, OWNED_FILE_SUFFIX } from "../src/models/generator/generate";

const check = process.argv.includes("--check");
const root = new URL("..", import.meta.url);
const files = generateModels(ModelDefinitions);
const emitted = new Set(files.map((f) => f.path));
const stale: string[] = [];

for (const { path, content } of files) {
  const file = Bun.file(new URL(path, root));
  const current = (await file.exists()) ? await file.text() : undefined;
  if (current === content) continue;
  if (check) stale.push(current === undefined ? `${path} (missing)` : path);
  else {
    await Bun.write(file, content);
    console.log(`wrote ${path}`);
  }
}

// Orphans: generated files in an owned directory that the current schema does not produce.
for (const dir of OWNED_DIRECTORIES) {
  const names = await readdir(new URL(`${dir}/`, root)).catch(() => [] as string[]);
  for (const name of names.sort()) {
    const path = `${dir}/${name}`;
    if (!name.endsWith(OWNED_FILE_SUFFIX) || emitted.has(path)) continue;
    if (check) stale.push(`${path} (orphan: no definition generates it)`);
    else {
      await unlink(new URL(path, root));
      console.log(`deleted orphan ${path}`);
    }
  }
}

if (check) {
  if (stale.length > 0) {
    console.error(`generated files are stale; run \`bun run generate-models\` and commit:\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`${files.length} generated files are up to date`);
} else {
  console.log(`${files.length} generated files checked`);
}
