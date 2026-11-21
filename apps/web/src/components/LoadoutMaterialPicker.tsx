import { useEffect, useState } from "react";
import { addLoadoutItems, describeError, listItems, mediaUrl } from "../api";
import type { ItemsResponse, LoadoutItem } from "../types";
import { Spinner, useDebounced } from "./ui";

const PAGE_SIZE = 24;
const MAX_SELECTION = 200;

export function LoadoutMaterialPicker(props: {
  avatarId: number;
  loadoutId: number;
  existingItems: LoadoutItem[];
  disabled: boolean;
  onSaving: (saving: boolean) => void;
  onAdded: (count: number, existing: number) => void;
}) {
  const { avatarId, loadoutId, existingItems, disabled, onSaving, onAdded } = props;
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 250);
  const [allMaterials, setAllMaterials] = useState(false);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<ItemsResponse | null>(null);
  const [searchError, setSearchError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [retry, setRetry] = useState(0);
  const [picked, setPicked] = useState<Map<number, string>>(() => new Map());

  useEffect(() => {
    setResult(null);
    setSearchError("");
    if (query !== search.trim()) return;
    let active = true;
    listItems({
      avatar: allMaterials ? undefined : [avatarId],
      q: query || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }).then((response) => {
      if (active) setResult(response);
    }).catch((err) => {
      if (active) setSearchError(describeError(err));
    });
    return () => { active = false; };
  }, [avatarId, allMaterials, page, query, search, retry]);

  const existingIds = new Set(existingItems.map((item) => item.itemId));
  const selected = Array.from(picked).filter(([id]) => !existingIds.has(id));
  const full = selected.length >= MAX_SELECTION;
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / PAGE_SIZE));

  const toggle = (id: number, title: string) => {
    setPicked((current) => {
      const next = new Map(current);
      if (!next.delete(id) && !full) next.set(id, title);
      return next;
    });
  };

  const add = async () => {
    if (disabled || !selected.length) return;
    onSaving(true);
    setSubmitError("");
    try {
      const { added, revived, existing } = await addLoadoutItems(loadoutId, { itemIds: selected.map(([id]) => id) });
      setPicked(new Map());
      onAdded(added + revived, existing);
    } catch (err) {
      setSubmitError(describeError(err));
    } finally {
      onSaving(false);
    }
  };

  return (
    <section className="loadout-picker" aria-label="挑选素材">
      <div className="row wrap loadout-picker-search">
        <input
          type="search"
          aria-label="搜索搭配素材"
          placeholder="搜索素材"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
        />
        <select
          aria-label="素材范围"
          value={allMaterials ? "all" : "compatible"}
          onChange={(e) => { setAllMaterials(e.target.value === "all"); setPage(0); }}
        >
          <option value="compatible">适配当前模型</option>
          <option value="all">全部素材</option>
        </select>
      </div>
      {searchError ? (
        <div className="row wrap">
          <span role="alert">{searchError}</span>
          <button className="btn" onClick={() => setRetry((attempt) => attempt + 1)}>重试</button>
        </div>
      ) : !result || query !== search.trim() ? (
        <div className="hint" role="status"><Spinner /> 正在读取素材…</div>
      ) : result.items.length ? (
        <div className="loadout-materials">
          {result.items.map((item) => {
            const inLoadout = existingIds.has(item.id);
            const cover = item.coverImageId ? mediaUrl(item.coverImageId, 96) : item.coverUrl;
            return (
              <label key={item.id} className="loadout-material">
                <input
                  type="checkbox"
                  checked={inLoadout || picked.has(item.id)}
                  disabled={disabled || inLoadout || (full && !picked.has(item.id))}
                  onChange={() => toggle(item.id, item.title)}
                />
                {cover && <img src={cover} alt="" loading="lazy" />}
                <span>{item.title}{inLoadout && <small>已在清单中</small>}</span>
              </label>
            );
          })}
        </div>
      ) : (
        <div className="hint">{allMaterials ? "没有找到素材，试试其他关键词。" : "没有找到适配素材，可以切换到「全部素材」。"}</div>
      )}
      {pageCount > 1 && (
        <div className="row loadout-picker-pages">
          <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="hint">第 {page + 1} / {pageCount} 页</span>
          <button className="btn" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
      {selected.length > 0 && (
        <div className="row wrap">
          {selected.map(([id, title]) => (
            <button key={id} className="btn" disabled={disabled} onClick={() => toggle(id, title)} aria-label={"取消勾选 " + title}>{title} ×</button>
          ))}
        </div>
      )}
      {submitError && <div role="alert" className="loadout-picker-error">{submitError}</div>}
      <div className="row wrap">
        <span className="hint" role="status">{full ? "本次最多添加 200 项" : `已选 ${selected.length} 项`}</span>
        <span className="spacer" />
        {selected.length > 0 && <button className="btn" disabled={disabled} onClick={() => setPicked(new Map())}>清空勾选</button>}
        <button className="btn primary" disabled={disabled || !selected.length} onClick={() => void add()}>
          {selected.length ? `加入清单（${selected.length}）` : "加入清单"}
        </button>
      </div>
    </section>
  );
}
