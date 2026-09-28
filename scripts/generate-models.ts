/**
 * `bun run generate-models`          writes every generated file (see src/models/generator/generate.ts)
 * `bun run generate-models --check`  writes nothing; exits 1 if a committed file differs from what
 *                                    the generator would emit (CI runs this so generated output is never stale)
 */
import { ModelDefinitions } from "../src/store/ModelDefinitions";
import { generateModels } from "../src/models/generator/generate";

const check = process.argv.includes("--check");
const root = new URL("..", import.meta.url);
const files = generateModels(ModelDefinitions);
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

if (check) {
  if (stale.length > 0) {
    console.error(`generated files are stale; run \`bun run generate-models\` and commit:\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`${files.length} generated files are up to date`);
} else {
  console.log(`${files.length} generated files checked`);
}
