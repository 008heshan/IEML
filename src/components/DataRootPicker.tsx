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
 * ★★ **即时生效**（2026-09-25 用户：「我不想要重启才生效，切换游戏数据应该是实时的」）：
 *   后端 `set_data_root` 校验 + 落盘之后**当场换掉 `AppState` 里的路径句柄**
 *   （`RwLock<Arc<AppPaths>>`），返回 `restartRequired: false`；
 *   父组件拿到结果后调 `reloadAfterRootChange()` 把派生的那几样刷新一遍。
 *   ⇒ 界面上不再有"重启后生效"这一说。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Modal, Note } from '../ui';
import { useConfirm } from '../ui/confirm';
import { IconAlert, IconRefresh } from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import type { DataRoot } from '../bridge/tauri';

export interface DataRootPickerProps {
  open: boolean;
  onClose: () => void;
  /** 现在正在用的根目录（`machine_info` 给的；换完会立刻变） */
  current: string;
  toast: (kind: 'ok' | 'warning' | 'err' | 'info', title: string, desc?: string) => void;
  /** 换成功之后（父组件据此刷新派生的那几样 —— 见 `reloadAfterRootChange`） */
  onChanged?: (next: string) => void;
}

export function DataRootPicker({ open, onClose, current, toast, onChanged }: DataRootPickerProps) {
  const { api } = useRealApi();
  /** 应用自己的确认弹窗（`window.confirm` 在这个壳里是坏的，见 `ui/confirm.tsx`） */
  const confirm = useConfirm();
  /** 用过的游戏文件夹（PCL 那张「文件夹列表」） */
  const [roots, setRoots] = useState<DataRoot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在写哪个目录（`null` = 没在写） */
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      setRoots(await api.launcher.dataRoots());
    } catch (e) {
      setRoots([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  /* 每次打开都重新读一遍：用户可能刚新建过一个目录、或删掉了一个 */
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  /** 把一个（已经不存在的）目录从列表里去掉 —— 只动列表，不碰磁盘 */
  async function forget(path: string) {
    if (!api || busy) return;
    setBusy(path);
    try {
      await api.launcher.forgetDataRoot(path);
      toast('info', '已从列表里去掉', `${path}（磁盘上的东西一个都没动）`);
      await load();
    } catch (e) {
      toast('err', '去不掉这一条', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

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
       * ★★ 2026-09-25（用户截图：换完目录弹出上下两条提示）：
       *
       *   「提示这里，上面的那个不要；下面的文字只保留『已切换游戏根目录』，
       *     文字改成『游戏根目录已切换』」
       *
       *   ⇒ 这一条又长又黄的提示**整条去掉**。它想说的三件事现在都由页面自己说，
       *     而且说得更清楚：
       *       · 换成了哪个目录 → 版本列表页头常驻「N 个版本 · 文件夹 <路径>」；
       *       · 新目录里是空的 → 那里直接显示空状态「这个文件夹里没有可用的版本」；
       *       · 旧目录没被动过 → 弹窗自己写着「只换地方，不搬东西」，空状态里也写着。
       *     一条 toast 里塞三句话，读者只会看第一句 —— 不如让页面承担。
       *
       *   ★ 只留下**一件反直觉的事**：用户选的是 `.minecraft` 本身、被我们提了一级
       *     （PCL 的「添加已有文件夹」就是这么选的）。不常见，而且不说的话
       *     他看到落地路径和选的不一样，会以为选错了。
       */
      if (r.normalizedFrom) {
        toast(
          'info',
          '已按它的上级目录当游戏根目录',
          `新的：${r.path}（你选的是 .minecraft 文件夹本身）`,
        );
      }
      onChanged?.(r.path);
      onClose();
    } catch (e) {
      toast('err', '换不了这个目录', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** 系统文件夹对话框 —— 留给"想放在别的地方"的人（可以在里面新建文件夹） */
  /**
   * **删除一个根目录（连目录一起删）** —— 用户图二要求的能力，且明确选了"连目录删"。
   *
   * ★ 两次确认，第一次把**要删什么**写清楚：
   *   "哪个路径" + "这是不可恢复的" + "里面可能有什么"。
   *   第二次是一句更短的"真的删吗" —— 两步之间用户有时间反悔。
   */
  async function removeDir(path: string) {
    if (!api) {
      toast('info', '演示模式', '浏览器里删不了目录');
      return;
    }
    /*
     * ★★ 2026-09-24（A-0）：这里原来是 `window.confirm(...)` ——
     *   而 Tauri 把它换成了 **async 包装**，返回的是 Promise：
     *   `if (!ok1)` 永远为假 ⇒ **两道确认都不生效，点了直接删**。
     *   现在走应用自己的确认弹窗（`useConfirm`），**必须 await**。
     */
    const ok1 = await confirm({
      title: '删除游戏根目录',
      danger: true,
      confirmText: '继续',
      message:
        `要删除这个游戏根目录吗？\n\n${path}\n\n` +
        '注意：**连目录里的文件一起删**（版本 / 存档 / Mod 都在里面），删完不可恢复。\n' +
        /*
         * ★★ 2026-09-24（A-4）：这段"不会连累什么"的话必须写出来。
         *   以前 `instances.json` / `prefs.json` 就住在这个目录里 ——
         *   删根目录 = **实例清单与全部设置一起没**，而两道确认里一个字都没提。
         *   现在它们（连同 ms_client_id.txt / cf_api_key.txt）住在启动器自己的
         *   数据目录里（Windows 是 %APPDATA%\IEML），删这个根目录不会碰到它们。
         */
        '**不会**动到：启动器的实例清单、设置、登录用的 client_id、CurseForge Key\n' +
        '—— 它们住在启动器自己的数据目录（Windows 上是 %APPDATA%\\IEML），不在这个目录里。\n' +
        '如果只想让它从这张列表里消失，请点「移除」。',
    });
    if (!ok1) return;
    const ok2 = await confirm({
      title: '再确认一次',
      danger: true,
      confirmText: '永久删除',
      message: `真的删除 ${path} ？\n\n这一步之后没法撤销。`,
    });
    if (!ok2) return;

    setBusy(path);
    try {
      const bytes = await api.launcher.deleteDataRoot(path);
      const mb = bytes > 0 ? `释放了 ${(bytes / 1024 / 1024).toFixed(1)} MB` : '目录本来是空的';
      toast('ok', '已删除', `${path}（${mb}）`);
      await load();
    } catch (e) {
      /*
       * ★ 后端的拒绝**带原因**（当前根目录 / 启动器数据目录 / 盘符根 / 不是目录），
       *   原样显示 —— 不要把它翻译成一句"删除失败"。
       */
      toast('err', '没删成', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

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
      subtitle="只换地方，不搬东西"
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
          title="列不出文件夹"
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
          · **切换** —— 在启动器里点（下面这张表），**不打开资源管理器**；
          · **新建** —— 走系统对话框（要进去新建文件夹），那是它该干的事。
        ★★ 这张表是 **PCL 那种「文件夹列表」**（用户给了 PCL 的截图：
          "当前文件夹 / D:\Minecraft\.minecraft\"、"测试目录 / D:\测试目录\.minecraft\"）：
          一行 = **一个你用过的游戏文件夹**（名字 + 路径），而不是"机器上有哪些盘"。
          盘符列表每次都要你重新想"放哪"；这张表是"回到你去过的那个地方"。
      */}
      <div className="droot-sec">切换（点一下就用它）</div>

      <div className="droot-list">
        {loading && roots.length === 0
          ? Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="droot-row droot-row-sk">
                <span className="sk sk-line w30" />
                <span className="sk sk-line w45" />
              </div>
            ))
          : null}

        {roots.map((r) => (
          <div className="droot-row" key={r.path}>
            <span className="droot-name">
              <span className="truncate" title={r.path}>
                {r.name}
              </span>
              {r.isCurrent ? <Chip tone="accent">正在用</Chip> : null}
              {!r.exists ? <Chip tone="warning">找不到这个目录</Chip> : null}
              {r.exists && r.onSystemDrive && !r.isCurrent ? (
                <Chip tone="warning">系统盘</Chip>
              ) : null}
            </span>
            <span className="droot-target mono truncate" title={r.path}>
              {r.path}
            </span>
            {/*
              ★ 目录已经不在的，只能「移除」—— 点"用这个"只会得到一句后端报错。
                这是"禁用必须给具体理由"的另一种形态：**给一个能做的动作**。
            */}
            {r.exists ? (
              <>
                <Button
                  size="sm"
                  variant={r.isCurrent ? 'ghost' : 'primary'}
                  disabled={r.isCurrent || busy !== null}
                  loading={busy === r.path}
                  title={r.isCurrent ? '现在用的就是这个目录' : `把游戏根目录换成 ${r.path}`}
                  onClick={() => void apply(r.path)}
                >
                  {r.isCurrent ? '当前' : '用这个'}
                </Button>
                {/*
                  ★★ 2026-09-23 用户（图二）：「游戏根目录要**允许用户删除**」，
                    并明确选了 **B：连目录一起删**。

                  ★ 这是**不可恢复**的操作，所以：
                    · 当前正在用的那个**不给删**（title 说明原因：先切走再删）；
                    · 点下去要**两次确认**，第一次把"删哪个路径、里面有多少东西"写清楚，
                      第二次再确认一次 —— 两句话都点"确定"才真的删。
                  ★ 后端还有另外三道闸（启动器数据目录 / 盘符根 / 必须真是目录），
                    拒绝时会带原因回来，这里原样显示。
                */}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={r.isCurrent || busy !== null}
                  title={
                    r.isCurrent
                      ? '这是现在正在用的根目录 —— 先切换到别的目录，再删它'
                      : `删除 ${r.path}（连里面的文件一起删，不可恢复）`
                  }
                  onClick={() => void removeDir(r.path)}
                >
                  删除
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                title="把这个目录从列表里去掉（磁盘上什么都没有动）"
                onClick={() => void forget(r.path)}
              >
                移除
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="droot-alt">
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void browse()}>
          新建文件夹…
        </Button>
        {/*
          ★★ 2026-09-22 用户：「**图九这个栏字太多了，眼花缭乱的**」——
            那一整句说明（"要新建一个目录（比如 D:\Games\IEML）走这里：会打开系统对话框，
            在里面新建文件夹再选中它 —— 选完也会进上面这张表"）删掉，只留最短的一句。
            按钮上的字已经说清了它是干什么的。
        */}
        <span className="dim">新建一个目录（会打开系统对话框）</span>
      </div>

      <div className="dim droot-note">
        {/* ★ 这里不许写 markdown 记号：JSX 文本按纯文本渲染，
            `**重启**` 会原样显示成带星号的怪东西（这个仓库栽过一次）。
            ★★ 2026-09-22：同样按"字太多"精简 —— 原来那一长句
              （"换完要重启启动器才生效 —— 数据目录是启动时定下来的，这个弹窗只负责把选择记下来。
                旧目录不会被搬走也不会被删，想换回来重新选它就行。"）压成两行。 */}
        ★ 换完<b>立刻生效</b>，不用重启。旧目录不搬不删，随时能换回来。
      </div>
    </Modal>
  );
}
