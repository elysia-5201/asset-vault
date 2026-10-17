/**
 * 列表分页稳定性。
 *
 * 背景：扫描一次会批量建很多条目，updated_at 常落在同一毫秒。只按 updated_at / title / size 排序时
 * SQLite 的行序不保证稳定 → 分批翻页会**重复或漏掉**记录。所以排序必须带唯一兜底列 id。
 * 这里用"同一时间戳 / 同名 / 同大小"三组数据，逐页取并断言：总数一致、无重复、无遗漏。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../../apps/server/src/db/migrate";
import { Repo } from "../../apps/server/src/db/repo";

const fresh = () => { const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrate(db); return { db, repo: new Repo(db) }; };

/** 逐页取完，返回 id 序列（每页 limit）。 */
function pageThrough(repo: Repo, limit: number, sort: "updated" | "title" | "size", total: number): number[] {
  const out: number[] = [];
  for (let offset = 0; offset < total; offset += limit) {
    out.push(...repo.listItems({ limit, offset, sort }).items.map((x) => x.id));
  }
  return out;
}

describe("列表分页稳定性", () => {
  test("updated_at 全相同：翻页不重复、不遗漏", () => {
    const { db, repo } = fresh();
    const ids: number[] = [];
    for (let i = 0; i < 250; i++) ids.push(repo.createItem({ title: "item-" + String(i).padStart(3, "0") }).id);
    db.prepare("UPDATE items SET updated_at='2026-01-01T00:00:00.000Z'").run();
    const seen = pageThrough(repo, 100, "updated", 250);
    assert.equal(seen.length, 250);
    assert.equal(new Set(seen).size, 250, "翻页出现重复条目");
    assert.deepEqual([...seen].sort((a, b) => a - b), [...ids].sort((a, b) => a - b), "翻页丢了条目");
    db.close();
  });

  test("标题全相同：按 id 兜底，翻页稳定", () => {
    const { db, repo } = fresh();
    for (let i = 0; i < 120; i++) repo.createItem({ title: "同一个标题" });
    const seen = pageThrough(repo, 50, "title", 120);
    assert.equal(seen.length, 120);
    assert.equal(new Set(seen).size, 120);
    db.close();
  });

  test("大小全相同：按 id 兜底，翻页稳定", () => {
    const { db, repo } = fresh();
    const root = repo.ensureRoot("/tmp/pg");
    for (let i = 0; i < 90; i++) {
      const item = repo.createItem({ title: "size-" + i });
      repo.upsertAsset({ item_id: item.id, kind: "archive", container: "zip", path: "/tmp/pg/f" + i + ".zip",
        path_norm: "/tmp/pg/f" + i + ".zip", root_id: root.id, size: 1000, discovered_by: "scan" });
    }
    const seen = pageThrough(repo, 40, "size", 90);
    assert.equal(seen.length, 90);
    assert.equal(new Set(seen).size, 90);
    db.close();
  });

  test("翻页区间与 total 自洽（offset 越界返回空）", () => {
    const { db, repo } = fresh();
    for (let i = 0; i < 10; i++) repo.createItem({ title: "t" + i });
    assert.equal(repo.listItems({ limit: 3, offset: 9 }).items.length, 1);
    assert.equal(repo.listItems({ limit: 3, offset: 10 }).items.length, 0);
    assert.equal(repo.listItems({ limit: 3, offset: 99 }).items.length, 0);
    db.close();
  });
});
