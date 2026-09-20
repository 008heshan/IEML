/**
 * 「换一个游戏根目录」弹窗（设置页 → 存储 → 新建/切换…）。
 * ------------------------------------------------------------------
 * ★★ 用户 2026-09-20：「**我希望数据目录是在启动器里选，不需要到资源管理器里找**」。
 *
 *   在这之前只有**一个**入口：系统文件夹对话框（`plugin-dialog` 的 `open`）。
 *   那个框长得就像资源管理器 —— 想"换个盘"得自己在里面翻。
 *   现在把**候选直接摆在启动器里**：一块盘一行（盘符 / 剩余空间 / 总容量 /
 *   是不是系统盘 / 会建到哪个目录），点一下就选它；
 *   系统对话框退成「其他地方…」的备选，而不是唯一入口。
 *
 * ★ 盘的列表**由后端给**（`list_data_volumes`）：盘符、剩余空间、哪块是系统盘、
 *   以及"我们打算建的目录"都只有 Rust 侧知道（目录名来自 `DATA_DIR_NAME`）。
 *   前端**不许自己拼** `<path>\IEML` —— 拼错的话界面说的位置和文件真正落下的
 *   位置就不是同一个地方，而且**一点报错都没有**。
 *
 * ★ 语义（用户 2026-09-17 明确过）：**只切换、不迁移**。新目录是空的，
 *   旧目录里的版本 / 存档 / Mod 一个字节都不动 —— 这句话必须写在界面上，
 *   否则用户不敢点。
 *
 * ★ **重启才生效**：`AppPaths` 是启动时解析一次放进 `AppState` 的。
 *   这里只记录选择（后端返回 `restartRequired`），不假装切成功了。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Modal, Note } from '../ui';
import { IconAlert, IconRefresh } from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import type { DataVolume } from '../bridge/tauri';

export interface DataRootPickerProps {
  open: boolean;
  onClose: () => void;
  /** 现在正在用的根目录（`machine_info` 给的，重启前不会变） */
  current: string;
  toast: (kind: 'ok' | 'warning' | 'err' | 'info', title: string, desc?: string) => void;
  /** 已经记下新目录之后（父组件据此显示"重启后生效"） */
  onChanged?: (next: string) => void;
}

/** 剩余空间显示：整数 GB（这一栏不是审计报告，小数没有意义） */
function gb(n: number): string {
  return `${Math.round(n)} GB`;
}

export function DataRootPicker({ open, onClose, current, toast, onChanged }: DataRootPickerProps) {
  const { api } = useRealApi();
  const [vols, setVols] = useState<DataVolume[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在写哪个目录（`null` = 没在写） */
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      setVols(await api.launcher.dataVolumes());
    } catch (e) {
      setVols([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  /* 每次打开都重新列一遍：用户可能刚插了 U 盘 / 挂了个新盘 */
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  /**
   * 真的去换。**校验与落盘全在后端**（`set_data_root`：拒绝嵌套、只读、
   * 和当前相同……每条都给具体原因），这里只负责把结果说清楚。
   */
  async function apply(target: string) {
    if (!api || busy) return;
    setBusy(target);
    try {
      const r = await api.launcher.setDataRoot(target);
      /*
       * ★★ 三种情况都要说出来，而且**空目录那一条必须说**：
       *
       *   · 目标在系统盘上 → 提示（默认选址刻意躲开它）；
       *   · 目标里已经有游戏数据 → 会说"直接用那一份"；
       *   · **目标里什么都没有** → 必须提前讲清"版本列表会是空的"。
       *
       *   最后这条是 2026-09-20 补的，来自一次真实体验：换到一个新目录之后
       *   启动器里**一个实例都不见了**（它们仍在旧目录里，只是新目录没有
       *   `instances.json`）。界面上"东西没了"和"东西被删了"看起来一模一样，
       *   而用户不会去读 toast 里那半句"旧目录里的东西一个都没动"。
       */
      const extra = [
        r.hasExistingData
          ? '这个目录里已经有游戏数据，会直接用那一份'
          : '★ 这个目录里还没有游戏数据 —— 重启后版本列表会是空的（旧数据仍在原目录里，随时能换回来）',
        r.onSystemDrive ? '★ 它在系统盘上，游戏多了会把系统盘写满' : null,
      ]
        .filter(Boolean)
        .join('；');
      toast(
        r.onSystemDrive || !r.hasExistingData ? 'warning' : 'ok',
        '已记录新的游戏根目录（重启后生效）',
        `新的：${r.path}　旧的：${r.previous} —— 旧目录里的东西一个都没动，` +
          `想换回来重新选它就行。${extra}${extra ? '。' : ''}`,
      );
      onChanged?.(r.path);
      onClose();
    } catch (e) {
      toast('err', '换不了这个目录', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** 系统文件夹对话框 —— 留给"想放在别的地方"的人（可以在里面新建文件夹） */
  async function browse() {
    let picked: string | null = null;
    try {
      /*
       * 动态 import：`@tauri-apps/plugin-dialog` 只在桌面版有意义，
       * 静态引入会把它拖进浏览器演示模式的包里。
       */
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const r = await openDialog({
        directory: true,
        multiple: false,
        title: '选一个目录当游戏根目录（旧的目录不会被动）',
      });
      picked = typeof r === 'string' ? r : null;
    } catch (e) {
      toast('err', '打不开文件夹选择框', e instanceof Error ? e.message : String(e));
      return;
    }
    if (!picked) return; // 用户取消 —— 不是错误，什么都不说
    await apply(picked);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="换一个游戏根目录"
      subtitle="只换地方，不搬东西 —— 旧目录里的版本、存档、Mod 一个都不动"
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
      }
    >
      <div className="droot-now">
        <span className="dim">现在用</span>
        <span className="mono droot-path truncate" title={current}>
          {current || '未知'}
        </span>
      </div>

      {error ? (
        <Note
          tone="danger"
          icon={<IconAlert />}
          title="列不出磁盘"
          actions={
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              <IconRefresh /> 重试
            </Button>
          }
        >
          {error}
        </Note>
      ) : null}

      {/*
        ★★ 两条路分工（用户 2026-09-20 明确）：
          · **切换** —— 在启动器里点（下面这个列表），**不打开资源管理器**；
          · **新建** —— 走系统对话框（要进去新建文件夹），那是它该干的事。
        所以列表上面直接写"切换"，新建那个按钮就叫「新建文件夹…」。
      */}
      <div className="droot-sec">切换 · 点一下就用它（不会打开资源管理器）</div>

      <div className="droot-list">
        {loading && vols.length === 0
          ? Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="droot-row droot-row-sk">
                <span className="sk sk-line w30" />
                <span className="sk sk-line w45" />
              </div>
            ))
          : null}

        {vols.map((v) => {
          /* 只剩不到 1 GB 的盘：装不下任何东西 —— **禁用并给理由**，
             而不是让他点了再看一句后端报错（"禁用必须给具体理由"）。 */
          const full = v.freeGb < 1;
          return (
            <div className="droot-row" key={v.path}>
              <span className="droot-drive mono">{v.path}</span>
              <span className="droot-free">
                {gb(v.freeGb)} 可用 <span className="dim">/ 共 {gb(v.totalGb)}</span>
              </span>
              {v.isSystem ? <Chip tone="warning">系统盘</Chip> : null}
              {v.freeGb >= 1 && v.freeGb < 5 ? <Chip tone="warning">快满了</Chip> : null}
              {v.current ? <Chip tone="accent">正在用</Chip> : null}
              <span className="droot-target mono truncate" title={v.suggested}>
                {v.suggested}
              </span>
              <Button
                size="sm"
                variant={v.current ? 'ghost' : 'primary'}
                disabled={v.current || full || busy !== null}
                loading={busy === v.suggested}
                title={
                  v.current
                    ? '现在用的就是这个目录'
                    : full
                      ? '这块盘没有可用空间了，装不下游戏'
                      : `把游戏根目录换成 ${v.suggested}`
                }
                onClick={() => void apply(v.suggested)}
              >
                {v.current ? '当前' : '用这个'}
              </Button>
            </div>
          );
        })}
      </div>

      <div className="droot-alt">
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void browse()}>
          新建文件夹…
        </Button>
        <span className="dim">
          要<b>新建</b>一个目录（比如 <span className="mono">D:\Games\IEML</span>）走这里：
          会打开系统对话框，在里面新建文件夹再选中它。
        </span>
      </div>

      <div className="dim droot-note">
        {/* ★ 这里不许写 markdown 记号：JSX 文本按纯文本渲染，
            `**重启**` 会原样显示成带星号的怪东西（这个仓库栽过一次）。 */}
        ★ 换完要 <b>重启启动器</b> 才生效 —— 数据目录是启动时定下来的，
        这个弹窗只负责把选择记下来。旧目录不会被搬走也不会被删，想换回来重新选它就行。
      </div>
    </Modal>
  );
}
