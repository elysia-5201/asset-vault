import { lstat, stat } from "node:fs/promises";
import { isAbsolute, parse, relative, sep } from "node:path";
import { AppError, type AssetRow, type ItemAssetScanResult, type LibraryRootRow } from "../../../../packages/core/src/contracts";
import type { Repo } from "../db/repo";

type PathCheck = Pick<ItemAssetScanResult["files"][number], "state" | "reason">;

export function createAssetPathInspector(repo: Repo): (asset: AssetRow) => Promise<PathCheck> {
  const roots = new Map((repo.listRoots() as LibraryRootRow[]).map((root) => [root.id, root.path]));
  const directoryChecks = new Map<string, Promise<boolean>>();
  const isDirectory = (path: string) => {
    let checked = directoryChecks.get(path);
    if (!checked) {
      checked = stat(path).then((entry) => entry.isDirectory(), () => false);
      directoryChecks.set(path, checked);
    }
    return checked;
  };
  return async (asset) => {
    const path = asset.path;
    const drive = parse(path).root;
    // Windows 的 \foo 也被 isAbsolute 接受，但它没有指定盘符或共享。
    if (!isAbsolute(path) || (process.platform === "win32" && drive.length === 1)) {
      return { state: "unavailable", reason: "登记路径不是当前系统的完整路径" };
    }

    const entry = await stat(path).catch((error: NodeJS.ErrnoException) => error);
    if (entry instanceof Error) {
      if (entry.code !== "ENOENT") {
        return { state: "unavailable", reason: "无法访问路径（" + (entry.code ?? "未知错误") + "）" };
      }
      const registeredRoot = roots.get(asset.root_id);
      const within = registeredRoot && isAbsolute(registeredRoot) ? relative(registeredRoot, path) : null;
      // 手动挂接的旧记录可能把文件本身或无关目录作为库根。按实际盘符或共享判断可用性。
      const inLibrary = within !== null && (within !== "" || asset.container === "dir") &&
        within !== ".." && !within.startsWith(".." + sep) && !isAbsolute(within);
      const parentRoot = registeredRoot && inLibrary ? registeredRoot : drive;
      if (!await isDirectory(drive) || !await isDirectory(parentRoot)) {
        return { state: "unavailable", reason: "库根或磁盘不可访问" };
      }
      // stat 也会为失效的符号链接返回 ENOENT；目录项仍存在时不能清理登记。
      const absent = await lstat(path).then(() => false, (e: NodeJS.ErrnoException) => e.code === "ENOENT");
      return absent ? { state: "missing" } : { state: "unavailable", reason: "原路径仍有目录项或暂时不可访问" };
    }
    if (!(asset.container === "dir" ? entry.isDirectory() : entry.isFile())) {
      return { state: "unavailable", reason: "路径类型已改变" };
    }
    if (asset.status === "missing" && (entry.size !== asset.size || entry.mtime.toISOString() !== asset.mtime)) {
      return { state: "unavailable", reason: "文件已出现，但与登记时的大小或修改时间不同，请重新挂接" };
    }
    return { state: "present" };
  };
}

export async function scanItemAssets(repo: Repo, itemId: number): Promise<ItemAssetScanResult> {
  const item = repo.itemRow(itemId);
  if (!item || item.status === "trashed") throw new AppError("NOT_FOUND", "素材条目不存在", 404);

  const inspect = createAssetPathInspector(repo);
  const files: ItemAssetScanResult["files"] = [];
  const changes: Parameters<Repo["applyAssetPathChecks"]>[0] = [];
  for (const asset of repo.listAssets(itemId)) {
    const check = await inspect(asset);
    files.push({ ...check, assetId: asset.id, path: asset.path, changed: false });
    if (check.state !== "unavailable" && check.state !== asset.status) changes.push({ asset, status: check.state });
  }

  const written = repo.applyAssetPathChecks(changes);
  const changedIds = new Set(changes.map(({ asset }) => asset.id));
  for (const result of files) {
    result.changed = written.has(result.assetId);
    if (changedIds.has(result.assetId) && !result.changed) {
      result.state = "unavailable";
      result.reason = "记录已被更新，请重试";
    }
  }
  return { files };
}
