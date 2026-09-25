/**
 * 「当前文件夹里的版本」与「账本里的实例」怎么对上 —— **只有这一份规则**。
 * ------------------------------------------------------------------
 * ★★ 2026-09-25（用户：「你看PCL，就是像换了个文件夹去读游戏版本，可以无缝切换」）：
 *
 *   IEML 的列表要像 PCL 那样**按当前文件夹说话**：
 *     · 文件夹里的版本 = 列表里的行；
 *     · 账本里的实例只负责给某个版本补上"你起的名字 / 设置 / 存档目录"；
 *     · **认领不到的既不删、也不显示**（用户：「既然不在这个文件夹就不用显示了」）。
 *
 *   ★ 为什么抽出来：这件事现在有**两个**页面要看（版本列表、启动页），
 *     还有计数（页头 / 侧栏角标 / 筛选）也要跟它一致。
 *     上一轮就是因为"一个事实三个出口各算各的"，页头显示 0、角标还显示 3 ——
 *     规则只留这一份，谁用谁调。
 */
import type { FolderVersion } from '../bridge/tauri';
import type { Instance } from './types';

export interface FolderMatch {
  /** 账本里**对得上当前文件夹**的实例（顺序与传入的 instances 一致）——能启动的就是这些 */
  instances: Instance[];
  /** 文件夹里有、账本里没有的版本（界面上显示成「还没建实例」） */
  withoutInstance: FolderVersion[];
}

/**
 * 一对一认领：`instances` 里每个实例尽量挑一个还没被挑走的版本。
 *
 * 判据两位（**故意的**，不用更细的）：
 *   · `mcVersion` 相同（大小写无关）；
 *   · "是不是加载器版本"相同（实例有 `loader` ⟷ 版本目录名里带加载器名）。
 *
 * ★ 为什么不比加载器的具体版本：`FolderVersion.loaderName` 是按**目录名**认的
 *   （要精确到"哪个加载器的哪个版本"得再读一遍 JSON），而列表行本来就会显示盘上事实 ——
 *   不值得为此多做一次读盘。多出来的实例（比如同一 MC 版本建了两个实例）
 *   会按顺序认领，认领不到的照样列出来（它们指向的版本确实在这个文件夹里）。
 */
export function matchFolderVersions(
  instances: readonly Instance[],
  folderVersions: readonly FolderVersion[] | null,
): FolderMatch {
  /*
   * 读不到文件夹（null）⇒ **不筛**：读不到 ≠ 没有。
   * 把实例全部当成"在文件夹里"，界面宁可多显示，也不要凭空藏掉用户的东西。
   */
  if (folderVersions === null) return { instances: [...instances], withoutInstance: [] };

  const pool = folderVersions.filter((v) => v.hasJson);
  const used = new Set<number>();
  const out: Instance[] = [];
  for (const inst of instances) {
    const i = pool.findIndex(
      (v, idx) =>
        !used.has(idx) &&
        v.mcVersion.toLowerCase() === inst.mcVersion.toLowerCase() &&
        (v.loaderName !== null) === (inst.loader !== null),
    );
    if (i >= 0) {
      used.add(i);
      out.push(inst);
    }
  }
  return { instances: out, withoutInstance: pool.filter((_, idx) => !used.has(idx)) };
}
