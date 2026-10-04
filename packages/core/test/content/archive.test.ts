import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectContainer,
  listArchive,
  listArchiveWith7zip,
  readArchiveEntry,
  readArchiveEntryWith7zip,
} from "../../src/archive/list";
import { unrarAvailable } from "../../src/archive/rar";
import { sha256Buffer } from "../../src/hash";
import { SAMPLES, buildZip, cleanup, crc32, has, SHIFT_JIS_TEST_NAME, tmpDir } from "./fixtures";

const ZIP_PASSWORD_ERR = (err: any) => err?.name === "AppError" && err.code === "ARCHIVE_PASSWORD";
const NOT_ARCHIVE_ERR = (err: any) => err?.name === "AppError" && err.code === "NOT_AN_ARCHIVE";
const NOT_FOUND_ERR = (err: any) => err?.name === "AppError" && err.code === "NOT_FOUND";

// ---------------------------------------------------------------- 容器探测

test("detectContainer: 魔数优先于扩展名（正例/反例对照）", async () => {
  const dir = tmpDir("detect");
  try {
    const zipBytes = buildZip([{ name: "a.txt", data: Buffer.from("x") }]);
    const disguised = join(dir, "actually-a-zip.7z"); // 扩展名撒谎，魔数说真话
    writeFileSync(disguised, zipBytes);
    assert.equal(detectContainer(disguised), "zip");
    const random = join(dir, "broken.zip"); // 魔数不认识 → 回退扩展名
    writeFileSync(random, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    assert.equal(detectContainer(random), "zip");
    const nothing = join(dir, "mystery.bin");
    writeFileSync(nothing, Buffer.from([9, 9, 9, 9]));
    assert.equal(detectContainer(nothing), null);
    // 真实样本断言：样本不在（未设 AV_SAMPLES_DIR）时跳过，合成样本断言始终执行
    if (has(SAMPLES.zipSmall)) assert.equal(detectContainer(SAMPLES.zipSmall), "zip");
    if (has(SAMPLES.sevenZip)) assert.equal(detectContainer(SAMPLES.sevenZip), "7z");
    if (has(SAMPLES.unitypackage)) assert.equal(detectContainer(SAMPLES.unitypackage), "unitypackage");
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------- zip

test("zip: 真实样本列目录（10 条目，含 readme.txt）", async (t) => {
  if (!has(SAMPLES.zipSmall)) return t.skip("sample zip missing");
  const l = await listArchive(SAMPLES.zipSmall);
  assert.equal(l.container, "zip");
  assert.equal(l.truncated, false);
  assert.equal(l.passwordProtected, false);
  assert.equal(l.entries.length, 10);
  // 度量定义：条目数 = 中央目录条目数（含目录条目）。以 readme.txt 作为已知正例。
  const readme = l.entries.find((e) => e.path === "KawaiiPosing_Ver.3.0.3/readme.txt");
  assert.ok(readme, "readme.txt 应在条目表里");
  assert.equal(readme!.isDir, false);
  assert.ok(readme!.size > 1000, `readme 应有实际大小，得到 ${readme!.size}`);
});

test("zip: 与 7za 独立解析器交叉一致（两套仪器，路径集合完全相等）", async (t) => {
  if (!has(SAMPLES.zipSmall)) return t.skip("sample zip missing");
  const mine = await listArchive(SAMPLES.zipSmall);
  const theirs = await listArchiveWith7zip(SAMPLES.zipSmall, "zip", 100000);
  const a = mine.entries.map((e) => e.path).sort();
  const b = theirs.entries.map((e) => e.path).sort();
  assert.deepEqual(a, b);
});

test("zip: 单条目读取 = 7za 读取 = 声明 CRC（三方一致）", async (t) => {
  if (!has(SAMPLES.zipSmall)) return t.skip("sample zip missing");
  const path = "KawaiiPosing_Ver.3.0.3/readme.txt";
  const listing = await listArchive(SAMPLES.zipSmall);
  const declared = listing.entries.find((e) => e.path === path)!;
  const viaStreamZip = await readArchiveEntry(SAMPLES.zipSmall, path);
  const via7za = await readArchiveEntryWith7zip(SAMPLES.zipSmall, "zip", path, 64 * 1024 * 1024);
  assert.equal(viaStreamZip.length, declared.size); // 声明大小 == 实读长度
  assert.equal(sha256Buffer(viaStreamZip), sha256Buffer(via7za)); // 两条独立解包路径字节相同
  assert.equal(crc32(viaStreamZip), declared.crc); // 且与中央目录 CRC 相符
});

test("zip: maxEntries 截断 → truncated=true 且条目数受限", async (t) => {
  if (!has(SAMPLES.zipSmall)) return t.skip("sample zip missing");
  const l = await listArchive(SAMPLES.zipSmall, { maxEntries: 3 });
  assert.equal(l.entries.length, 3);
  assert.equal(l.truncated, true);
});

test("zip: 加密标志位 → passwordProtected=true；读条目 → ARCHIVE_PASSWORD", async () => {
  const dir = tmpDir("zip-enc");
  try {
    const f = join(dir, "enc.zip");
    writeFileSync(f, buildZip([{ name: "secret.txt", data: Buffer.from("top secret"), encrypted: true }]));
    const l = await listArchive(f);
    assert.equal(l.passwordProtected, true);
    assert.deepEqual(l.entries.map((e) => e.path), ["secret.txt"]);
    await assert.rejects(() => readArchiveEntry(f, "secret.txt"), ZIP_PASSWORD_ERR);
  } finally { cleanup(dir); }
});

test("zip: 旧编码文件名（无 UTF-8 标志位）→ 正确解码为 Shift-JIS，并在 note 标注", async () => {
  const dir = tmpDir("zip-sjis");
  try {
    const f = join(dir, "sjis.zip");
    writeFileSync(f, buildZip([{ name: "テスト.txt", nameBytes: SHIFT_JIS_TEST_NAME, data: Buffer.from("hello") }]));
    const l = await listArchive(f);
    assert.deepEqual(l.entries.map((e) => e.path), ["テスト.txt"]); // 不是 "\uFFFD\uFFFDe\uFFFD\uFFFDT.txt"
    assert.ok((l.note ?? "").includes("shift_jis"), `note 应标注编码，得到 ${JSON.stringify(l.note)}`);
    assert.equal((await readArchiveEntry(f, "テスト.txt")).toString("utf8"), "hello"); // 解码后的名字能回读
  } finally { cleanup(dir); }
});

test("zip: GBK 文件名 → 解成中文（不误判为 Shift-JIS）", async () => {
  const dir = tmpDir("zip-gbk");
  try {
    const gbk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0x2e, 0x74, 0x78, 0x74]); // "测试.txt"
    assert.equal(new TextDecoder("gbk").decode(gbk), "测试.txt"); // 夹具自检
    const f = join(dir, "gbk.zip");
    writeFileSync(f, buildZip([{ name: "测试.txt", nameBytes: gbk, data: Buffer.from("hi") }]));
    const l = await listArchive(f);
    assert.deepEqual(l.entries.map((e) => e.path), ["测试.txt"]);
    assert.ok((l.note ?? "").includes("gbk"));
  } finally { cleanup(dir); }
});

test("zip: UTF-8 标志位正常时不做多余探测（反例对照：note 为空）", async () => {
  const dir = tmpDir("zip-utf8");
  try {
    const f = join(dir, "utf8.zip");
    writeFileSync(f, buildZip([{ name: "テスト.txt", data: Buffer.from("hello") }]));
    const l = await listArchive(f);
    assert.deepEqual(l.entries.map((e) => e.path), ["テスト.txt"]);
    assert.equal(l.note, undefined);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------- 7z

test("7z: 真实样本列目录（29 条目）", async (t) => {
  if (!has(SAMPLES.sevenZip)) return t.skip("sample 7z missing");
  const l = await listArchive(SAMPLES.sevenZip);
  assert.equal(l.container, "7z");
  assert.equal(l.entries.length, 29);
  assert.equal(l.truncated, false);
  assert.equal(l.passwordProtected, false);
  assert.ok(l.entries.some((e) => e.isDir), "应有目录条目");
  assert.ok(l.entries.some((e) => !e.isDir), "应有文件条目");
});

test("7z: 解出的字节 CRC == 声明的 CRC（字节级正确性，独立 crc32 实现）", async (t) => {
  if (!has(SAMPLES.sevenZip)) return t.skip("sample 7z missing");
  const l = await listArchive(SAMPLES.sevenZip);
  const target = l.entries.find((e) => !e.isDir && e.crc !== null && e.size > 0);
  assert.ok(target, "应能找到带 CRC 的文件条目");
  const data = await readArchiveEntry(SAMPLES.sevenZip, target!.path, 64 * 1024 * 1024);
  assert.equal(data.length, target!.size);
  assert.equal(crc32(data), target!.crc);
});

test("7z: maxEntries 截断 + 不存在的条目 → NOT_FOUND", async (t) => {
  if (!has(SAMPLES.sevenZip)) return t.skip("sample 7z missing");
  const l = await listArchive(SAMPLES.sevenZip, { maxEntries: 5 });
  assert.equal(l.entries.length, 5);
  assert.equal(l.truncated, true);
  await assert.rejects(() => readArchiveEntry(SAMPLES.sevenZip, "no/such/entry.bin"), NOT_FOUND_ERR);
});

// ---------------------------------------------------------------- rar

test("rar: 有 node-unrar-js 时列出并直读；未安装时抛可判别的 NOT_AN_ARCHIVE", async (t) => {
  if (!has(SAMPLES.rar)) return t.skip("sample rar missing");
  if (await unrarAvailable()) {
    const l = await listArchive(SAMPLES.rar);
    assert.equal(l.container, "rar");
    assert.ok(l.entries.length > 0, `应列出条目，得到 ${l.entries.length}`);
    const target = l.entries.find((e) => !e.isDir && e.size > 0);
    assert.ok(target, "应有文件条目");
    const data = await readArchiveEntry(SAMPLES.rar, target!.path, 64 * 1024 * 1024);
    assert.equal(data.length, target!.size);
  } else {
    await assert.rejects(
      () => listArchive(SAMPLES.rar),
      (err: any) => err?.name === "AppError" && err.code === "NOT_AN_ARCHIVE" && /node-unrar-js/.test(err.message),
    );
  }
});

test("rar: 7za(16.02) 对合法 RAR 报 NOT_AN_ARCHIVE —— 这就是必须换 node-unrar-js 的证据", async (t) => {
  if (!has(SAMPLES.rar)) return t.skip("sample rar missing");
  // 注意：这条用例断言的是"7za 无 RAR codec"这一环境事实（它与 node-unrar-js 是否安装无关）。
  await assert.rejects(
    () => listArchiveWith7zip(SAMPLES.rar, "rar", 10),
    (err: any) => err?.name === "AppError" && err.code === "NOT_AN_ARCHIVE",
  );
});

// ---------------------------------------------------------------- 损坏 / 边界

test("损坏包/非包/目录/空文件 → 全部可判别错误，不抛裸异常", async () => {
  const dir = tmpDir("broken");
  try {
    const random = join(dir, "random.zip");
    writeFileSync(random, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)));
    await assert.rejects(() => listArchive(random), NOT_ARCHIVE_ERR);

    const empty = join(dir, "empty.zip");
    writeFileSync(empty, Buffer.alloc(0));
    await assert.rejects(() => listArchive(empty), NOT_ARCHIVE_ERR);

    const truncated = join(dir, "truncated.zip");
    if (has(SAMPLES.zipSmall)) {
      writeFileSync(truncated, readFileSync(SAMPLES.zipSmall).subarray(0, 1024));
      await assert.rejects(() => listArchive(truncated), NOT_ARCHIVE_ERR);
    }

    const asdir = join(dir, "dir.zip");
    mkdirSync(asdir); // 同名目录：不是文件
    await assert.rejects(() => listArchive(asdir), NOT_ARCHIVE_ERR);

    await assert.rejects(() => listArchive(join(dir, "nope.zip")), NOT_FOUND_ERR);

    // unitypackage 交给 listArchive → 明确指引，不是含糊的解析失败
    if (has(SAMPLES.unitypackage)) {
      await assert.rejects(
        () => listArchive(SAMPLES.unitypackage),
        (err: any) => err?.name === "AppError" && err.code === "NOT_AN_ARCHIVE" && /listUnityPackage/.test(err.message),
      );
    }
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------- 恶意条目名（中央目录回退路径）

test("zip: 含反斜杠/绝对路径/盘符/.. 的包 → 归一化 + 只跳危险项，其余仍可列可读", async () => {
  const dir = tmpDir("zip-unsafe");
  try {
    const BS = String.fromCharCode(92); // 反斜杠：用 charCode 构造，避免测试源码里的转义歧义
    const safe1 = Buffer.from("safe one");
    const safe2 = Buffer.from("compressible ".repeat(400));
    const f = join(dir, "unsafe.zip");
    writeFileSync(f, buildZip([
      { name: "safe/one.txt", data: safe1 },
      { name: ["world", "advancements", "a.json"].join(BS), data: Buffer.from("world") },
      { name: "/etc/passwd", data: Buffer.from("absolute") },
      { name: "C:" + BS + "evil.txt", data: Buffer.from("drive-letter") },
      { name: ["..", "..", "evil.txt"].join(BS), data: Buffer.from("traversal") },
      { name: ["safe", "two.txt"].join(BS), data: safe2, method: "deflate" },
    ]));
    const l = await listArchive(f);
    assert.equal(l.container, "zip");
    assert.deepEqual(l.entries.map((e) => e.path).sort(), ["safe/one.txt", "safe/two.txt", "world/advancements/a.json"]);
    assert.ok(l.entries.every((e) => !e.path.includes(BS)), "输出路径不应再含反斜杠");
    assert.ok((l.note ?? "").includes("normalized 2 backslash paths"), `note=${l.note}`);
    assert.ok((l.note ?? "").includes("skipped 3 unsafe entries"), `note=${l.note}`);

    // store 与 deflate 两条读取路径都要对（deflate 走自研 inflateRawSync）
    assert.deepEqual(await readArchiveEntry(f, "safe/one.txt"), safe1);
    const two = await readArchiveEntry(f, "safe/two.txt");
    assert.deepEqual(two, safe2);
    assert.equal(crc32(two), l.entries.find((e) => e.path === "safe/two.txt")!.crc);
    assert.deepEqual(await readArchiveEntry(f, "world/advancements/a.json"), Buffer.from("world"));

    // 危险项被跳过 ⇒ 不该能读到（既不是静默成功，也不是整包 500）
    await assert.rejects(() => readArchiveEntry(f, "/etc/passwd"), NOT_FOUND_ERR);
    await assert.rejects(() => readArchiveEntry(f, "C:/evil.txt"), NOT_FOUND_ERR);
    await assert.rejects(() => readArchiveEntry(f, "../../evil.txt"), NOT_FOUND_ERR);
  } finally { cleanup(dir); }
});

test("zip: 真实 Windows 备份包（901 条全反斜杠名）→ 不再整包失败，可列可读", async (t) => {
  if (!has(SAMPLES.zipBackslash)) return t.skip("backslash zip sample missing");
  const l = await listArchive(SAMPLES.zipBackslash);
  assert.equal(l.container, "zip");
  assert.equal(l.entries.length, 901); // 度量定义：中央目录条目数（含目录）
  assert.ok(l.entries.every((e) => !e.path.includes(String.fromCharCode(92))));
  assert.ok((l.note ?? "").includes("normalized 901"), `note=${l.note}`);
  // 独立仪器交叉核对条目数
  const via7za = await listArchiveWith7zip(SAMPLES.zipBackslash, "zip", 100000);
  assert.equal(via7za.entries.length, l.entries.length);
  // 直读一条并核对声明大小与 CRC（deflate → 自研 inflate 路径）
  const target = l.entries.find((e) => !e.isDir && e.size > 0)!;
  const d = await readArchiveEntry(SAMPLES.zipBackslash, target.path);
  assert.equal(d.length, target.size);
  assert.equal(crc32(d), target.crc);
});

test("readArchiveEntry: 参数校验（空路径/超大上限）", async (t) => {
  if (!has(SAMPLES.zipSmall)) return t.skip("sample zip missing");
  await assert.rejects(() => readArchiveEntry(SAMPLES.zipSmall, ""), (err: any) => err?.name === "AppError" && err.code === "INVALID_INPUT");
  await assert.rejects(() => readArchiveEntry(SAMPLES.zipSmall, "KawaiiPosing_Ver.3.0.3/readme.txt", 0), (err: any) => err?.name === "AppError" && err.code === "INVALID_INPUT");
  // maxBytes 小于条目实际大小 → 拒绝而不是 OOM
  await assert.rejects(
    () => readArchiveEntry(SAMPLES.zipSmall, "KawaiiPosing_Ver.3.0.3/readme.txt", 16),
    (err: any) => err?.name === "AppError" && err.code === "INVALID_INPUT" && /too large/.test(err.message),
  );
});
