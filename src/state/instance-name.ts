/**
 * 实例的显示名（**唯一实现**）。
 *
 * ## 格式（2026-09-23 用户最终确认）
 *
 *   · 原版      → `Minecraft 1.12.2`
 *   · 带加载器  → `Minecraft 26.2 + Fabric 0.19.5`
 *
 * ★★ 与上一版的区别：**去掉了尾巴上的「：原版」「：模组加载器」**。
 *   用户原话：「版本列表的版本名称，后面的"：原版"和"：模组加载器"**不要**」，
 *   以及「那个版本名称，原版和模组加载器**也按那个格式写**」——
 *   也就是"格式统一成 `Minecraft <MC> [+ <加载器> <版本>]`"，但不要那个中文尾巴。
 *
 * ★ 为什么要有"用户改过名"这一支：
 *   实例名（`config.name`）是**用户可改**的（版本列表的「重命名」）。
 *   如果一律显示统一格式名，重命名就白改了。
 *   所以：名字等于"自动生成的那些写法之一"（或为空）→ 用统一格式名；否则显示他改的名字。
 *
 * ★★ 2026-09-23 补：`autoNames` 里**没有**把"英文加载器名"和"中文尾巴"混在一起，
 *   所以老数据里 `Fabric 26.2`、`26.2 (2)`、`Minecraft 1.12.2 ：原版` 这些
 *   **都会被认出来是"自动生成的"**，从而统一显示成新格式 ——
 *   这正是用户说的"怎么没统一主页版本的命名"要的效果（不用改名也能统一）。
 */

/** 加载器在界面上的名字（Forge / NeoForge / Fabric / Quilt / OptiFine …） */
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

/** 这种加载器在游戏里是"加载 Mod 的"，还是"只改画面"的 */
function isModLoader(kind: string): boolean {
  return kind === 'forge' || kind === 'neoforge' || kind === 'fabric' || kind === 'quilt';
}

/** 只改画面的加载器（OptiFine / LiteLoader）—— 显示时也挂在 `+` 后面 */
export function isVisualLoader(kind: string): boolean {
  return !isModLoader(kind);
}

/** 实例里最小的那个加载器信息（界面只需要一个 kind + version） */
export interface InstanceLoader {
  kind: string;
  version?: string | null;
}

/**
 * 统一格式名（不含"用户改过名"的判断）。
 *
 *   原版     → `Minecraft 1.12.2`
 *   加载器   → `Minecraft 26.2 + Fabric 0.19.5`
 *   没有版本号的加载器 → `Minecraft 26.2 + Fabric`（不硬凑一个空的 `+ `）
 */
export function formatInstanceTitle(mcVersion: string, loader: InstanceLoader | null): string {
  if (!loader) return `Minecraft ${mcVersion}`;
  const l = loaderLabel(loader.kind);
  const v = loader.version ? ` ${loader.version}` : '';
  return `Minecraft ${mcVersion} + ${l}${v}`;
}

/**
 * 新建实例时的**默认名字**。
 *
 * ★ 用户（截图）：新建版本那个输入框里默认写着 `26.3 (2)` ——
 *   那是"版本号去重"的产物，既看不出是不是原版，也和别处不一致。
 *   现在直接给统一格式名（原版 `Minecraft 26.3`、加载器 `Minecraft 26.3 + Fabric 1.0`）。
 */
export function defaultInstanceName(mcVersion: string, loader: InstanceLoader | null): string {
  return formatInstanceTitle(mcVersion, loader);
}

/**
 * 自动生成的名字长什么样 —— **历史各代写法都要在里面**，
 * 否则老数据会被误判成"用户改过名"，于是永远统一不了。
 */
function autoNames(mcVersion: string, loader: InstanceLoader | null): string[] {
  const base = [
    `Minecraft ${mcVersion}`,
    mcVersion,
    `${mcVersion} 原版`,
    // ★ 上一版的写法（带中文尾巴）也算自动生成的
    `Minecraft ${mcVersion} ：原版`,
  ];
  if (!loader) return base;
  const l = loaderLabel(loader.kind);
  const tail = isModLoader(loader.kind) ? '模组加载器' : l;
  const v = loader.version ? ` ${loader.version}` : '';
  return [
    ...base,
    // 上一版：`Minecraft 26.2 + Fabric 0.19.5：模组加载器`
    `Minecraft ${mcVersion} + ${l}${v}：${tail}`,
    // 这一版：`Minecraft 26.2 + Fabric 0.19.5`
    `Minecraft ${mcVersion} + ${l}${v}`,
    // 更早的各代
    `${l} ${mcVersion}`,
    `${l} ${loader.version ?? ''}`.trim(),
    `${l} ${loader.version ?? ''} ${mcVersion}`.trim(),
    `${mcVersion} + ${l}${v}`,
    // 新建时"版本号去重"产生的那种（`26.3 (2)`）也算自动生成的
    `${mcVersion} (2)`,
    `${mcVersion} (3)`,
  ];
}

/**
 * 界面上真正显示的标题。
 * @param name  `config.name`（用户可改的那个）
 */
export function instanceTitle(
  name: string,
  mcVersion: string,
  loader: InstanceLoader | null,
): string {
  const trimmed = (name ?? '').trim();
  /*
   * ★ 带 `(数字)` 后缀的**保留那个后缀**（`Minecraft 26.3 (2)`）——
   *   它表示"同一版本的第二个实例"，去掉就会和第一个显示成同一个名字。
   *   但前面那一段要换成统一格式（原来可能是 `26.3-fabric-0.19.5 (2)` 这种内部标签）。
   */
  const dup = /\((\d+)\)$/.exec(trimmed);
  if (dup && (trimmed.startsWith(mcVersion) || /^Minecraft /.test(trimmed))) {
    return `${formatInstanceTitle(mcVersion, loader)} (${dup[1]})`;
  }
  if (trimmed && !autoNames(mcVersion, loader).includes(trimmed)) {
    // 用户改过名 → 尊重他改的
    return trimmed;
  }
  return formatInstanceTitle(mcVersion, loader);
}
