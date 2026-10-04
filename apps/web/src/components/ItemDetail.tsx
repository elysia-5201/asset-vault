import { useCallback, useEffect, useMemo, useState } from "react";
import type { AvatarMatch } from "@core/contracts";
import {
  addAsset, addImages, addItemAvatars, addItemTags, addToCollection, boothPeek, checkUpdate, createCollection, deleteImage, deleteItem, describeError,
  getItem, linkBooth, listItems, matchAvatars, mediaUrl, mergeItems, patchItem, removeFromCollection, removeItemAvatar, reorderImages, restoreItem, setCover,
  type EntryPreview,
} from "../api";
import type { AvatarCard, ItemDetailWeb } from "../types";
import { formatBytes, formatDate, formatYen } from "../util";
import { ArchiveView } from "./ArchiveView";
import { Badge, MATCH_LABEL, Section, SITE_LABEL, STATUS_LABEL, Spinner } from "./ui";

export interface ProjectLite { id: number; name: string; path: string }

const orderKey = (id: number) => "av.imgorder." + id;

export function ItemDetail(props: {
  itemId: number;
  avatars: AvatarCard[];
  projects: ProjectLite[];
  onClose: () => void;
  onChanged: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  importedIds: number[];
  onMarkImported: (itemId: number, projectId: number) => void;
}) {
  const { itemId } = props;
  const [detail, setDetail] = useState<ItemDetailWeb | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [notes, setNotes] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [imgUrl, setImgUrl] = useState("");
  const [imgPaths, setImgPaths] = useState("");
  const [assetPath, setAssetPath] = useState("");
  const [newTag, setNewTag] = useState("");
  const [boothUrl, setBoothUrl] = useState("");
  const [collName, setCollName] = useState("");
  const [mergeQ, setMergeQ] = useState("");
  const [mergeHits, setMergeHits] = useState<{ id: number; title: string }[]>([]);
  const [boothBusy, setBoothBusy] = useState(false);
  const [boothHint, setBoothHint] = useState("");
  const [localTags, setLocalTags] = useState<string[] | null>(null);
  const [localTagNote, setLocalTagNote] = useState(false);
  const [order, setOrder] = useState<number[] | null>(null);
  const [compatPick, setCompatPick] = useState<number | "">("");
  const [compatMatch, setCompatMatch] = useState<AvatarMatch>("any");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true); setErr("");
    getItem(itemId)
      .then((d) => { setDetail(d); setNotes(d.notes ?? ""); setLocalTags(null); })
      .catch((e) => setErr(describeError(e)))
      .finally(() => setLoading(false));
  }, [itemId]);

  useEffect(() => { setOrder(null); setLocalTags(null); setLocalTagNote(false); load(); }, [itemId, load]);
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

  const saveNotes = () => {
    if (!detail) return;
    setNotesSaving(true);
    patchItem(itemId, { notes })
      .then(() => { props.onToast("ok", "备注已保存"); props.onChanged(); })
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

  if (loading) return <div className="backdrop"><div className="drawer"><div className="empty"><Spinner /> 载入条目 #{itemId}…</div></div></div>;
  if (err || !detail) return (
    <div className="backdrop" onClick={props.onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>条目 #{itemId}</h3><button className="btn" onClick={props.onClose}>关闭</button></div>
        <div className="pane-body"><div className="err">{err || "无数据"}</div></div>
      </div>
    </div>
  );

  const it = detail.item;
  const tags = localTags ?? detail.tags ?? [];
  const imported = props.importedIds.includes(itemId);

  return (
    <div className="backdrop" onClick={props.onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3 title={detail.title}>{detail.title}</h3>
          <Badge tone={detail.status === "inbox" ? "warn" : "muted"}>{STATUS_LABEL[detail.status]}</Badge>
          <Badge>{SITE_LABEL[detail.sourceSite]}</Badge>
          {imported && <Badge tone="ok">已导入</Badge>}
          {busy && <Spinner />}
          <button className="btn tiny" onClick={() => guard(checkUpdate(itemId), "已起 check_update 作业")}>检查更新</button>
          <button className="btn tiny" onClick={() => guard(matchAvatars(itemId), "已起 match_avatars 作业")}>重跑头像匹配</button>
          {detail.status === "trashed"
            ? <button className="btn tiny" onClick={() => guard(restoreItem(itemId), "已从回收站恢复")}>恢复</button>
            : <button className="btn tiny danger" onClick={() => guard(deleteItem(itemId), "已软删（status=trashed）")}>删除</button>}
          <button className="btn" onClick={props.onClose}>关闭</button>
        </div>
        <div className="drawer-body">
          <div className="left">
            {detail.sourceSite === "local" && (
              <Section title="关联 BOOTH 商品（补全标题/店铺/价格/标签 + 抓图集）">
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
                    onClick={async () => {
                      setBoothBusy(true); setBoothHint("");
                      try {
                        const r: any = await linkBooth(itemId, boothUrl.trim(), false);
                        props.onToast("ok", "已关联 BOOTH " + r?.meta?.itemId + "，抓取 " + (r?.images ?? 0) + " 张图");
                        setBoothUrl("");
                        load();
                        props.onChanged();
                      } catch (e) { props.onToast("bad", describeError(e)); }
                      finally { setBoothBusy(false); }
                    }}
                  >抓取</button>
                  {boothBusy && <Spinner />}
                </div>
                <div className="hint">扫库建出来的本地条目没有商品号；粘一次商品链接就会把元数据与图集补全（原压缩包保持不变）。</div>
                {boothHint && <div className="notice" style={{ marginTop: "6px" }}>{boothHint}</div>}
              </Section>
            )}
            <Section title="套装 / 合并（同一商品的模型包 + 材质包）">
              <div className="row wrap" style={{ gap: "6px", alignItems: "center" }}>
                {(detail.collections ?? []).length === 0 && <span className="hint">未归入任何套装</span>}
                {(detail.collections ?? []).map((c) => (
                  <span key={c.id} className="row" style={{ gap: "2px", alignItems: "center" }}>
                    <Badge tone="violet">{c.name}</Badge>
                    <button className="btn tiny" title="移出套装" onClick={() => guard(removeFromCollection(c.id, itemId), "已移出套装")}>×</button>
                  </span>
                ))}
              </div>
              <div className="row" style={{ marginTop: "6px" }}>
                <input placeholder="套装名（如 Danzai Bunny）" value={collName} onChange={(e) => setCollName(e.target.value)} style={{ flex: 1 }} />
                <button className="btn tiny" disabled={!collName.trim() || busy} onClick={() => guard(createCollection(collName.trim(), [itemId]), "已加入套装「" + collName.trim() + "」")}>加入套装</button>
              </div>
              <div className="hint">套装 = 保留各自条目、只做归组（适合"模型包 + 材质包"分别售卖的情况）。</div>
              <div className="hr" />
              <label className="hint">合并到另一条目（把这条的压缩包/图片/标签/模型并过去，本条进回收站、可恢复）</label>
              <div className="row">
                <input placeholder="搜索目标条目标题…" value={mergeQ} onChange={(e) => { setMergeQ(e.target.value); const q = e.target.value.trim(); if (q.length >= 2) listItems({ q, limit: 6 }).then((r) => setMergeHits(r.items.filter((x) => x.id !== itemId).map((x) => ({ id: x.id, title: x.title })))).catch(() => setMergeHits([])); else setMergeHits([]); }} style={{ flex: 1 }} />
              </div>
              {mergeHits.length > 0 && (
                <div className="row wrap" style={{ gap: "4px", marginTop: "4px" }}>
                  {mergeHits.map((h) => (
                    <button key={h.id} className="btn tiny" onClick={() => { if (window.confirm("把本条合并到 #" + h.id + "「" + h.title + "」？本条会进回收站。")) guard(mergeItems(itemId, h.id), "已合并到 #" + h.id); }}>#{h.id} {h.title.slice(0, 24)}</button>
                  ))}
                </div>
              )}
            </Section>
            <Section
              title={<>缩略图 {images.length} · {detail.imageCount} 张</>}
              right={<span className="hint">{order ? "本地顺序" : "服务端顺序"}</span>}
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
              <div className="hint" style={{ marginTop: "4px" }}>↑↓ 调 POST /items/:id/images/reorder 落库；失败才退回本机顺序。</div>
            </Section>

            <Section title="备注" right={<button className="btn tiny" disabled={notesSaving} onClick={saveNotes}>保存</button>}>
              <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="PATCH /items/:id { notes }" />
              <div className="hint">{(detail.item.notes ?? "").length > 0 ? "已存长度 " + (detail.item.notes ?? "").length : "尚未填写"}</div>
            </Section>

            <Section title="标签">
              <div className="row wrap">
                {tags.map((t) => (
                  <span className="tag-chip" key={t}>{t}<button onClick={() => applyTags(tags.filter((x) => x !== t), "remove")} title="移除（PATCH 全量替换）">×</button></span>
                ))}
                {!tags.length && <span className="hint">无标签</span>}
              </div>
              <div className="row" style={{ marginTop: "6px" }}>
                <input type="text" placeholder="新增标签名" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
                <button className="btn" disabled={!newTag.trim()} onClick={() => { applyTags([...tags, newTag.trim()], "add"); setNewTag(""); }}>加标签</button>
              </div>
              {localTagNote && <div className="notice" style={{ marginTop: "6px" }}>该后端未接受标签改动（POST /items/:id/tags 与 PATCH tags 均失败），改动仅本机生效。</div>}
            </Section>

            <Section title="元数据">
              <table className="kv">
                <tbody>
                  <tr><td className="k">id / uid</td><td className="mono">{it.id} · {it.uid}</td></tr>
                  <tr><td className="k">来源</td><td>{SITE_LABEL[it.source_site]} {it.source_item_id ?? ""} {it.source_url ? <a href={it.source_url} target="_blank" rel="noreferrer">链接</a> : null}</td></tr>
                  <tr><td className="k">店铺/作者</td><td>{it.shop_name ?? "—"} / {it.author ?? "—"}</td></tr>
                  <tr><td className="k">分类</td><td>{it.category_parent ? it.category_parent + " › " : ""}{it.category_name ?? "—"}</td></tr>
                  <tr><td className="k">价格</td><td>{formatYen(it.price_yen, it.price_text)} {it.purchased ? "· 已购入" : ""}</td></tr>
                  <tr><td className="k">声明适配</td><td>{it.compat_declared_count ?? "—"} 体</td></tr>
                  <tr><td className="k">识别</td><td>{it.id_match_method ?? "—"} · conf {it.id_confidence ?? "—"}</td></tr>
                  <tr><td className="k">发布时间</td><td>{formatDate(it.published_at)}</td></tr>
                  <tr><td className="k">更新时间</td><td>{formatDate(it.updated_at)}</td></tr>
                  <tr><td className="k">体积</td><td>{formatBytes(detail.totalBytes)}</td></tr>
                </tbody>
              </table>
            </Section>

            <Section title="导入到 Unity 工程">
              <div className="row wrap">
                {props.projects.map((p) => (
                  <button key={p.id} className="btn tiny" onClick={() => props.onMarkImported(itemId, p.id)} title={p.path}>标记已导入 → {p.name}</button>
                ))}
                {!props.projects.length && <span className="hint">无已登记工程（POST /projects）</span>}
              </div>
              <div className="hint" style={{ marginTop: "4px" }}>走 POST /projects/:id/imports；「已导入」过滤基于本地登记。</div>
            </Section>
          </div>

          <div className="right">
            <Section title={<>适配模型 {detail.avatars.length}</>}>
              <div className="row wrap" style={{ marginBottom: "6px" }}>
                {detail.avatars.map((a) => (
                  <span className="tag-chip" key={a.id} title={a.evidence ?? "无证据字段"}>
                    @{a.name} · {MATCH_LABEL[a.match]}{a.confidence !== undefined && a.confidence !== null ? " · " + a.confidence.toFixed(2) : ""}
                    <button onClick={() => guard(removeItemAvatar(itemId, a.id), "已移除适配模型 @" + a.name)} title="移除">×</button>
                  </span>
                ))}
                {!detail.avatars.length && <span className="hint">未标注适配模型</span>}
              </div>
              <div className="asset-list">
                {detail.avatars.map((a) => (
                  <div className="evidence" key={"ev" + a.id}>
                    <b>@{a.name}</b> source={a.source ?? "—"}
                    {a.evidence ? " · 证据来源：" + a.evidence : " · 证据来源：API 未返回 evidence 字段"}
                  </div>
                ))}
              </div>
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

            <Section title={<>资产 {detail.assets.length}</>}>
              <div className="asset-list">
                {detail.assets.map((a) => <ArchiveView key={a.id} asset={a} onToast={props.onToast} />)}
                {!detail.assets.length && <span className="hint">未挂接资产</span>}
              </div>
              <div className="row" style={{ marginTop: "7px" }}>
                <input type="text" placeholder="本地文件/目录路径，如 %DOWNLOADS%/pkg.zip" value={assetPath} onChange={(e) => setAssetPath(e.target.value)} />
                <button className="btn" disabled={!assetPath.trim()} onClick={() => { guard(addAsset(itemId, assetPath.trim()), "已挂接资产"); setAssetPath(""); }}>挂接</button>
              </div>
              <div className="hint" style={{ marginTop: "4px" }}>POST /items/:id/assets — 自动识别容器类型。</div>
            </Section>

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

            {detail.description && (
              <Section title="商品说明">
                <div style={{ whiteSpace: "pre-wrap", maxHeight: "220px", overflow: "auto", fontSize: "12px" }}>{detail.description}</div>
              </Section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export type { EntryPreview };