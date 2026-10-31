import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_FILTERS, activeConditions, activeFilterCount, clearFilters,
  hasAnyCondition, commonCategories, pushEscLayer, dropEscLayer, isTopEscLayer, resetEscLayers, type FilterState,
} from "../apps/web/src/ui-state";

const cats = [
  { id: "all", name: "全部" },
  { id: "clothing", name: "服饰", children: [{ id: "clothing.suit", name: "套装" }] },
  { id: "hair", name: "发型" },
  { id: "c01", name: "装饰" }, { id: "c02", name: "模型" }, { id: "c03", name: "场景" },
  { id: "c04", name: "工具" }, { id: "c05", name: "材质" }, { id: "c06", name: "动画" },
  { id: "c07", name: "预设" }, { id: "c08", name: "杂项" }, { id: "c09", name: "末位" },
];

test("空筛选没有任何活动条件，排序不算条件", () => {
  assert.deepEqual(activeConditions(EMPTY_FILTERS, cats), []);
  assert.equal(activeFilterCount(EMPTY_FILTERS), 0);
  assert.equal(hasAnyCondition(EMPTY_FILTERS, "", 0), false);
});

test("高级筛选逐项出现在活动条件摘要里（含人类可读标签）", () => {
  const f: FilterState = { ...EMPTY_FILTERS, site: "booth", status: "inbox", imported: "yes", favoriteOnly: true, pendingCategory: true };
  const got = activeConditions(f, cats).map((c) => c.label);
  assert.deepEqual(got, ["来源：BOOTH", "状态：待整理", "已导入：已导入", "待确认", "只看收藏"]);
  assert.equal(activeFilterCount(f), 5);
});

test("分类条件（一级/二级）进入摘要并使用分类名", () => {
  const f: FilterState = { ...EMPTY_FILTERS, catTop: "clothing", catSub: "clothing.suit" };
  assert.deepEqual(activeConditions(f, cats).map((c) => c.label), ["分类：服饰 / 套装"]);
  assert.equal(hasAnyCondition(f, "", 0), true);
});

test("清空筛选只重置筛选项，保留排序，不碰搜索与头像", () => {
  const f: FilterState = { ...EMPTY_FILTERS, site: "booth", status: "active", imported: "no", catTop: "hair", catSub: "", favoriteOnly: true, pendingCategory: true, sort: "title" };
  const cleared = clearFilters(f);
  assert.deepEqual(cleared, { ...EMPTY_FILTERS, sort: "title" });
  assert.equal(f.status, "active");
  assert.equal(hasAnyCondition(cleared, "水手服", 0), true);
  assert.equal(hasAnyCondition(cleared, "", 2), true);
});

test("常用分类：默认取前 8 个，选中项即使不在前 8 也保留且不重复", () => {
  const selected = "c09";
  const r = commonCategories(cats, selected, 8);
  assert.equal(r.common.length, 8);
  assert.ok(r.common.some((c) => c.id === selected));
  assert.ok(!r.more.some((c) => c.id === selected));
  assert.equal(r.common.filter((c) => c.id === selected).length, 1);
  const r2 = commonCategories(cats, "", 8);
  assert.deepEqual(r2.common.map((c) => c.id), cats.slice(0, 8).map((c) => c.id));
});

test("分类选中态文案：一级/二级都可见，避免隐藏条件无反馈", () => {
  assert.equal(activeConditions({ ...EMPTY_FILTERS, catTop: "hair" }, cats)[0].label, "分类：发型");
  assert.equal(activeConditions({ ...EMPTY_FILTERS, catTop: "zzz" }, cats)[0].label, "分类：zzz");
});

// ---- Fix1 追加：Esc 分层（只有最上层响应 Escape） ----
test("Esc 分层：后打开的在栈顶，只有栈顶响应", () => {
  resetEscLayers();
  pushEscLayer("side");
  assert.equal(isTopEscLayer("side"), true);
  pushEscLayer("more-tools");
  assert.equal(isTopEscLayer("more-tools"), true);
  assert.equal(isTopEscLayer("side"), false);
  // 同一层重复打开（先关再开）要移到栈顶，不能留下旧条目压住新层
  pushEscLayer("side");
  assert.equal(isTopEscLayer("side"), true);
  assert.equal(isTopEscLayer("more-tools"), false);
  resetEscLayers();
});

test("Esc 分层：关掉栈顶后下一层才成为栈顶（第二次 Esc 才关侧栏）", () => {
  resetEscLayers();
  pushEscLayer("side");
  pushEscLayer("more-tools");
  dropEscLayer("more-tools");
  assert.equal(isTopEscLayer("more-tools"), false);
  assert.equal(isTopEscLayer("side"), true);
  dropEscLayer("side");
  assert.equal(isTopEscLayer("side"), false);
  resetEscLayers();
});

test("Esc 分层：丢弃非栈顶层不影响栈顶；未知层与空栈都为 false", () => {
  resetEscLayers();
  pushEscLayer("side");
  pushEscLayer("cat-more");
  dropEscLayer("cat-more");
  assert.equal(isTopEscLayer("side"), true);
  dropEscLayer("never-opened");
  assert.equal(isTopEscLayer("side"), true);
  resetEscLayers();
  assert.equal(isTopEscLayer("side"), false);
  dropEscLayer("side");
  assert.equal(isTopEscLayer("side"), false);
});

// ---- Fix2 追加：前景模态层压住背景 Esc 层（详情在上层时侧栏/分类弹层不响应） ----
test("Fix2 Esc：前景模态在栈顶时背景侧栏与分类弹层都不算栈顶", () => {
  resetEscLayers();
  pushEscLayer("side-panel");
  pushEscLayer("cat-more");
  pushEscLayer("foreground-modal");
  assert.equal(isTopEscLayer("foreground-modal"), true);
  assert.equal(isTopEscLayer("side-panel"), false);
  assert.equal(isTopEscLayer("cat-more"), false);
  resetEscLayers();
});

test("Fix2 Esc：模态关闭出栈后原层级恢复（先分类弹层，再侧栏）", () => {
  resetEscLayers();
  pushEscLayer("side-panel");
  pushEscLayer("cat-more");
  pushEscLayer("foreground-modal");
  dropEscLayer("foreground-modal");
  assert.equal(isTopEscLayer("cat-more"), true);
  assert.equal(isTopEscLayer("side-panel"), false);
  dropEscLayer("cat-more");
  assert.equal(isTopEscLayer("side-panel"), true);
  dropEscLayer("side-panel");
  assert.equal(isTopEscLayer("side-panel"), false);
  resetEscLayers();
});

