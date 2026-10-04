// 把本机专属信息（绝对路径 / WSL 发行版名 / 用户名 / 含露骨字样的素材名）替换成占位符，便于公开或分享。
// 用法：node scripts/sanitize-for-git.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const RULES = [
  // 本机具体路径（先处理长前缀，再兜底盘符）
  [/E:\\\\tool\\\\asset-vault/g, "%APP_DIR%"],
  [/E:\/tool\/asset-vault/g, "%APP_DIR%"],
  [/E:\\\\game\\\\vrchatcache\\\\素材库/g, "%LIBRARY%/素材库"],
  [/E:\/game\/vrchatcache\/素材库/g, "%LIBRARY%/素材库"],
  [/E:\\\\game\\\\vrchatcache/g, "%LIBRARY%"],
  [/E:\/game\/vrchatcache/g, "%LIBRARY%"],
  [/E:\\\\IDM\\\\压缩文件/g, "%DOWNLOADS%"],
  [/E:\/IDM\/压缩文件/g, "%DOWNLOADS%"],
  [/\/mnt\/e\/game\/vrchatcache\/素材库/g, "%LIBRARY%/素材库"],
  [/\/mnt\/e\/game\/vrchatcache/g, "%LIBRARY%"],
  [/\/mnt\/e\/IDM\/压缩文件/g, "%DOWNLOADS%"],
  [/\/mnt\/[a-z]\//g, "<win-drive>/"],
  [/\/root\/Code\/asset-vault/g, "<repo>"],
  [/\\\\wsl\\.localhost\\[^\\]+\\[^"\x27]*?asset-vault/g, "\\\\wsl.localhost\\<distro>\\<repo>"],
  [/\\\\wsl\\.localhost\\Ubuntu[^\\\\]*/g, "\\\\wsl.localhost\\<distro>"],
  [/Ubuntu-26\.04-LTS/g, "<distro>"],
  // 兜底：任何盘符路径
  [/\bE:([\\\\/])/g, "<drive>:$1"],
  // 账号名
  [new RegExp(process.env.GIT_SCRUB_USER ?? "your-github-login", "g"), "example-user"],
  [new RegExp(process.env.GIT_SCRUB_USER_SHORT ?? "your-user", "gi"), "user"],
  // 含露骨字样的真实商品名 → 保留结构、去掉字样（测试语义不变）
  [/💘胡蝶の夢（Butterfly Pussy） ぬるぬるおまんこ💘/g, "❀チョウチョの夢（Butterfly）❀"],
  [/ミルフィちゃん専用おまんこテクスチャ/g, "ミルフィちゃん専用テクスチャ"],
  [/Sucubus_Shinano/g, "Outfit_Shinano"],
  [/\[19 Avatars\] citrus shop Soft R18 Texture/g, "[19 Avatars] citrus shop Soft Texture"],
  [/おまんこ|まんこ|Pussy/gi, "texture"],
];

const files = execSync("git ls-files", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
let changed = 0;
for (const f of files) {
  if (f === "package-lock.json" || f.startsWith("scripts/sanitize-for-git")) continue;
  let src;
  try { src = readFileSync(f, "utf8"); } catch { continue; }
  if (src.includes("\u0000")) continue;
  let out = src;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  if (out !== src) { writeFileSync(f, out); changed++; console.log("  scrubbed:", f); }
}
console.log("files changed:", changed);