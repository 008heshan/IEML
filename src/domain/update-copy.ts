/**
 * 更新状态 → 一句**人话**（只有一个来源）。
 *
 * ★★ 2026-09-24（B-2 修复）
 *
 * ## 原来错在哪
 *
 *   `AboutPage.tsx` 里是一条三元链，只认
 *   `unsupported / available / ready / checking` 四种状态，
 *   **其余全部落到「已是最新版本」**。而 `useLauncherUpdate` 的 phase 一共有 9 种：
 *
 *     idle（还没查过）/ checking / uptodate / available / downloading /
 *     ready / installing / unsupported / **error**
 *
 *   也就是说：**断网点「检查更新」**（phase='error'）时，关于页会告诉用户
 *   「已是最新版本」—— 一个**假事实**。而错误原因早就被翻成中文写进了
 *   `state.error`，只是**没有任何地方显示它**（`UpdateChip` 在 error 时直接 return null）。
 *   同理，"还没查过"（idle）与"正在下载"（downloading）也都会被说成"已是最新版本"。
 *
 * ## 现在的规矩
 *
 *   · **只有 `uptodate` 才允许说「已是最新版本」**；
 *   · 认不出的状态**如实报出它的名字**（宁可难看，也不许说假话）；
 *   · 失败时必须把**原因**说出来（那是用户唯一能据此行动的信息）。
 *
 * ## 为什么放在 domain 而不是页面里
 *
 *   放页面里就没法被单测钉住（`.tsx` 不能直接 import 进 node 测试），
 *   而这条映射恰恰是"用户看到的结论"—— 它必须有测试守着。
 *   测试：`tests/update-copy.test.mjs`。
 */

/** 只需要这几个字段 —— 这样 domain 不必反过来依赖 hooks */
export interface UpdateLike {
  /** `UpdatePhase` 的字面量；这里收成 `string`，认不出的一律如实报出来 */
  phase: string;
  /** 新版本号（available 之后一直有） */
  version?: string;
  /** 已经翻成中文的失败原因 */
  error?: string;
}

export function describeUpdate(upd: UpdateLike): string {
  switch (upd.phase) {
    case 'unsupported':
      return '演示模式下没有更新能力';
    case 'idle':
      return '还没检查过更新';
    case 'checking':
      return '正在检查…';
    case 'uptodate':
      // ★ 全仓库**只有这一句**允许说"已是最新版本"，而且只有这个状态能走到
      return '已是最新版本';
    case 'available':
      /*
       * ★★ 2026-09-26：`available` 其实是**两种**处境 ——
       *   ① 刚查到新版本、马上要开始下（`error` 没有值）；
       *   ② **下载失败退回这里**（`useLauncherUpdate` 的 catch 把 `error` 填上）。
       *   ②的原因原来只写在顶栏角标的悬停提示里，而用户当天要求
       *   「去掉所有悬停显示描述」⇒ 那句提示没了，原因就必须在这句**看得见**的
       *   话里说出来，否则界面会对一个刚下失败的新版本说"正在后台下载"——
       *   那是一句假话（本仓库最不能忍的一类 bug）。
       */
      return upd.error
        ? `有新版本 ${upd.version}，下载没成功：${upd.error}`
        : `有新版本 ${upd.version}，正在后台下载`;
    case 'downloading':
      return `正在下载新版本 ${upd.version}…`;
    case 'ready':
      return `新版本 ${upd.version} 已经下好了`;
    case 'installing':
      return '正在交给安装程序（启动器会退出并重开）';
    case 'error':
      return `检查更新失败：${upd.error ?? '原因未知'}`;
    default:
      return `更新状态：${upd.phase}`;
  }
}

/**
 * 这个状态是不是"出问题了"（页面据此标红）。
 *
 * ★ 第二个参数是"已经翻成人话的失败原因"：`available` 带着原因 = **下载失败**，
 *   它和 `error`（检查更新失败）一样是问题，页面也该标红。
 */
export function isUpdateProblem(phase: string, error?: string): boolean {
  return phase === 'error' || (phase === 'available' && Boolean(error));
}

/**
 * 把更新失败翻成人能看懂的话。
 *
 * ★ 为什么值得单独写：更新失败最常见的原因是**网络**（这台机器的国际出口
 *   有 12–18% 丢包），而插件抛出来的是英文的 reqwest 报错，
 *   直接甩给用户等于没说。至少要让人知道"是网络问题、可以再试"。
 *
 * ★★ 2026-09-24（B-2 真机复验时抓到的真实串，见下）：
 *   原来这段在 `hooks/useLauncherUpdate.ts` 里、**没有测试**，而它的词表
 *   恰好漏了 reqwest 最外层那句 —— 真机上断网时用户看到的是
 *   `error sending request for url (https://…)`，一句纯英文。
 *   现在搬进 domain（可被 `tests/update-copy.test.mjs` 钉住）并补上实测串。
 */
export function describeUpdateError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/timeout|timed out|超时/i.test(raw)) return '检查更新超时，可能是网络不通。稍后再试。';
  if (/dns|resolve|getaddrinfo|ENOTFOUND/i.test(raw)) return '域名解析失败，检查一下网络或 DNS。';
  /*
   * ★ 实测串（把 HTTPS_PROXY 指向死端口跑出来的，逐字）：
   *   error sending request for url (https://cnb.cool/…/latest.json)
   *   上面几条词一个都不含 —— 所以这条必须单独列，且要排在泛化的 connect/network 之前。
   */
  if (/error sending request/i.test(raw)) return '连不上更新服务器（网络或代理不通）。稍后重试。';
  if (/certificate|tls|ssl|handshake/i.test(raw))
    return '与更新服务器的安全连接失败（证书 / TLS）。如果开了代理，先关掉再试。';
  if (/connect|network|unreachable|ECONN|socket/i.test(raw)) return '连不上更新服务器。检查网络后重试。';
  if (/signature|verify|public key/i.test(raw)) return '更新包签名校验失败，已拒绝安装。请联系开发者。';
  if (/404|not found/i.test(raw)) return '更新服务器上没有这个版本的清单（404）。可能刚发布还没同步好。';
  return raw;
}
