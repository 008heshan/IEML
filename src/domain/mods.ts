/**
 * Mod 状态判定（ADR-018 / ADR-019）
 * ------------------------------------------------------------------
 * ★ 最重要的一条源码事实（源码研读第 12 章）：
 *   **「已启用」靠文件扩展名判定，不读任何元数据。**
 *   PCL2 的 `LocalResourceLoaders.vb`：
 *       Return {".jar", ".zip", ".litemod"}.Contains(File.Extension.Lower)
 *   禁用 = 文件重命名加 `.disabled` 后缀。
 *
 * ★ 第二条：**更新判定靠文件哈希反查在线库，不读本地元数据。**
 *   CurseForge 用 MurmurHash2（种子 1，先剔除 \t \n \r 空格），
 *   Modrinth 用 SHA1。缓存 key 必须带 mtime + size，否则用户替换同名文件后会拿到过期结果。
 *
 * ★ 第三条（ADR-021）：**不做静态兼容性判定**，标"可能不兼容"而不是"不匹配"。
 */

export type ModLoaderFlavor = 'fabric' | 'forge' | 'neoforge' | 'quilt' | 'liteloader';

/** Mod 文件在磁盘上的样子 */
export interface ModFile {
  /** 文件名（含后缀） */
  fileName: string;
  /** 绝对路径 */
  path: string;
  bytes: number;
  /** 最后修改时间（毫秒），哈希缓存的 key 要用 */
  mtimeMs: number;
}

/** 从在线库反查到的信息 */
export interface ModRemoteInfo {
  source: 'modrinth' | 'curseforge';
  projectId: string;
  name: string;
  version: string;
  /** 声明支持的 MC 版本 */
  gameVersions: string[];
  loaders: ModLoaderFlavor[];
  /** 该 Mod 是不是"前置库"（被别的 Mod 依赖） */
  isLibrary: boolean;
}

export interface ModEntry {
  /** 去掉 .disabled / .old 之后的显示名 */
  displayName: string;
  /** 磁盘上的真实文件名 */
  fileName: string;
  path: string;
  /** 是否启用（由扩展名决定） */
  enabled: boolean;
  bytes: number;
  mtimeMs: number;
  /** SHA1，用于 Modrinth 反查 */
  sha1?: string;
  /** MurmurHash2 指纹，用于 CurseForge 反查 */
  murmur2?: string;
  remote?: ModRemoteInfo;
  /** 是否有可用更新 */
  updateAvailable?: boolean;
  /** 可更新的目标版本 */
  latestVersion?: string;
  /** 命中"可能不兼容"时的推断依据（必须能解释给用户看） */
  incompatibleEvidence?: string[];
  /** 文件解析失败 / 损坏 */
  errored?: boolean;
}

/* ====================== 扩展名判定（核心事实） ====================== */

/** 被承认的 Mod 扩展名 —— 注意认 .zip（很多 Mod 打包成 zip） */
const ENABLED_EXTS = ['.jar', '.zip', '.litemod'];
/** 禁用后缀，按源码事实：主用 .disabled，兼容遗留的 .old */
const DISABLED_SUFFIXES = ['.disabled', '.old'];

export function isModFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const stripped = stripDisabledSuffix(lower);
  return ENABLED_EXTS.some((ext) => stripped.endsWith(ext));
}

/** 剥掉禁用后缀，得到"假如它启用"时的名字 */
export function stripDisabledSuffix(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const suffix of DISABLED_SUFFIXES) {
    if (lower.endsWith(suffix)) return fileName.slice(0, -suffix.length);
  }
  return fileName;
}

/** 判定是否启用：**只看扩展名，不读元数据** */
export function isEnabled(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  // 先看有没有禁用后缀
  if (DISABLED_SUFFIXES.some((s) => lower.endsWith(s))) return false;
  return ENABLED_EXTS.some((ext) => lower.endsWith(ext));
}

/** 生成启用 / 禁用后的文件名 */
export function toggledName(fileName: string, enable: boolean): string {
  const base = stripDisabledSuffix(fileName);
  return enable ? base : base + '.disabled';
}

/** 显示名：剥掉扩展名与禁用后缀 */
export function displayNameOf(fileName: string): string {
  const base = stripDisabledSuffix(fileName);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/* ====================== 扫描目录 ====================== */

/**
 * 扫描 Mod 目录生成条目列表。
 * ★ 默认**不递归子目录**；唯一例外是 Forge 且 MC < 1.13 且目录名恰为版本号
 *   （如 mods/1.12.2/）—— 这是 PCL2 的行为，直接抄。
 */
export function scanMods(
  files: ModFile[],
  opts: { loaderKind: string | null; mcVersion: string },
): ModEntry[] {
  const entries: ModEntry[] = [];
  const forVersionDir = shouldScanVersionDir(opts.loaderKind, opts.mcVersion);

  for (const f of files) {
    const rel = f.fileName;
    // 目录判定：只有满足例外条件才认 mods/<mcVersion>/ 下的文件
    const slash = rel.indexOf('/');
    if (slash >= 0) {
      const dir = rel.slice(0, slash);
      if (!forVersionDir || dir !== opts.mcVersion) continue;
    }
    const base = slash >= 0 ? rel.slice(slash + 1) : rel;
    if (!isModFile(base)) continue;
    entries.push({
      displayName: displayNameOf(base),
      fileName: base,
      path: f.path,
      enabled: isEnabled(base),
      bytes: f.bytes,
      mtimeMs: f.mtimeMs,
    });
  }

  // 固定按文件名排序 —— PCL2 完全没有排序功能，我们也不做（ADR-019）
  entries.sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-Hans-CN'));
  return entries;
}

function shouldScanVersionDir(loaderKind: string | null, mcVersion: string): boolean {
  const isForgeLike = loaderKind === 'forge' || loaderKind === 'neoforge';
  if (!isForgeLike) return false;
  const [maj, min] = mcVersion.split('.').map((x) => parseInt(x, 10));
  const M = maj ?? 0;
  const m = min ?? 0;
  if (M > 1) return false;
  return M === 1 && m < 13;
}

/* ====================== 重复 Mod 处理 ====================== */

/**
 * 去重（源码事实）：按"去掉禁用后缀后的名字"归并，
 * 一启用一禁用时**保留启用的那个**；两文件内容不同则不允许批量操作。
 */
export interface DuplicateGroup {
  name: string;
  enabled: ModEntry | null;
  disabled: ModEntry[];
  /** 两个文件内容是否一致（不一致时禁止自动批量处理） */
  identicalContent: boolean;
}

export function findDuplicates(entries: ModEntry[]): DuplicateGroup[] {
  const byName = new Map<string, ModEntry[]>();
  for (const e of entries) {
    const key = stripDisabledSuffix(e.fileName).toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(e);
    byName.set(key, list);
  }
  const groups: DuplicateGroup[] = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const enabled = list.filter((e) => e.enabled);
    const disabled = list.filter((e) => !e.enabled);
    groups.push({
      name,
      enabled: enabled[0] ?? null,
      disabled,
      identicalContent: list.every((e) => e.bytes === list[0]!.bytes),
    });
  }
  return groups;
}

/* ====================== 状态判定 ====================== */

export interface ModStateInput {
  entry: ModEntry;
  /** 当前实例的 MC 版本 */
  instanceMcVersion: string;
  /** 当前实例的基础加载器 */
  instanceLoader: ModLoaderFlavor | null;
  /** 当前实例是否由整合包管理（整合包的 Mod 不提供更新，ADR-018 ⑥） */
  managedByModpack: boolean;
}

export type ModStateResult = {
  state: 'fine' | 'disabled' | 'can-update' | 'maybe-incompatible' | 'errored' | 'library';
  /** 为什么是这个状态，可点开给用户看 */
  evidence?: string[];
};

/**
 * 判定单个 Mod 的状态。
 * 优先级：errored > disabled > library > can-update > maybe-incompatible > fine
 */
export function judgeModState(input: ModStateInput): ModStateResult {
  const { entry, instanceMcVersion, instanceLoader, managedByModpack } = input;

  if (entry.errored) {
    return { state: 'errored', evidence: ['文件无法解析，可能下载不完整或已损坏'] };
  }
  if (!entry.enabled) {
    return { state: 'disabled', evidence: ['文件名带 .disabled 后缀，游戏不会加载它'] };
  }
  if (entry.remote?.isLibrary) {
    return {
      state: 'library',
      evidence: [
        `${entry.remote.name} 是其他 Mod 的前置库`,
        '单独禁用它会导致依赖它的 Mod 无法加载',
      ],
    };
  }
  if (entry.updateAvailable && !managedByModpack) {
    return {
      state: 'can-update',
      evidence: [
        `在线库里有 ${entry.latestVersion}（当前 ${entry.remote?.version ?? '未知'}）`,
        '更新是你手动触发的，启动器不会自动替换',
      ],
    };
  }

  // 可能不兼容：只在**从在线库反查到的元数据**能给出证据时才提示
  const evidence: string[] = [];
  if (entry.remote) {
    const supportsMc = entry.remote.gameVersions.includes(instanceMcVersion);
    const supportsLoader =
      instanceLoader === null || entry.remote.loaders.includes(instanceLoader);
    if (!supportsMc) {
      evidence.push(`在线库记录该版本支持 ${entry.remote.gameVersions.join(' / ')}`);
      evidence.push(`当前实例是 ${instanceMcVersion}`);
    }
    if (!supportsLoader && instanceLoader) {
      evidence.push(`该 Mod 标注的加载器是 ${entry.remote.loaders.join(' / ')}`);
      evidence.push(`当前实例用的是 ${instanceLoader}`);
    }
  }
  if (evidence.length > 0) {
    return { state: 'maybe-incompatible', evidence };
  }
  return { state: 'fine' };
}

/* ====================== 哈希缓存 key ====================== */

/**
 * 哈希缓存 key（源码事实）：必须带 mtime + size，
 * 否则用户替换同名文件后会拿到过期的反查结果。
 */
export function hashCacheKey(entry: Pick<ModEntry, 'fileName' | 'mtimeMs' | 'bytes'>): string {
  return `${entry.fileName}-${entry.mtimeMs}-${entry.bytes}`;
}

/* ====================== 列表筛选器 ====================== */

export type ModFilter =
  | 'all'
  | 'enabled'
  | 'disabled'
  | 'can-update'
  | 'maybe-incompatible'
  | 'errored'
  | 'library';

/**
 * 筛选器按数据自动隐藏（源码事实）：
 * 没有可更新的就不显示"可更新"；全部启用就不显示"已启用"。
 * 但**选中项永远可见**，否则用户会以为自己的选择丢了。
 */
export function availableFilters(
  entries: ModEntry[],
  states: Map<string, ModStateResult['state']>,
  current: ModFilter,
): Array<{ id: ModFilter; label: string; count: number }> {
  const count = (s: ModStateResult['state']) =>
    [...states.values()].filter((x) => x === s).length;

  const all: Array<{ id: ModFilter; label: string; count: number }> = [
    { id: 'all', label: '全部', count: entries.length },
    { id: 'enabled', label: '已启用', count: entries.filter((e) => e.enabled).length },
    { id: 'disabled', label: '已禁用', count: entries.filter((e) => !e.enabled).length },
    { id: 'can-update', label: '可更新', count: count('can-update') },
    { id: 'maybe-incompatible', label: '可能不兼容', count: count('maybe-incompatible') },
    { id: 'errored', label: '有错误', count: count('errored') },
    { id: 'library', label: '前置库', count: count('library') },
  ];

  return all.filter((f) => {
    if (f.id === 'all' || f.id === current) return true;
    if (f.id === 'enabled' || f.id === 'disabled') {
      // 全部启用时不显示"已启用"，全部禁用时不显示"已禁用"
      const other = f.id === 'enabled' ? 'disabled' : 'enabled';
      const otherCount = all.find((x) => x.id === other)?.count ?? 0;
      return f.count > 0 && otherCount > 0;
    }
    return f.count > 0;
  });
}

export function filterMods(
  entries: ModEntry[],
  states: Map<string, ModStateResult['state']>,
  filter: ModFilter,
): ModEntry[] {
  if (filter === 'all') return entries;
  return entries.filter((e) => {
    const s = states.get(e.path) ?? (e.enabled ? 'fine' : 'disabled');
    if (filter === 'enabled') return e.enabled;
    if (filter === 'disabled') return !e.enabled;
    return s === filter;
  });
}
