/**
 * v0.7.0 结构验收夹具生成器（task-40 / verifier）
 *
 * 用法：
 *   node test/fixtures/structure/generate.mjs            # 生成到 test/fixtures/structure/out/
 *   node test/fixtures/structure/generate.mjs <outDir>
 *   import { generateFixtures } from ".../generate.mjs"  # 验收脚本调用（生成到临时目录）
 *
 * 设计：真实 zip / tar.gz（unitypackage），不 mock；每个 .unitypackage 含 <guid>/pathname、
 * <guid>/asset、<guid>/asset.meta（YAML，含 guid + pathname）与可选 preview.png。
 * 生成是确定性的（固定 mtime、内容由路径 md5 派生），可重复执行。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PY = String.raw`
import sys, os, io, tarfile, zipfile, hashlib

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

def guid(path):
    return hashlib.md5(path.encode("utf-8")).hexdigest()

def upkg_bytes(paths, preview=False):
    """构建一个真实 unitypackage：tar.gz，里面每个资产一个 <guid>/ 目录。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.USTAR_FORMAT) as tar:
        for path in paths:
            g = guid(path)
            def add(name, data):
                ti = tarfile.TarInfo(g + "/" + name)
                ti.size = len(data); ti.mtime = 0; ti.mode = 0o644
                tar.addfile(ti, io.BytesIO(data))
            add("pathname", path.encode("utf-8"))
            add("asset", (path + " fixture content").encode("utf-8"))
            meta = "fileFormatVersion: 2\nguid: " + g + "\npathname: " + path + "\n"
            add("asset.meta", meta.encode("utf-8"))
            if preview:
                add("preview.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    return buf.getvalue()

def write(name, data):
    p = os.path.join(out, name)
    with open(p, "wb") as f:
        f.write(data)
    return p

def zip_bytes(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            z.writestr(name, data)
    return buf.getvalue()

MANUKA = "Assets/Manuka/Manuka_body.fbx"
MANUKA_MAT = "Assets/Manuka/Manuka_body_MAT.mat"
MANUKA_TEX = "Assets/Manuka/Manuka_TEX.png"
KIKYO = "Assets/Kikyo/Kikyo_body.fbx"

# A：外层 zip，2+ 独立 upkg（Manuka 服装/材质 + 另一个 Avatar）+ 说明.pdf
a = zip_bytes([
    ("MANUKA_clothing/MANUKA.unitypackage", upkg_bytes([MANUKA])),
    ("MANUKA_materials/MANUKA_mat.unitypackage", upkg_bytes([MANUKA_MAT])),
    ("OTHER_AVATAR/Kikyo.unitypackage", upkg_bytes([KIKYO])),
    ("说明.pdf", b"%PDF-1.4\n% fixture doc\n"),
])
write("A_multi_container.zip", a)

# B：单个 upkg 内混合 2 个 Avatar 路径
b = upkg_bytes([MANUKA, KIKYO], preview=True)
write("B_mixed.unitypackage", b)

# C：zip 内只含 B（混合包）；外层 zip 不得变成 multi
c = zip_bytes([("packages/B_mixed.unitypackage", b)])
write("C_container_mixed.zip", c)

# D：同商品模型/材质/贴图三个独立 upkg（同一 Avatar）
d = zip_bytes([
    ("MANUKA_model/MANUKA_model.unitypackage", upkg_bytes([MANUKA])),
    ("MANUKA_material/MANUKA_material.unitypackage", upkg_bytes([MANUKA_MAT])),
    ("MANUKA_texture/MANUKA_texture.unitypackage", upkg_bytes([MANUKA_TEX])),
])
write("D_companion.zip", d)

# E1：损坏 zip（有 zip 魔数但结构损坏）
write("E1_corrupt.zip", b"PK\x03\x04" + b"\x00" * 100 + b"this is not a zip file")

# E2：截断的 upkg（合法 gzip 前缀，末尾被截掉）
full = upkg_bytes([MANUKA, KIKYO])
write("E2_truncated.unitypackage", full[: max(64, int(len(full) * 0.6))])

# E3：条目数超限 + 单条目字节超限
e3_entries = [("files/f%03d.txt" % i, (b"x" * 8)) for i in range(60)]
e3_entries.append(("huge.bin", b"y" * 2048))
write("E3_overlimit.zip", zip_bytes(e3_entries))

# E4：zip-slip 路径（解析只列出，不落盘；提取/计划必须拒绝越界）
write("E4_zipslip.zip", zip_bytes([
    ("../../../evil.unitypackage", upkg_bytes([MANUKA])),
    ("ok/readme.txt", b"hello"),
]))

# E5：嵌套 3 层（zip -> zip -> zip -> upkg）
inner_zip = zip_bytes([("deep/inner.unitypackage", upkg_bytes([MANUKA]))])
middle_zip = zip_bytes([("inner.zip", inner_zip)])
write("E5_nested3.zip", zip_bytes([("layer1/middle.zip", middle_zip)]))

print("generated", len(os.listdir(out)), "files")
`;

export function fixtureDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "out");
}

/**
 * 生成 A/B/C/D/E 夹具到 outDir（默认 test/fixtures/structure/out/）。
 * 返回 [{name,path,size}]。
 */
export async function generateFixtures(outDir = fixtureDir()) {
  mkdirSync(outDir, { recursive: true });
  const py = spawnSync("python3", ["-c", PY, outDir], { encoding: "utf8" });
  if (py.error) throw new Error("python3 不可用（夹具生成需要 zipfile/tarfile）: " + py.error.message);
  if (py.status !== 0) throw new Error("fixture generation failed: " + (py.stderr || py.stdout));
  return readdirSync(outDir).filter((n) => !n.startsWith(".")).sort().map((name) => {
    const path = join(outDir, name);
    return { name, path, size: statSync(path).size };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : fixtureDir();
  generateFixtures(dir).then((list) => {
    for (const f of list) console.log(f.size.toString().padStart(8) + "  " + f.name);
  }).catch((e) => { console.error(String(e)); process.exit(1); });
}
