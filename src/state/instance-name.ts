/**
 * 实例的显示名（**唯一实现**）。
 *
 * 用户 2026-09-22 给的格式：
 *   · 原版      → \`Minecraft 1.12.2 ：原版\`
 *   · 带加载器  → \`Minecraft 26.2 + Fabric 26.2：模组加载器\`
 *
 * ★ 为什么要有"用户改过名"这一支：
 *   实例名（\`config.name\`）是**用户可改**的（版本列表的「重命名」）。
 *   如果一律显示统一格式名，重命名就白改了。
 *   所以：名字等于"自动生成的那个"（或为空）→ 用统一格式名；否则显示他改的名字。
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

/** 实例里最小的那个加载器信息（界面只需要一个 kind + version） */
export interface InstanceLoader {
  kind: string;
  version?: string | null;
}

/** 自动生成的名字长什么样（旧数据里就是这两三种写法） */
function autoNames(mcVersion: string, loader: InstanceLoader | null): string[] {
  const base = [`Minecraft ${mcVersion}`, mcVersion, `${mcVersion} 原版`];
  if (!loader) return base;
  const l = loaderLabel(loader.kind);
  return [
    ...base,
    `${l} ${mcVersion}`,
    `${l} ${loader.version ?? ''}`.trim(),
    `${l} ${loader.version ?? ''} ${mcVersion}`.trim(),
  ];
}

/**
 * 统一格式名（不含"用户改过名"的判断）。
 *
 * 原版：\`Minecraft 1.12.2 ：原版\`（用户给的写法里那个空格+全角冒号照抄）
 * 加载器：\`Minecraft 26.2 + Fabric 26.2：模组加载器\`
 */
export function formatInstanceTitle(mcVersion: string, loader: InstanceLoader | null): string {
  if (!loader) return `Minecraft ${mcVersion} ：原版`;
  const l = loaderLabel(loader.kind);
  const v = loader.version ? ` ${loader.version}` : '';
  const tail = isModLoader(loader.kind) ? '模组加载器' : l;
  return `Minecraft ${mcVersion} + ${l}${v}：${tail}`;
}

/**
 * 界面上真正显示的标题。
 * @param name  \`config.name\`（用户可改的那个）
 */
export function instanceTitle(
  name: string,
  mcVersion: string,
  loader: InstanceLoader | null,
): string {
  const trimmed = (name ?? '').trim();
  if (trimmed && !autoNames(mcVersion, loader).includes(trimmed)) {
    // 用户改过名 → 尊重他改的
    return trimmed;
  }
  return formatInstanceTitle(mcVersion, loader);
}
