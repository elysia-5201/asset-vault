import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { makeThumbnail, probeImage } from "../../src/images";
import { PNG_1x1 } from "./fixtures";

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 200, b: 30 } } }).png().toBuffer();
}

test("probeImage: 已知尺寸的 PNG → 精确宽高与格式（正例）", async () => {
  const buf = await makePng(200, 100);
  const p = await probeImage(buf);
  assert.equal(p.width, 200);
  assert.equal(p.height, 100);
  assert.equal(p.format, "png");
});

test("probeImage: JPEG 与 WebP 也识别（跨格式对照）", async () => {
  const src = await makePng(64, 32);
  const jpg = await sharp(src).jpeg().toBuffer();
  const webp = await sharp(src).webp().toBuffer();
  assert.equal((await probeImage(jpg)).format, "jpeg");
  assert.equal((await probeImage(webp)).format, "webp");
  assert.equal((await probeImage(jpg)).width, 64);
});

test("probeImage: 非图片字节 → AppError INVALID_INPUT（反例）", async () => {
  await assert.rejects(
    () => probeImage(Buffer.from("this is definitely not an image")),
    (err: any) => err?.name === "AppError" && err.code === "INVALID_INPUT",
  );
  await assert.rejects(() => probeImage(Buffer.alloc(0)), (err: any) => err?.name === "AppError");
});

test("makeThumbnail: 200x100 → 缩略 64（webp 默认），宽高为输出尺寸", async () => {
  const t = await makeThumbnail(await makePng(200, 100), { maxSize: 64 });
  assert.equal(t.format, "webp");
  assert.equal(t.width, 64);
  assert.equal(t.height, 32); // 等比：200x100 → 64x32
  assert.equal((await probeImage(t.data)).width, 64);
  assert.ok(t.data.length > 0 && t.data.subarray(0, 4).toString("ascii") === "RIFF"); // WEBP 容器魔数
});

test("makeThumbnail: 不放大小图（withoutEnlargement）", async () => {
  const t = await makeThumbnail(await makePng(10, 8), { maxSize: 64 });
  assert.equal(t.width, 10);
  assert.equal(t.height, 8);
});

test("makeThumbnail: format=jpeg → mozjpeg 输出，魔数 FFD8", async () => {
  const t = await makeThumbnail(await makePng(300, 300), { maxSize: 100, format: "jpeg" });
  assert.equal(t.format, "jpeg");
  assert.equal(t.width, 100);
  assert.equal(t.height, 100);
  assert.equal(t.data[0], 0xff);
  assert.equal(t.data[1], 0xd8);
});

test("makeThumbnail: 1x1 PNG 也能出图（边界）", async () => {
  const t = await makeThumbnail(PNG_1x1, { maxSize: 32 });
  assert.equal(t.width, 1);
  assert.equal(t.height, 1);
});

test("makeThumbnail: maxSize<=0 与非图片 → AppError INVALID_INPUT（反例）", async () => {
  const png = await makePng(8, 8);
  await assert.rejects(() => makeThumbnail(png, { maxSize: 0 }), (err: any) => err?.name === "AppError" && err.code === "INVALID_INPUT");
  await assert.rejects(() => makeThumbnail(png, { maxSize: -5 }), (err: any) => err?.name === "AppError");
  await assert.rejects(() => makeThumbnail(Buffer.from("nope"), { maxSize: 16 }), (err: any) => err?.name === "AppError" && err.code === "INVALID_INPUT");
});
