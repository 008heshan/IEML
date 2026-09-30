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
  /**
   * 文件夹里有、账本里没有的版本。
   *
   * ★★ 2026-09-30（用户）：「**这是不必要的设计，删除它**」——
   *   他指的是原来那支行（「还没建实例」+「用它建一个」按钮）。
   *   现在这些版本被当成**普通的版本行**渲染：盘上有版本 = 这个版本就在
   *   （PCL 的语义）。记录里的名字/内存/Java/隔离在用户第一次动设置时才需要，
   *   而不是"先建一个才能用"。
   */
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
 * ★★ 2026-09-30（用户：「删除实例时……有时还会**诈尸**，删了的又回来」）：
 *   多了一条输入 `deletedVersions` —— 用户**删掉过**的版本目录名（墓碑）。
 *   命中墓碑的版本**不再自动认领**。
 *
 *   为什么需要它：自动认领的判据本来是"账本里一个实例都没有、而文件夹里有版本"，
 *   而用户"只把版本从列表里移除、文件留着"之后，账本正好是空的 ——
 *   于是下一轮启动他刚删掉的版本又出现了。**删掉这件事必须是可信的**，
 *   所以它要被记下来（写进 `prefs.json` 的 `deletedVersions`），
 *   而不能只靠"账本里现在没有"来推断。
 *
 * 四条边界（都是"不许替用户做决定"）：
 *   · **账本里只要有实例就不认领** —— 有实例说明账本是好的，绝不改写用户的选择；
 *   · 只认领**能在启动器里启动的**（`hasJson`）版本 —— 只有目录、没有 json 的不算；
 *   · **被用户删过的不认领**（墓碑，大小写无关 —— Windows 上 `Fabric` 与 `fabric`
 *     是同一个目录）；
 *   · 多个时取**文件夹顺序的第一个**（与版本列表的显示顺序一致，用户看得见是哪一条）。
 */
export function pickAutoAdopt(
  folderVersions: readonly FolderVersion[] | null,
  instances: readonly Instance[],
  deletedVersions: readonly string[] = [],
): FolderVersion | null {
  if (instances.length > 0) return null;
  const buried = new Set(deletedVersions.map((s) => s.toLowerCase()));
  const candidates = (folderVersions ?? []).filter(
    (v) => v.hasJson && !buried.has(v.dir.toLowerCase()),
  );
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
