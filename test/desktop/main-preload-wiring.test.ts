/**
 * Desktop 打包/接线静态断言（不是真实 Electron 启动的替代）。
 *
 * 结构绑定（评审 WARN-1 修复）：用 TypeScript AST 解析 main.mjs，要求
 *   - preload 是 BrowserWindow 参数对象里 webPreferences 对象字面量的属性；
 *   - 其初始化器恰为 join(here, "preload.cjs")；
 *   - here 由 dirname(fileURLToPath(import.meta.url)) 初始化。
 * 注释天然被 AST 忽略；三个坏变异（preload 移出 webPreferences / 注释掉 / here=process.cwd()）
 * 都必须被拒绝。变异只在内存字符串上做，不改 live main.mjs。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const mainSrc = readFileSync(join(root, "apps", "desktop", "main.mjs"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  build?: { files?: string[] };
};

interface WiringVerdict { ok: boolean; reason: string }

function findProp(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | null {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p;
  }
  return null;
}

function findVariable(sf: ts.SourceFile, name: string): ts.VariableDeclaration | null {
  let found: ts.VariableDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** 结构检查：preload 必须在 BrowserWindow.webPreferences 内，here 必须来自 import.meta.url。 */
function checkWiring(src: string): WiringVerdict {
  const sf = ts.createSourceFile("main.mjs", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  let bw: ts.NewExpression | null = null;
  const findBw = (node: ts.Node): void => {
    if (bw) return;
    if (ts.isNewExpression(node) && node.expression.getText(sf) === "BrowserWindow") { bw = node; return; }
    ts.forEachChild(node, findBw);
  };
  findBw(sf);
  if (!bw) return { ok: false, reason: "未找到 new BrowserWindow(...)" };

  const arg = (bw as ts.NewExpression).arguments?.[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return { ok: false, reason: "BrowserWindow 参数不是对象字面量" };

  const wp = findProp(arg, "webPreferences");
  if (!wp || !ts.isObjectLiteralExpression(wp.initializer)) return { ok: false, reason: "webPreferences 不是对象字面量" };

  const pre = findProp(wp.initializer, "preload");
  if (!pre) return { ok: false, reason: "webPreferences 内缺少 preload（顶层/注释掉都不算）" };

  const init = pre.initializer;
  if (!ts.isCallExpression(init) || init.expression.getText(sf) !== "join") return { ok: false, reason: "preload 必须是 join(...)" };
  const args = init.arguments;
  if (args.length !== 2 || args[0]!.getText(sf) !== "here" || !ts.isStringLiteral(args[1]!) || args[1]!.text !== "preload.cjs") {
    return { ok: false, reason: 'preload 必须是 join(here, "preload.cjs")' };
  }

  const hereDecl = findVariable(sf, "here");
  if (!hereDecl) return { ok: false, reason: "未找到 here 声明" };
  const hInit = hereDecl.initializer;
  if (!hInit || !ts.isCallExpression(hInit) || hInit.expression.getText(sf) !== "dirname") return { ok: false, reason: "here 必须由 dirname(...) 初始化" };
  const inner = hInit.arguments[0];
  if (!inner || !ts.isCallExpression(inner) || inner.expression.getText(sf) !== "fileURLToPath") return { ok: false, reason: "here 必须由 fileURLToPath(...) 初始化" };
  const meta = inner.arguments[0];
  if (!meta || meta.getText(sf) !== "import.meta.url") return { ok: false, reason: "here 必须来自 import.meta.url" };

  return { ok: true, reason: "" };
}

const MUT_TOPLEVEL = mainSrc
  .replace('webPreferences: { contextIsolation: true, nodeIntegration: false, preload: join(here, "preload.cjs") }',
    'webPreferences: { contextIsolation: true, nodeIntegration: false }')
  .replace("new BrowserWindow({", 'new BrowserWindow({\n      preload: join(here, "preload.cjs"),');
const MUT_COMMENTED = mainSrc.replace('preload: join(here, "preload.cjs")', '/* preload: join(here, "preload.cjs") */');
const MUT_HERE = mainSrc.replace("const here = dirname(fileURLToPath(import.meta.url));", "const here = process.cwd();");

test("main.mjs：真实接线通过结构检查", () => {
  const v = checkWiring(mainSrc);
  assert.equal(v.ok, true, v.reason);
});

test("变异：preload 移到 BrowserWindow 顶层 → 必须拒绝", () => {
  assert.notEqual(MUT_TOPLEVEL, mainSrc, "mutation must apply");
  const v = checkWiring(MUT_TOPLEVEL);
  assert.equal(v.ok, false, "preload 不在 webPreferences 内必须被拒");
  assert.match(v.reason, /webPreferences/);
});

test("变异：preload 被注释掉 → 必须拒绝", () => {
  assert.notEqual(MUT_COMMENTED, mainSrc, "mutation must apply");
  const v = checkWiring(MUT_COMMENTED);
  assert.equal(v.ok, false, "注释掉的 preload 必须被拒");
  assert.match(v.reason, /preload/);
});

test("变异：here = process.cwd() → 必须拒绝", () => {
  assert.notEqual(MUT_HERE, mainSrc, "mutation must apply");
  const v = checkWiring(MUT_HERE);
  assert.equal(v.ok, false, "here 必须来自 import.meta.url");
  assert.match(v.reason, /dirname|fileURLToPath|import\.meta/);
});

test("main.mjs：未放宽隔离，包内拖动仅允许应用主帧", () => {
  assert.match(mainSrc, /contextIsolation:\s*true/);
  assert.match(mainSrc, /nodeIntegration:\s*false/);
  assert.doesNotMatch(mainSrc, /sandbox:\s*false/, "不得关闭 sandbox");
  assert.match(mainSrc, /event\.sender !== win\.webContents \|\| frame !== win\.webContents\.mainFrame/);
  assert.match(mainSrc, /new URL\(frame\.url\)\.origin === handle\.url/);
  assert.match(mainSrc, /archiveDrag\.fileForToken\(token\)/);
  assert.match(mainSrc, /startDrag\(\{ file, icon: dragIcon \}\)/);
});

test("package.json：build.files 含 preload.cjs（与 main.mjs 同目录）", () => {
  const files = pkg.build?.files ?? [];
  assert.ok(files.includes("apps/desktop/preload.cjs"), "打包清单必须包含 preload.cjs");
  assert.ok(files.includes("apps/desktop/main.mjs"));
});
