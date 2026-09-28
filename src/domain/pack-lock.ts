/**
 * 整合包实例的 **Mod 更新锁定**（ADR-018 第 ⑥ 条）
 * ------------------------------------------------------------------
 * 原文：
 *
 * > 从整合包安装的实例，其 Mod 版本由 manifest 指定。**默认不允许更新**
 * > （因为整合包作者已经验证过这套组合），UI 上更新按钮应置灰并说明
 * > 「此实例由整合包管理，作者未提供新版本清单」。
 * > 若整合包提供了新版 manifest，则走**整合包整体更新**流程，而不是一个个 Mod 单独更新。
 *
 * ## 为什么这条规矩值得单独写成函数
 *
 *   它是一条**产品规则**（不是实现细节）：判错的代价是"用户把作者配好的一套 Mod
 *   升级坏掉"，而那种崩法很难查（作者验证过的组合被我们拆了）。
 *   写成纯函数 + 单测，是为了让它**不可能**在某次界面改动里被顺手删掉。
 *
 * ## 判定只需要一个事实
 *
 *   "这个实例是不是从整合包装的" —— 那由后端回答（`pack_info` 读
 *   `<实例>/pack-record.json`，见 ADR-025 的实现）。这里**不猜**：
 *   没有记录（`null`）就是没锁定，录不到就当作"不是整合包"（宁可放开也不误锁 ——
 *   误锁会让整合包用户连"自己装的 Mod"都更新不了）。
 */

/** 后端 `pack_info` 的返回（同 `src/bridge/tauri.ts` 的 `PackInfo`） */
export interface PackInfoLike {
  name: string;
  version: string;
  source: string;
}

export interface ModUpdateLock {
  /** 允许更新吗 */
  locked: boolean;
  /** 为什么（锁定/放开都要说得出，界面直接显示这一句） */
  reason: string;
}

/**
 * 这个实例的 Mod 能不能更新。
 *
 * `pack === null`（不是从整合包装的 / 没有记录）⇒ 允许更新。
 */
export function modUpdateLock(pack: PackInfoLike | null): ModUpdateLock {
  if (!pack) {
    return { locked: false, reason: '这个版本不是从整合包装的，Mod 可以自行更新' };
  }
  return {
    locked: true,
    reason:
      `此实例由整合包「${pack.name} ${pack.version}」管理，作者没有提供新版清单 —— ` +
      '单个 Mod 的更新会破坏作者验证过的组合，已关闭',
  };
}
