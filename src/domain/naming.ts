/**
 * 目录名与版本名的规范 —— **Rust `domain::naming` 的前端镜像**。
 * ------------------------------------------------------------------
 * ★★ 2026-09-30（用户：「游戏数据目录有些杂乱和不规范，按 PCL 的来规范一下」）
 *
 *   ADR-055 决定八早就定下了规范：`{mc_version}-{loader_type}-{loader_version}`
 *   （`1.20.1-forge-47.2.0`），**显示名与目录名用同一套**。但规范只写在文档里，
 *   代码里却有两份实现，于是真机上长出了三种互相不认识的名字：
 *
 *   | 谁写的 | 长什么样 |
 *   |---|---|
 *   | `InstallComposer` 的 `versionLabel` → 账本 slug | `26.3-fabric-0.19.5` |
 *   | 安装器（Fabric profile 自带的 `id`） | `fabric-loader-0.19.5-26.3` |
 *   | 更早的盘上目录 | `vanilla-262` · `fabric-262` |
 *
 *   后果不是"名字难看"，而是**账本里的 slug 拼不出磁盘上的目录**
 *   （`docs/DECISIONS.md` 54.1：拿 slug 拼目录名，把所有条目都判成了"目录不在"），
 *   以及同一个版本在盘上留下两个看不出差别的目录。
 *
 *   ⇒ 规则收敛到 Rust 的 `domain::naming` 一份，这里是**必须逐字一致**的镜像
 *     （浏览器 demo 模式没有 Rust 可用）。`tests/naming.test.mjs` 拿
 *     `tests/naming-cases.json` 同时喂两边，算出来不一致就红。
 *
 * ★ 为什么前端还需要自己算：`install-plan.ts` 是**纯函数**（ADR 里"下载计划不碰盘"），
 *   而版本目录名在计划里就要用到（`versions/<名字>/<名字>.json`）。
 *   为它加一次异步 IPC 会让纯函数变成 async，那是把简单的事弄复杂。
 */

/** 基础加载器种类（与 `domain/types.ts` 的联合类型一致） */
export type LoaderKind = 'forge' | 'neoforge' | 'fabric' | 'quilt';

/** 附加组件种类（与 `domain/types.ts` 一致） */
export type AddonKind = 'optifine' | 'liteloader';

/** 一套组合里的成分（与 Rust `VersionParts` 逐字段对齐） */
export interface VersionParts {
  mcVersion: string;
  /** `null` = 纯原版 */
  loader: { kind: LoaderKind; version: string } | null;
  addons?: Array<{ kind: AddonKind; version: string }>;
}

/**
 * 目录名 / 显示名里**不该出现**的字符 —— 与 Rust `ILLEGAL` 同一份表。
 *
 * 与 `validate.ts::safe_name`（拒绝用户输入）判的是同一件事，但用途不同：
 * 那边**拒绝**，这边**清洗**我们自己拼出来的名字。
 */
const ILLEGAL = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

/** Windows 保留设备名（与 Rust `RESERVED` 同一份表） */
const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * 把一个任意字符串洗成**能当目录名**的样子（Rust `sanitize_dir_name` 的镜像）。
 *
 *   · 非法字符与控制字符 → `-`；连续 `-` 合并；去掉首尾的 `-`、空格、点
 *   · 保留设备名 → 加 `-ver` 后缀
 *   · 洗不出东西 → `null`（**绝不用空串去拼路径**）
 */
export function sanitizeDirName(raw: string): string | null {
  let out = '';
  let lastDash = false;
  for (const ch of raw) {
    const c = ILLEGAL.has(ch) || ch.charCodeAt(0) < 0x20 ? '-' : ch;
    if (c === '-') {
      if (lastDash) continue;
      lastDash = true;
    } else {
      lastDash = false;
    }
    out += c;
  }
  const trimmed = out.replace(/^[- .]+/, '').replace(/[- .]+$/, '');
  if (trimmed === '') return null;
  const stem = (trimmed.split('.')[0] ?? trimmed).toUpperCase();
  if (RESERVED.has(stem)) return `${trimmed}-ver`;
  return trimmed;
}

/**
 * **规范目录名**（ADR-055 决定八）—— 一个版本在 `versions/` 下应该叫什么。
 *
 *   原版 `26.3` · 加载器 `26.3-fabric-0.19.5` · 附加组件接在后面
 *   `1.12.2-forge-14.23.5.2860-optifine-HD_U_E7`
 *
 * 顺序固定：**MC → 基础加载器 → 附加组件**。
 */
export function versionDirName(parts: VersionParts): string | null {
  const mc = sanitizeDirName(parts.mcVersion);
  if (mc === null) return null;
  let name = mc;
  if (parts.loader) {
    name += `-${parts.loader.kind}`;
    const v = sanitizeDirName(parts.loader.version);
    if (v !== null) name += `-${v}`;
  }
  for (const addon of parts.addons ?? []) {
    name += `-${addon.kind}`;
    const v = sanitizeDirName(addon.version);
    if (v !== null) name += `-${v}`;
  }
  return name;
}

/**
 * 同名的版本已经存在时**取下一个空位**（`-2`、`-3`…）—— Rust `unique_dir_name` 的镜像。
 *
 * ★ 去重**大小写无关**：Windows 上 `Fabric` 与 `fabric` 是同一个目录，
 *   只按字节比会让第二个实例撞进第一个的目录里。
 */
export function uniqueDirName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((s) => s.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** 加载器在界面上的名字（与 `instance-name.ts::loaderLabel` 一致） */
export function loaderLabel(kind: string): string {
  switch (kind) {
    case 'forge':
      return 'Forge';
    case 'neoforge':
      return 'NeoForge';
    case 'fabric':
      return 'Fabric';
    case 'quilt':
      return 'Quilt';
    case 'optifine':
      return 'OptiFine';
    case 'liteloader':
      return 'LiteLoader';
    default:
      return kind;
  }
}

/**
 * 显示名（版本列表里那一行）—— Rust `version_display_name` 的镜像。
 *
 *   `Minecraft 26.3` · `Minecraft 26.3 + Fabric 0.19.5`
 *
 * ★ 与 `instance-name.ts::formatInstanceTitle` 是**同一个格式**（那条是用户明确
 *   确认过的：「版本列表的版本名称，后面的"：原版"和"：模组加载器"不要」）。
 */
export function versionDisplayName(parts: VersionParts): string {
  let name = `Minecraft ${parts.mcVersion}`;
  if (parts.loader) {
    name += ` + ${loaderLabel(parts.loader.kind)}`;
    const v = parts.loader.version.trim();
    if (v !== '') name += ` ${v}`;
  }
  return name;
}

/**
 * 从**已经在盘上的目录名**反解成分（Rust `parse_dir_name` 的镜像）。
 *
 * 认清**两种**真实存在的写法：
 *   · ADR-055（IEML 自己的规范）：`{mc}-{loader}-{loaderVer}` —— `26.3-fabric-0.19.5`
 *   · PCL 的写法：`{loader}-loader-{loaderVer}-{mc}` —— `fabric-loader-0.19.5-26.3`
 *     （真机上那个目录就是安装器按 Fabric profile 自带的 `id` 建的）
 *
 * ★ **认不出的一律 `null`** —— 绝不猜着改名。改错了名字会让启动器再也找不到
 *   那个版本（版本 JSON 找不到时会静默落回原版 JSON，游戏报"找不到主类"）。
 */
export function parseDirName(dir: string): VersionParts | null {
  const pcl = parsePclStyle(dir);
  if (pcl !== null) return pcl;

  const lower = dir.toLowerCase();
  let loader: { kind: LoaderKind; version: string; pos: number } | null = null;
  const needles: Array<[string, LoaderKind]> = [
    ['neoforge', 'neoforge'],
    ['forge', 'forge'],
    ['fabric', 'fabric'],
    ['quilt', 'quilt'],
  ];
  for (const [needle, kind] of needles) {
    const pos = lower.lastIndexOf(needle);
    if (pos < 0) continue;
    // 只认"作为独立一段出现"的加载器名（`26.3-fabric-0.19.5` 里的 `-fabric-`）
    if (pos > 0 && lower[pos - 1] !== '-') continue;
    if (loader === null || pos > loader.pos) {
      loader = {
        kind,
        version: dir.slice(pos + needle.length).replace(/^-+/, ''),
        pos,
      };
    }
  }
  const mcVersion =
    loader === null ? dir : dir.slice(0, loader.pos).replace(/-+$/, '');
  /*
   * ★★ 空 MC 版本 ⇒ 反解不出来（与 Rust `parse_dir_name` 的同一道闸）。
   *
   *   `fabric-loader-0.19.5`（**没有** MC 版本那一段）里加载器名出现在第 0 段，
   *   "它之前的那一段"是空的。不挡住的话会解析出 `mcVersion: ''` 或
   *   把加载器版本当成 MC 版本 —— 而调用方拿它去**改名**，就会把一个版本
   *   改成另一个版本的名字。
   *
   *   ★ 这条是 `tests/naming.test.mjs` 抓出来的：Rust 侧一直有这道闸，
   *     而 TS 镜像漏了 —— **跨语言用例表存在的意义就是这个**。
   */
  if (mcVersion === '') return null;
  const addons: Array<{ kind: AddonKind; version: string }> = [];
  if (loader !== null) {
    const tail = lower.slice(loader.pos);
    const addonNeedles: Array<[string, AddonKind]> = [
      ['optifine', 'optifine'],
      ['liteloader', 'liteloader'],
    ];
    for (const [needle, kind] of addonNeedles) {
      const i = tail.indexOf(needle);
      if (i < 0) continue;
      const after = tail.slice(i).split('-').slice(1).join('-');
      addons.push({ kind, version: after });
    }
  }
  return {
    mcVersion,
    loader: loader === null ? null : { kind: loader.kind, version: loader.version },
    addons,
  };
}

/**
 * PCL 那种 `{loader}-loader-{loaderVer}-{mc}` 的写法（Rust `parse_pcl_style` 的镜像）。
 *
 *   `fabric-loader-0.19.5-26.3` → mc `26.3`、fabric `0.19.5`
 *
 * ★ 判据要**窄**：要求 `{loader}-loader-`（或 `forge-`）出现在**开头**，
 *   并且最后一段要**像**版本号（数字开头）—— 免得把
 *   `1.20.1-fabric-loader-X` 这种怪名字误判进来。
 */
function parsePclStyle(dir: string): VersionParts | null {
  const lower = dir.toLowerCase();
  const prefixes: Array<[string, LoaderKind]> = [
    ['fabric-loader-', 'fabric'],
    ['quilt-loader-', 'quilt'],
    ['forge-', 'forge'],
    ['neoforge-', 'neoforge'],
  ];
  for (const [prefix, kind] of prefixes) {
    if (!lower.startsWith(prefix)) continue;
    const segs = dir.slice(prefix.length).split('-').filter((s) => s !== '');
    /*
     * ★★ 至少两段：`{loaderVer}-{mcVer}`。
     *
     *   只有一段（`fabric-loader-0.19.5`）说明**没有 MC 版本那一半** ——
     *   那时"第一段"与"最后一段"是同一个东西，会被当成
     *   `mcVersion: '0.19.5'`，也就是**把加载器版本当成了游戏版本**。
     *   调用方拿它去改名就会把一个版本改成另一个版本的名字。
     *
     *   ★ 这一段被删掉过一次（改成显式取 index 时漏了），
     *     是 `tests/naming.test.mjs` 立刻抓出来的 —— 跨语言用例表的意义就在这。
     */
    if (segs.length < 2) return null;
    const first = segs[0];
    const last = segs[segs.length - 1];
    if (first === undefined || last === undefined) return null;
    if (!/^[0-9]/.test(last)) return null;
    return { mcVersion: last, loader: { kind, version: first }, addons: [] };
  }
  return null;
}
