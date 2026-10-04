/**
 * ③b FTS5 trigram 中日文子串命中测试（verifier / task-4）
 *
 * 被测：apps/server/src/db/schema.sql 的 items_fts(tokenize='trigram')
 * 口径（schema 注释写明）：>=3 字符走 FTS 子串；<3 字符 FTS 无法出 token（应用层回退 LIKE）。
 * 正/负例成对：命中必须命中、缺词必须为 0、2 字符子串在 FTS 层必须为 0（这是分词阈值，不是缺陷），
 * 并对照 LIKE 查询 items 基表能命中 —— 证明上面的 0 来自 FTS 阈值而非数据缺失。
 *
 * 注意（测量期间基线变化）：lead 在 verifier 测量期间把 items_fts 的 `content=''` 去掉了，
 * 该表因此是 **内容存储型**（列可读回、可普通 DELETE）；本文件据此断言。若改回 contentless，
 * 最后两条会红 —— 那正是应用层 reindex/删除路径要重新适配的信号。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addItem, type TempDb } from "./_db";

let t: TempDb;
const TITLE1 = "【12アバター対応】マヌカちゃん用 衣装セット";
before(() => {
  t = openTempDb();
  const ins = t.db.prepare("INSERT INTO items_fts(rowid, title, shop_name, author, description, notes, tags_text) VALUES (?,?,?,?,?,?,?)");
  ins.run(1, TITLE1, "マヌカ屋", "まぬか", "マヌカ対応の衣装です", "メモ", "booth 衣装");
  ins.run(2, "Loli_Shinano_6115428 対応1.01", "ShinanoShop", "しなの", "雪乃ちゃん用の髪型", null, "hair");
  ins.run(3, "Milfy 対応 フルセット", "Milfy", "みるふぃ", "ミルフィ用のセット", null, "set");
});
after(() => t.close());

const hits = (q: string): number[] =>
  (t.db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ? ORDER BY rowid").all(q) as { rowid: number }[]).map((r) => r.rowid);

describe("trigram 日文子串（>=3 字符）", () => {
  test("正例：前缀 マヌカ → 命中 rowid 1", () => {
    assert.deepEqual(hits("マヌカ"), [1]);
  });
  test("正例：**中段**子串 ヌカち（非前缀）也命中 —— trigram 的价值所在", () => {
    assert.deepEqual(hits("ヌカち"), [1]);
  });
  test("正例：跨字段边界子串 ちゃん用 命中 1（title）与 2（description）", () => {
    // row2 的 description 是「雪乃ちゃん用の髪型」——同一 token 命中不同列
    assert.deepEqual(hits("ちゃん用"), [1, 2]);
  });
  test("负例：不存在的词 只命中它真正所在的 rowid 3", () => {
    assert.deepEqual(hits("ミルフィ"), [3]);
  });
});

describe("trigram 中文子串（>=3 字符）", () => {
  test("正例：中段子串 乃ちゃ → 命中 rowid 2", () => {
    assert.deepEqual(hits("乃ちゃ"), [2]);
  });
  test("正例：含数字的 3 字符子串 対応1 → 命中有「対応1.01」的 rowid 2", () => {
    assert.deepEqual(hits("対応1"), [2]);
  });
  test("边界：2 字符子串 雪乃 在 FTS 层为 0 行（<3 字符必须回退 LIKE，见下一条对照）", () => {
    assert.deepEqual(hits("雪乃"), []);
  });
  test("正例对照：同一份数据 items 基表 LIKE '%雪乃%' 命中 1 行 —— 证明上面的 0 是分词阈值", () => {
    addItem(t.db, { uid: "u-fts-like", source_item_id: "7001", title: "雪乃ちゃん用の髪型" });
    const n = Number((t.db.prepare("SELECT COUNT(*) AS n FROM items WHERE title LIKE ?").get("%雪乃%") as { n: number }).n);
    assert.equal(n, 1, "LIKE 回退路径必须能命中 2 字符查询");
    assert.deepEqual(hits("雪乃"), [], "FTS 层对 2 字符仍应为 0");
  });
});

describe("trigram ASCII 子串与大小写", () => {
  test("正例：ASCII 中段子串 hinano（在 Shinano 内部）命中 rowid 2", () => {
    assert.deepEqual(hits("hinano"), [2]);
  });
  test("正例：大小写不敏感（Shinano / SHINANO / shinano 同结果）", () => {
    assert.deepEqual(hits("shinano"), [2]);
    assert.deepEqual(hits("SHINANO"), [2]);
    assert.deepEqual(hits("hinano"), hits("HINANO"));
  });
  test("负例：不存在的 ASCII 子串 qwerty 必须 0 行", () => {
    assert.deepEqual(hits("qwerty"), []);
  });
});

describe("分词器配置与维护路径（行为断言，不只看 DDL 文本）", () => {
  test("DDL 声明 tokenize='trigram'", () => {
    const sql = String((t.db.prepare("SELECT sql FROM sqlite_master WHERE name='items_fts'").get() as { sql: string }).sql);
    assert.match(sql, /fts5/i);
    assert.match(sql, /tokenize\s*=\s*'trigram'/i);
  });

  test("当前模式：内容存储型（title 列可读回；若 content='' 恢复则本断言应改为 NULL）", () => {
    const row = t.db.prepare("SELECT title FROM items_fts WHERE rowid=1").get() as { title: string | null };
    console.log("      items_fts content mode:", row.title === null ? "contentless (content='')" : "content-storing");
    assert.equal(row.title, TITLE1);
  });

  test("维护路径：DELETE 一条 FTS 行后该行不再被命中（contentless 表此处会抛错）", () => {
    const fresh = openTempDb();
    try {
      fresh.db.prepare("INSERT INTO items_fts(rowid, title) VALUES (10, 'ミルフィ 対応')").run();
      assert.deepEqual((fresh.db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ?").all("ルフィ") as { rowid: number }[]).map((r) => r.rowid), [10]);
      fresh.db.prepare("DELETE FROM items_fts WHERE rowid=10").run();
      assert.deepEqual(fresh.db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ?").all("ルフィ"), []);
    } finally { fresh.close(); }
  });

  test("负例：FTS 语法错误（未闭合引号）必须抛错而不是静默返回空集", () => {
    assert.throws(() => t.db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ?").all('"unbalanced'));
  });
});
