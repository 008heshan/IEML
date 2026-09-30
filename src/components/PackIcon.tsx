/**
 * 版本 / 整合包的图标（2026-09-30）。
 * ------------------------------------------------------------------
 * ★★ 用户原话：「这两个地方的整合包显示**整合包自己的图标**，
 *   而且要**直接在卡片上，不整那个跟槽一样的东西**」。
 *
 * ## 三条规矩
 *
 *   ① **有作者图标就用它**：`packIcons[slug]` 是装包时从包体里抽出来的
 *      （见 Rust 侧 `install_pack_plan` 的 ④′），原图直接显示。
 *   ② **没有就退回自绘的版本图标**（`VersionIcon`，按世代配色）——
 *      那本来就是"这个版本没有真图标"时的样子，**不留空、也不编**。
 *   ③ **不套槽**：作者图标**不带底色、不带边框**，直接浮在卡片上。
 *      ★ 道理与 Mod 图标那条一样：外面再套一层方框，看起来就像"放在盒子里"，
 *        而作者画的那张图本身就是完整的视觉单元。
 *
 *   尺寸由调用方给（启动页 72、版本列表 34）——两处的视觉权重不同，
 *   而"多大"是**版式**的事，不该写死在这个组件里。
 */
import { useState } from 'react';
import { VersionIcon } from './VersionIcon';

export function PackIcon({
  icon,
  version,
  size,
}: {
  /** 作者图标的 `data:` URI；没有就是 `undefined` */
  icon?: string;
  /** 退回自绘图标时用（决定配色世代） */
  version: string;
  size: number;
}) {
  /*
   * ★ 加载失败就退回自绘图标。
   *   内嵌 `data:` URI 理论上不会失败，但"理论上"三个字在这个仓库不值钱 ——
   *   真坏了的话，破图比一个正常方块难看得多。
   */
  const [broken, setBroken] = useState(false);

  if (icon && !broken) {
    return (
      <img
        className="pack-icon"
        src={icon}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
      />
    );
  }
  return <VersionIcon version={version} size={size} />;
}
