/**
 * 启动器自身的更新检查（区别于 ModsPanel 里那个"检查 Mod 更新"）。
 * ------------------------------------------------------------------
 * ★ 为什么必须有这个文件：
 *   更新通道（CNB 上的 latest.json + 签名）早就搭好了，Rust 侧也注册了
 *   `tauri_plugin_updater`，capability 里也开了 `updater:default` ——
 *   但**前端从来没有调用过它**。也就是说：东西全在，玩家永远收不到更新。
 *   这个 hook 就是那条缺失的链路。
 *
 * ★ 与"检查 Mod 更新"的区别（UI 上文案必须能分清）：
 *   - 这里更新的是**启动器自己**，装完要重启启动器；
 *   - ModsPanel 更新的是**游戏 Mod**，装完进游戏才生效。
 *   两者都叫"检查更新"会让人点错，所以按钮文案是「检查启动器更新」。
 *
 * ★ 为什么不用 @tauri-apps/plugin-process 的 relaunch：
 *   多一个依赖就多一条权限、多一处可能在别人机器上出问题的环节。
 *   插件文档写明：Windows 上 `downloadAndInstall` 会**自己退出 app** 并把
 *   控制权交给安装程序，装完由安装程序拉起，不需要我们手动 relaunch
 *   （那是 macOS/Linux 的要求）。
 *
 * ★ 为什么可以用 `import type`：
 *   类型导入在编译期就被抹掉，不会把 Tauri 插件拖进浏览器演示模式的包里；
 *   真正的运行时 import 放在函数体里、点按钮时才发生。
 */
import { useCallback, useRef, useState } from 'react';
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { isTauri } from '../bridge';

export type UpdatePhase =
  | 'idle' // 还没查过
  | 'checking'
  | 'uptodate' // 查过了，已是最新
  | 'available' // 有新版本，等用户点"下载并安装"
  | 'downloading'
  | 'installing' // 下载完，已交给安装程序；Windows 上这里 app 就退出了
  | 'unsupported' // 浏览器演示模式，没有更新能力
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  /** 新版本号（available / downloading / installing 时有意义） */
  version?: string;
  /** 更新说明（来自 latest.json 的 notes，即 CHANGELOG 里那一节） */
  notes?: string;
  /** 已下载字节数；total 为 null 表示服务端没给 Content-Length */
  downloaded?: number;
  total?: number | null;
  error?: string;
}

/**
 * 检查更新的超时。
 * ★ 交给插件原生的 `timeout` 选项，而不是自己 Promise.race —— 后者只是
 *   提前报错，底层请求还在跑，属于给用户看的假超时。
 * 国际出口在这台机器上有 12–18% 丢包，30 秒是"确实该放弃了"的量级。
 */
const CHECK_TIMEOUT_MS = 30_000;

export function useLauncherUpdate() {
  const [state, setState] = useState<UpdateState>(() => ({
    phase: isTauri() ? 'idle' : 'unsupported',
  }));
  /** 待安装的 Update 对象。放 ref 里 —— 它不该触发重渲染。 */
  const pending = useRef<Update | null>(null);
  const busy = useRef(false);

  const checkNow = useCallback(async () => {
    if (busy.current) return;
    if (!isTauri()) {
      setState({ phase: 'unsupported' });
      return;
    }
    busy.current = true;
    setState({ phase: 'checking' });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check({ timeout: CHECK_TIMEOUT_MS });
      if (!update) {
        pending.current = null;
        setState({ phase: 'uptodate' });
        return;
      }
      pending.current = update;
      setState({ phase: 'available', version: update.version, notes: update.body ?? '' });
    } catch (e) {
      setState({ phase: 'error', error: describeUpdateError(e) });
    } finally {
      busy.current = false;
    }
  }, []);

  const install = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    setState((s) => ({ ...s, phase: 'downloading', downloaded: 0, total: null }));
    try {
      let got = 0;
      await update.downloadAndInstall((e: DownloadEvent) => {
        if (e.event === 'Started') {
          setState((s) => ({ ...s, total: e.data.contentLength ?? null }));
        } else if (e.event === 'Progress') {
          got += e.data.chunkLength;
          setState((s) => ({ ...s, downloaded: got }));
        }
        // 'Finished' 之后 Windows 会退出 app，没有可显示的"完成"状态
      });
      pending.current = null;
      setState({ phase: 'installing' });
    } catch (e) {
      setState({ phase: 'error', error: describeUpdateError(e) });
    }
  }, []);

  return { state, checkNow, install };
}

/**
 * 把更新失败翻成人能看懂的话。
 *
 * ★ 为什么值得单独写：更新失败最常见的原因是**网络**（这台机器的国际出口
 *   有 12–18% 丢包），而插件抛出来的原始信息是英文的 reqwest 报错，
 *   直接甩给用户等于没说。至少要让人知道"是网络问题、可以再试"。
 */
function describeUpdateError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/timeout|timed out|超时/i.test(raw)) return '检查更新超时，可能是网络不通。稍后再试。';
  if (/dns|resolve|getaddrinfo|ENOTFOUND/i.test(raw)) return '域名解析失败，检查一下网络或 DNS。';
  if (/connect|network|unreachable|ECONN|socket/i.test(raw)) return '连不上更新服务器。检查网络后重试。';
  if (/signature|verify|public key/i.test(raw)) return '更新包签名校验失败，已拒绝安装。请联系开发者。';
  if (/404|not found/i.test(raw)) return '更新服务器上没有这个版本的清单（404）。可能刚发布还没同步好。';
  return raw;
}
