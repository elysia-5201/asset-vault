import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MergePreview, validateWrapper, validateIds, pickTargetCover, buildMergePreview } from "../../apps/web/src/components/MergePreview";

const wrapper = (id: number, extra: any = {}) => ({ item: { id, title: "T" + id }, assets: [{ id: 10 }], images: [{ id: 1, position: 0 }, { id: 2, position: 1 }], coverImageId: null, ...extra });

test("validateWrapper：真实 wrapper 正例/错 ID/同 ID/缺顶层 assets/images/old item.assets", () => {
  assert.equal(validateWrapper(wrapper(1), 1).ok, true);
  assert.equal(validateWrapper(wrapper(2), 1).ok, false);
  assert.equal(validateWrapper({ item: { id: 1, title: "T", assets: [{ id: 10 }] }, images: [] }, 1).ok, false, "old item.assets-only 必须失败");
  assert.equal(validateWrapper({ item: { id: 1, title: "T" }, assets: [], images: [] }, 1).ok, true);
  assert.equal(validateWrapper({ item: { id: 1, title: "T" }, assets: [] }, 1).ok, false);
  assert.equal(validateWrapper({ item: { id: 1, title: "T" }, images: [] }, 1).ok, false);
  assert.equal(validateWrapper({ item: { id: 0, title: "T" }, assets: [], images: [] }, 0).ok, false);
});

test("pickTargetCover：有 cover 用 cover；否则 position,id 第一张；空图 null", () => {
  assert.equal(pickTargetCover({ id: 1, title: "T", coverImageId: 9, images: [{ id: 2, position: 0 }], assets: [] }), 9);
  assert.equal(pickTargetCover({ id: 1, title: "T", coverImageId: null, images: [{ id: 5, position: 2 }, { id: 3, position: 0 }], assets: [] }), 3);
  assert.equal(pickTargetCover({ id: 1, title: "T", coverImageId: null, images: [], assets: [] }), null);
});

test("buildMergePreview：只保留 target 图，source 图不迁入", () => {
  const m = buildMergePreview(
    { id: 1, title: "target", coverImageId: null, images: [{ id: 1, position: 0 }], assets: [] },
    { id: 2, title: "source", coverImageId: 7, images: [{ id: 7 }, { id: 8 }], assets: [{ id: 10 }, { id: 11 }] },
  );
  assert.equal(m.targetId, 1); assert.equal(m.sourceId, 2);
  assert.equal(m.targetImages.length, 1);
  assert.equal(m.sourceAssets, 2);
  assert.equal(m.sourceImagesStay, 2);
  assert.equal(m.targetCover, 1);
});

test("SSR：初始 loading + 确认禁用；同 ID 显示错误且禁用", () => {
  const loading = renderToStaticMarkup(createElement(MergePreview, { sourceId: 2, targetId: 1, onClose: () => {}, onConfirm: () => {} }));
  assert.ok(loading.includes("载入两条目详情"));
  assert.ok(loading.includes("disabled"));
  assert.ok(loading.includes('data-testid="merge-preview"'));
  assert.ok(loading.includes('aria-label="合并预览"'));
  assert.ok(loading.includes('data-source-id="2"'));
  assert.ok(loading.includes('data-target-id="1"'));
  assert.equal(validateIds(1, 1), "合并双方 ID 非法或相同");
  assert.equal(validateIds(0, 1), "合并双方 ID 非法或相同");
  assert.equal(validateIds(1, 2), "");
  const bad = renderToStaticMarkup(createElement(MergePreview, { sourceId: 1, targetId: 1, onClose: () => {}, onConfirm: () => {} }));
  assert.ok(bad.includes("载入两条目详情"));
  assert.ok(bad.includes("disabled"));
});