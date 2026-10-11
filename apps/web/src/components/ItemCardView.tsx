import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { getItem, mediaUrl } from "../api";
import type { ItemCardWeb } from "../types";
import { formatBytes, formatDate } from "../util";
import { Badge, CATEGORY_SOURCE_LABEL, SITE_LABEL, STATUS_LABEL } from "./ui";

/** 卡片多图轮播：ItemCard 只有 coverUrl，故首次悬停/聚焦时按需 GET /items/:id 取 images（缓存）。 */
const imageCache = new Map<number, string[]>();

export function ItemCardView(props: {
  item: ItemCardWeb;
  onOpen: (id: number) => void;
  onToggleFavorite: (item: ItemCardWeb) => void;
  imported: boolean;
  /** 批量选择模式：整卡点击改为勾选（复选框在缩略图右上角），不会打开详情 */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
}) {
  const { item } = props;
  const [urls, setUrls] = useState<string[]>(() => imageCache.get(item.id) ?? (item.coverUrl ? [item.coverUrl] : []));
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(imageCache.has(item.id));

  useEffect(() => { setIdx(0); }, [item.id]);

  // 列表刷新后封面可能变了（例如刚导入新图、或后端补了封面）：卡片必须跟着换图，
  // 否则网格数据更新了、缩略图还停在旧 URL（"卡片没更新"的观感来源）。
  useEffect(() => {
    const cached = imageCache.get(item.id);
    if (!cached) {
      setUrls(item.coverUrl ? [item.coverUrl] : []);
      return;
    }
    // 图片数量变化说明库里有增删 → 缓存失效，回到按需加载
    if (cached.length !== item.imageCount) {
      imageCache.delete(item.id);
      loaded.current = false;
      setUrls(item.coverUrl ? [item.coverUrl] : []);
    }
  }, [item.id, item.coverUrl, item.imageCount]);

  useEffect(() => { if (idx >= urls.length) setIdx(0); }, [urls.length, idx]);

  const ensure = () => {
    if (loaded.current || busy) return;
    loaded.current = true;
    setBusy(true);
    getItem(item.id)
      .then((d) => {
        const list = [...d.images].sort((a, b) => a.position - b.position).map((i) => i.thumbUrl ?? mediaUrl(i.id, 240));
        const merged = list.length ? list : (item.coverUrl ? [item.coverUrl] : []);
        imageCache.set(item.id, merged);
        setUrls(merged);
      })
      .catch(() => { /* 取不到就只用封面 */ })
      .finally(() => setBusy(false));
  };

  const step = (delta: number) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (urls.length < 2) return;
    setIdx((i) => (i + delta + urls.length) % urls.length);
  };
  const current = urls[idx] ?? item.coverUrl;
  const sel = props.selected === true;
  const pick = () => { if (props.selectMode) props.onToggleSelect?.(item.id); else props.onOpen(item.id); };
  // 物品分类徽章：主分类优先，有子分类显示「主 › 子」；未分类显示灰 chip「未分类」
  const cat = item.category ?? null;
  const catLabel = cat && cat.categoryId
    ? (cat.subCategoryId && cat.subCategoryName ? cat.categoryName + " › " + cat.subCategoryName : (cat.categoryName ?? cat.categoryId))
    : null;

  return (
    <div
      className={"card" + (sel ? " sel" : "")}
      onClick={pick}
      onMouseEnter={ensure}
      onFocus={ensure}
      tabIndex={0}
      title={props.selectMode ? "选择模式：点击卡片切换勾选（不打开详情）" : item.title}
    >
      <div className="thumb">
        {current ? <img src={current} alt="" loading="lazy" /> : <div className="empty">无图</div>}
        {props.selectMode && (
          <label
            className={"pick" + (sel ? " on" : "")}
            title={sel ? "取消选择" : "选择这条（批量分类）"}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={sel}
              onChange={() => props.onToggleSelect?.(item.id)}
            />
          </label>
        )}
        <div className="corner">
          <Badge tone={item.status === "inbox" ? "warn" : item.status === "trashed" ? "bad" : "muted"}>{STATUS_LABEL[item.status]}</Badge>
          {item.status === "inbox" && <Badge tone="busy">inbox</Badge>}
          {props.imported && <Badge tone="ok" title="本地登记：已导入 Unity 工程">已导入</Badge>}
          {item.adult === 1 && <Badge tone="bad">R18</Badge>}
        </div>
        {urls.length > 1 && (
          <>
            <button className="nav l" onClick={step(-1)} aria-label="上一张">‹</button>
            <button className="nav r" onClick={step(1)} aria-label="下一张">›</button>
            <div className="dots">{urls.map((_, i) => <i key={i} className={i === idx ? "on" : ""} />)}</div>
          </>
        )}
      </div>
      <div className="card-body">
        <div className="card-title">{item.title}</div>
        <div className="card-meta">
          <span>{SITE_LABEL[item.sourceSite]}</span>
          <span>· {item.imageCount} 图 / {item.assetCount} 资产</span>
          <span>· {formatBytes(item.totalBytes)}</span>
          {item.shopName && <span>· {item.shopName}</span>}
        </div>
        <div className="row wrap" style={{ gap: "4px" }}>
          {catLabel
            ? <Badge tone="busy" title={"物品分类：" + catLabel + (cat?.source ? "（" + CATEGORY_SOURCE_LABEL[cat.source] + "）" : "")}>{catLabel}</Badge>
            : <Badge tone="muted" title="尚未归属任何物品分类（与 BOOTH 来源分类无关）">未分类</Badge>}
          {item.suggestion && (
            <button
              className="badge warn badge-btn"
              title={"有待确认的自动分类建议：" + (item.suggestion.subCategoryName ?? item.suggestion.categoryName) + "（点开详情可采纳/忽略）"}
              onClick={(e) => { e.stopPropagation(); props.onOpen(item.id); }}
            >
              建议 {item.suggestion.subCategoryName ?? item.suggestion.categoryName}
            </button>
          )}
          {item.avatars.slice(0, 3).map((a) => <Badge key={a.id} tone="violet" title={a.evidence ?? "无证据字段"}>@{a.name}</Badge>)}
          {item.avatars.length > 3 && <Badge tone="muted">+{item.avatars.length - 3}</Badge>}
          {(item.collections ?? []).slice(0, 1).map((c) => <Badge key={c.id} tone="ok" title="套装/合集">{c.name}</Badge>)}
          {item.compatDeclaredCount !== null && <Badge tone="busy" title="商品声明适配数">{item.compatDeclaredCount} 体対応</Badge>}
        </div>
        <div className="row">
          <span className="hint">{formatDate(item.updatedAt)}</span>
          <span className="spacer" />
          <button
            className={"star" + (item.favorite ? " on" : "")}
            title={item.favorite ? "取消收藏" : "收藏"}
            onClick={(e) => { e.stopPropagation(); props.onToggleFavorite(item); }}
          >★</button>
        </div>
      </div>
    </div>
  );
}
