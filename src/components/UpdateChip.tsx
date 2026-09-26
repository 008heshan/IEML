/**
 * 顶栏的「新版本」角标（热更新）。
 * ------------------------------------------------------------------
 * 用户 2026-09-21：「**我想要热更新和静默安装**」。
 *
 * 三件事凑成"热"：
 *   · 开机自动查一次（`useLauncherUpdate` 里，延迟 8 秒、失败静默）；
 *   · 查到就**后台下载** —— 用户看到这个角标时通常已经能一键换了；
 *   · 点一下 = **静默安装**（NSIS `/S`）+ 装完安装程序自己把启动器拉起来（`/R`）。
 *
 * ★ 为什么放顶栏而不是只放设置页：更新是"你该做的一件事"。
 *   藏在设置页最下面那张卡里，等于只有主动去找的人才知道 ——
 *   而"玩家永远收不到更新"正是 beta.44 之前那个真实状态。
 *
 * ★ 三种状态各有各的话，**不可点时必须给出理由**（这个仓库的老规矩）：
 *   · 下载中 → 不可点，角标自己就写着"新版本 X · 下载中 45%"（理由在字面上）；
 *   · 已下好 → 「重启并更新」；
 *   · 下失败 → 「重试」。
 *
 * ★★ 2026-09-26 用户：「去掉所有悬停显示描述」——
 *   四个角标上的 `title` 全删了（原来失败原因就藏在里面）。
 *   **原因没有丢**：`describeUpdate()` 在「关于 → 启动器更新」那一行把
 *   `state.error` 写出来（下载失败会显示"下载没成功：…"，且那一行标红）——
 *   见 `domain/update-copy.ts` 与 `tests/update-copy.test.mjs`。
 */
import { useApp } from '../state/AppContext';
import { IconDownload } from '../ui/Icons';

export function UpdateChip() {
  const { update } = useApp();
  const { state } = update;

  /* 只有这四种状态值得占顶栏的位置 —— 其余（已是最新 / 还没查过 / 演示模式）不打扰 */
  if (
    state.phase !== 'downloading' &&
    state.phase !== 'ready' &&
    state.phase !== 'available' &&
    state.phase !== 'installing'
  ) {
    return null;
  }

  const v = state.version ?? '';
  const pct =
    state.total && state.total > 0
      ? Math.min(100, Math.round(((state.downloaded ?? 0) / state.total) * 100))
      : null;

  if (state.phase === 'downloading') {
    return (
      <button
        type="button"
        className="chip chip-btn chip-neutral upd-chip"
        disabled
      >
        <IconDownload />
        <span className="truncate">
          新版本 {v}
          {pct === null ? ' · 下载中' : ` · ${pct}%`}
        </span>
      </button>
    );
  }

  if (state.phase === 'installing') {
    return (
      <button
        type="button"
        className="chip chip-btn chip-accent upd-chip"
        disabled
      >
        <IconDownload />
        <span className="truncate">正在更新…</span>
      </button>
    );
  }

  if (state.phase === 'ready') {
    return (
      <button
        type="button"
        className="chip chip-btn chip-accent upd-chip"
        onClick={() => void update.install()}
      >
        <IconDownload />
        <span className="truncate">新版本 {v} · 重启并更新</span>
      </button>
    );
  }

  /* available —— 下载还没成（失败或还没开始） */
  return (
    <button
      type="button"
      className="chip chip-btn chip-warning upd-chip"
      onClick={() => void update.download()}
    >
      <IconDownload />
      <span className="truncate">新版本 {v} · 重试下载</span>
    </button>
  );
}
