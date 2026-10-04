import type { AvatarMatch, ContainerKind, ItemStatus, SourceSite } from "@core/contracts";
import { CONTAINERS, CONTAINER_LABEL, SITES, SITE_LABEL, STATUSES, STATUS_LABEL } from "./ui";

export interface FilterState {
  site: SourceSite | "";
  status: ItemStatus | "";
  container: ContainerKind | "";
  tag: string;
  imported: "any" | "yes" | "no";
  sort: "updated" | "title" | "size";
}

export function SearchBar(props: {
  text: string;
  onText: (s: string) => void;
  filters: FilterState;
  onFilters: (f: FilterState) => void;
  atAvatars: string[];
  unresolved: string[];
  onRemoveAt: (name: string) => void;
  tags: string[];
  loading: boolean;
  total: number;
}) {
  const f = props.filters;
  const set = (patch: Partial<FilterState>) => props.onFilters({ ...f, ...patch });
  return (
    <div className="toolbar">
      <div className="search-wrap">
        <span className="ico">⌕</span>
        <input
          type="search"
          placeholder="搜索标题/店铺/作者（中日文子串），@头像名 过滤，如：@MANUKA セーラー"
          value={props.text}
          onChange={(e) => props.onText(e.target.value)}
        />
      </div>
      {(props.atAvatars.length > 0 || props.unresolved.length > 0) && (
        <div className="chips">
          {props.atAvatars.map((n) => (
            <span className="chip" key={"at-" + n}>@{n}<button onClick={() => props.onRemoveAt(n)} title="移除">×</button></span>
          ))}
          {props.unresolved.map((n) => (
            <span className="chip" key={"un-" + n} style={{ borderColor: "rgba(232,98,79,.5)", background: "rgba(232,98,79,.12)", color: "#ffcdc4" }} title="未匹配到已知头像">
              @{n} 未识别
            </span>
          ))}
        </div>
      )}
      <div className="filters">
        <label>来源站
          <select value={f.site} onChange={(e) => set({ site: e.target.value as SourceSite | "" })}>
            <option value="">全部</option>
            {SITES.map((s) => <option key={s} value={s}>{SITE_LABEL[s]}</option>)}
          </select>
        </label>
        <label>状态
          <select value={f.status} onChange={(e) => set({ status: e.target.value as ItemStatus | "" })}>
            <option value="">默认（非回收站）</option>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label>容器类型
          <select value={f.container} onChange={(e) => set({ container: e.target.value as ContainerKind | "" })}>
            <option value="">全部</option>
            {CONTAINERS.map((s) => <option key={s} value={s}>{CONTAINER_LABEL[s]}</option>)}
          </select>
        </label>
        <label>标签
          <select value={f.tag} onChange={(e) => set({ tag: e.target.value })}>
            <option value="">全部</option>
            {props.tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>已导入
          <select value={f.imported} onChange={(e) => set({ imported: e.target.value as FilterState["imported"] })}>
            <option value="any">全部</option>
            <option value="yes">已导入</option>
            <option value="no">未导入</option>
          </select>
        </label>
        <label>排序
          <select value={f.sort} onChange={(e) => set({ sort: e.target.value as FilterState["sort"] })}>
            <option value="updated">最近更新</option>
            <option value="title">标题</option>
            <option value="size">体积</option>
          </select>
        </label>
      </div>
      <div className="row">
        <span className="hint">
          {props.loading ? <><span className="spin" /> 查询中…</> : <>命中 <b style={{ color: "var(--fg)" }}>{props.total}</b> 条</>}
        </span>
        <span className="spacer" />
        <span className="hint">已导入 = 服务端 project_imports（GET /items?imported=1|0）；卡片徽标为本地登记</span>
      </div>
    </div>
  );
}
