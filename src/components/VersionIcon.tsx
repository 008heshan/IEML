/**
 * 版本图标（MC 版本 + 加载器）
 * ------------------------------------------------------------------
 * ## 为什么需要它（用户的要求）
 *
 * 原话：「mc 版本也可以要 icon 的，只是需要好的显示方式，或许得让 mc 版本有
 * 更好的显示方式，而不是展开后看到版本们一堆堆在一起」。
 *
 * 所以这里解决两件事：
 *   ① **一眼能分辨**：一条纯文字 `1.20.1` 和一串 `1.20.1 / 1.20.2 / 1.20.4`
 *      在列表里长得一模一样。按"版本世代"给一个**方块图标**（等距立方体，
 *      不同世代不同色）之后，扫一眼就知道哪个是新的、哪个是老版本。
 *   ② **分组显示**：列表按 `1.21` / `1.20` 这样的世代分组，每组一个标题 ——
 *      900 个版本平铺就是"一堆堆在一起"，分组之后是"一节一节的"。
 *
 * ## ★ 为什么不是"真正的游戏图标"
 *
 * Minecraft 的草方块等贴图是 Mojang 的美术资源，**不能随启动器分发**
 * （README「许可」一节写着：本项目不含任何游戏资源文件）。
 * 所以这里画的是一个**自绘的等距方块**：形状是通用的几何，颜色由版本世代决定，
 * 不复制任何官方美术。PCL 用的是本地游戏文件里的贴图 —— 我们没有那份文件，
 * 也不该去下它。
 *
 * ## ★★★★ 2026-09-26：**世代判据与分组函数搬到 `./version-family.ts` 了**
 *
 *   `versionFamily` / `VersionFamily` / `groupByFamily` 现在住在那边，
 *   这里是**图标组件**（只负责画）。
 *
 *   为什么搬：那几个是纯逻辑，而 `.tsx` 里的东西**跑不进 `node --test`**
 *   （Node 只剥离 `.ts`，遇到 `.tsx` 直接 `ERR_UNKNOWN_FILE_EXTENSION`）。
 *   搬出来之后 `tests/version-groups.test.mjs` 能直接调它们 ——
 *   而"同一世代出现两次"（用户截图：快照出现了两次）这种毛病
 *   **不报错、只是显示乱**，正是必须有机器守的那一类。
 *
 *   ★ 这里**只 re-export**，让老的 import 路径（`./VersionIcon`）继续可用；
 *     新代码请直接从 `./version-family` 拿（那边才是真源）。
 */

import versionIcon from '../assets/version-icon.png';
import { versionFamily } from './version-family';

export { groupByFamily, versionFamily, type VersionFamily } from './version-family';

/**
 * 自绘的等距方块图标。
 *
 * 三个面用同一个色相的三档明度：顶面最亮、右侧中间、左侧最暗 ——
 * 就有了"立体块"的感觉，而且**任何纯色主题下都成立**（不依赖图片资源）。
 */
export function VersionIcon({
  version,
  size = 34,
  title,
}: {
  version: string;
  size?: number;
  /** 悬停提示（默认就是版本号） */
  title?: string;
}) {
  const fam = versionFamily(version);
  return (
    <span
      className={`vi vi-${fam.tone}`}
      style={{ width: size, height: size }}
      title={title ?? version}
      aria-hidden="true"
    >
      <img src={versionIcon} width={size} height={size} alt="" style={{ borderRadius: 4 }} />
    </span>
  );
}
