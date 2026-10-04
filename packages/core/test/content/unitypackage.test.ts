import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listUnityPackage, parseUnityPackage, readUnityPackagePreview, unityTypeFromPath } from "../../src/unitypackage";
import { probeImage } from "../../src/images";
import { SAMPLES, PNG_1x1, buildTarGz, cleanup, gnuTarEntryCount, has, tarAvailable, tmpDir } from "./fixtures";

const HEX32 = /^[0-9a-f]{32}$/;

test("MANUKA.unitypackage: 165 GUID / 678 tar 条目（与 CONTRACT §5 已知事实一致）", async (t) => {
  if (!has(SAMPLES.unitypackage)) return t.skip("unitypackage sample missing");
  const r = await parseUnityPackage(SAMPLES.unitypackage);
  // 度量定义：guidCount = 包里出现过的独立 <guid>/ 顶层目录数；tarEntries = tar 条目总数（含 asset.meta/preview/目录）
  assert.equal(r.guidCount, SAMPLES.manuka.guids);
  assert.equal(r.tarEntries, SAMPLES.manuka.tarEntries);
  assert.equal(r.assets.length, SAMPLES.manuka.guids);
  assert.equal(r.truncated, false);
});

test("MANUKA.unitypackage: 与 GNU tar 独立仪器交叉一致（678 行）", async (t) => {
  if (!has(SAMPLES.unitypackage)) return t.skip("unitypackage sample missing");
  if (!tarAvailable()) return t.skip("tar not available");
  const mine = (await parseUnityPackage(SAMPLES.unitypackage)).tarEntries;
  const theirs = gnuTarEntryCount(SAMPLES.unitypackage);
  assert.equal(mine, theirs);
  assert.equal(theirs, SAMPLES.manuka.tarEntries);
});

test("MANUKA.unitypackage: preview 计数 47 与 tar 目录中的 preview.png 数量一致", async (t) => {
  if (!has(SAMPLES.unitypackage)) return t.skip("unitypackage sample missing");
  const r = await parseUnityPackage(SAMPLES.unitypackage);
  const withPreview = r.assets.filter((a) => a.hasPreview);
  assert.equal(withPreview.length, SAMPLES.manuka.previews);
  // 语义对照（实测校正：prefab 也带 Unity 生成的 preview.png，不能只按"图像扩展名"断言）：
  assert.ok(withPreview.some((a) => a.type === "Texture2D"), "应有带 preview 的贴图");
  assert.ok(withPreview.some((a) => a.type === "Prefab"), "prefab 也有 preview（Unity 行为）");
  assert.ok(r.assets.some((a) => !a.hasPreview), "也应存在没有 preview 的资产");
  assert.equal(withPreview.every((a) => r.assets.includes(a)), true);
});

test("MANUKA.unitypackage: 字段完整性（guid/path/type/size 全部自洽）", async (t) => {
  if (!has(SAMPLES.unitypackage)) return t.skip("unitypackage sample missing");
  const r = await parseUnityPackage(SAMPLES.unitypackage);
  for (const a of r.assets) {
    assert.match(a.guid, HEX32, `guid 必须是 32 位 hex: ${a.guid}`);
  }
  const paths = r.assets.map((a) => a.assetPath);
  assert.equal(new Set(paths).size, paths.length, "assetPath 不应重复");
  assert.ok(paths.every((p) => p.startsWith("Assets/")), "pathname 都应指向 Assets/ 下");
  // 已知正例：Icon/5.png（Texture2D，size>0，有 preview）
  const icon = r.assets.find((a) => a.assetPath.endsWith("Icon/5.png"));
  assert.ok(icon, "应能找到 Assets/MANUKA/MANUKA_3.0/Icon/5.png");
  assert.equal(icon!.type, "Texture2D");
  assert.ok((icon!.size ?? 0) > 0);
  assert.equal(icon!.hasPreview, true);
  // 已知反例：动画文件不应有 preview
  const anim = r.assets.find((a) => a.assetPath.endsWith(".anim"));
  assert.ok(anim, "应能找到 .anim 资产");
  assert.equal(anim!.type, "AnimationClip");
  assert.equal(anim!.hasPreview, false);
});

test("readUnityPackagePreview: 取出的是可解码 PNG，且与资产扩展名相符", async (t) => {
  if (!has(SAMPLES.unitypackage)) return t.skip("unitypackage sample missing");
  const r = await parseUnityPackage(SAMPLES.unitypackage);
  const target = r.assets.find((a) => a.hasPreview && a.assetPath.endsWith(".png"))!;
  const buf = await readUnityPackagePreview(SAMPLES.unitypackage, target.guid);
  assert.ok(buf && buf.length > 0, "preview 应有内容");
  assert.equal(buf!.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); // PNG 魔数
  const probe = await probeImage(buf!);
  assert.equal(probe.format, "png");
  assert.ok(probe.width > 0 && probe.height > 0);
  // 反例：没有 preview 的资产 → null（不是空 Buffer，也不是抛错）
  const noPreview = r.assets.find((a) => !a.hasPreview)!;
  assert.equal(await readUnityPackagePreview(SAMPLES.unitypackage, noPreview.guid), null);
});

test("unityTypeFromPath: 扩展名 → Unity 类型（含未知扩展名反例）", () => {
  assert.equal(unityTypeFromPath("Assets/A/b.prefab"), "Prefab");
  assert.equal(unityTypeFromPath("Assets/A/b.PNG"), "Texture2D");
  assert.equal(unityTypeFromPath("Assets/A/b.mat"), "Material");
  assert.equal(unityTypeFromPath("Assets/A/b.cs"), "MonoScript");
  assert.equal(unityTypeFromPath("Assets/A/b.anim"), "AnimationClip");
  assert.equal(unityTypeFromPath("Assets/A/b.weirdx"), null);
  assert.equal(unityTypeFromPath("Assets/A/noext"), null);
});

test("合成包: 顺序/目录资产/缺 pathname/非 GUID 条目 全部按预期处理", async () => {
  const dir = tmpDir("up-syn");
  try {
    const gA = "a".repeat(32), gB = "b".repeat(32), gC = "c".repeat(32), gD = "d".repeat(32);
    const f = join(dir, "syn.unitypackage");
    writeFileSync(f, buildTarGz([
      { name: `${gA}/asset`, data: Buffer.alloc(12, 1) },
      { name: `${gA}/asset.meta`, data: Buffer.from("m") },
      { name: `${gA}/pathname`, data: Buffer.from("Assets/Foo/bar.prefab") },
      { name: `${gA}/preview.png`, data: PNG_1x1 },
      { name: `${gB}/asset`, type: "5" }, // 目录型资产
      { name: `${gB}/asset.meta`, data: Buffer.from("m") },
      { name: `${gB}/pathname`, data: Buffer.from("Assets/Foo") },
      { name: `${gC}/preview.png`, data: PNG_1x1 }, // preview 早于 asset（顺序回归）
      { name: `${gC}/asset`, data: Buffer.alloc(3, 2) },
      { name: `${gC}/pathname`, data: Buffer.from("Assets/Bar/baz.png") },
      { name: `${gD}/asset`, data: Buffer.alloc(5, 3) },
      { name: `${gD}/asset.meta`, data: Buffer.from("m") }, // 无 pathname → 不是资产
      { name: "stray.txt", data: Buffer.from("noise") }, // 非 GUID 顶层条目 → 忽略
    ]));
    const r = await parseUnityPackage(f);
    assert.equal(r.tarEntries, 13);
    assert.equal(r.guidCount, 4);
    assert.equal(r.assets.length, 3); // D 无 pathname，被正确排除
    const byGuid = new Map(r.assets.map((a) => [a.guid, a]));
    assert.equal(byGuid.get(gA)!.type, "Prefab");
    assert.equal(byGuid.get(gA)!.size, 12);
    assert.equal(byGuid.get(gA)!.hasPreview, true);
    assert.equal(byGuid.get(gB)!.type, null, "目录资产没有类型");
    assert.equal(byGuid.get(gB)!.size, null, "目录资产没有大小");
    assert.equal(byGuid.get(gB)!.hasPreview, false);
    assert.equal(byGuid.get(gC)!.hasPreview, true, "preview 先出现也必须记上");
    assert.equal(byGuid.get(gC)!.type, "Texture2D");
    assert.equal(byGuid.has(gD), false);
    // preview 字节逐字节相同
    assert.deepEqual(await readUnityPackagePreview(f, gC), PNG_1x1);
  } finally { cleanup(dir); }
});

test("listUnityPackage: 冻结接口形态 + maxAssets 截断", async (t) => {
  if (!has(SAMPLES.unitypackage)) return t.skip("unitypackage sample missing");
  const l = await listUnityPackage(SAMPLES.unitypackage);
  assert.equal(Object.keys(l).sort().join(","), "assets,truncated"); // 只有冻结字段
  assert.equal(l.assets.length, SAMPLES.manuka.guids);
  const cut = await listUnityPackage(SAMPLES.unitypackage, { maxAssets: 10 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.assets.length <= 10);
  assert.ok(cut.assets.length > 0);
});

test("unitypackage: 损坏/非 gzip/不存在/坏 guid → 可判别 AppError", async () => {
  const dir = tmpDir("up-bad");
  try {
    const notGzip = join(dir, "fake.unitypackage");
    writeFileSync(notGzip, Buffer.from("not a gzip stream at all, just text"));
    await assert.rejects(() => listUnityPackage(notGzip), (err: any) => err?.name === "AppError" && err.code === "NOT_AN_ARCHIVE");

    const truncated = join(dir, "cut.unitypackage");
    if (has(SAMPLES.unitypackage)) {
      const { readFileSync } = await import("node:fs");
      writeFileSync(truncated, readFileSync(SAMPLES.unitypackage).subarray(0, 2048));
      // 截断的 gzip/tar：要么报错，要么只解析出极少条目——两者都不能是"抛裸异常"
      try {
        const r = await listUnityPackage(truncated);
        assert.ok(r.assets.length < SAMPLES.manuka.guids);
      } catch (err: any) {
        assert.equal(err?.name, "AppError");
      }
    }

    await assert.rejects(() => listUnityPackage(join(dir, "absent.unitypackage")), (err: any) => err?.name === "AppError" && err.code === "NOT_FOUND");
    if (has(SAMPLES.unitypackage)) {
      await assert.rejects(() => readUnityPackagePreview(SAMPLES.unitypackage, "not-a-guid"), (err: any) => err?.name === "AppError" && err.code === "INVALID_INPUT");
      await assert.rejects(() => readUnityPackagePreview(SAMPLES.unitypackage, "zzzz"), (err: any) => err?.name === "AppError");
    }
  } finally { cleanup(dir); }
});
