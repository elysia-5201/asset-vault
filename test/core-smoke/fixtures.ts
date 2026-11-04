/**
 * core-smoke 合成素材工厂（task36 Phase B / R1）
 *
 * 只造合成字节：不读真实素材、不连生产库、不写仓库内文件。
 * 复用既有工厂（packages/core/test/content/fixtures.ts 的 buildZip/buildTarGz），不复制实现。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTarGz, buildZip, PNG_1x1 } from "../../packages/core/test/content/fixtures";

export interface SyntheticLibrary {
  root: string;
  cleanup: () => void;
  /** 事先写死的期望值：断言不得由被测返回值生成。 */
  expected: {
    /** A 目录 zip 内的文件条目（排序后） */
    zipEntryPaths: string[];
    /** A 目录独立 .unitypackage 的 GUID 数 */
    unityPackageGuids: number;
    /** 预算用例 zip 的文件条目（排序后） */
    budgetEntryPaths: string[];
    /** 扫描应发现的候选文件数 */
    scannedFiles: number;
    /** 同 basename、同字节的两个独立目录 */
    dupDirs: [string, string];
  };
}

const GUID_A = "11111111111111111111111111111111";
const GUID_B = "22222222222222222222222222222222";

/** 造一棵完全合成的素材树：两个相似名独立目录 + 预算用例 + 同 basename/同字节对照。 */
export function makeSyntheticLibrary(): SyntheticLibrary {
  const root = mkdtempSync(join(tmpdir(), "av-core-smoke-"));
  const cleanup = (): void => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } };

  // 独立 .unitypackage：2 个 GUID，各带 pathname
  const upkg = buildTarGz([
    { name: GUID_A + "/asset", data: Buffer.from("prefab-bytes") },
    { name: GUID_A + "/asset.meta", data: Buffer.from("guid: " + GUID_A) },
    { name: GUID_A + "/pathname", data: Buffer.from("Assets/Shinano/Shinano.prefab") },
    { name: GUID_A + "/preview.png", data: PNG_1x1 },
    { name: GUID_B + "/asset", data: Buffer.from("mat-bytes") },
    { name: GUID_B + "/pathname", data: Buffer.from("Assets/Shinano/Shinano.mat") },
  ]);

  const a = join(root, "Shinano_Outfit");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "Shinano.unitypackage"), upkg);
  writeFileSync(join(a, "Shinano_Outfit.zip"), buildZip([
    { name: "Assets/Shinano/Shinano.prefab", data: Buffer.from("p") },
    { name: "Assets/Shinano/Shinano.mat", data: Buffer.from("m") },
    { name: "Shinano.unitypackage", data: upkg },
  ]));

  // 相似名但独立：不得因同名/相似路径被自动合并
  const b = join(root, "Shinano_Outfit_copy");
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "Shinano_Outfit_copy.zip"), buildZip([
    { name: "Assets/Other/Other.prefab", data: Buffer.from("o") },
  ]));

  // 预算用例：单条目 4096 字节，用于真实触发 maxEntryBytes 声明判定
  const c = join(root, "Budget");
  mkdirSync(c, { recursive: true });
  writeFileSync(join(c, "Budget.zip"), buildZip([
    { name: "Assets/Big/big.bin", data: Buffer.alloc(4096, 7) },
    { name: "Assets/Small/small.txt", data: Buffer.from("ok") },
  ]));

  // 判别性对照：同 basename、同字节，不同目录 —— 真实扫描后仍必须是两个独立 item
  const dupBytes = buildZip([{ name: "Assets/Dup/Dup.prefab", data: Buffer.from("dup") }]);
  const d1 = join(root, "dup_a");
  const d2 = join(root, "dup_b");
  mkdirSync(d1, { recursive: true });
  mkdirSync(d2, { recursive: true });
  writeFileSync(join(d1, "Outfit.zip"), dupBytes);
  writeFileSync(join(d2, "Outfit.zip"), dupBytes);

  return {
    root,
    cleanup,
    expected: {
      zipEntryPaths: ["Assets/Shinano/Shinano.mat", "Assets/Shinano/Shinano.prefab", "Shinano.unitypackage"],
      unityPackageGuids: 2,
      budgetEntryPaths: ["Assets/Big/big.bin", "Assets/Small/small.txt"],
      scannedFiles: 6,
      dupDirs: [d1, d2],
    },
  };
}
