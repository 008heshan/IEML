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
import { autoMemory } from './memory.ts';

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

/**
 * 用文件夹里的一个版本**建一个实例**（PCL 里点一下版本就能用）。
 *
 * ★★ 2026-09-29（用户：「当没有版本时，下载第一个版本不会自动选择那个仅有的版本」）：
 *
 *   这段逻辑原来长在 `VersionsPage` 里（一个"建实例"按钮），只能在那一页手动点。
 *   现在**两处**要用同一套规则：那一页的按钮 + 启动器发现"一个实例都没有、
 *   但文件夹里有版本"时**自动认领**（见 `AppContext` 的自动选择）。
 *   ⇒ 抽成纯函数放这里：规则只留一份，谁用谁调（与上面 `matchFolderVersions` 同理）。
 *
 * 判据（与手动认领**逐条一致**，不许两套）：
 *   · `slug` 取版本目录名；撞了就 `-2`、`-3`……
 *   · 加载器种类按目录名认（认不出的当"没有加载器"—— 见 `knownLoaderKind` 的说明）；
 *   · 内存按 `autoMemory` 自动算（用户之后可以在设置里改）。
 */
export function instanceFromFolderVersion(
  fv: FolderVersion,
  opts: {
    /** 账本里**已经占用**的 slug（用来避重名） */
    takenSlugs: readonly string[];
    totalMemoryGb: number;
    availableMemoryGb: number;
    /** 注入时间是为了让测试能断言（默认取现在） */
    now?: number;
  },
): Instance {
  const taken = new Set(opts.takenSlugs);
  let slug = fv.dir;
  for (let n = 2; taken.has(slug); n += 1) slug = `${fv.dir}-${n}`;
  const kind = knownLoaderKind(fv.loaderName);
  const nowMs = opts.now ?? Date.now();
  return {
    id: `inst-${nowMs.toString(36)}`,
    mcVersion: fv.mcVersion,
    loader: kind ? { kind, version: '', mcVersion: fv.mcVersion } : null,
    addons: [],
    config: {
      name: fv.dir,
      slug,
      isolation: 'auto',
      memoryMb: Math.round(
        autoMemory(0, 'vanilla', opts.totalMemoryGb, opts.availableMemoryGb).gb * 1024,
      ),
      memorySource: 'auto',
      javaMode: 'auto',
    },
    createdAt: new Date(nowMs).toISOString(),
    lastPlayedAt: null,
    totalPlaySeconds: 0,
  };
}

/**
 * **该不该自动认领一个版本？** 返回要认领的那一个；不该认领时 `null`。
 *
 * ★★ 2026-09-29（用户：「当没有版本时，下载第一个版本**不会自动选择那个仅有的版本**」）：
 *   从"装完第一个版本"到"启动页有个能点的目标"之间，原来差一次手动点击
 *   （版本列表里那个「建实例」按钮）。这条规则把那一跳补上。
 *
 * 三条边界（都是"不许替用户做决定"）：
 *   · **账本里只要有实例就不认领** —— 有实例说明账本是好的，绝不改写用户的选择；
 *   · 只认领**能在启动器里启动的**（`hasJson`）版本 —— 只有目录、没有 json 的不算；
 *   · 多个时取**文件夹顺序的第一个**（与版本列表的显示顺序一致，用户看得见是哪一条）。
 */
export function pickAutoAdopt(
  folderVersions: readonly FolderVersion[] | null,
  instances: readonly Instance[],
): FolderVersion | null {
  if (instances.length > 0) return null;
  const candidates = (folderVersions ?? []).filter((v) => v.hasJson);
  return candidates[0] ?? null;
}

/**
 * `FolderVersion.loaderName` 是**按目录名猜的字符串**（Rust 侧只做了 `contains`）， * 而账本里的 `loader.kind` 是一个**受约束的联合类型** —— 直接把字符串塞进去会让
 * 类型系统失去保护。认不出的（比如 `optifine`、`liteloader`）一律当"没有加载器"：
 * 那两种在 IEML 里走的是 `addons`，不是 `loader`。
 *
 * ★ 从 `VersionsPage` 搬到这里（与 `instanceFromFolderVersion` 同一个道理：
 *   两处要用同一套规则，就不能让它长在某一页里）。
 */
export function knownLoaderKind(
  name: string | null,
): 'forge' | 'neoforge' | 'fabric' | 'quilt' | null {
  if (name === 'forge' || name === 'neoforge' || name === 'fabric' || name === 'quilt') {
    return name;
  }
  return null;
}
