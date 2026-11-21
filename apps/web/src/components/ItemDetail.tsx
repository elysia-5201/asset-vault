import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AvatarMatch, ItemAssetScanResult } from "@core/contracts";
import {
  addAsset, addImages, addItemAvatars, addItemTags, addToCollection, boothPeek, checkUpdate, createCollection, deleteImage, deleteItem, describeError,
  deleteCollection, getCollection, getItem, getItemDuplicates, getRelatedItems, linkBooth, listItems, matchAvatars, mediaUrl, mergeItems, patchItem, pruneItemAvatars, removeFromCollection, removeItemAvatar, reorderImages, restoreItem, setCover,
  type CollectionMember,
  itemUsage, scanItemFiles, scanProjectUsage,
  type EntryPreview,
} from "../api";
import type { AssetRow, AvatarCard, DuplicateFileDiff, DuplicateLevel, DuplicateMatch, ItemDetailWeb, ProjectRefUsage, RelatedMatch } from "../types";
import type { WorkbenchFocus } from "../workbench-focus";
import { formatBytes, formatDate, formatYen, shortenPath } from "../util";
import { ArchiveView } from "./ArchiveView";
import { MissingAssetActions } from "./MissingAssetActions";
import { MergePreview } from "./MergePreview";
import { VersionLinksSection } from "./VersionLinksSection";
import { AddToLoadoutButton } from "./AddToLoadoutButton";
import { RegisterAvatarSection } from "./RegisterAvatarSection";
import { BoothCorrectionSection } from "./BoothCorrectionSection";
import { CategoryEditor } from "./CategoryEditor";
import { Badge, Collapsible, EvidenceLine, MATCH_LABEL, Section, SITE_LABEL, STATUS_LABEL, Spinner } from "./ui";

export interface ProjectLite { id: number; name: string; path: string }

const orderKey = (id: number) => "av.imgorder." + id;

/** 「疑似重复」的 level 徽章文案 / 色调（契约：exact | same-content | near）。 */
const DUP_LEVEL_LABEL: Record<DuplicateLevel, string> = { exact: "完全相同", "same-content": "内容一致", near: "高度相似" };
const DUP_LEVEL_TONE: Record<DuplicateLevel, "bad" | "warn" | "muted"> = { exact: "bad", "same-content": "warn", near: "muted" };

/** 差异三组里的一组：最多铺 10 条，其余折成 "+N 更多"（避免大包差异把面板淹掉）。 */
function DiffGroup(props: { label: string; items: DuplicateFileDiff[] }) {
  if (!props.items.length) return null;
  const shown = props.items.slice(0, 10);
  return (
    <div>
      <div className="k">{props.label} {props.items.length}</div>
      {shown.map((x, i) => (
        <div className="dup-file" key={props.label + i + x.path} title={x.path}>
          <span className="p">{shortenPath(x.path, 64)}</span>
          <span className="sz">{formatBytes(x.size)}</span>
        </div>
      ))}
      {props.items.length > shown.length && <div className="hint">+{props.items.length - shown.length} 更多</div>}
    </div>
  );
}

function DetailDisclosure({ label, meta, children, onOpen }: {
  label: ReactNode; meta?: ReactNode; children: ReactNode; onOpen?: () => void;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="detail-disclosure" onToggle={(event) => {
      if (event.currentTarget.open && !opened) {
        setOpened(true);
        onOpen?.();
      }
    }}>
      <summary>
        {label}
        {meta != null && <span className="detail-disclosure-meta">{meta}</span>}
      </summary>
      {opened && <div className="detail-disclosure-body">{children}</div>}
    </details>
  );
}

function DetailFile({ asset, onToast }: {
  asset: AssetRow; onToast: (kind: "ok" | "bad" | "info", text: string) => void;
}) {
  const fileName = asset.path.split(/[\\/]/).filter(Boolean).at(-1) ?? asset.path;
  return (
    <DetailDisclosure
      label={<span className="detail-file-name" title={asset.path}>{fileName}</span>}
      meta={formatBytes(asset.size)}
    >
      <ArchiveView asset={asset} onToast={onToast} />
    </DetailDisclosure>
  );
}

export function ItemDetail(props: {
  itemId: number;
  hidden?: boolean;
  avatars: AvatarCard[];
  projects: ProjectLite[];
  onClose: () => void;
  onChanged: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  importedIds: number[];
  onMarkImported: (itemId: number, projectId: number) => void;
  /** 打开另一个条目的详情（「疑似重复」里点「打开 #id」用）。 */
  onOpenItem: (itemId: number) => void;
  /** 打开工作台并定位到本条素材。 */
  onOpenWorkbench?: (focus: WorkbenchFocus) => void;
  /**
   * 用户在头像轨显式选中的模型（恰好一个时才有值）。只用于「加入搭配清单」的显式目标，
   * 不从条目的适配模型自动推断；null = 未选/多选，按钮只提示。
   */
  selectedAvatarId?: number | null;
  /** 条目被登记为模型本体后，通知父刷新 avatars 列表（详情与 items 由本组件/onChanged 负责）。 */
  onAvatarRegistered?: () => void;
}) {
  const { itemId } = props;
  const [detail, setDetail] = useState<ItemDetailWeb | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const [notesSaving, setNotesSaving] = useState(false);
  const [imgUrl, setImgUrl] = useState("");
  const [imgPaths, setImgPaths] = useState("");
  const [assetPath, setAssetPath] = useState("");
  const [fileScanBusy, setFileScanBusy] = useState(false);
  const [fileScan, setFileScan] = useState<ItemAssetScanResult | null>(null);
  const [fileScanError, setFileScanError] = useState("");
  const [newTag, setNewTag] = useState("");
  const [boothUrl, setBoothUrl] = useState("");
  const [collName, setCollName] = useState("");
  const [mergeQ, setMergeQ] = useState("");
  const [mergeHits, setMergeHits] = useState<{ id: number; title: string }[]>([]);
  const [boothBusy, setBoothBusy] = useState(false);
  const [boothHint, setBoothHint] = useState("");
  const [mergePreview, setMergePreview] = useState<{ sourceId: number; targetId: number } | null>(null);
  const [localTags, setLocalTags] = useState<string[] | null>(null);
  const [localTagNote, setLocalTagNote] = useState(false);
  const [order, setOrder] = useState<number[] | null>(null);
  const [compatPick, setCompatPick] = useState<number | "">("");
  const [compatMatch, setCompatMatch] = useState<AvatarMatch>("any");
  const [busy, setBusy] = useState(false);
  const detailRequest = useRef(0);
  /** 只在商品页标题/标签/描述里出现过、素材内容里毫无痕迹的适配模型（可用「按包内证据校正」一键去掉）。 */
  const weakAvatars = useMemo(() => {
    const FILE_SOURCES = ["archive_path", "unitypackage_path", "filename"];
    return (detail?.avatars ?? []).filter((a) => {
      try {
        const j = JSON.parse(String(a.evidence ?? "")) as { sources?: unknown };
        const s = Array.isArray(j.sources) ? j.sources.map(String) : [];
        return s.length > 0 && !s.some((x) => FILE_SOURCES.includes(x));
      } catch { return false; }
    });
  }, [detail]);
  /** 这个条目在各工程里"真的被用到"的文件（GUID 求交；未扫描/旧后端 → 空数组，静默不报错） */
  const [usage, setUsage] = useState<ProjectRefUsage[] | null>(null);
  const [usageOpen, setUsageOpen] = useState<number | null>(null);
  const [usageBusy, setUsageBusy] = useState(0);
  /** 套装 id → 成员条目（用来一键"并到本条"） */
  const [collMembers, setCollMembers] = useState<Record<number, CollectionMember[]>>({});
  /**
   * 详情页「疑似重复」。后端端点还没上线 / 请求失败时一律静默（不打断主流程）；
   * 没有重复时整块不渲染，避免给正常素材加噪音。
   */
  const [dups, setDups] = useState<DuplicateMatch[]>([]);
  const [dupBusy, setDupBusy] = useState(false);
  const [dupOpen, setDupOpen] = useState<Set<number>>(new Set());
  /**
   * 详情页「疑似同商品」（模型包 / 材质包 / DLC 分开打包）—— **手动查**，不自动列。
   * 原因：自动列出非常容易误报（卖家把"支持的全部 base"打成一堆 tag，标签一相同就命中；
   * 实测一个条目的 8 条建议里 7 条是标签命中）。所以默认严格（min=0.75，只认"两侧标题共有产品名"），
   * 勾「更宽松」才降到 0.6（含标签命中）并给结果标「弱」。null = 还没查过。
   */
  const [related, setRelated] = useState<RelatedMatch[] | null>(null);
  const [relatedLoose, setRelatedLoose] = useState(false);
  const [relatedBusy, setRelatedBusy] = useState(false);

  const findRelated = useCallback((loose: boolean) => {
    setRelatedBusy(true);
    getRelatedItems(itemId, loose ? 0.6 : 0.75)
      .then((r) => setRelated(r.matches))
      .catch(() => setRelated([]))
      .finally(() => setRelatedBusy(false));
  }, [itemId]);

  /** 把某条「疑似同商品」与本条归入同一套装（保留各自条目）；套装名优先用输入框，其次共有产品名。 */
  const doRelateCollect = (m: RelatedMatch) => {
    const name = collName.trim() || m.shared[0] || m.title || detail?.title || "同商品";
    guard(createCollection(name, [m.itemId, itemId]), "已把 #" + m.itemId + " 与本条归入套装「" + name + "」");
  };

  /** 把某条「疑似同商品」并进本条（对方进回收站，可恢复）——与「合并到本条」同风格。 */
  const doRelateMerge = (m: RelatedMatch) => {
    if (busy) return;
    if (!window.confirm("把 #" + m.itemId + "「" + m.title + "」并入本条？\n它的压缩包/图片/标签/模型会归到本条，#" + m.itemId + " 进回收站（可恢复）。")) return;
    setBusy(true);
    mergeItems(m.itemId, itemId)
      .then(() => {
        props.onToast("ok", "已把 #" + m.itemId + " 并入本条");
        setRelated((prev) => (prev ?? []).filter((x) => x.itemId !== m.itemId));
        load();
        props.onChanged();
      })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBusy(false));
  };

  const load = useCallback(() => {
    const request = ++detailRequest.current;
    setErr("");
    getItem(itemId)
      .then((result) => {
        if (detailRequest.current !== request) return;
        setDetail(result);
        setLocalTags(null);
      })
      .catch((error) => { if (detailRequest.current === request) setErr(describeError(error)); })
      .finally(() => { if (detailRequest.current === request) setLoading(false); });
  }, [itemId]);

  useEffect(() => {
    load();
    return () => { detailRequest.current++; };
  }, [load]);

  const scanFiles = async () => {
    setFileScanBusy(true);
    setFileScan(null);
    setFileScanError("");
    try {
      const result = await scanItemFiles(itemId);
      setFileScan(result);
      load();
      if (result.files.some((file) => file.changed)) props.onChanged();
    } catch (error) {
      setFileScanError(describeError(error));
    } finally {
      setFileScanBusy(false);
    }
  };

  /** 拉一次本条的疑似重复；失败静默（空列表）。 */
  const loadDups = useCallback(() => {
    setDupBusy(true);
    getItemDuplicates(itemId)
      .then((r) => setDups(r.matches))
      .catch(() => setDups([]))
      .finally(() => setDupBusy(false));
  }, [itemId]);
  useEffect(() => { setDups([]); setDupOpen(new Set()); loadDups(); }, [itemId, loadDups]);

  const toggleDup = (assetId: number) => setDupOpen((prev) => {
    const n = new Set(prev);
    if (n.has(assetId)) n.delete(assetId); else n.add(assetId);
    return n;
  });

  /** 把某个疑似重复的条目并进本条（对方进回收站，可恢复）。 */
  const doMergeDuplicate = (m: DuplicateMatch) => {
    if (busy) return;
    if (!window.confirm("把 #" + m.otherItemId + "「" + m.otherTitle + "」合并到本条？\n它的压缩包/图片/标签/模型会归到本条，#" + m.otherItemId + " 进回收站（可恢复）。")) return;
    setBusy(true);
    mergeItems(m.otherItemId, itemId)
      .then(() => {
        props.onToast("ok", "已把 #" + m.otherItemId + " 并入本条");
        load();
        loadDups();
        props.onChanged();
      })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    try {
      const raw = localStorage.getItem(orderKey(itemId));
      if (raw) setOrder(JSON.parse(raw) as number[]);
    } catch { setOrder(null); }
  }, [itemId]);

  const images = useMemo(() => {
    const list = detail ? [...detail.images] : [];
    list.sort((a, b) => a.position - b.position);
    if (order) {
      const rank = new Map(order.map((id, i) => [id, i]));
      list.sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));
    }
    return list;
  }, [detail, order]);

  const guard = (p: Promise<unknown>, okText: string) => {
    setBusy(true);
    p.then(() => { props.onToast("ok", okText); load(); props.onChanged(); })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBusy(false));
  };

  const moveImage = (id: number, delta: number) => {
    const ids = images.map((i) => i.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids];
    const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
    setOrder(next); // 乐观显示
    setBusy(true);
    reorderImages(itemId, next)
      .then(() => {
        try { localStorage.removeItem(orderKey(itemId)); } catch { /* 忽略 */ }
        setOrder(null);
        load();
        props.onToast("ok", "缩略图顺序已写入服务端（POST /items/:id/images/reorder）");
      })
      .catch((e) => {
        try { localStorage.setItem(orderKey(itemId), JSON.stringify(next)); } catch { /* 存储满则仅会话内生效 */ }
        props.onToast("bad", "重排未落库，顺序仅本机生效：" + describeError(e));
      })
      .finally(() => setBusy(false));
  };

  /** 一键校正：去掉"只有商品页证据"的适配模型（保留有包内路径/文件名证据的）。 */
  const doPruneAvatars = () => {
    if (!weakAvatars.length) { props.onToast("info", "这个条目没有「只有商品页证据」的适配模型"); return; }
    const names = weakAvatars.map((a) => "@" + a.name).join("、");
    if (!window.confirm("只保留素材内容里真的有痕迹的适配模型？\n\n将移除：" + names + "\n（它们只在商品页的标题/标签/描述里出现过，压缩包/包内路径里没有任何对应文件）")) return;
    setBusy(true);
    pruneItemAvatars(itemId)
      .then((r) => {
        props.onToast("ok", r.removed.length ? "已移除 " + r.removed.length + " 个仅声明的适配模型：" + r.removed.map((x) => "@" + x.name).join("、") + "（保留 " + r.kept.join("、") + "）" : (r.note ?? "没有可校正的"));
        load();
        props.onChanged();
      })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBusy(false));
  };

  const saveNotes = () => {
    if (!detail) return;
    setNotesSaving(true);
    patchItem(itemId, { notes })
      .then(() => {
        setDetail((current) => current ? { ...current, notes, item: { ...current.item, notes } } : current);
        setNotesDraft((current) => current === notes ? null : current);
        props.onToast("ok", "备注已保存");
        props.onChanged();
      })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setNotesSaving(false));
  };

  /** 追加：优先 POST /items/:id/tags；删除：PATCH 全量替换（api.md v1.1）。都失败才本地生效。 */
  const applyTags = (next: string[], mode: "add" | "remove") => {
    const prev = tags;
    setLocalTags(next);
    setLocalTagNote(false);
    const req = mode === "add"
      ? addItemTags(itemId, next.filter((t) => !prev.includes(t)))
      : patchItem(itemId, { tags: next });
    req
      .then(() => { setLocalTags(null); load(); props.onChanged(); props.onToast("ok", mode === "add" ? "标签已追加（POST /items/:id/tags）" : "标签已更新（PATCH /items/:id {tags}）"); })
      .catch((e) => {
        setLocalTagNote(true);
        props.onToast("bad", "服务端未接受标签改动，已仅本机生效：" + describeError(e));
      });
  };

  /** 「关联 BOOTH 商品」：把商品页的标题/店铺/价格/分类/标签 + 图集灌进当前条目；已关联的条目重跑即"补全"。 */
  const runBoothLink = (url: string, okText: (r: any) => string) => {
    const u = url.trim();
    if (!u || boothBusy) return;
    setBoothBusy(true); setBoothHint("");
    linkBooth(itemId, u, false)
      .then((res: any) => { props.onToast("ok", okText(res)); setBoothUrl(""); load(); props.onChanged(); })
      .catch((e) => props.onToast("bad", describeError(e)))
      .finally(() => setBoothBusy(false));
  };

  /**
   * 拉这个条目的"实际引用"（工程里真的在用哪些文件）。
   * 接口 404/失败一律静默：旧后端没有 /items/:id/usage，不能因此弹错或崩。
   */
  const loadUsage = useCallback(() => {
    itemUsage(itemId)
      .then((r) => setUsage(r.projects))
      .catch(() => setUsage((prev) => prev ?? []));
  }, [itemId]);

  /** 扫某个工程的引用（会写 project_refs、可能跑几十秒），完成后刷新本条的 usage。 */
  const doScanUsage = (p: ProjectLite) => {
    if (usageBusy) return;
    setUsageBusy(p.id);
    scanProjectUsage(p.id)
      .then((r) => {
        props.onToast("ok", "「" + p.name + "」扫到 " + r.scannedFiles + " 个文件 / " + r.guidCount + " 个 GUID：命中 "
          + r.matchedItems + " 个素材（" + r.matchedGuids + " 个 GUID / " + r.matchedAssets + " 个资产）"
          + (r.remaining ? "；预算用尽还有资产没查完，可再扫一次" : "；已扫完"));
        loadUsage();
      })
      .catch((e) => props.onToast("bad", "扫描工程引用失败：" + describeError(e)))
      .finally(() => setUsageBusy(0));
  };

  /** 套装成员（用于"把套装里的其他条目并到本条"）；套装 id 变了才重拉。 */
  const collIds = (detail?.collections ?? []).map((c) => c.id).join(",");
  useEffect(() => {
    const ids = (detail?.collections ?? []).map((c) => c.id);
    if (!ids.length) { setCollMembers({}); return; }
    let alive = true;
    Promise.all(ids.map((id) => getCollection(id).catch(() => null))).then((rs) => {
      if (!alive) return;
      const next: Record<number, CollectionMember[]> = {};
      rs.forEach((r, i) => { const id = ids[i]; if (r && id !== undefined) next[id] = r.items; });
      setCollMembers(next);
    });
    return () => { alive = false; };
  }, [collIds]);

  const backdropProps = { className: "backdrop item-detail-backdrop", hidden: props.hidden };
  if (loading) return <div {...backdropProps}><div className="drawer"><div className="empty"><Spinner /> 载入条目 #{itemId}…</div></div></div>;
  if (!detail) return (
    <div {...backdropProps} onClick={props.onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>条目 #{itemId}</h3><button className="btn" onClick={props.onClose}>关闭</button></div>
        <div className="pane-body"><div className="err">{err || "无数据"}</div></div>
      </div>
    </div>
  );

  const it = detail.item;
  /** 已有 BOOTH 商品链接 → 该按钮直接重跑抓取（补全元数据/图集）；否则只引导到粘贴框。 */
  const boothUrlFromItem = it.source_site === "booth" && it.source_url ? it.source_url : "";
  const tags = localTags ?? detail.tags ?? [];
  const imported = props.importedIds.includes(itemId);
  const cover = images.find((image) => image.id === detail.coverImageId) ?? images[0];
  const coverUrl = detail.coverUrl ?? (cover ? cover.thumbUrl ?? mediaUrl(cover.id, 240) : null);
  const category = [detail.category?.categoryName, detail.category?.subCategoryName].filter(Boolean).join(" › ");
  const sourceName = [SITE_LABEL[it.source_site], it.source_item_id].filter(Boolean).join(" ");
  const notes = notesDraft ?? detail.notes ?? "";
  const visibleFiles = 4;
  const availableFiles = detail.assets.filter((asset) => asset.status === "present");
  const missingFiles = detail.assets.filter((asset) => asset.status === "missing");
  const unavailable = fileScan?.files.filter((file) => file.state === "unavailable") ?? [];

  return (
    <div {...backdropProps} onClick={props.onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head item-detail-head">
          <h3 title={detail.title}>{detail.title}</h3>
          <Badge tone={detail.status === "inbox" ? "warn" : "muted"}>{STATUS_LABEL[detail.status]}</Badge>
          {imported && <Badge tone="ok">已导入</Badge>}
          {busy && <Spinner />}
          <button className="btn" onClick={props.onClose}>关闭</button>
        </div>
        <div className="item-detail-body">
          {err && <div className="err" role="status">刷新失败：{err}</div>}
          <div className="item-detail-overview">
            <div className="item-detail-cover">
              {coverUrl ? <img src={coverUrl} alt="素材封面" /> : <span>暂无封面</span>}
            </div>
            <dl className="item-detail-facts">
              <div>
                <dt>来源</dt>
                <dd>
                  {it.source_url ? <a href={it.source_url} target="_blank" rel="noreferrer">{sourceName}</a> : sourceName}
                  {it.shop_name && <> · {it.shop_name}</>}
                </dd>
              </div>
              <div><dt>分类</dt><dd>{category || "未分类"}</dd></div>
              <div>
                <dt>适配模型</dt>
                <dd>
                  {detail.avatars.length ? detail.avatars.slice(0, 3).map((avatar) => avatar.name).join("、") : "未标注"}
                  {detail.avatars.length > 3 && <span className="hint"> · 另有 {detail.avatars.length - 3} 个</span>}
                </dd>
              </div>
            </dl>
          </div>

          <Section title={"本地文件 " + availableFiles.length} right={detail.assets.length > 0 && detail.status !== "trashed" ? (
            <>
              <span className="hint">{formatBytes(availableFiles.reduce((total, file) => total + file.size, 0))}</span>
              <button className="btn tiny" disabled={fileScanBusy} onClick={() => void scanFiles()}>
                {fileScanBusy ? "扫描中…" : "扫描本条"}
              </button>
            </>
          ) : undefined}>
            <div className="item-detail-file-list">
              {fileScanError && <div className="err" role="alert">扫描失败：{fileScanError}</div>}
              {fileScan && (
                <div className="hint" role="status">
                  已检查 {fileScan.files.length} 个路径 · {fileScan.files.filter((file) => file.state === "missing").length} 个缺失
                  {unavailable.length > 0 && <> · {unavailable.length} 个无法确认</>}
                </div>
              )}
              {unavailable.length > 0 && (
                <DetailDisclosure label="无法确认的路径" meta={unavailable.length}>
                  {unavailable.map((file) => <div key={file.assetId}><span className="mono">{file.path}</span> · {file.reason}</div>)}
                </DetailDisclosure>
              )}
              {availableFiles.slice(0, visibleFiles).map((asset) => <DetailFile key={asset.id} asset={asset} onToast={props.onToast} />)}
              {!availableFiles.length && <span className="hint">暂无可用本地文件</span>}
              {availableFiles.length > visibleFiles && (
                <DetailDisclosure label={"其余 " + (availableFiles.length - visibleFiles) + " 个文件"}>
                  <div className="item-detail-file-list">
                    {availableFiles.slice(visibleFiles).map((asset) => <DetailFile key={asset.id} asset={asset} onToast={props.onToast} />)}
                  </div>
                </DetailDisclosure>
              )}
              {missingFiles.length > 0 && (
                <DetailDisclosure label="缺失记录" meta={missingFiles.length}>
                  {missingFiles.map((asset) => (
                    <div className="missing-asset-row" key={asset.id}>
                      <div className="mono missing-asset-path">{asset.path}</div>
                      {detail.status !== "trashed" && <MissingAssetActions asset={asset} onToast={props.onToast}
                        onChanged={() => { setFileScan(null); load(); props.onChanged(); }} />}
                    </div>
                  ))}
                </DetailDisclosure>
              )}
            </div>
          </Section>

          <div className="item-detail-panels">
            {props.onOpenWorkbench && detail.status !== "trashed" && (
              <button className="btn primary item-detail-import" onClick={() => props.onOpenWorkbench?.({
                itemId, title: detail.title, assetIds: [], units: [],
              })}>导入到 Unity</button>
            )}
            <DetailDisclosure label="工程使用记录" onOpen={loadUsage}>
              <Section title="已登记的工程">
                <div className="row wrap">
                  {props.projects.map((p) => {
                    const u = usage ? usage.find((x) => x.projectId === p.id) ?? null : null;
                    return (
                      <span key={p.id} className="row" style={{ gap: "4px", alignItems: "center" }}>
                        <button className="btn tiny" onClick={() => props.onMarkImported(itemId, p.id)} title={p.path}>仅登记：已导入 → {p.name}</button>
                        {u && u.files > 0 ? (
                          <button
                            className="btn tiny"
                            onClick={() => setUsageOpen(usageOpen === p.id ? null : p.id)}
                            title={"工程里真的在用（GUID 求交命中 " + u.files + " 个文件）：" + u.paths.slice(0, 10).join(" / ")}
                          >项目里真的在用：{u.name || p.name}（{u.files} 个文件）</button>
                        ) : usage ? (
                          <span className="hint">未扫描</span>
                        ) : null}
                        <button className="btn tiny" disabled={usageBusy !== 0} onClick={() => doScanUsage(p)}>
                          {usageBusy === p.id ? "扫描中…（最多 45s）" : "扫描工程引用"}
                        </button>
                      </span>
                    );
                  })}
                  {!props.projects.length && <span className="hint">无已登记工程</span>}
                </div>
                {usageOpen !== null && (() => {
                  const u = usage ? usage.find((x) => x.projectId === usageOpen) : null;
                  if (!u || !u.paths.length) return null;
                  return (
                    <div className="hint mono" style={{ marginTop: "4px", wordBreak: "break-all", fontSize: "10px" }}>
                      {u.name || "#" + u.projectId} 实际引用（前 {Math.min(5, u.paths.length)}/{u.files}）：{u.paths.slice(0, 5).join(" ｜ ")}
                    </div>
                  );
                })()}
                <div className="hint" style={{ marginTop: "4px" }}>已导入登记只更新素材库记录。扫描引用可核对工程实际使用的文件。</div>
              </Section>
            </DetailDisclosure>
            {detail.description && (
              <DetailDisclosure label="商品说明">
                <div className="item-detail-description">{detail.description}</div>
              </DetailDisclosure>
            )}
            <DetailDisclosure label="素材管理">
              <div className="item-detail-manage">
                <DetailDisclosure label="图片与封面" meta={images.length ? images.length + " 张" : undefined}>
                  <Section
                    title="图片与封面"
                    right={order ? <span className="hint">使用本地排序</span> : undefined}
                  >
                    <div className="img-grid">
                      {images.map((im, i) => (
                        <div className={"img-cell" + (detail.coverImageId === im.id ? " cover" : "")} key={im.id}>
                          <img src={im.thumbUrl ?? mediaUrl(im.id, 240)} alt={im.role} loading="lazy" />
                          <div className="tags">
                            {detail.coverImageId === im.id && <Badge tone="ok">封面</Badge>}
                            <Badge tone="muted">{im.role}</Badge>
                          </div>
                          <div className="ops">
                            <button className="btn tiny" disabled={i === 0} onClick={() => moveImage(im.id, -1)} title="本地前移">↑</button>
                            <button className="btn tiny" disabled={i === images.length - 1} onClick={() => moveImage(im.id, 1)} title="本地后移">↓</button>
                            <button className="btn tiny" onClick={() => guard(setCover(itemId, im.id), "已设为封面")}>封面</button>
                            <button className="btn tiny danger" onClick={() => guard(deleteImage(itemId, im.id), "已删除图片")}>删</button>
                          </div>
                        </div>
                      ))}
                      {!images.length && <div className="hint">暂无图片</div>}
                    </div>
                    <div className="hr" />
                    <label className="hint">加图片 URL（新导入的第一张会设为封面）</label>
                    <div className="row">
                      <input type="url" placeholder="https://booth.pximg.net/…" value={imgUrl} onChange={(e) => setImgUrl(e.target.value)} />
                      <button className="btn" disabled={!imgUrl.trim()} onClick={() => { guard(addImages(itemId, { url: imgUrl.trim(), origin: "user", role: "user" }), "已添加 URL 图片"); setImgUrl(""); }}>加图</button>
                    </div>
                    <label className="hint" style={{ display: "block", marginTop: "6px" }}>加本地图片路径（每行一个）</label>
                    <textarea rows={2} placeholder="%LIBRARY%/素材库/1/extra.png" value={imgPaths} onChange={(e) => setImgPaths(e.target.value)} />
                    <div className="row">
                      <span className="spacer" />
                      <button className="btn" disabled={!imgPaths.trim()} onClick={() => { guard(addImages(itemId, { paths: imgPaths.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean), origin: "user", role: "user" }), "已添加本地图片"); setImgPaths(""); }}>添加</button>
                    </div>
                  </Section>
                </DetailDisclosure>
                <DetailDisclosure label="适配模型">
                  <Section
                    title={<>适配模型 {detail.avatars.length}</>}
                    right={weakAvatars.length > 0 ? (
                      <button
                        className="btn tiny"
                        disabled={busy}
                        title={"移除只在商品页标题/标签/描述里出现过的适配模型：" + weakAvatars.map((a) => "@" + a.name).join("、") + "\n注意：若是「全アバター対応 / N アバター対応」的工具类素材，这些标签本身是有意义的，别删。"}
                        onClick={doPruneAvatars}
                      >按包内证据校正（去 {weakAvatars.length} 个）</button>
                    ) : undefined}
                  >
                    <div className="row wrap" style={{ marginBottom: "6px" }}>
                      {detail.avatars.map((a) => (
                        <span className="tag-chip" key={a.id} title={a.evidence ?? "无证据字段"}>
                          @{a.name} · {MATCH_LABEL[a.match]}{a.confidence !== undefined && a.confidence !== null ? " · " + a.confidence.toFixed(2) : ""}
                          <button onClick={() => guard(removeItemAvatar(itemId, a.id), "已移除适配模型 @" + a.name)} title="移除">×</button>
                        </span>
                      ))}
                      {!detail.avatars.length && <span className="hint">未标注适配模型</span>}
                    </div>
                    {/* 模型多的时候这一列会很长：默认收起，只占一行。 */}
                    <Collapsible label="适配证据" count={detail.avatars.length}>
                      <div className="asset-list">
                        {detail.avatars.map((a) => (
                          <EvidenceLine key={"ev" + a.id} name={a.name} source={a.source} evidence={a.evidence} confidence={a.confidence} />
                        ))}
                        {!detail.avatars.length && <div className="hint">没有证据行（先跑「重跑头像匹配」）</div>}
                      </div>
                    </Collapsible>
                    {weakAvatars.length > 0 && (
                      <div className="notice" style={{ marginTop: "6px" }}>
                        {weakAvatars.length} 个适配模型（{weakAvatars.map((a) => "@" + a.name).join("、")}）只有商品页证据 —— 标题/标签/描述里有，
                        但压缩包和包内路径里没有任何对应文件。多 avatar 商品里你只下了某一个变体时，这就是假适配，可点右上「按包内证据校正」删掉；
                        <b>但「全アバター対応 / N アバター対応」的工具类素材（插件、姿势、着色器）本来就该匹配一大堆</b>，那种别删。
                      </div>
                    )}
                    {/* 加入搭配清单（spec §7.1）：模型由父传入的显式选择，未选只提示、不推断。 */}
                    <div className="row wrap" style={{ marginTop: "7px" }}>
                      <AddToLoadoutButton
                        itemId={itemId}
                        avatarId={props.selectedAvatarId ?? null}
                        onToast={props.onToast}
                        onAdded={() => props.onChanged()}
                      />
                    </div>
                    {/* 设为模型本体（SALT 首次确认）：显式入口，点开才展开表单；不自动建档、不猜名称。 */}
                    <div className="hint" style={{ marginTop: "7px" }}>
                      设为模型本体时，可先确认模型名称和别名。
                    </div>
                    <RegisterAvatarSection
                      itemId={itemId}
                      onToast={props.onToast}
                      onRegistered={() => { load(); props.onChanged(); props.onAvatarRegistered?.(); }}
                    />
                    <div className="row" style={{ marginTop: "7px" }}>
                      <select value={compatPick} onChange={(e) => setCompatPick(e.target.value ? Number(e.target.value) : "")}>
                        <option value="">选择头像…</option>
                        {props.avatars.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                      <select value={compatMatch} onChange={(e) => setCompatMatch(e.target.value as AvatarMatch)} style={{ width: "90px" }}>
                        <option value="any">any</option>
                        <option value="all">all</option>
                        <option value="exclude">exclude</option>
                      </select>
                      <button
                        className="btn"
                        disabled={compatPick === ""}
                        onClick={() => { if (compatPick !== "") guard(addItemAvatars(itemId, [compatPick], compatMatch), "已标注适配模型"); }}
                      >添加</button>
                    </div>
                  </Section>
                </DetailDisclosure>
                <DetailDisclosure label="分类与标签">
                  <Section title="标签">
                    <div className="row wrap">
                      {tags.map((t) => (
                        <span className="tag-chip" key={t}>{t}<button onClick={() => applyTags(tags.filter((x) => x !== t), "remove")} title="移除标签">×</button></span>
                      ))}
                      {!tags.length && <span className="hint">无标签</span>}
                    </div>
                    <div className="row" style={{ marginTop: "6px" }}>
                      <input type="text" placeholder="新增标签名" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
                      <button className="btn" disabled={!newTag.trim()} onClick={() => { applyTags([...tags, newTag.trim()], "add"); setNewTag(""); }}>加标签</button>
                    </div>
                    {localTagNote && <div className="notice" style={{ marginTop: "6px" }}>该后端未接受标签改动（POST /items/:id/tags 与 PATCH tags 均失败），改动仅本机生效。</div>}
                  </Section>

                  {/* 物品分类编辑区（docs/categories.md §7）。注意：下面「元数据」里的「分类」是 BOOTH 来源分类，两者不是一回事。 */}
                  <CategoryEditor detail={detail} onToast={props.onToast} onBusy={setBusy} onSaved={() => { load(); props.onChanged(); }} />
                </DetailDisclosure>
                <DetailDisclosure label="备注">
                  <Section title="备注" right={<button className="btn tiny" disabled={notesSaving} onClick={saveNotes}>保存</button>}>
                    <textarea rows={4} value={notes} onChange={(e) => setNotesDraft(e.target.value)} placeholder="填写备注…" aria-label="备注" />
                  </Section>
                </DetailDisclosure>
                <DetailDisclosure label="套装与合并">
                  <Section title="套装与合并">
                    <div className="row wrap" style={{ gap: "6px", alignItems: "center" }}>
                      {(detail.collections ?? []).length === 0 && <span className="hint">未归入任何套装</span>}
                      {(detail.collections ?? []).map((c) => (
                        <span key={c.id} className="row" style={{ gap: "2px", alignItems: "center" }}>
                          <Badge tone="violet">{c.name}</Badge>
                          <button className="btn tiny" title="把本条移出这个套装" onClick={() => guard(removeFromCollection(c.id, itemId), "已移出套装")}>×</button>
                          <button className="btn tiny danger" title="删除整个套装（只删分组，不动条目本身）" onClick={() => { if (window.confirm("删除套装「" + c.name + "」？\n只删这个分组，条目本身不受影响。")) guard(deleteCollection(c.id), "已删除套装「" + c.name + "」"); }}>🗑</button>
                        </span>
                      ))}
                    </div>
                    {/* 疑似同商品：**手动触发**。自动列出太容易误报（标签命中），所以默认严格、按需查。
                        同商品 ≠ 重复内容：这里只提示，归组（加入套装）或并入由用户点按钮决定。 */}
                    <div className="row wrap" style={{ gap: "6px", alignItems: "center", marginTop: "4px" }}>
                      <button
                        className="btn tiny"
                        disabled={relatedBusy}
                        title="按标题 / 包内文件名里的产品名找「同一商品的不同打包」（模型包 + 材质包 / DLC）"
                        onClick={() => findRelated(relatedLoose)}
                      >{relatedBusy ? "查找中…" : related === null ? "🔍 查找同商品" : "🔍 重新查找"}</button>
                      <label className="row" style={{ gap: "4px", alignItems: "center", cursor: "pointer" }} title="连「只在标签里出现过」的也一起列出来——这类很容易误报（卖家常把支持的全部 base 打上标签）">
                        <input
                          type="checkbox"
                          checked={relatedLoose}
                          onChange={(e) => { const v = e.target.checked; setRelatedLoose(v); if (related !== null) findRelated(v); }}
                        />
                        <span className="hint">更宽松（含标签命中，易误报）</span>
                      </label>
                      {related !== null && !relatedBusy && (
                        <span className="hint">{related.length ? "找到 " + related.length + " 条" : "严格模式下没找到；可勾「更宽松」再试"}</span>
                      )}
                    </div>
                    {related !== null && related.length > 0 && (
                      <div style={{ marginTop: "4px" }}>
                        {related.map((m) => (
                          <div key={m.itemId} className="row wrap" style={{ gap: "6px", alignItems: "center", marginTop: "2px" }}>
                            {m.score < 0.75 && <span className="badge warn" title={"相似度 " + (m.score * 100).toFixed(0) + "%"}>弱</span>}
                            <span className="hint">疑似同商品（模型包 / 材质包）：《#{m.itemId} {m.title}》 共有「{m.shared[0] ?? m.reason}」</span>
                            <button className="btn tiny" disabled={busy} title={"把 #" + m.itemId + " 与本条归入同一个套装（保留各自条目）"} onClick={() => doRelateCollect(m)}>加入套装</button>
                            <button className="btn tiny" disabled={busy} title={"把 #" + m.itemId + " 并进本条（对方进回收站，可恢复）"} onClick={() => doRelateMerge(m)}>并入本条</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* 套装只是归组：成员仍是各自独立的条目。这里直接把同套装的其它条目并进来（可恢复）。 */}
                    {(detail.collections ?? []).map((c) => {
                      const others = (collMembers[c.id] ?? []).filter((m) => m.id !== itemId && m.status !== "trashed");
                      if (!others.length) return null;
                      return (
                        <div key={"m" + c.id} className="row wrap" style={{ gap: "4px", alignItems: "center", marginTop: "4px" }}>
                          <span className="hint">{c.name} 里还有：</span>
                          {others.map((m) => (
                            <button
                              key={m.id}
                              className="btn tiny"
                              disabled={busy}
                              title={"把 #" + m.id + "「" + m.title + "」合并到本条（它的压缩包/标签/模型并过来；图片保留在原条目，它进回收站、可恢复）"}
                              onClick={() => setMergePreview({ sourceId: m.id, targetId: itemId })}
                            >#{m.id} {m.title.slice(0, 20)} ⤵并入</button>
                          ))}
                        </div>
                      );
                    })}
                    <div className="row" style={{ marginTop: "6px" }}>
                      <input placeholder="套装名（如 Danzai Bunny）" value={collName} onChange={(e) => setCollName(e.target.value)} style={{ flex: 1 }} />
                      <button className="btn tiny" disabled={!collName.trim() || busy} onClick={() => guard(createCollection(collName.trim(), [itemId]), "已加入套装「" + collName.trim() + "」")}>加入套装</button>
                    </div>
                    <div className="hint">套装 = 保留各自条目、只做归组（适合"模型包 + 材质包"分别售卖的情况）。</div>
                    <div className="hr" />
                    <label className="hint">
                      合并到另一条目（方向：<b>本条 → 目标</b>，单向；搜索只查其他条目、不含本条。合并后本条进回收站——
                      「恢复」只恢复条目状态，已并过去的压缩包/标签/模型不会自动迁回；图片保留在原条目）
                    </label>
                    <div className="row">
                      <input placeholder="搜索目标条目标题…" value={mergeQ} onChange={(e) => { setMergeQ(e.target.value); const q = e.target.value.trim(); if (q.length >= 2) listItems({ q, limit: 6 }).then((r) => setMergeHits(r.items.filter((x) => x.id !== itemId).map((x) => ({ id: x.id, title: x.title })))).catch(() => setMergeHits([])); else setMergeHits([]); }} style={{ flex: 1 }} />
                    </div>
                    {mergeQ.trim().length >= 2 && mergeHits.length === 0 && (
                      <div className="hint">没有匹配的条目（搜索只含其他条目，不含本条；本页没有反向搜索）</div>
                    )}
                    {mergeHits.length > 0 && (
                      <div className="row wrap" style={{ gap: "4px", marginTop: "4px" }}>
                        {mergeHits.map((h) => (
                          <button key={h.id} className="btn tiny" onClick={() => setMergePreview({ sourceId: itemId, targetId: h.id })}>#{h.id} {h.title.slice(0, 24)}</button>
                        ))}
                      </div>
                    )}
                  </Section>
                </DetailDisclosure>
                <DetailDisclosure label="版本关系">
                  {/* 版本关系（spec §8.2）：只对已登记资产建候选，人工确认；不自动 proven。 */}
                  <VersionLinksSection itemId={itemId} onToast={props.onToast} onChanged={() => { load(); props.onChanged(); }} />
                </DetailDisclosure>
                <DetailDisclosure label="挂接文件">
                  <div className="row">
                    <input type="text" aria-label="本地文件或目录路径" placeholder="本地文件或目录路径" value={assetPath} onChange={(e) => setAssetPath(e.target.value)} />
                    <button className="btn" disabled={!assetPath.trim()} onClick={() => { guard(addAsset(itemId, assetPath.trim()), "已挂接资产"); setAssetPath(""); }}>挂接</button>
                  </div>
                </DetailDisclosure>
                <DetailDisclosure label="来源与条目操作">
                  <div className="row wrap item-detail-actions">
                    <button className="btn tiny" onClick={() => guard(checkUpdate(itemId), "已开始检查更新")}>检查更新</button>
                    <button className="btn tiny" onClick={() => guard(matchAvatars(itemId), "已开始匹配头像")}>重跑头像匹配</button>
                    {detail.status === "trashed"
                      ? <button className="btn tiny" title="只恢复条目状态；合并时已迁到别处的压缩包/图片/标签/模型不会自动迁回" onClick={() => guard(restoreItem(itemId), "已从回收站恢复（资源不自动迁回）")}>恢复</button>
                      : <button className="btn tiny danger" onClick={() => guard(deleteItem(itemId), "已移到回收站")}>删除</button>}
                  </div>
                  <Section title="元数据">
                    <table className="kv">
                      <tbody>
                        <tr><td className="k">id / uid</td><td className="mono">{it.id} · {it.uid}</td></tr>
                        <tr>
                          <td className="k">来源</td>
                          <td>
                            {it.source_url
                              ? <a href={it.source_url} target="_blank" rel="noreferrer" title={"在浏览器打开来源页：" + it.source_url}>{SITE_LABEL[it.source_site]} {it.source_item_id ?? ""}</a>
                              : <span>{SITE_LABEL[it.source_site]}{it.source_item_id ? " " + it.source_item_id : ""}</span>}
                            {boothUrlFromItem && (
                              <>
                                {" "}
                                <button className="btn tiny" disabled={boothBusy}
                                  onClick={() => runBoothLink(boothUrlFromItem, (res) => "已补全 BOOTH 元数据，新增 " + (res?.images ?? 0) + " 张图")}
                                >补全 BOOTH</button>
                                <BoothCorrectionSection
                                  itemId={itemId}
                                  reload={load}
                                  onChanged={props.onChanged}
                                  onToast={props.onToast}
                                />
                              </>
                            )}
                          </td>
                        </tr>
                        <tr><td className="k">店铺/作者</td><td>{it.shop_name ?? "—"} / {it.author ?? "—"}</td></tr>
                        <tr><td className="k">来源分类</td><td>{it.category_parent ? it.category_parent + " › " : ""}{it.category_name ?? "—"}</td></tr>
                        <tr><td className="k">价格</td><td>{formatYen(it.price_yen, it.price_text)} {it.purchased ? "· 已购入" : ""}</td></tr>
                        <tr><td className="k">声明适配</td><td>{it.compat_declared_count ?? "—"} 体</td></tr>
                        <tr><td className="k">识别</td><td>{it.id_match_method ?? "—"} · conf {it.id_confidence ?? "—"}</td></tr>
                        <tr><td className="k">发布时间</td><td>{formatDate(it.published_at)}</td></tr>
                        <tr><td className="k">更新时间</td><td>{formatDate(it.updated_at)}</td></tr>
                        <tr><td className="k">体积</td><td>{formatBytes(detail.totalBytes)}</td></tr>
                      </tbody>
                    </table>
                  </Section>
                  {!boothUrlFromItem && (
                    <Section title="关联 BOOTH 商品">
                      <div className="row">
                        <input
                          type="url"
                          placeholder="https://booth.pm/zh-cn/items/6747912"
                          value={boothUrl}
                          onChange={(e) => setBoothUrl(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button
                          className="btn tiny"
                          disabled={!boothUrl.trim() || boothBusy}
                          onClick={async () => {
                            setBoothBusy(true); setBoothHint("");
                            try {
                              const p: any = await boothPeek(boothUrl.trim());
                              setBoothHint("预览：" + String(p.title ?? "").slice(0, 40) + " · " + (p.images?.length ?? 0) + " 张图 · " + ((p.files?.length ?? 0)) + " 个文件");
                            } catch (e) { setBoothHint("预览失败：" + describeError(e)); }
                            finally { setBoothBusy(false); }
                          }}
                        >预览</button>
                        <button
                          className="btn"
                          disabled={!boothUrl.trim() || boothBusy}
                          onClick={() => runBoothLink(boothUrl, (r) => {
                            const s = r?.imageStats;
                            if (!s) return "已关联 BOOTH " + (r?.meta?.itemId ?? "") + "，抓取 " + (r?.images ?? 0) + " 张图";
                            return "已关联 BOOTH " + (r?.meta?.itemId ?? "") + "：下载成功 " + s.downloaded + " / 新增 " + s.added + " / 复用 " + s.reused + " / 内容重复 " + s.duplicates + " / 失败 " + s.failed;
                          })}
                        >抓取</button>
                        {boothBusy && <Spinner />}
                      </div>
                      {boothHint && <div className="notice" style={{ marginTop: "6px" }}>{boothHint}</div>}
                    </Section>
                  )}
                  {detail.updates && detail.updates.length > 0 && (
                    <Section title="更新记录">
                      <table className="kv">
                        <tbody>
                          {detail.updates.map((u) => (
                            <tr key={u.id}><td className="k">{u.kind}</td><td>{u.detail ?? "—"}<div className="hint">{formatDate(u.created_at)}</div></td></tr>
                          ))}
                        </tbody>
                      </table>
                    </Section>
                  )}
                </DetailDisclosure>
              </div>
            </DetailDisclosure>
          </div>
          {dups.length > 0 && (
            <DetailDisclosure label="疑似重复" meta={dups.length + " 条"}>
              <Section
                title={<>⚠ 疑似重复 {dups.length}</>}
                right={<button className="btn tiny" disabled={dupBusy} onClick={loadDups}>{dupBusy ? "检测中…" : "重新检测"}</button>}
              >
                {dups.map((m) => {
                  const open = dupOpen.has(m.otherAssetId);
                  return (
                    <div className="dup-card" key={m.otherAssetId}>
                      <div className="row wrap" style={{ gap: "6px", alignItems: "center" }}>
                        <span>与《{m.otherTitle}》内容重复 <b>{(m.similarity * 100).toFixed(1)}%</b></span>
                        <Badge tone={DUP_LEVEL_TONE[m.level]}>{DUP_LEVEL_LABEL[m.level]}</Badge>
                        <span className="spacer" />
                        <button className="btn tiny" onClick={() => toggleDup(m.otherAssetId)}>{open ? "▾ 收起差异" : "▸ 看差异"}</button>
                        <button className="btn tiny" disabled={busy} title={"把 #" + m.otherItemId + " 合并到本条（对方进回收站，可恢复）"} onClick={() => doMergeDuplicate(m)}>合并到本条</button>
                        <button className="btn tiny" title={"打开 #" + m.otherItemId + " 的详情"} onClick={() => props.onOpenItem(m.otherItemId)}>打开 #{m.otherItemId}</button>
                      </div>
                      <div className="hint">{m.reason}{m.otherVersionKey ? " · 版本 " + m.otherVersionKey : ""}</div>
                      <div className="hint mono dup-path" title={m.otherPath}>{shortenPath(m.otherPath)}</div>
                      {open && (
                        <div className="dup-diff">
                          <DiffGroup label="新增" items={m.diff.added} />
                          <DiffGroup label="删除" items={m.diff.removed} />
                          <DiffGroup label="修改" items={m.diff.changed} />
                          {!m.diff.added.length && !m.diff.removed.length && !m.diff.changed.length && (
                            <div className="hint">没有文件级差异（签名判定为整包一致）</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </Section>
            </DetailDisclosure>
          )}
        </div>
        {mergePreview && (
          <MergePreview
            sourceId={mergePreview.sourceId}
            targetId={mergePreview.targetId}
            onClose={() => setMergePreview(null)}
            onConfirm={(sourceId, targetId) => { setMergePreview(null); guard(mergeItems(sourceId, targetId), "已合并 #" + sourceId + " → #" + targetId); }}
          />
        )}
      </div>
    </div>
  );
}

export type { EntryPreview };
