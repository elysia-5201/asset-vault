/**
 * M0/P1 定点验证（只读仓内代码，不触碰 apps/server/**）：
 *   listPresentAssetsUnderPath 的路径段边界 + LIKE 通配符安全性。
 * 运行：node --import tsx test/repro/m0-repo-path-prefix.mjs
 * 这是 scratch 诊断脚本（非验收测试；不改动任何验收仪器）。
 */
import { openTempDb, addRoot, addItem, addAsset } from "../schema/_db.ts";
import { Repo } from "../../apps/server/src/db/repo.ts";

const t = openTempDb();
const { db } = t;
const rootId = addRoot(db, "c:/");
const itemId = addItem(db);
const P = (p) => addAsset(db, itemId, rootId, p);
P("c:/lib/a.zip");
P("c:/lib/sub/a.zip");
P("c:/lib");                 // 前缀自身（目录形态）也算命中
P("c:/library/a.zip");       // 反例：sibling
P("c:/lib2/a.zip");          // 反例：数字后缀
P("c:/lib_x/a.zip");         // 反例：LIKE 的 _ 通配符（old: "c:/libX" 会被 "_" 命中）
P("c:/li");
P("c:/my_lib/a.zip");
P("c:/myXlib/a.zip");        // 反例：old 里 "my_lib" 的 _ 会命中它
P("c:/mylib/b.zip");         // 大小写：入库侧唯一合法形态是 normalizePath 后的小写（path_norm 由调用方保证）

const repo = new Repo(db);
const ids = (rows) => rows.map((r) => r.path_norm).sort();
const check = (name, got, want) => {
  const ok = JSON.stringify([...got].sort()) === JSON.stringify([...want].sort());
  console.log((ok ? "PASS" : "FAIL") + " | " + name + "\n     got  = " + JSON.stringify([...got].sort()) + "\n     want = " + JSON.stringify([...want].sort()));
  return ok;
};
let all = true;
all = check("prefix='c:/lib'", ids(repo.listPresentAssetsUnderPath("c:/lib")), ["c:/lib", "c:/lib/a.zip", "c:/lib/sub/a.zip"]) && all;
all = check("prefix='c:/lib/' (尾斜杠等价)", ids(repo.listPresentAssetsUnderPath("c:/lib/")), ["c:/lib", "c:/lib/a.zip", "c:/lib/sub/a.zip"]) && all;
all = check("prefix='c:/lib2'", ids(repo.listPresentAssetsUnderPath("c:/lib2")), ["c:/lib2/a.zip"]) && all;
all = check("prefix='c:/my_lib' (下划线不被当通配符)", ids(repo.listPresentAssetsUnderPath("c:/my_lib")), ["c:/my_lib/a.zip"]) && all;
all = check("prefix='C:\\MyLib' (大小写/反斜杠归一)", ids(repo.listPresentAssetsUnderPath("C:\\MyLib")), ["c:/mylib/b.zip"]) && all;
all = check("prefix='c:/' (盘根)", ids(repo.listPresentAssetsUnderPath("c:/")), ["c:/lib", "c:/lib/a.zip", "c:/lib/sub/a.zip", "c:/library/a.zip", "c:/lib2/a.zip", "c:/lib_x/a.zip", "c:/li", "c:/my_lib/a.zip", "c:/myXlib/a.zip", "c:/mylib/b.zip"]) && all;
all = check("prefix='' (空)", ids(repo.listPresentAssetsUnderPath("")), []) && all;

// missing 门控符号可用性
const { missingWriteGate } = await import("../../apps/server/src/services/scan.ts");
const cases = [
  [{ truncated: false, errorCount: 0, readability: { rootReadable: true, dirsRead: 1, dirsFailed: 0, entriesStatFailed: 0 } }, true],
  [{ truncated: true,  errorCount: 0, readability: { rootReadable: true, dirsRead: 1, dirsFailed: 0, entriesStatFailed: 0 } }, false],
  [{ truncated: false, errorCount: 1, readability: { rootReadable: true, dirsRead: 1, dirsFailed: 1, entriesStatFailed: 0 } }, false],
  [{ truncated: false, errorCount: 0, readability: { rootReadable: false, dirsRead: 0, dirsFailed: 1, entriesStatFailed: 0 } }, false],
  [{ truncated: false, errorCount: 0, readability: { rootReadable: true, dirsRead: 1, dirsFailed: 0, entriesStatFailed: 0 } }, true],
];
for (const [s, want] of cases) {
  const g = missingWriteGate(s);
  const ok = g.allowed === want;
  all = all && ok;
  console.log((ok ? "PASS" : "FAIL") + " | gate " + JSON.stringify({ truncated: s.truncated, errorCount: s.errorCount, rootReadable: s.readability.rootReadable, dirsRead: s.readability.dirsRead }) + " -> allowed=" + g.allowed + " reasons=" + JSON.stringify(g.reasons));
}
t.close();
console.log(all ? "VERDICT=PASS" : "VERDICT=FAIL");
process.exit(all ? 0 : 1);
