import { memo, useEffect, useState } from "react";
import { getSearchAlternatives, getSearchFacets, getSearchIndex, getSearchSuggestions, maintainSearchIndex, describeError, type SearchFacet, type SearchIndexState } from "../api";
import type { ItemQuery, ItemsResponse } from "../types";
import { useDebounced } from "./ui";

const facetLabels: Record<SearchFacet, string> = {
  avatar: "Avatar", author: "作者", tag: "标签", color: "颜色", style: "风格", site: "来源", status: "状态",
  format: "文件格式", available: "可用状态", size: "文件大小", added: "入库时间", updated: "更新时间",
  favorite: "收藏", imported: "Unity 导入", update: "版本状态",
};
const facetValues: Record<string, string> = {
  favorite: "已收藏", "-favorite": "未收藏", imported: "已导入", "-imported": "未导入",
  update: "有更新", "-update": "无待处理更新", present: "可用", missing: "文件缺失",
  "7d": "过去 7 天", "30d": "过去 30 天", "90d": "过去 90 天",
};
const historyKey = "assetvault.search.history";
const savedKey = "assetvault.search.saved";
function readList(key: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string").slice(0, 12) : [];
  } catch { return []; }
}
function storeList(key: string, list: string[]) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* Keep the session list. */ }
}

export const SearchTools = memo(function SearchTools(props: {
  text: string; query: ItemQuery; result: ItemsResponse["search"]; loading: boolean; total: number;
  onText: (text: string) => void; listView: boolean; onListView: (list: boolean) => void;
  onGlobal: () => void; onRefresh: () => void;
}) {
  const [panel, setPanel] = useState<"facets" | "saved" | "index" | null>(null);
  const [facet, setFacet] = useState<SearchFacet>("avatar");
  const [options, setOptions] = useState<{ value: string; count: number }[]>([]);
  const [history, setHistory] = useState(() => readList(historyKey));
  const [saved, setSaved] = useState(() => readList(savedKey));
  const [index, setIndex] = useState<SearchIndexState | null>(null);
  const [message, setMessage] = useState("");
  const [alternatives, setAlternatives] = useState<Awaited<ReturnType<typeof getSearchAlternatives>>>();
  const [related, setRelated] = useState<{ query: string; label: string }[]>([]);
  const settled = useDebounced(props.text, 700);
  const offset = props.text.length - props.text.trimStart().length;
  const replace = (start: number, end: number) => props.onText((props.text.slice(0, start + offset) + props.text.slice(end + offset)).trim());
  const updatePanel = (next: typeof panel) => { setMessage(""); setPanel(panel === next ? null : next); };

  useEffect(() => {
    const text = settled.trim();
    if (!text) return;
    setHistory((before) => {
      if (before[0] === text) return before;
      const next = [text, ...before.filter((v) => v !== text)].slice(0, 12);
      storeList(historyKey, next);
      return next;
    });
  }, [settled]);
  useEffect(() => {
    if (panel !== "facets") return;
    const request = new AbortController();
    setOptions([]);
    getSearchFacets(props.query, facet, request.signal).then((data) => setOptions(data.options))
      .catch((error) => { if (!request.signal.aborted) setMessage(describeError(error)); });
    return () => request.abort();
  }, [panel, facet, props.query]);
  useEffect(() => {
    if (panel !== "index") return;
    let active = true;
    const load = () => getSearchIndex().then((data) => { if (active) setIndex(data); })
      .catch((error) => { if (active) setMessage(describeError(error)); });
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [panel]);
  useEffect(() => {
    setAlternatives(undefined); setRelated([]);
    if (props.loading || props.total || !props.query.q?.trim()) return;
    const request = new AbortController();
    getSearchAlternatives(props.query, request.signal).then((data) => {
      if (!request.signal.aborted) setAlternatives(data);
    }).catch(() => {});
    getSearchSuggestions(props.query.q, request.signal).then((r) => {
      if (!request.signal.aborted) setRelated(r.suggestions);
    }).catch(() => {});
    return () => request.abort();
  }, [props.loading, props.total, props.query]);

  const addFacet = (value: string) => {
    const field = facet === "update" ? "has" : ["available", "favorite", "imported"].includes(facet) ? "is" : facet;
    const exclude = (facet === "favorite" || facet === "imported" || facet === "update") && value.startsWith("-");
    const queryValue = facet === "available" && value === "present" ? "available" : exclude ? value.slice(1) : value;
    const escaped = /\s/u.test(queryValue) ? '"' + queryValue.replace(/"/gu, '\\"') + '"' : queryValue;
    props.onText([props.text.trim(), (exclude ? "-" : "") + field + ":" + escaped].filter(Boolean).join(" "));
  };
  const toggleSave = () => {
    const text = props.text.trim();
    if (!text) return;
    const next = saved.includes(text) ? saved.filter((v) => v !== text) : [text, ...saved].slice(0, 12);
    setSaved(next); storeList(savedKey, next);
  };
  const act = async (action: Parameters<typeof maintainSearchIndex>[0]) => {
    setMessage("");
    try {
      const result = await maintainSearchIndex(action);
      if ("jobId" in result) setMessage("作业 #" + result.jobId + " 已排队");
      else setIndex(result);
    } catch (error) { setMessage(describeError(error)); }
  };
  const current = props.query.q === props.text.trim() ? props.result : undefined;
  const edit = (start: number, end: number) => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索素材"]');
    input?.focus();
    input?.setSelectionRange(start + offset, end + offset);
  };
  return <section className="search-tools" aria-label="搜索工具">
    <div className="row wrap">
      <button type="button" className="btn tiny" onClick={props.onGlobal}>搜索全库</button>
      <button type="button" className="btn tiny" aria-expanded={panel === "facets"} onClick={() => updatePanel("facets")}>结果筛选</button>
      <button type="button" className="btn tiny" aria-expanded={panel === "saved"} onClick={() => updatePanel("saved")}>历史与收藏搜索</button>
      <button type="button" className="btn tiny" aria-expanded={panel === "index"} onClick={() => updatePanel("index")}>搜索索引</button>
      <button type="button" className="btn tiny" onClick={() => props.onListView(!props.listView)}>{props.listView ? "卡片视图" : "列表视图"}</button>
    </div>
    {!!current && <div className="row wrap">
      {current.filters.map((filter) => <span className="chip" key={filter.start + ":" + filter.end}>
        <button type="button" onClick={() => edit(filter.start, filter.end)} title="编辑此筛选条件">{props.text.slice(filter.start + offset, filter.end + offset)}</button>
        <button type="button" onClick={() => replace(filter.start, filter.end)} title="移除此筛选条件" aria-label="移除此筛选条件">×</button></span>)}
      {current.intents.filter((v) => v.label !== "插件").map((v) => <button type="button" className="chip search-intent" key={v.start + ":" + v.end + ":" + v.text}
        onClick={() => replace(v.start, v.end)} title="移除此搜索词">{v.label} ×</button>)}
    </div>}
    {current?.candidateLimit && props.total >= current.candidateLimit && <span className="hint">该词命中较多。加一个关键词或筛选条件可缩小范围。</span>}
    {panel === "facets" && <div className="row wrap">
      <select aria-label="筛选维度" value={facet} onChange={(e) => { setMessage(""); setFacet(e.target.value as SearchFacet); }}>
        {Object.entries(facetLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      {options.map((v) => <button type="button" className="btn tiny" key={v.value} onClick={() => addFacet(v.value)}>{facetValues[v.value] ?? v.value} · {v.count}</button>)}
    </div>}
    {panel === "saved" && <div className="search-saved">
      <button type="button" className="btn tiny" disabled={!props.text.trim()} onClick={toggleSave}>{saved.includes(props.text.trim()) ? "移除已保存搜索" : "保存当前搜索"}</button>
      {!!saved.length && <div className="row wrap"><span className="hint">已保存</span>{saved.map((q) => <button type="button" className="chip" key={q} onClick={() => props.onText(q)}>{q}</button>)}</div>}
      {!!history.length && <div className="row wrap"><span className="hint">最近</span>{history.map((q) => <button type="button" className="chip" key={q} onClick={() => props.onText(q)}>{q}</button>)}
        <button type="button" className="btn tiny" onClick={() => { setHistory([]); storeList(historyKey, []); }}>清空历史</button></div>}
    </div>}
    {panel === "index" && <div className="row wrap">
      {index && <span className="hint">已索引 {index.indexed}/{index.total} · 待处理 {index.pending} · 失败 {index.failed}{index.paused ? " · 已暂停" : ""}
        {index.contentPending > 0 && " · 包内待解析 " + index.contentPending}
        {index.contentFailed > 0 && " · 包内解析失败 " + index.contentFailed}
        {(index.contentLimited > 0 || index.pathLimitedItems > 0) && " · 部分包只索引了部分路径"}</span>}
      <button type="button" className="btn tiny" onClick={() => void act(index?.paused ? "resume" : "pause")}>{index?.paused ? "继续索引" : "暂停索引"}</button>
      <button type="button" className="btn tiny" onClick={() => void act("repair")}>增量更新与修复</button>
      <button type="button" className="btn tiny" onClick={() => void act("rebuild")}>后台重建</button>
      <button type="button" className="btn tiny" onClick={() => void act("cancel-rebuild")}>取消重建</button>
      <button type="button" className="btn tiny" onClick={props.onRefresh}>刷新结果</button>
    </div>}
    {message && <div className="hint" role="status">{message}</div>}
    {!props.loading && !props.total && props.query.q && <div className="row wrap" aria-label="搜索建议">
      {alternatives && alternatives.index.pending > 0 && <span className="hint">有 {alternatives.index.pending} 条索引尚未完成</span>}
      {alternatives && alternatives.index.contentPending > 0 && <span className="hint">有 {alternatives.index.contentPending} 个包的内容尚未解析完整</span>}
      {alternatives?.relaxations.filter((v) => v.count > 0).map((v) => <button type="button" className="btn tiny" key={v.query}
        onClick={() => props.onText(v.query)}>移除「{v.removed}」后可找到 {v.count} 条</button>)}
      {related.slice(0, 4).map((v) => <button type="button" className="btn tiny" key={v.query} onClick={() => props.onText(v.query)}>{v.label}</button>)}
    </div>}
  </section>;
});
