import { describe, expect, test } from "bun:test";
import { ModelDefinitions, type ModelDefinition } from "../../store/ModelDefinitions";
import { GENERATED_HEADER, generateModels, OWNED_DIRECTORIES } from "./generate";

const root = new URL("../../../", import.meta.url);

describe("generateModels", () => {
  test("the committed files are exactly what the generator emits for the demo schema (what `--check` enforces)", async () => {
    const files = generateModels(ModelDefinitions);
    expect(files.map((f) => f.path)).toEqual([
      "src/store/DataCache.ts",
      "src/models/appdata/UserModelAppData.ts",
      "src/models/appdata/CurrentUserModelAppData.ts",
      "src/models/appdata/ProjectModelAppData.ts",
      "src/models/appdata/TaskModelAppData.ts",
      "src/models/appdata/TagModelAppData.ts",
    ]);
    for (const { path, content } of files) {
      expect(await Bun.file(new URL(path, root)).text()).toBe(content);
      expect(content.startsWith(GENERATED_HEADER)).toBe(true);
      expect(content.endsWith("\n")).toBe(true);
    }
  });

  test("is deterministic: two runs are byte-identical", () => {
    expect(generateModels(ModelDefinitions)).toEqual(generateModels(ModelDefinitions));
  });

  test("the CLI's --check passes on the committed tree", () => {
    const result = Bun.spawnSync(["bun", "scripts/generate-models.ts", "--check"], { cwd: root.pathname });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("6 generated files are up to date");
  });

  test("refuses an inconsistent schema instead of emitting broken code", () => {
    expect(() => generateModels({ a: { index: "id", foreignKeys: { b_id: { objectType: "b", getter: "getB" } } } })).toThrow(/points at unknown type "b"/);
  });

  test("--check flags an orphaned *AppData.ts file, and a write deletes it (step 8 review, finding 4)", async () => {
    const orphan = new URL(`${OWNED_DIRECTORIES[0]}/OrphanModelAppData.ts`, root);
    await Bun.write(orphan, "// an orphan left behind by a renamed model\n");
    try {
      const check = Bun.spawnSync(["bun", "scripts/generate-models.ts", "--check"], { cwd: root.pathname });
      expect(check.exitCode).toBe(1);
      expect(check.stderr.toString()).toContain("src/models/appdata/OrphanModelAppData.ts (orphan: no definition generates it)");
      const write = Bun.spawnSync(["bun", "scripts/generate-models.ts"], { cwd: root.pathname });
      expect(write.exitCode).toBe(0);
      expect(write.stdout.toString()).toContain("deleted orphan src/models/appdata/OrphanModelAppData.ts");
      expect(write.stdout.toString()).not.toContain("wrote"); // nothing else changed
      expect(await Bun.file(orphan).exists()).toBe(false);
    } finally {
      await Bun.file(orphan).delete().catch(() => undefined);
    }
  });

  test("every schema property becomes the documented member; plain types become record interfaces", () => {
    const defs: Record<string, ModelDefinition> = {
      owners: {
        index: "uid",
        model: "OwnerModel",
        foreignKeys: { boss_uid: { objectType: "owners", getter: "getBoss" }, home_id: { objectType: "homes", getter: "getHome" } },
        foreignKeysArray: { pet_ids: { objectType: "pets", getter: "getPets" } },
        relatedObjectType: { pets: { objectType: "pets", key: "owner_uid", getter: "getOwnedPets", cascadeDelete: true } },
        hasMany: { friends: { objectType: "owners", through: "friendships", thisKey: "owner_uid", otherKey: "friend_uid", getter: "getFriends" } },
        metaData: ["limits"],
      },
      homes: { index: "id" },
      pets: { index: "id", model: "PetModel", foreignKeys: { owner_uid: { objectType: "owners", getter: "getOwner" } } },
      lonely: { index: "id", model: "LonelyModel" },
      friendships: {
        index: "id",
        foreignKeys: { owner_uid: { objectType: "owners", getter: "getOwner" }, friend_uid: { objectType: "owners", getter: "getFriend" } },
        belongsTo: ["owners"],
      },
    };
    const files = new Map(generateModels(defs).map((f) => [f.path, f.content]));
    expect([...files.keys()]).toEqual([
      "src/store/DataCache.ts",
      "src/models/appdata/OwnerModelAppData.ts",
      "src/models/appdata/PetModelAppData.ts",
      "src/models/appdata/LonelyModelAppData.ts",
    ]);

    const owner = files.get("src/models/appdata/OwnerModelAppData.ts")!;
    expect(owner).toContain("export class OwnerModelAppData extends PassiveModel<DataCache> {");
    expect(owner).toContain("  declare uid: IndexValue;\n  declare boss_uid?: IndexValue | null;\n  declare home_id?: IndexValue | null;\n  declare pet_ids?: readonly IndexValue[] | null;\n");
    expect(owner).toContain("  getBoss(): OwnerModel | undefined {\n    return storeOf(this).owners.getById(this.boss_uid);\n  }");
    expect(owner).toContain("  getHome(): HomesRecord | undefined {\n    return storeOf(this).homes.getById(this.home_id);\n  }");
    expect(owner).toContain("  getPets(): PetModel[] {\n    return storeOf(this).pets.getMultipleByIds(this.pet_ids ?? []);\n  }");
    expect(owner).toContain('  getOwnedPets(): readonly PetModel[] {\n    return storeOf(this).pets.getGroupedById("owner_uid", this.uid);\n  }');
    expect(owner).toContain(
      '  getFriends(): OwnerModel[] {\n    return storeOf(this).owners.getAssociation<OwnerModel>("friendships", "owner_uid", "friend_uid", this.uid);\n  }',
    );
    expect(owner).toContain('  getLimits(): unknown {\n    return storeOf(this).owners.getMetaData(this.uid, "limits");\n  }');
    // imports: the store type, the referenced HANDWRITTEN models (types only; even its own subclass, for getBoss) and records, never the singleton
    expect(owner).toContain('import { PassiveModel, storeOf } from "../generator/PassiveModel";');
    expect(owner).toContain('import type { DataCache, HomesRecord } from "../../store/DataCache";');
    expect(owner).toContain('import type { OwnerModel } from "../OwnerModel";\nimport type { PetModel } from "../PetModel";');
    expect(owner).not.toContain("AppData\";"); // no base imports another base: accessors return the model classes
    for (const content of files.values()) expect(content).not.toContain("AppDataFactory");
    // a model without relations gets no accessor and no storeOf import
    const lonely = files.get("src/models/appdata/LonelyModelAppData.ts")!;
    expect(lonely).toContain('import { PassiveModel } from "../generator/PassiveModel";');
    expect(lonely).not.toContain("storeOf");
    expect(lonely).toContain("export class LonelyModelAppData extends PassiveModel<DataCache> {\n  declare id: IndexValue;\n}");

    const cache = files.get("src/store/DataCache.ts")!;
    expect(cache).toContain("export interface HomesRecord extends Record<string, unknown> {\n  id: IndexValue;\n}");
    expect(cache).toContain(
      "export interface FriendshipsRecord extends Record<string, unknown> {\n  id: IndexValue;\n  owner_uid?: IndexValue | null;\n  friend_uid?: IndexValue | null;\n}",
    );
    expect(cache).toContain("  readonly owners: DataCacheIndex<OwnerModel>;\n  readonly homes: DataCacheIndex<HomesRecord>;");
    expect(cache).toContain('import type { OwnerModel } from "../models/OwnerModel";');
    expect(cache).toContain('    this.friendships = new DataCacheIndex<FriendshipsRecord>("friendships", definitions, context);');
    expect(cache).toContain("  constructor(onListenerError?: ListenerErrorHandler) {"); // no definitions parameter: the buckets are fixed to the schema
    expect(cache).toContain("owner: this }");
    expect(cache).not.toContain("HomesRecord } from"); // records live in this file
  });
});
