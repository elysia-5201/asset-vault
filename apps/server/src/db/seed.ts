import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normKey, type AvatarKind } from "../../../../packages/core/src/contracts";
import type { Repo } from "./repo";

const primarySeed = fileURLToPath(new URL("../../../../config/avatars.seed.json", import.meta.url));
const legacySeed = fileURLToPath(new URL("../../../../data/avatars.seed.json", import.meta.url));
const defaultSeedPath = existsSync(primarySeed) ? primarySeed : legacySeed;

/** 首次启动播种常见 avatar 与别名（幂等；已存在不覆盖，别名冲突跳过）。 */
export function seedAvatars(repo: Repo, seedFile?: string): number {
  const seedPath = seedFile ?? defaultSeedPath;
  if (repo.getSetting("avatars_seeded") === "1") return 0;
  let added = 0;
  if (!existsSync(seedPath)) {
    // 种子文件缺失时**不**标记已播种，否则库会永久没有头像（曾因 data/ 被清空踩过）
    console.warn(`[seed] avatar seed file not found: ${seedPath} (skipped, will retry next boot)`);
    return 0;
  }
  if (existsSync(seedPath)) {
    const data = JSON.parse(readFileSync(seedPath, "utf8")) as { avatars: { name: string; aliases: string[]; kind?: AvatarKind; owned?: boolean }[] };
    for (const a of data.avatars ?? []) {
      const existing = repo.findAvatarByAlias(normKey(a.name));
      if (existing) continue;
      const row = repo.createAvatar({ name: a.name, kind: a.kind ?? "avatar", owned: a.owned ?? false, aliases: a.aliases });
      added++;
      for (const al of a.aliases ?? []) {
        try { if (!repo.findAvatarByAlias(normKey(al))) repo.addAlias(row.id, al, null, "seed"); } catch { /* 冲突跳过 */ }
      }
    }
  }
  repo.setSetting("avatars_seeded", "1");
  return added;
}
