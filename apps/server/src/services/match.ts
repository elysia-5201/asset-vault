import { normKey, type AvatarDetectionResult, type KnownAvatar } from "../../../../packages/core/src/contracts";
import { detectAvatars, avatarNamesFromPaths } from "../../../../packages/core/src/avatars/detect";
import { parseDeclaredCount } from "../../../../packages/core/src/avatars/normalize";
import type { Repo } from "../db/repo";

export interface MatchOutcome {
  hits: { name: string; confidence: number; sources: string[] }[];
  declared: number | null; planned: string[]; addedItem: number; addedAsset: number;
  /** 自动校准删掉的（以前 auto 加过、这次没证据的）适配模型数 */
  removedItem: number;
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

  /**
   * 自动校准：只要素材**内容**里确实认出了某些模型（包内路径 / 文件名 / unitypackage 路径证据），
   * 就说明这是「按 avatar 分包」的素材 —— 那么只在商品页标题/标签/描述里出现的模型，属于卖家写的
   * 「本商品支持的全部 base」（实测：一个只有 Shinano 变体的纹身，tags 里有 7 个 base），不算本条的适配。
   * 商品页口径仍保留在 compat_declared_count（声明适配）里，信息不丢。
   * 反过来：一个内容证据都没认出（插件/姿势/着色器等通用素材）时，商品页那批标签就是唯一信息，照旧全保留。
   */
  const FILE_SOURCES = new Set(["archive_path", "unitypackage_path", "filename"]);
  const strong = result.hits.filter((h) => h.confidence >= 0.5 && h.sources.some((s) => FILE_SOURCES.has(s)));
  const wantHits = strong.length ? strong : result.hits.filter((h) => h.confidence >= 0.5);

  let addedItem = 0;
  const itemAvatarIds = new Set<number>();
  for (const hit of wantHits) {
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
  // 自动校准的收尾：把之前由 auto 加进来、这次不该再有的删掉（人工加/确认过的受 protectedIds 保护，绝不删）
  let removedItem = 0;
  for (const r of existing as any[]) {
    if (r.source !== "auto") continue;
    if (itemAvatarIds.has(Number(r.avatar_id))) continue;
    repo.removeItemAvatar(itemId, Number(r.avatar_id));
    removedItem++;
  }

  void allPaths;
  return {
    hits: wantHits.map((h) => ({ name: h.name, confidence: h.confidence, sources: [...h.sources] })),
    declared, planned: result.planned, addedItem, addedAsset, removedItem,
  };
}
