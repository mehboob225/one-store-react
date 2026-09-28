import { describe, expect, test } from "bun:test";
import { ModelDefinitions, type ModelDefinition } from "../../store/ModelDefinitions";
import { GENERATED_HEADER, generateModels, pascalCase } from "./generate";

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

  test("pascalCase", () => {
    expect(pascalCase("task_tags_relation")).toBe("TaskTagsRelation");
    expect(pascalCase("users")).toBe("Users");
    expect(pascalCase("current_users")).toBe("CurrentUsers");
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
      friendships: {
        index: "id",
        foreignKeys: { owner_uid: { objectType: "owners", getter: "getOwner" }, friend_uid: { objectType: "owners", getter: "getFriend" } },
        belongsTo: ["owners"],
      },
    };
    const files = new Map(generateModels(defs).map((f) => [f.path, f.content]));
    expect([...files.keys()]).toEqual(["src/store/DataCache.ts", "src/models/appdata/OwnerModelAppData.ts", "src/models/appdata/PetModelAppData.ts"]);

    const owner = files.get("src/models/appdata/OwnerModelAppData.ts")!;
    expect(owner).toContain("export class OwnerModelAppData extends PassiveModel {");
    expect(owner).toContain("  declare uid: IndexValue;\n  declare boss_uid?: IndexValue | null;\n  declare home_id?: IndexValue | null;\n  declare pet_ids?: readonly IndexValue[] | null;\n");
    expect(owner).toContain("  getBoss(): OwnerModelAppData | undefined {\n    return AppDataFactory.owners.getById(this.boss_uid);\n  }");
    expect(owner).toContain("  getHome(): HomesRecord | undefined {\n    return AppDataFactory.homes.getById(this.home_id);\n  }");
    expect(owner).toContain("  getPets(): PetModelAppData[] {\n    return AppDataFactory.pets.getMultipleByIds(this.pet_ids ?? []);\n  }");
    expect(owner).toContain('  getOwnedPets(): readonly PetModelAppData[] {\n    return AppDataFactory.pets.getGroupedById("owner_uid", this.uid);\n  }');
    expect(owner).toContain(
      '  getFriends(): OwnerModelAppData[] {\n    return AppDataFactory.owners.getAssociation<OwnerModelAppData>("friendships", "owner_uid", "friend_uid", this.uid);\n  }',
    );
    expect(owner).toContain('  get limits(): unknown {\n    return AppDataFactory.owners.getMetaData(this.uid, "limits");\n  }');
    // imports: the referenced model bases and records, never itself
    expect(owner).toContain('import type { HomesRecord } from "../../store/DataCache";');
    expect(owner).toContain('import type { PetModelAppData } from "./PetModelAppData";');
    expect(owner).not.toContain('from "./OwnerModelAppData"');

    const cache = files.get("src/store/DataCache.ts")!;
    expect(cache).toContain("export interface HomesRecord extends Record<string, unknown> {\n  id: IndexValue;\n}");
    expect(cache).toContain(
      "export interface FriendshipsRecord extends Record<string, unknown> {\n  id: IndexValue;\n  owner_uid?: IndexValue | null;\n  friend_uid?: IndexValue | null;\n}",
    );
    expect(cache).toContain("  readonly owners: DataCacheIndex<OwnerModelAppData>;\n  readonly homes: DataCacheIndex<HomesRecord>;");
    expect(cache).toContain('    this.friendships = new DataCacheIndex<FriendshipsRecord>("friendships", definitions, context);');
    expect(cache).not.toContain("HomesRecord } from"); // records live in this file
  });
});
