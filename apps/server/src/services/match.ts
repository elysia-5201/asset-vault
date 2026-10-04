import { normKey, type AvatarDetectionResult, type KnownAvatar } from "../../../../packages/core/src/contracts";
import { detectAvatars, avatarNamesFromPaths } from "../../../../packages/core/src/avatars/detect";
import { parseDeclaredCount } from "../../../../packages/core/src/avatars/normalize";
import type { Repo } from "../db/repo";

export interface MatchOutcome {
  hits: { name: string; confidence: number; sources: string[] }[];
  declared: number | null; planned: string[]; addedItem: number; addedAsset: number;
}

function pathsOfAsset(repo: Repo, assetId: number, container: string): string[] {
  if (container === "unitypackage") return repo.getUnityPackageAssets(assetId).map((a: any) => String(a.assetPath));
  return repo.getArchiveEntries(assetId).map((e: any) => String(e.path));
}

/** 依据 6 类证据为条目/资产标注适配 avatar；manual/confirmed 的关联绝不被自动结果覆盖。 */
export function matchItem(repo: Repo, itemId: number, extra: { fileNames?: string[] } = {}): MatchOutcome {
  const detail = repo.getItem(itemId);
  if (!detail) throw Object.assign(new Error(`item ${itemId} not found`), { code: "NOT_FOUND", status: 404 });
  const item = detail.item;
  const known: KnownAvatar[] = repo.listAvatars().map((a) => ({ name: a.name, aliases: a.aliases, kind: a.kind }));

  const assetPaths: { assetId: number; container: string; paths: string[] }[] = detail.assets.map((a) => ({
    assetId: a.id, container: a.container, paths: pathsOfAsset(repo, a.id, a.container),
  }));
  const allPaths = assetPaths.flatMap((a) => a.paths);
  const upkgPaths = assetPaths.filter((a) => a.container === "unitypackage").flatMap((a) => a.paths);
  const archivePaths = assetPaths.filter((a) => a.container !== "unitypackage").flatMap((a) => a.paths);

  const input = {
    title: item.title, description: item.description, tags: detail.tags,
    fileNames: [...(extra.fileNames ?? []), ...detail.assets.map((a) => a.path.split("/").pop() ?? "")],
    archivePaths, unitypackagePaths: upkgPaths,
  };
  const result: AvatarDetectionResult = detectAvatars(input, known);
  const declared = result.declaredCount ?? parseDeclaredCount(`${item.title}\n${item.description ?? ""}`);
  repo.updateItem(itemId, { compat_declared_count: declared });

  const existing = repo.listItemAvatars(itemId);
  const protectedIds = new Set<number>(existing.filter((r: any) => r.source !== "auto").map((r: any) => r.avatar_id));

  const resolveAvatar = (name: string): number => {
    const av = repo.findAvatarByAlias(normKey(name));
    if (av) return av.id;
    const k = known.find((x) => normKey(x.name) === normKey(name));
    return repo.createAvatar({ name: k?.name ?? name, kind: k?.kind ?? "unknown" }).id;
  };

  let addedItem = 0;
  const itemAvatarIds = new Set<number>();
  for (const hit of result.hits) {
    if (hit.confidence < 0.5) continue;
    const avatarId = resolveAvatar(hit.name);
    itemAvatarIds.add(avatarId);
    if (protectedIds.has(avatarId)) continue;
    repo.setItemAvatars(itemId, [avatarId], "auto", "any", hit.confidence, JSON.stringify({ sources: hit.sources, evidence: hit.evidence }));
    addedItem++;
  }

  let addedAsset = 0;
  for (const a of assetPaths) {
    if (a.paths.length === 0) continue;
    for (const { name, prefix } of avatarNamesFromPaths(a.paths, known)) {
      const avatarId = resolveAvatar(name);
      const av = repo.getAvatar(avatarId);
      const conf = av && av.kind !== "unknown" ? 0.9 : 0.7;
      repo.setAssetAvatar(a.assetId, avatarId, prefix || null, conf, `path:${prefix || name}`);
      addedAsset++;
      if (!itemAvatarIds.has(avatarId) && !protectedIds.has(avatarId)) { repo.setItemAvatars(itemId, [avatarId], "auto", "any", conf); itemAvatarIds.add(avatarId); addedItem++; }
    }
  }
  void allPaths;
  return { hits: result.hits.map((h) => ({ name: h.name, confidence: h.confidence, sources: [...h.sources] })), declared, planned: result.planned, addedItem, addedAsset };
}
