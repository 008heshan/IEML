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
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { Button, Note } from '../ui';
import { useConfirm } from '../ui/confirm';
import {
  IconAlert,
  IconBox,
  IconCheck,
  IconCopy,
  IconDownload,
  IconFolder,
  IconJava,
  IconPuzzle,
  IconRam,
  IconRefresh,
  IconTerminal,
  IconTrash,
} from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
// ★ 整合包身份与"有没有新版"（ADR-025 第 4 条）的类型 —— 只借类型，不自己拼结论
import type { PackInfo, PackUpdateVerdict } from '../bridge/tauri';
// ★ 导出为整合包（ADR-024）：弹窗在 AppShell 里挂载，这里只负责打开它
import { openExportModpack } from '../components/ExportModpackModal';
import { installGame } from '../flows/install';
import { formatBytes } from '../domain';
// ★ Java 要求只有一份实现（`domain/java-requirement.ts`）—— 界面不许自己再算一遍
import { forgeLikeOf, javaRequirementFor } from '../domain/java-requirement.ts';
import { useDeclaredJava } from '../hooks/useJavaRequirement.ts';
/*
 * ★ 2026-09-17：顶栏「安装 Mod」改成 `goDownloadFor('mod', inst.id)` 跳下载页之后，
 *   本文件不再需要 `EVT_OPEN_MOD_BROWSE`（那个事件是给"实例内的 Mod 管理页
 *   弹搜索框"用的，见 ModsPanel）。原 import 已随之删除 —— 留着就是新的 TS6133。
 */
import {
  deleteIntent,
  describeDelete,
  trashUnavailablePrompt,
} from '../domain/delete.ts';

export function InstanceOverview() {
  /** 应用自己的确认弹窗（`window.confirm` 在这个壳里是坏的，见 `ui/confirm.tsx`） */
  const confirm = useConfirm();
  const {
    open: inst,
    state,
    go,
    goDownloadFor,
    setSubPage,
    toast,
    renameInstance,
    duplicateInstance,
    removeInstance,
    closeVersion,
  } = useApp();
  const { api } = useRealApi();
  /** 隔离判定（ADR-005）：后端算好的结论（读不到时 null → 只说模式，不宣称结果） */
  const iso = inst ? state.isolation[inst.config.slug] ?? null : null;
  /**
   * ★★ 整合包安装记录（ADR-025）：这个版本是不是从整合包装的。
   * 读不到（不是整合包 / 记录没有）就是 null —— 界面显示一个破折号，不编。
   */
  const [pack, setPack] = useState<PackInfo | null>(null);
  useEffect(() => {
    if (!api || !inst) return;
    let alive = true;
    void api.pack.info(inst.config.slug).then((p) => {
      if (alive) {
        setPack(p);
        // 换了实例就把上一个实例的结论清掉（结论是"这个实例的"，不是全局的）
        setUpdateVerdict(null);
      }
    });
    return () => {
      alive = false;
    };
  }, [api, inst]);
  /** 检查 / 补齐共用一个忙碌位：它们是同一件事的两步，界面上也只有一个按钮 */
  const [busy, setBusy] = useState(false);
  /** ★ 检查整合包完整性时用它显示忙碌态（ADR-025） */
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; text: string } | null>(null);
  /**
   * ★★ 「作者有没有发新版」（ADR-025 第 4 条）。
   *
   *   `null` = 还没查过（**不显示任何结论** —— 没查就说"已是最新"是编的）；
   *   查过之后原样显示后端给的 `summary`，按钮只在真能原地升级时才出现。
   */
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateVerdict, setUpdateVerdict] = useState<PackUpdateVerdict | null>(null);
  /** 正在原地升级（升级过程与安装共用一套进度事件，界面上只显示忙碌态） */
  const [upgrading, setUpgrading] = useState(false);

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

  /*
   * ★ 2026-09-24：「启动 / 停止游戏」按钮按用户要求删掉之后，
   *   这里的 `isRunning` 与 `isInstanceRunning` 就没有用处了 ——
   *   一起删掉，不留死变量（判据本身仍在 `domain` 里，别处还要用）。
   */
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
        /*
         * ★★ 「检查并补齐文件」是**显式的补齐动作** —— 这里必须把资源文件也算上
         *   （安装默认不下资源文件，见 `installGame` 的说明）。
         *   不传的话这个按钮永远补不齐资源，用户点了会以为"补好了"。
         */
        downloadAssets: true,
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
          {/*
            ★★ 2026-09-24（用户截图 +「**这两个启动键都不要**」）：
              这里原来有一个「启动 / 停止游戏」按钮，被删掉了。
              同一个动作在界面上有三处入口（版本列表行菜单、这里、侧栏底部），
              用户明确不要 —— 启动请走「版本列表 → 启动」，或者直接在启动页上按启动。
              ★ 停止游戏的能力**没有丢**：启动页上有「停止游戏」，
                主导航侧栏底部那份"正在运行的版本"列表里每个也都能单独停。
          */}
          {/*
            ★★ 用户报「mod 列表的选项还没做，你虽然做了，但是根本没这个功能键，
               我怎么装 mod 嘛」。

            查下来是这样：安装 Mod 的功能**是有的**（ModsPanel 右上角
            「添加 Mod」→ 搜 Modrinth → 安装），但它只存在于
            「版本列表 → 双击版本 → Mod 管理」这条路上。而这个启动器
            第一屏能看到的、最像"我要装东西"的地方就是这里 ——
            以前这里一个 Mod 相关的按钮都没有。

            所以补的不是功能，是**入口**：概览页顶栏直接给一个「安装 Mod」。

            ★ 2026-09-17 用户（截图 图二）：「原版不给装mod的选项，
              **能装mod的版本，跳转mod下载页**」。按这个把入口对齐到与
              版本列表 ⋯ 菜单**完全一致**的行为：
                · 原版不显示（`inst.loader === null`，与 ModsPanel 同一判据）；
                · 能装的走 `goDownloadFor('mod', inst.id)` 跳**下载页的 Mod 页签**
                  并带上当前版本 —— 而不是"切到 Mod 管理再补一个事件"。
              以前那两行（`setSubPage('mods')` + 派发 `EVT_OPEN_MOD_BROWSE`）
              有两个问题：落在的是"已装了什么"而不是"能装什么"；
              而且事件在 ModsPanel 挂载前发出会被丢掉，搜索框根本不弹。
          */}
          {inst.loader !== null ? (
            <Button
              variant="secondary"
              onClick={() => goDownloadFor('mod', inst.id)}
            >
              <IconPuzzle /> 安装 Mod
            </Button>
          ) : null}
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
        >
          <IconRefresh /> 检查并补齐文件
        </Button>
        <span className="toolbar-sep" />
        <Button size="sm" variant="ghost" onClick={doRename}>
          <IconBox /> 重命名
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={doDuplicate}
          /*
           * ★★ 2026-09-24：这里原来有一句 title 写的是「配置照搬一份，**游戏文件共享**，
           *   不会多占几百 MB」—— 而实参是 `copyInstanceFiles(..., true)`，
           *   也就是**整份复制**（`duplicateInstance` 里写死 true；
           *   成功提示也写着"存档 / Mod / 配置都复制过去了（X MB）"）。
           *   按钮上的说明必须与实际行为一致：这里就是一次真复制，会占空间。
           * ★★ 2026-09-26 用户：「去掉所有悬停显示描述」—— 那句（已改对的）title 也删了；
           *   现在这句话只在点下去之后的确认弹窗里说（那里逐字写明会占一份空间）。
           */
        >
          <IconCopy /> 创建副本
        </Button>
        {/*
          ★★ 2026-09-27（0.10.0）：**导出为整合包**（ADR-024）。
            放在这一条动作里，是因为它是"把这个版本交给别人"的动作 ——
            与"创建副本"同一族（一个给自己，一个给别人）。
        */}
        <Button size="sm" variant="ghost" onClick={() => openExportModpack(inst.config.slug)}>
          <IconDownload /> 导出为整合包
        </Button>
        {/*
          ★★ 2026-09-28（ADR-025）：**检查整合包完整性**。
            装完发现少了几个 Mod 时，用户在这里能看见"缺哪些"，而不是进游戏才知道。
            没有安装记录（不是整合包装的）时**不显示这个按钮** —— 摆一个点了没用的
            按钮比不摆更糟。
        */}
        {pack ? (
          <Button
            size="sm"
            variant="ghost"
            loading={verifying}
            onClick={() => {
              if (!api || !inst) return;
              setVerifying(true);
              void api.pack
                .verify(inst.config.slug, false)
                .then((r) => {
                  toast(
                    r.complete ? 'ok' : 'warning',
                    r.summary,
                    r.missing.length > 0
                      ? `缺的文件：${r.missing.slice(0, 5).join('、')}${
                          r.missing.length > 5 ? '…' : ''
                        }`
                      : undefined,
                  );
                })
                .catch((e) => toast('err', '检查失败', e instanceof Error ? e.message : String(e)))
                .finally(() => setVerifying(false));
            }}
          >
            检查整合包完整性
          </Button>
        ) : null}
        {/*
          ★★ 2026-09-28（0.17.0，ADR-025 第 4 条）：**作者有没有发新版**。

            这是 0.15.0 里那句"作者没有提供新版清单"缺的另一半：以前那句话
            **没法验证**（我们根本不知道作者发没发新版）。
            结论由后端给（`summary` 一个字都不在界面里拼），按钮只在
            **真能原地升级**时才出现 —— 换了 MC 版本的新版只给一句解释，
            不给按钮（那等于换一个包，见 `domain::pack_update`）。
        */}
        {pack ? (
          <Button
            size="sm"
            variant="ghost"
            loading={checkingUpdate}
            onClick={() => {
              if (!api || !inst) return;
              setCheckingUpdate(true);
              void api.pack
                .checkUpdate(inst.config.slug)
                .then((v) => setUpdateVerdict(v))
                .catch((e) =>
                  toast('err', '查不到新版本', e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setCheckingUpdate(false));
            }}
          >
            检查整合包更新
          </Button>
        ) : null}
        {/*
          ★ 升级按钮只在"有能原地升的版本"时出现（`upgrade_target` 由后端判）。
            点了先问一句（要下多少、会动什么），再走 `pack_apply_update`。
        */}
        {pack && updateVerdict?.version_id && updateVerdict.version ? (
          <Button
            size="sm"
            variant="primary"
            loading={upgrading}
            onClick={() => {
              if (!api || !inst || !updateVerdict.version_id) return;
              const target = updateVerdict.version!;
              void (async () => {
                const ja = await confirm({
                  title: `升级到 ${target}？`,
                  message:
                    `${updateVerdict.summary}\n\n` +
                    '升级会：按新清单补齐/更新文件；作者删掉的文件移进回收区（可恢复）；' +
                    '你的存档、设置、自己装的 Mod 都不动。',
                  confirmText: '开始升级',
                });
                if (!ja) return;
                setUpgrading(true);
                const taskId = `modpack-${Date.now().toString(36)}`;
                window.dispatchEvent(
                  new CustomEvent('ieml:task-add', {
                    detail: {
                      id: taskId,
                      kind: 'install',
                      title: `升级整合包 ${pack.name} → ${target}`,
                      detail: '准备中',
                      status: 'running',
                      percent: 0,
                      finishedFiles: 0,
                      bytesPerSecond: 0,
                      currentFile: '',
                      etaSeconds: 0,
                    },
                  }),
                );
                try {
                  const r = await api.pack.applyUpdate({
                    slug: inst.config.slug,
                    versionId: updateVerdict.version_id!,
                    taskId,
                    // ★ 跟设置里的「下载源」走（0.18.2：以前这一条写死镜像）
                    source: state.prefs.downloadSource,
                  });
                  window.dispatchEvent(
                    new CustomEvent('ieml:task-patch', {
                      detail: { id: taskId, patch: { status: 'done', percent: 100 } },
                    }),
                  );
                  toast(
                    'ok',
                    `已升级到 ${target}`,
                    r.update?.summary ?? r.completion?.summary,
                  );
                  /*
                   * ★ 升级完必须**重读**记录：界面上的包版本、完整性结论
                   *   都跟着变了（不重读就会显示旧版本号 —— 那是假信息）。
                   */
                  setPack(await api.pack.info(inst.config.slug));
                  setUpdateVerdict(await api.pack.checkUpdate(inst.config.slug));
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  window.dispatchEvent(
                    new CustomEvent('ieml:task-patch', {
                      detail: { id: taskId, patch: { status: 'failed', error: msg } },
                    }),
                  );
                  toast('err', '升级失败', msg);
                } finally {
                  setUpgrading(false);
                }
              })();
            }}
          >
            升级到 {updateVerdict.version}
          </Button>
        ) : null}
      </div>

      {updateVerdict ? (
        <Note
          tone={
            updateVerdict.state === 'newer'
              ? 'warning'
              : updateVerdict.state === 'up-to-date'
                ? 'success'
                : 'info'
          }
          icon={updateVerdict.state === 'newer' ? <IconAlert /> : <IconRefresh />}
        >
          {updateVerdict.summary}
        </Note>
      ) : null}

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
          <span className="fact-k">整合包</span>
          <span className="fact-v">
            {/*
              ★★ 2026-09-28（ADR-025）：这个版本是不是从整合包装出来的、装的哪个版本。
                记录在 `<实例>/pack-record.json`（**不在游戏目录**，见 domain::pack_record）。
                没有记录就是"不是整合包装的" —— 如实显示一个破折号，不编。
            */}
            {pack ? `${pack.name} ${pack.version}` : '—'}
          </span>
          <span />
        </div>
        <div className="fact">
          <span className="fact-k">版本隔离</span>
          <span className="fact-v">
            {/*
              ★★ 2026-09-27（0.7.0）：结论来自后端（ADR-005 三段判定）。
                历史：这里先后写过"已关闭（共享目录）"与"已关闭（还没生效）" ——
                前一句是假的（共享没接上），后一句当时是真的。
                现在共享真的生效了，所以显示后端算出来的目录归属。
            */}
            {iso === null
              ? `${modeLabel(inst.config.isolation)}（判定读取中）`
              : `${modeLabel(inst.config.isolation)} · ${iso.isolated ? '独立目录' : '共享目录'}`}          </span>
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
        {/* ★★ 2026-09-16 用户："'从未启动'相关的记录时间的功能，删掉，这没有用" ——
            「最近游玩 / 累计时长」两格已删。启动器的本职是把游戏跑起来，
            玩多久是游戏自己的事；而且这个数字以前还长期是假的（从没被写过）。 */}
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
            onClick={async (e) => {
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
              /* ★★ 2026-09-24（A-0）：window.confirm 被 Tauri 换成 async 包装，
                 返回 Promise ⇒ !confirm(...) 永远是假，守卫形同虚设。
                 改成应用自己的弹窗，**必须 await**。 */
              if (
                !(await confirm({
                  title: '删除这个版本',
                  danger: true,
                  confirmText: copy.permanent ? '永久删除' : '删除',
                  message: copy.message,
                }))
              ) {
                return;
              }
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
                .catch(async (err) => {
                  // ★ 回收站不可用时不静默降级成永久删，先问用户
                  if (
                    !copy.permanent &&
                    (await confirm({
                      title: '回收站用不了',
                      danger: true,
                      confirmText: '永久删除',
                      message: trashUnavailablePrompt(err),
                    }))
                  ) {
                    void removeInstance(inst.id, true)
                      .then((bytes) => {
                        closeVersion();
                        go('versions');
                        toast(
                          'warning',
                          '已永久删除',
                          bytes > 0
                            ? `${inst.config.name} · 磁盘上释放了 ${formatBytes(bytes)}`
                            : `${inst.config.name}（磁盘上本来就没有这个目录）`,
                        );
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

/**
 * 隔离模式怎么念。
 *
 * ★ 这里只把**模式**翻译成人话，不判断"最终到底隔不隔离"—— 那是后端的结论
 *   （ADR-005/ADR-006：规则只写一次，写在 Rust 侧），页面显示的是 `state.isolation`。
 */
function modeLabel(mode: string): string {
  if (mode === 'on') return '强制隔离';
  if (mode === 'off') return '不隔离';
  return '自动判定';
}
