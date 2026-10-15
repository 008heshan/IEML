/**
 * 「当前用哪个账号」这件事的**纯逻辑**（2026-10-09）
 * ------------------------------------------------------------------
 * ## 它为什么值得单独一个文件
 *
 *   用户报的 bug：「切换到离线登录，再切回正版登录**要重新登录**」。
 *
 *   根因不在 keyring（正版凭据一直好好地躺在系统凭据管理器里），而在
 *   **"上一次那个正版账号是谁"这件事只记在内存里**：
 *
 *     · 切离线时把 `prefs.accountUuid` 写成 `null`（正确 —— 那表示"现在用离线"）；
 *     · 但"上一个正版 uuid"只存在 `AccountMenu` 的一个 `useRef` 里 ——
 *       而那个组件**一进版本二级页就被卸载**（侧栏整体换掉），
 *       更别提重启了；
 *     · 于是"切回正版"走到 `if (!savedUuidRef.current)` 那条分支 →
 *       弹出登录面板 → 用户只能重新走一遍微软授权。
 *
 *   ⇒ 两件事必须**分开记**：
 *       `accountUuid`      = 现在用哪个（切换会改它）
 *       `lastPremiumUuid`  = 上一次那个正版号是谁（**切离线时不许清**）
 *     这一层只回答"能不能切回去、该拿谁的 uuid 去切"，
 *     所以它必须能在 `node --test` 里被钉住（错了不会报错，只会让用户白登一次）。
 */

/** 切回正版时该做什么 */
export type SwitchBackPlan =
  /** 现在已经是正版了 —— 什么都不用做（别弹任何东西） */
  | { kind: 'already-online'; uuid: string }
  /** 有可切回的正版 uuid —— 拿它去切换 */
  | { kind: 'switch'; uuid: string }
  /** 没有任何正版号可切回 —— 只能走一次登录 */
  | { kind: 'need-login' };

/** uuid 的形态检查：与 `sanitizePrefs` 里那条一致（带不带横线都认） */
export function looksLikeUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-fA-F-]{32,36}$/.test(v);
}

/**
 * 切回正版该怎么走。
 *
 * ★ 顺序很要紧：**先看"现在是不是已经在正版了"** ——
 *   那种情况下再派发一次"切成正版"是无害的，但把登录面板弹出来就很蠢
 *   （用户在正版上点一下"切回正版"，得到的却是一个登录框）。
 */
export function planSwitchBack(prefs: {
  accountUuid?: string | null;
  lastPremiumUuid?: string | null;
}): SwitchBackPlan {
  const current = prefs.accountUuid;
  if (looksLikeUuid(current)) return { kind: 'already-online', uuid: current };
  const last = prefs.lastPremiumUuid;
  if (looksLikeUuid(last)) return { kind: 'switch', uuid: last };
  return { kind: 'need-login' };
}

/**
 * 老数据自愈：把"上一次那个正版号是谁"补记上。
 *
 *   在这条 bug 修好之前**登录过**的用户（也就是绝大多数老用户），
 *   `prefs.accountUuid` 里有 uuid、但 `lastPremiumUuid` 这个键根本不存在 ⇒
 *   他们只要切一次离线，就再也切不回正版（要重新登录）。
 *
 *   两种形状都要补：
 *     ① **现在就在用正版** ⇒ 直接把 `accountUuid` 记成"上一个正版号"
 *        （这是最常见的一种：老用户一升级就是这个形状，不需要问任何人）；
 *     ② **现在在离线、记忆也是空的** ⇒ 问后端要密钥环里那个 `__current__` 指针
 *        （切离线时它没被清掉 —— `account_offline` 只构造一个内存对象，不碰密钥环）。
 *
 * ★ 返回值只用来**记**（`lastPremiumUuid`），**绝不自动切到正版** ——
 *   用户此刻的选择是离线（或正版），替他换回来是另一种"界面自作主张"。
 * ★ 已经记着就直接返回 `null`（不覆盖：可能与当前账号不同，但那是用户的选择史）。
 */
export function adoptablePremiumUuid(prefs: {
  accountUuid?: string | null;
  lastPremiumUuid?: string | null;
}, keyringCurrent: string | null | undefined): string | null {
  if (looksLikeUuid(prefs.lastPremiumUuid)) return null; // 已经记着，不用补
  if (looksLikeUuid(prefs.accountUuid)) return prefs.accountUuid; // ① 现在就用着正版
  return looksLikeUuid(keyringCurrent) ? keyringCurrent : null; // ② 在离线，问密钥环
}
