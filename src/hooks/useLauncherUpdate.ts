/**
 * 启动器自身的更新（**热更新**：查 → 后台下 → 一键换 → 自己回来）。
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
 *   两者都叫"检查更新"会让人点错，所以文案是「新版本 vX」，而不是含糊的"更新"。
 *
 * ## 2026-09-21：用户要「热更新和静默安装」，于是补了三件事
 *
 *   ① **开机自动查一次**（延迟 `AUTO_CHECK_DELAY_MS`，别和启动那一堆网络请求抢带宽）。
 *      自动查失败**静默**（回到 idle）—— 开机弹一条红色的"检查更新失败"是噪音，
 *      用户没做任何操作，不该被报错打扰。手动点的那次才报错。
 *   ② **查到就后台下载**：等用户决定"要不要更新"时，包已经在本地了 ——
 *      点一下就是"重启并更新"，而不是"等 3 MB 下完"。
 *   ③ **静默安装**：`tauri.conf.json` 的 `plugins.updater.windows.installMode = "quiet"`
 *      → NSIS 收到 `/S`（无界面）**加上 `/R`（装完自己把启动器拉起来）**。
 *      这两件事都在插件的 `config.rs` 里有据可查（`nsis_args` / `nsis_restart_after_install_args`），
 *      不是猜的：`quiet` → `/S` + `/R`；默认的 `passive` → `/P` + `/R`（会显示进度条）。
 *      ★ 也就是说"装完自动回来"是插件白送的（`restartAfterInstall` 默认 true），
 *        我们只需要把档位设成 quiet，**不要**再加 `--no-restart` 之类的参数。
 *
 * ★ 为什么不用 @tauri-apps/plugin-process 的 relaunch：
 *   多一个依赖就多一条权限、多一处可能在别人机器上出问题的环节。
 *   插件文档写明：Windows 上 `install` 会**自己退出 app** 并把控制权交给安装程序，
 *   装完由安装程序拉起（`/R`），不需要我们手动 relaunch（那是 macOS/Linux 的要求）。
 *
 * ★ 为什么可以用 `import type`：
 *   类型导入在编译期就被抹掉，不会把 Tauri 插件拖进浏览器演示模式的包里；
 *   真正的运行时 import 放在函数体里、需要时才发生。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { isTauri } from '../bridge';
/*
 * ★★ 2026-09-24：`describeUpdateError` 住在 `domain/update-copy.ts` ——
 *   放这个文件里没法被单测钉住（它依赖 React 与 Tauri 桥），
 *   而它恰恰决定"用户看到的失败原因"，必须有测试守着。
 *   真机复验时抓到它漏了 reqwest 最外层那句 `error sending request for url (…)`：
 *   断网的用户看到的是一句纯英文。见 `tests/update-copy.test.mjs`。
 */
import { describeUpdateError } from '../domain/update-copy';

export type UpdatePhase =
  | 'idle' // 还没查过
  | 'checking'
  | 'uptodate' // 查过了，已是最新
  | 'available' // 有新版本，但还没下下来（正在下，或下失败了）
  | 'downloading'
  | 'ready' // ★ 新包已经躺在本地，就等用户点"重启并更新"
  | 'installing' // 已交给安装程序；Windows 上这里 app 就退出了
  | 'unsupported' // 浏览器演示模式，没有更新能力
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  /** 新版本号（available 之后一直有） */
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

/**
 * 开机之后隔多久自动查一次。
 *
 * ★ 8 秒不是随手写的：启动那几秒里，Rust 侧正在跑源延迟探测（`net::probe`
 *   三个端点取中位数）和版本清单，那些是**用户马上要用的**；自动更新检查
 *   晚几秒没有任何代价。抢带宽只会让首屏该出来的东西变慢 ——
 *   那正是这个仓库反复记着的"优化一处、劣化另一处"。
 */
const AUTO_CHECK_DELAY_MS = 8_000;

export function useLauncherUpdate() {
  const [state, setState] = useState<UpdateState>(() => ({
    phase: isTauri() ? 'idle' : 'unsupported',
  }));
  /** 待安装的 Update 对象。放 ref 里 —— 它不该触发重渲染。 */
  const pending = useRef<Update | null>(null);
  /**
   * ★ 包**已经下到本地**了吗？（2026-09-24 加）
   *   `pending.current` 只表示"查到了一个更新"，不代表包在手上；
   *   而"能不能直接装"取决于这个 —— 用户报的"点了又下一份"就出在这个区别上。
   */
  const downloaded = useRef(false);
  const busy = useRef(false);
  /** 自动查只做一次（这个 hook 挂在 AppContext 上，但别指望它只渲染一次） */
  const autoChecked = useRef(false);

  /**
   * 把新包下到本地（**只下载，不安装**）。
   *
   * ★ 拆开 `download` 与 `install` 是"热更新"的关键：
   *   下载可以在后台悄悄完成，安装则要等用户点头（那一刻启动器会退出并重开）。
   *   合并成 `downloadAndInstall` 就只有"用户点了才开始下"这一条路。
   */
  const download = useCallback(async () => {
    const update = pending.current;
    if (!update || busy.current) return;
    busy.current = true;
    setState((s) => ({ ...s, phase: 'downloading', downloaded: 0, total: null, error: undefined }));
    try {
      let got = 0;
      await update.download((e: DownloadEvent) => {
        if (e.event === 'Started') {
          setState((s) => ({ ...s, total: e.data.contentLength ?? null }));
        } else if (e.event === 'Progress') {
          got += e.data.chunkLength;
          setState((s) => ({ ...s, downloaded: got }));
        }
      });
      downloaded.current = true;
      setState((s) => ({ ...s, phase: 'ready' }));
    } catch (e) {
      /*
       * ★ 下载失败要**退回 available 并留下原因**，而不是停在 downloading：
       *   停在 downloading 界面上会一直显示"下载中"，而它其实早就断了。
       *   （"看起来还在动"是最难被发现的一类假状态。）
       */
      setState((s) => ({ ...s, phase: 'available', error: describeUpdateError(e) }));
    } finally {
      busy.current = false;
    }
  }, []);

  const checkNow = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (busy.current) return;
      if (!isTauri()) {
        setState({ phase: 'unsupported' });
        return;
      }
      /*
       * ★★ 2026-09-24（用户报的 bug）：「**在检查到更新并下载完新版本后，转变安装按钮时，
       *   点击依旧是检查更新，而且还会再给我下一份**」。
       *
       *   现场：关于页那个按钮的文字已经变成「重启并更新」，但 onClick 里写的还是
       *   `checkNow()` —— 于是它**又去问了一次服务端**、拿到**一个新的 Update 对象**放进
       *   `pending.current`，接着 `download()` 从头再下一份（3.4 MB，白下一遍）。
       *
       *   两道修：① 按钮按状态分支（见 `AboutPage`）；② 这里加守卫 ——
       *   **手里已经有一个下好的包，就不许再查、更不许再下**，只把状态重申成 ready。
       *   守卫必须有：界面之外还可能有人（快捷键/未来接线）调进来。
       */
      if (pending.current && downloaded.current) {
        setState((s) => ({ ...s, phase: 'ready', error: undefined }));
        return;
      }
      const silent = opts?.silent === true;
      busy.current = true;
      setState({ phase: 'checking' });
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check({ timeout: CHECK_TIMEOUT_MS });
        if (!update) {
          pending.current = null;
          downloaded.current = false;
          setState({ phase: 'uptodate' });
          return;
        }
        pending.current = update;
        setState({ phase: 'available', version: update.version, notes: update.body ?? '' });
        busy.current = false; // 下载自己管 busy，这里先放开
        /* ★ 查到就**后台下**：等用户决定时包已经在了（见文件头部的说明） */
        void download();
      } catch (e) {
        if (silent) {
          /* 自动查失败 = 用户没做任何操作 → 不留痕、不打扰（下次开机再试） */
          console.warn('[IEML/update] 自动检查更新失败：', e);
          setState({ phase: 'idle' });
        } else {
          setState({ phase: 'error', error: describeUpdateError(e) });
        }
      } finally {
        busy.current = false;
      }
    },
    [download],
  );

  /**
   * 装上（**静默**）：`installMode = "quiet"` 让 NSIS 收到 `/S`，
   * 而插件的 `restartAfterInstall`（默认 true）会补一个 `/R` ——
   * 装完安装程序自己把启动器拉起来。
   * ★ 走到这里之后**本进程会被结束**（插件里是 `std::process::exit(0)`），
   *   所以下面那句 setState 只是为了"万一没退成"时界面别停在旧状态。
   */
  const install = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    setState((s) => ({ ...s, phase: 'installing' }));
    try {
      await update.install();
      pending.current = null;
      downloaded.current = false;
    } catch (e) {
      const raw = describeUpdateError(e);
      /*
       * ★★ 装失败时**必须把"包还在本地"这件事说清楚**：用户已经等过一次下载，
       *   再让他重新下一遍是第二次收税。`ready` 这个状态表示"包在手上，
       *   只是没装成"，界面上按钮仍然是"重启并更新"，可以直接再试。
       */
      setState((s) => ({ phase: 'ready', error: raw, version: s.version, notes: s.notes }));
    }
  }, []);

  /* 开机自动查一次（延迟、静默、只查一次） */
  useEffect(() => {
    if (!isTauri() || autoChecked.current) return;
    autoChecked.current = true;
    const t = setTimeout(() => void checkNow({ silent: true }), AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(t);
  }, [checkNow]);

  return { state, checkNow, download, install };
}
