/**
 * AC2 链接建档（BOOTH）
 * 判据操作化：
 *   - POST /import/url → 作业 done
 *   - 详情里 origin='booth' 的图片 >= 2
 *   - item.title 非空；shop/author/category/price 至少各为"可读值"（非 undefined；允许 null 但必须在响应里出现该字段）
 *   - "断网后仍出图" := 每张 booth 图的 file_path 非空且磁盘上 existsSync(label) —— 图确实落盘
 */
import { existsSync } from "node:fs";
import { runAc, api, waitJob, assertAc, log, AcPending, AcFailure } from "./_lib";

await runAc("AC2", "POST /import/url 建条目 + 官方图落盘", { needsServer: true, note: "需要外网访问 booth.pm；会真实下载图片" }, async () => {
  const url = process.env.AV_SMOKE_BOOTH_URL ?? "https://booth.pm/ja/items/6115428";
  const r = await api.post("/import/url", { url, downloadImages: true });
  assertAc(r.status === 200, `POST /import/url → HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  const jobId = r.body?.jobId;
  assertAc(jobId, `未返回 jobId: ${JSON.stringify(r.body)}`);
  log(`    import url=${url} jobId=${jobId} itemId=${r.body?.itemId ?? "(等作业)"}`);
  await waitJob(Number(jobId));

  let itemId = Number(r.body?.itemId);
  if (!itemId) {
    const items = (await api.get("/items?limit=20&sort=updated")).body?.items ?? [];
    const hit = items.find((i: any) => String(i.sourceItemId ?? "") === url.match(/items\/(\d+)/)?.[1]);
    if (!hit) throw new AcFailure("作业完成但找不到对应条目（检查 /items 列表）");
    itemId = hit.id;
  }
  const d = (await api.get(`/items/${itemId}`)).body;
  assertAc(d?.item, `GET /items/${itemId} 无 item 字段`);
  const boothImgs = (d.images ?? []).filter((x: any) => x.origin === "booth");
  assertAc(boothImgs.length >= 2, `origin='booth' 图片只有 ${boothImgs.length} 张（要求 >=2）`);
  const missing = boothImgs.filter((x: any) => !x.file_path || !existsSync(x.file_path));
  assertAc(missing.length === 0, `${missing.length} 张 booth 图未落盘（file_path=${missing.map((m: any) => m.file_path).join(",")}）→ 断网后出图不成立`);
  for (const k of ["title", "shop_name", "author", "category_name", "price_text", "price_yen"]) {
    assertAc(k in d.item, `ItemRow 缺字段 ${k}`);
  }
  assertAc(!!d.item.title, "title 为空");
  assertAc(d.item.price_text != null || d.item.price_yen != null, "价格字段全空（price_text/price_yen）");
  log(`    item#${itemId} title=${JSON.stringify(d.item.title)} shop=${d.item.shop_name} author=${d.item.author} cat=${d.item.category_name} price=${d.item.price_text}/${d.item.price_yen}`);
  log(`    booth 图=${boothImgs.length} 全部落盘; tags=${JSON.stringify(d.tags ?? [])}`);
});
