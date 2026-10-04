import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Buffer, sha256File, sha256FileWithSize } from "../../src/hash";
import { cleanup, tmpDir } from "./fixtures";

/** 已知值对照组：明文 "hello\n" 的 SHA-256（与 sha256sum(1) 一致） */
const HELLO_SHA = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";

test("sha256File: 已知内容 → 已知哈希（正例）", async () => {
  const dir = tmpDir("hash");
  try {
    const f = join(dir, "hello.txt");
    writeFileSync(f, "hello\n");
    assert.equal(await sha256File(f), HELLO_SHA);
    assert.equal(sha256Buffer(Buffer.from("hello\n")), HELLO_SHA);
  } finally { cleanup(dir); }
});

test("sha256File: 与 sha256sum(1) 交叉一致（独立仪器）", async () => {
  const dir = tmpDir("hash-x");
  try {
    const f = join(dir, "data.bin");
    const buf = Buffer.alloc(3 * 1024 * 1024 + 7, 0x5a); // 跨多个 1 MiB 读块
    writeFileSync(f, buf);
    const mine = await sha256File(f);
    const theirs = execFileSync("sha256sum", [f], { encoding: "utf8" }).split(/\s+/)[0];
    assert.equal(mine, theirs);
    assert.equal(mine, sha256Buffer(buf)); // 流式与一次性口径一致
    const withSize = await sha256FileWithSize(f);
    assert.equal(withSize.sha256, mine);
    assert.equal(withSize.bytes, buf.length); // 度量定义：字节数 = 实际文件长度
    assert.equal(withSize.streamed, true);
  } finally { cleanup(dir); }
});

test("sha256File: 内容不同 → 哈希不同（反例对照，防退化度量）", async () => {
  const dir = tmpDir("hash-neg");
  try {
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    writeFileSync(a, "hello\n");
    writeFileSync(b, "hello\r\n"); // 仅差一个字节
    assert.notEqual(await sha256File(a), await sha256File(b));
  } finally { cleanup(dir); }
});

test("sha256File: 不存在 → AppError NOT_FOUND（可判别，不抛裸 ENOENT）", async () => {
  await assert.rejects(
    () => sha256File("/definitely/not/here/nope.bin"),
    (err: any) => err?.name === "AppError" && err.code === "NOT_FOUND" && err.status === 404,
  );
});
