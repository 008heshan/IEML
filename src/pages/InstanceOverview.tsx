/**
 * 概览（二级页）
 * ------------------------------------------------------------------
 * 参照 PCL2 的概览页：**全是动作，没有一个是"值"**。
 *
 * 布局分三层，从上到下按"用到的频率"排：
 *   ① 顶栏：启动 / 安装 Mod —— 最高频的两个动作，永远在第一行
 *   ② 动作条：打开目录 / 查看日志 / 检查并补齐文件 / 重命名 / 创建副本
 *   ③ 现状表：只读事实，整表一个"去设置改"的入口（不给每行挂一个"改"）
 *
 * ★ 这里不放解释性长句。以前的四张卡每张都写两三行"为什么"，占掉半屏，
 *   用户要的按钮反而被挤到卡片右边；现在按钮自己在动作条上。
 */
import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { isInstanceRunning } from '../state/store';
import { Button, Note } from '../ui';
import {
  IconAlert,
  IconBox,
  IconCheck,
  IconCopy,
  IconFolder,
  IconJava,
  IconPlay,
  IconPuzzle,
  IconRam,
  IconRefresh,
  IconTerminal,
  IconTrash,
} from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import { installGame } from '../flows/install';
import { formatBytes } from '../domain';
// ★ Java 要求只有一份实现（`domain/java-requirement.ts`）—— 界面不许自己再算一遍
import { forgeLikeOf, javaRequirementFor } from '../domain/java-requirement.ts';
import { useDeclaredJava } from '../hooks/useJavaRequirement.ts';
import { EVT_OPEN_MOD_BROWSE } from '../state/events';
import {
  deleteIntent,
  describeDelete,
  trashUnavailablePrompt,
} from '../domain/delete.ts';

export function InstanceOverview() {
  const {
    open: inst,
    state,
    go,
    setSubPage,
    toast,
    renameInstance,
    duplicateInstance,
    removeInstance,
    closeVersion,
  } = useApp();
  const { api } = useRealApi();
  /** 检查 / 补齐共用一个忙碌位：它们是同一件事的两步，界面上也只有一个按钮 */
  const [busy, setBusy] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; text: string } | null>(null);

  const modsBytes = useMemo(
    () => state.mods.entries.reduce((s, e) => s + e.bytes, 0),
    [state.mods.entries],
  );

  /*
   * ★★ Hook 必须**无条件调用**，所以要放在 `if (!inst) return` **之前**。
   *   它只负责去后端取「Mojang 在版本 JSON 里声明的 Java」；算结论在下面
   *   用 `javaRequirementFor`（同步，可以用在条件分支之后）。
   */
  const declaredJava = useDeclaredJava(inst?.mcVersion ?? '');

  if (!inst) {
    return <Note tone="warning">没有选中的版本。</Note>;
  }

  // ★ 多开实例：判据只有一份（`isInstanceRunning`）—— 别的版本在跑不影响这一个
  const isRunning = isInstanceRunning(state, inst.id);
  /*
   * ★★ 用**唯一的**入口算"需要 Java 几"，不要在这里再写一遍。
   *
   *   这里原来有一个本地 `neededJavaMajor()`，只取 `mcVersion.split('.')[0]`
   *   当 major —— 于是 `26.2` 的 major 是 **26 而不是 1**，所有
   *   `major === 1 && …` 分支全不成立，落到 `return 8`。
   *   用户看到的就是「26.2 需要 Java 8」（而游戏其实能打开，
   *   因为启动路径由 Rust 按版本 JSON 判）。
   *
   *   `declaredJava` 是后端取回来的「Mojang 在版本 JSON 里声明的那个数」
   *   （26.2 写的是 25）—— 只按版本号基线算会得到 21，那也不是真话。
   */
  const javaReq = javaRequirementFor({
    mcVersion: inst.mcVersion,
    /*
     * ★★ **加载器种类与版本都要传**（P0-7）：Forge 的补丁号段与 Fabric Loader
     *   的版本都会改变 Java 要求（34.0.0~36.2.25 最高 8、0.17.0 之前的
     *   Loader 不兼容 Java 25）。不传的话，这里显示的数字会与
     *   **启动时真正判定的那个**不一样。
     */
    loaderKind: inst.loader?.kind ?? null,
    loaderVersion: inst.loader?.version ?? null,
    hasForgeLike: forgeLikeOf(inst.loader?.kind),
    modCount: state.mods.entries.length,
    hasOptifine: inst.addons.some((a) => a.kind === 'optifine'),
    /*
     * 把 hook 取回来的声明值传进去。`declaredJava` 变化会让这个组件重渲染，
     * 于是这里会带着新的声明值再算一次。
     */
    declaredJava,
  });
  const neededJava = javaReq.major;
  const javaReady = state.java.runtimes.some((r) => r.major === neededJava);

  /**
   * 检查并补齐 —— 一个按钮干完两步。
   *
   * ★ 以前这里是两个按钮（「检查」「一键补齐」），用户得先点检查、看到缺，
   *   再点补齐。而"缺文件"这件事没有任何需要用户决策的地方 —— 缺了就补，
   *   所以合成一步：先 verify，缺了才下载，补完再 verify 一次报实数。
   */
  const checkAndRepair = async () => {
    if (!api) {
      toast('info', '演示模式', '桌面版才能校验文件');
      return;
    }
    setBusy(true);
    setVerifyResult(null);
    try {
      const before = await api.installer.verify(inst.mcVersion, [inst.config.slug]);
      if (before.missing_count === 0) {
        setVerifyResult({ ok: true, text: `文件完整（检查了 ${before.checked} 项）` });
        return;
      }
      setVerifyResult({
        ok: false,
        text: `缺 ${before.missing_count} 项，正在补齐…`,
      });
      const outcome = await installGame({
        mcVersion: inst.mcVersion,
        loaderKind: inst.loader?.kind ?? null,
        loaderVersion: inst.loader?.version ?? null,
        source: 'bmclapi',
        concurrency: state.prefs.concurrentDownloads,
        loaderName: inst.loader ? loaderName(inst.loader.kind) : undefined,
      });
      // ★ 暂停 / 失败要分开说（P0-3）—— 暂停不是错误
      if (outcome === 'paused') {
        setVerifyResult({
          ok: false,
          text: '已暂停 —— 点顶栏任务中心的「继续」接着补',
        });
        return;
      }
      if (outcome !== 'done') {
        setVerifyResult({ ok: false, text: '补齐没完成 —— 失败原因在顶栏任务中心' });
        return;
      }
      const after = await api.installer.verify(inst.mcVersion, [inst.config.slug]);
      setVerifyResult(
        after.missing_count === 0
          ? { ok: true, text: `补齐完成，文件已完整（检查了 ${after.checked} 项）` }
          : {
              ok: false,
              text: `补齐后仍缺 ${after.missing_count} 项：${after.missing.slice(0, 3).join('、')}`,
            },
      );
    } catch (e) {
      setVerifyResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const doOpenFolder = async () => {
    const p = await api?.launcher.openFolder(inst.config.slug);
    toast('info', '版本目录', p ?? inst.config.slug);
  };

  /** 改名：只改显示名。★ 校验在 `renameInstance` 里做（判据只有一处） */
  const doRename = () => {
    const next = prompt('新的版本名称', inst.config.name);
    if (next === null) return; // 取消
    const why = renameInstance(inst.id, next);
    if (why) {
      toast('warning', '这个名字不能用', why);
      return;
    }
    toast('ok', '已重命名', '目录名不变，只改显示名');
  };

  /** 复制：真的复制目录（以前只克隆记录，副本是个空壳） */
  const doDuplicate = () => {
    void duplicateInstance(inst.id)
      .then((bytes) =>
        toast(
          'ok',
          '已创建副本',
          bytes > 0
            ? `存档 / Mod / 配置都复制过去了（${formatBytes(bytes)}）`
            : '已创建副本（源实例还没有磁盘文件，副本是空的）',
        ),
      )
      .catch((e) => toast('err', '创建副本失败', e instanceof Error ? e.message : String(e)));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{inst.config.name}</h1>
          <p className="page-desc">
            {inst.mcVersion}
            {inst.loader ? ` · ${loaderName(inst.loader.kind)} ${inst.loader.version}` : ' · 原版'}
            {inst.addons.length > 0
              ? ` · ${inst.addons.map((a) => (a.kind === 'optifine' ? 'OptiFine' : 'LiteLoader')).join(' + ')}`
              : ''}
          </p>
        </div>
        <div className="page-actions">
          {isRunning ? (
            <Button
              variant="danger"
              onClick={() => {
                // ★ 多开实例：停的是**这个**版本（不带 id 就等于"随机停一个"）
                window.dispatchEvent(
                  new CustomEvent('ieml:stop-request', { detail: { instanceId: inst.id } }),
                );
                void api?.launcher.stop(inst.id);
              }}
            >
              停止游戏
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() =>
                window.dispatchEvent(new CustomEvent('ieml:launch-request', { detail: inst.id }))
              }
            >
              <IconPlay /> 启动
            </Button>
          )}
          {/*
            ★★ 用户报「mod 列表的选项还没做，你虽然做了，但是根本没这个功能键，
               我怎么装 mod 嘛」。

            查下来是这样：安装 Mod 的功能**是有的**（ModsPanel 右上角
            「添加 Mod」→ 搜 Modrinth → 安装），但它只存在于
            「版本列表 → 双击版本 → Mod 管理」这条路上。而这个启动器
            第一屏能看到的、最像"我要装东西"的地方就是这里 ——
            以前这里一个 Mod 相关的按钮都没有。

            所以补的不是功能，是**入口**：概览页顶栏直接给一个
            「安装 Mod」，点了就切到 Mod 管理并弹出搜索框。
          */}
          <Button
            variant="secondary"
            title={
              inst.loader === null
                ? '这是纯原版版本 —— 装 Mod 前需要先给它加一个加载器（Forge / Fabric 等）'
                : '搜索并安装 Mod 到 mods 目录'
            }
            onClick={() => {
              setSubPage('mods');
              window.dispatchEvent(new CustomEvent(EVT_OPEN_MOD_BROWSE));
            }}
          >
            <IconPuzzle /> 安装 Mod
          </Button>
        </div>
      </div>

      {/* ==================== 动作条 ====================
          一行放完。以前这四个动作各占一张卡、每张卡写两三行解释，
          半屏都是字 —— 现在动作自己站出来，解释交给 title 提示。
          ============================================== */}
      <div className="toolbar">
        <Button size="sm" variant="secondary" onClick={() => void doOpenFolder()}>
          <IconFolder /> 打开目录
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setSubPage('logs')}>
          <IconTerminal /> 查看日志
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          onClick={() => void checkAndRepair()}
          title="对比官方清单，缺哪个库或资源文件就自动重下（已下好的会跳过）"
        >
          <IconRefresh /> 检查并补齐文件
        </Button>
        <span className="toolbar-sep" />
        <Button size="sm" variant="ghost" onClick={doRename} title="只改显示名，不动目录名">
          <IconBox /> 重命名
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={doDuplicate}
          title="配置照搬一份，游戏文件共享，不会多占几百 MB"
        >
          <IconCopy /> 创建副本
        </Button>
      </div>

      {verifyResult ? (
        <Note
          tone={verifyResult.ok ? 'success' : 'warning'}
          icon={verifyResult.ok ? <IconCheck /> : <IconAlert />}
        >
          {verifyResult.text}
        </Note>
      ) : null}

      {/* ==================== 只读事实 ====================
          值只在这里看，改只有一处入口 —— 所以整表只给一个「在设置里修改」，
          而不是每行挂一个「改」。
          ============================================== */}
      <div className="section-head">
        <h2 className="section-title">现状</h2>
        <button type="button" className="link-btn" onClick={() => setSubPage('setup')}>
          在设置里修改
        </button>
      </div>

      <div className="facts">
        <div className="fact">
          <span className="fact-k">
            <IconRam /> 内存
          </span>
          <span className="fact-v mono">{Math.round(inst.config.memoryMb / 1024)} GB</span>
          <span />
        </div>
        <div className="fact">
          <span className="fact-k">
            <IconJava /> Java
          </span>
          <span className="fact-v">
            需要 Java {neededJava} ·{' '}
            {javaReady ? (
              <span style={{ color: 'var(--success)' }}>已就绪</span>
            ) : (
              <span style={{ color: 'var(--warning)' }}>未找到</span>
            )}
          </span>
          <span />
        </div>
        <div className="fact">
          <span className="fact-k">版本隔离</span>
          <span className="fact-v">
            {inst.config.isolation === 'auto'
              ? '自动判定'
              : inst.config.isolation === 'on'
                ? '已强制开启'
                : '已关闭（共享目录）'}
          </span>
          <span />
        </div>
        <div className="fact">
          <span className="fact-k">Mod</span>
          <span className="fact-v">
            {state.mods.entries.length} 个
            {state.mods.entries.length > 0 ? ` · ${formatSize(modsBytes)}` : ''}
          </span>
          {/* ★ 装 Mod 的入口在顶栏，这里只负责"去看列表" */}
          <button type="button" className="link-btn" onClick={() => setSubPage('mods')}>
            管理
          </button>
        </div>
        <div className="fact">
          <span className="fact-k">最近游玩</span>
          <span className="fact-v">
            {inst.lastPlayedAt ? relativeTime(inst.lastPlayedAt) : '从未启动'}
          </span>
          <span />
        </div>
        <div className="fact">
          <span className="fact-k">累计时长</span>
          <span className="fact-v mono">
            {inst.totalPlaySeconds > 0 ? formatDuration(inst.totalPlaySeconds) : '—'}
          </span>
          <span />
        </div>
      </div>

      {/* ==================== 危险区（折叠） ==================== */}
      <details className="danger-zone">
        <summary>
          <IconAlert /> 删除这个版本
        </summary>
        <div className="danger-body">
          <p>
            删掉存档与配置；默认<b>移入回收站</b>，按住 Shift 点是永久删除。共享的游戏文件不受影响。
          </p>
          <Button
            variant="danger"
            title="默认移入系统回收站；按住 Shift 点击则永久删除"
            onClick={(e) => {
              // ★ 具体清单比抽象警告有用（PCL2 的做法）
              const detail = state.mods.entries
                .slice(0, 6)
                .map((m) => m.displayName)
                .join('\n');
              const extra =
                state.mods.entries.length > 6
                  ? `\n· 等共 ${state.mods.entries.length} 个 Mod`
                  : '';
              const saves = '实例目录里的存档、配置与截图（instances/<slug>/game/）';
              const copy = describeDelete({
                what: `「${inst.config.name}」`,
                items: [
                  ...(detail ? [detail, extra].filter(Boolean) : []),
                  saves,
                ],
                note: '共享的游戏文件不会被删除，其他版本还能继续用。',
                // 实例大小要真去遍历磁盘才知道 —— 不编数字，所以不传 bytes
                intent: deleteIntent(e),
              });
              if (!confirm(copy.message)) return;
              /*
               * ★ 审计发现：这里原来只删记录、不删磁盘，而确认框写着会删存档。
               *   现在真的删，并按结果说话。
               */
              void removeInstance(inst.id, copy.permanent)
                .then((bytes) => {
                  closeVersion();
                  go('versions');
                  toast(
                    'warning',
                    copy.doneVerb,
                    bytes > 0
                      ? `${inst.config.name} · 磁盘上释放了 ${formatBytes(bytes)}`
                      : `${inst.config.name}（磁盘上本来就没有这个目录）`,
                  );
                })
                .catch((err) => {
                  // ★ 回收站不可用时不静默降级成永久删，先问用户
                  if (!copy.permanent && confirm(trashUnavailablePrompt(err))) {
                    void removeInstance(inst.id, true)
                      .then(() => {
                        closeVersion();
                        go('versions');
                        toast('warning', '已永久删除', inst.config.name);
                      })
                      .catch((e2) => {
                        closeVersion();
                        go('versions');
                        toast('err', '磁盘目录没删掉', e2 instanceof Error ? e2.message : String(e2));
                      });
                    return;
                  }
                  closeVersion();
                  go('versions');
                  toast('err', '磁盘目录没删掉', err instanceof Error ? err.message : String(err));
                });
            }}
          >
            <IconTrash /> 删除这个版本
          </Button>
        </div>
      </details>
    </>
  );
}

/* ====================== 工具 ====================== */

function loaderName(kind: string): string {
  const map: Record<string, string> = {
    forge: 'Forge',
    neoforge: 'NeoForge',
    fabric: 'Fabric',
    quilt: 'Quilt',
  };
  return map[kind] ?? kind;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400000);
  if (d === 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}
