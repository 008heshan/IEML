/**
 * 版本列表（一级页）
 * ------------------------------------------------------------------
 * 参照 PCL2 的版本列表：**一行一个版本，双击进入它的二级页**。
 *
 * 刻意删掉的东西（原设计稿的繁复来源）：
 *   * 不在这里放「版本隔离」卡与「备份回滚」卡 —— 那是**某个版本**的属性，
 *     放进二级页的「设置」里，不该占着一级页
 *   * 不做左侧筛选 + 右侧面板的两栏布局 —— 一行够放下所有信息
 *   * 不做"当前实例"概念 —— 打开哪个就编辑哪个，没有隐藏状态
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/AppContext';
import { isInstanceRunning } from '../state/store';
import { EmptyState, Button, Chip, Note, SearchBox, Segmented } from '../ui';
// ★ 版本图标（自绘方块，按世代配色）—— 与下载页、启动页用的是同一个组件
import { VersionIcon } from '../components/VersionIcon';
// ★ 行菜单的图标：每个菜单项都要有，视觉效果才统一（用户要求）
import { IconCopy, IconPencil, IconTrash } from '../ui/Icons';
import {
  IconAlert,
  IconBox,
  IconDownload,
  IconFolder,
  IconInfo,
  IconMore,
  IconPlay,
  IconPlus,
  IconPuzzle,
  IconRefresh,
} from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import { formatBytes } from '../domain';
import { EVT_OPEN_MOD_BROWSE } from '../state/events';
import {
  deleteIntent,
  describeDelete,
  trashUnavailablePrompt,
} from '../domain/delete.ts';
import type { InstalledLoader } from '../bridge/tauri';

type Filter = 'all' | 'modded' | 'vanilla';

export function VersionsPage() {
  const { state, go, goDownloadTab, openVersion, toast, removeInstance, duplicateInstance, renameInstance } =
    useApp();
  const { api } = useRealApi();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 菜单的屏幕坐标（面板是 `position: fixed`，见按钮上的注释） */
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /*
   * ★★ 点空白处要关掉菜单，滚动/按 Esc 也要关（用户报：
   *   "不会点空白位置后消失"）。
   *
   *   三个都要，因为三种都真的会发生：
   *     · 点别处 → 用户以为关掉了，结果它还挂在那儿；
   *     · 滚动   → 菜单是 fixed，不跟着滚，会**浮在错的位置**上；
   *     · Esc    → 键盘用户唯一的"取消"手势就是这个。
   */
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuFor(null);
    };
    const onScroll = () => setMenuFor(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  /* ====================== 盘上到底装了什么（实时） ====================== */
  /**
   * `MC 版本 → 盘上真实存在的加载器/附加组件`。
   *
   * ★ 为什么这一页也要**主动去问**，而不是直接用实例记录：
   *   实例记录（`inst.loader`）是"**当初装的时候**说要装什么"，
   *   而磁盘是"**现在**实际有什么"。两者会不一致，真实场景很多：
   *   · 在别的启动器里给同一个 MC 版本装/删了 Forge
   *   · 手动把 `versions/` 下的目录删了或搬走了
   *   · 上次安装失败，只留了半份
   *   · 两个实例共用同一个 MC 版本的文件
   *   只显示实例记录，用户就会看到"版本列表说装了 Forge、启动却说没有痕迹"
   *   ——这正是他说的「你得实时监测」。
   *
   * 数据来源是后端每次**当场读盘**的 `versions/` 扫描结果（不做结论缓存）。
   * 轮询间隔 5 秒：读盘本身是毫秒级的，而用户真正的困惑窗口就是
   * "装完之后这一页有没有变"。
   */
  const [diskLoaders, setDiskLoaders] = useState<Record<string, InstalledLoader[]>>({});
  const [diskError, setDiskError] = useState<string | null>(null);
  /*
   * ★★ **盘上到底读到了没有**（用户 2026-09-15 抓的那一帧："有模组加载器的版本会跳 1 帧"）。
   *
   *   现象：切到版本列表时，带加载器的行会先闪一下「缺 Fabric」「缺 Forge」，
   *   然后才消失。
   *
   *   原因就在下面这个判据里：`refreshDisk` 是**异步**的，首帧 `diskLoaders` 是 `{}`，
   *   而 `diskConflictOf` 把"**没读到**"和"**盘上没有**"当成了同一件事 ——
   *   于是每一行都先被判成"缺加载器"，等清单回来再翻回去。
   *
   *   这条规矩这个仓库已经写过好几遍：**读不到 ≠ 没有**。
   *   修法：显式记住"读到过没有"，没有之前**不下冲突结论**（不显示那个角标）。
   *   读失败时也不下结论（`diskError` 那条提示才是该出现的东西）。
   */
  const [diskLoaded, setDiskLoaded] = useState(false);

  const refreshDisk = useCallback(async () => {
    if (!api) {
      // 浏览器演示模式没有磁盘可读：标记成"读过"，否则角标永远不出现也不会消失
      setDiskLoaded(true);
      return;
    }
    try {
      const m = await api.metadata.manifest('bmclapi');
      const map: Record<string, InstalledLoader[]> = {};
      for (const row of m.versions) {
        if (row.loaders && row.loaders.length > 0) map[row.id] = row.loaders;
      }
      setDiskLoaders(map);
      setDiskError(null);
      setDiskLoaded(true);
    } catch (e) {
      // 读盘失败必须说出来，不能显示成"什么都没装"
      setDiskError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void refreshDisk();
    const t = window.setInterval(() => void refreshDisk(), 5000);
    // 切回窗口时立刻补一次（用户刚在别处装完东西，最可能这时候回来看）
    const onFocus = () => void refreshDisk();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshDisk]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.instances.filter((i) => {
      if (q && !i.config.name.toLowerCase().includes(q) && !i.mcVersion.includes(q)) return false;
      if (filter === 'modded') return i.loader !== null || i.addons.length > 0;
      if (filter === 'vanilla') return i.loader === null && i.addons.length === 0;
      return true;
    });
  }, [state.instances, filter, query]);

  const installedCount = useMemo(
    () => state.versions.filter((v) => v.installed).length,
    [state.versions],
  );

  /** 这个 MC 版本在盘上装了哪些加载器（读盘结果，空的 = 没有或没读到） */
  const diskLoadersOf = (mcVersion: string): InstalledLoader[] =>
    diskLoaders[mcVersion] ?? [];

  /**
   * 实例记录与磁盘**冲突**时，给列表行用的**一个徽标**（+ 完整原因）。
   *
   * ★ 为什么收成徽标（dev.15）：旧版在这里写整句
   *   「与实例记录不符：记录要装 Forge，盘上没有」，一屏四行里重复三遍 ——
   *   用户的原话是"有些地方文字太多，很繁杂"。信息不能丢，所以
   *   `why` 里是完整句子（徽标 `title` 显示、概览页也有一整块对照）。
   */
  const diskConflictOf = (
    inst: (typeof state.instances)[number],
    onDisk: InstalledLoader[],
  ): { short: string; why: string } | null => {
    const recorded = inst.loader;
    if (!recorded) return null; // 纯原版实例：盘上有没有加载器都不算冲突
    /*
     * ★★ **还没读到盘上的清单时不下结论**（见 `diskLoaded` 的注释）：
     *   否则首帧会把每一行都标成「缺 X」，等清单回来再翻回去 ——
     *   用户看到的就是"跳 1 帧"，而且那一刻界面在**说假话**。
     */
    if (!diskLoaded) return null;
    const base = onDisk.find((l) => l.loader_type === recorded.kind);
    if (!base) {
      return {
        short: `缺 ${loaderName(recorded.kind)}`,
        why:
          `实例记录写着要装 ${loaderName(recorded.kind)} ${recorded.version}，` +
          `但盘上这个 MC 版本没有任何 ${loaderName(recorded.kind)} —— ` +
          `现在启动会失败。双击这一行进「概览」，用「检查并补齐」或重新装一次加载器。`,
      };
    }
    if (base.version && recorded.version && base.version !== recorded.version) {
      return {
        short: `盘上 ${base.version}`,
        why:
          `实例记录是 ${loaderName(recorded.kind)} ${recorded.version}，` +
          `盘上装的是 ${base.version} —— 启动的是盘上那个。` +
          `想统一的话：双击进「概览」重新装一次，或改实例设置。`,
      };
    }
    return null;
  };

  /* ---------- 空状态 ---------- */
  if (state.instances.length === 0) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">版本列表</h1>
          </div>
        </div>
        <EmptyState
          icon={<IconBox />}
          title="还没有任何版本"
          desc="装一份游戏就会出现在这里 —— 装好后双击某个版本，就能进入它的设置、Mod 与日志。"
          actions={
            <>
              <Button variant="primary" onClick={() => go('download')}>
                <IconDownload /> 下载游戏
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  // ★ 一次派发到位（以前 go + 事件两步走，事件在页面挂载前就被丢掉）
                  goDownloadTab('modpack');
                }}
              >
                导入整合包
              </Button>
            </>
          }
        />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">版本列表</h1>
          <p className="page-desc">
            {state.instances.length} 个版本
            {installedCount > 0 ? ` · 盘上已装 ${installedCount} 份游戏文件` : ''}
            <span className="dim"> · 点一行进它的设置</span>
          </p>
        </div>
        <div className="page-actions">
          {api ? (
            <Button
              size="sm"
              variant="ghost"
              title="重新读一遍磁盘上的 versions/ 目录（不会重新下载）"
              onClick={() => void refreshDisk()}
            >
              <IconRefresh /> 重新探测
            </Button>
          ) : null}
          <Button variant="primary" size="sm" onClick={() => go('download')}>
            <IconPlus /> 新装一个
          </Button>
        </div>
      </div>

      <div className="row row-wrap" style={{ marginBottom: 'var(--space-3)' }}>
        <Segmented
          label="筛选"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `全部 ${state.instances.length}` },
            { value: 'modded', label: '可装 Mod' },
            { value: 'vanilla', label: '原版' },
          ]}
        />
        <div style={{ flex: 1 }} />
        <div style={{ width: 220 }}>
          <SearchBox
            label="搜索版本"
            placeholder="搜索名称或版本号…"
            value={query}
            onChange={setQuery}
          />
        </div>
      </div>

      {/* 读盘失败必须说出来 —— 不能显示成"什么都没装" */}
      {diskError ? (
        <Note
          tone="warning"
          icon={<IconAlert />}
          actions={
            <Button size="sm" variant="secondary" onClick={() => void refreshDisk()}>
              <IconRefresh /> 重试
            </Button>
          }
        >
          没读到盘上的加载器（{diskError}）—— 这不代表没装，行里就不显示「盘上」了。
        </Note>
      ) : null}

      {/* ==================== 列表 ==================== */}
      <div className="ver-list">
        {rows.map((inst) => {
          // ★ 多开实例：判据只有一份（`isInstanceRunning`）
          const isRunning = isInstanceRunning(state, inst.id);
          const openMenu = menuFor === inst.id;
          /*
           * ★ 盘上与实例记录的**冲突判据**（只在列表行里用，且只产出一个徽标）。
           *   完整说明在 `title` 与概览页的「版本状态」表里 —— 列表不是讲理的地方。
           */
          const diskLoaders = diskLoadersOf(inst.mcVersion);
          const conflict = diskConflictOf(inst, diskLoaders);
          return (
            <div
              key={inst.id}
              className={`ver-item${isRunning ? ' running' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`打开 ${inst.config.name} 的设置`}
              onClick={() => openVersion(inst.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openVersion(inst.id);
                }
              }}
            >
              {/*
                ★★ 版本图标（0.1.0-beta.1）：自绘等距方块，按**世代**配色
                  （现代=绿 / 中期=蓝 / Mod 黄金期=琥珀 / 快照=紫）。
                  以前是一个统一的灰方块或灰层叠图标 —— 一屏四个版本长得
                  一模一样，扫一眼分不出哪个是 1.20、哪个是 1.7.10。
                  ★ 不复制任何官方美术（README 许可那一节说清了）。
              */}
              <VersionIcon version={inst.mcVersion} size={34} />

              {/* 中间：名称与元信息（一行主 + 一行次；冲突只给徽标） */}
              <div className="ver-info">
                <div className="ver-title">
                  <span className="ver-title-name truncate">{inst.config.name}</span>
                  {isRunning ? <Chip tone="success">运行中</Chip> : null}
                  {inst.addons.map((a) => (
                    <Chip key={a.kind} tone="neutral">
                      {a.kind === 'optifine' ? 'OptiFine' : 'LiteLoader'}
                    </Chip>
                  ))}
                  {/*
                    ★ 记录与盘上不一致时**只给一个徽标**（dev.15 重构）。
                      旧版在这里写整句"与实例记录不符：记录要装 Forge，盘上没有"，
                      一屏四行里重复三遍，把名字和启动按钮都淹了。
                      原因没有丢：`title` 里是完整句子，概览页也有一整块对照表。
                  */}
                  {conflict ? (
                    <Chip tone="warning" title={conflict.why}>
                      {conflict.short}
                    </Chip>
                  ) : null}                </div>
                <div className="ver-meta">
                  <span className="mono">{inst.mcVersion}</span>
                  <span className="dot" />
                  <span>
                    {inst.loader
                      ? `${loaderName(inst.loader.kind)} ${inst.loader.version}`
                      : '原版'}
                  </span>
                  <span className="dot" />
                  <span className="mono">{Math.round(inst.config.memoryMb / 1024)} GB</span>
                  {inst.config.isolation !== 'auto' ? (
                    <>
                      <span className="dot" />
                      <span>{inst.config.isolation === 'on' ? '已隔离' : '共享目录'}</span>
                    </>
                  ) : null}
                  {/*
                    盘上确实装了加载器时，把它的版本号如实带一句（信息，不是告警）。
                    盘上什么都没有时**不再重复那句"还没有游戏文件"** ——
                    版本列表是"我建了哪些版本"的清单，缺文件是启动时的事，
                    真缺了上面那个徽标会说。
                  */}
                  {diskLoaders.length > 0 ? (
                    <>
                      <span className="dot" />
                      <span className="ver-disk">
                        <span className="ver-disk-label">盘上</span>
                        {diskLoaders.map((l) => (
                          <span key={l.loader_type} className="mono">
                            {l.name}
                            {l.version ? ` ${l.version}` : ''}
                          </span>
                        ))}
                      </span>
                    </>
                  ) : null}                </div>
              </div>

              {/* 右侧：最近游玩 + 操作 */}
              <div className="ver-side">
                <span className="ver-time">
                  {inst.lastPlayedAt ? relativeTime(inst.lastPlayedAt) : '从未启动'}
                </span>
                <div className="ver-actions" onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent('ieml:launch-request', { detail: inst.id }),
                      );
                    }}
                  >
                    <IconPlay /> 启动
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={`${inst.config.name} 的更多操作`}
                    aria-expanded={openMenu}
                    onClick={(e) => {
                      /*
                       * ★★ 菜单位置按**按钮的屏幕坐标**算，面板用 `position: fixed`
                       *   （用户报："这个栏的图层层级不对"）。
                       *
                       *   原因：菜单原来是 `absolute`，而它住在 `.ver-list` 里，
                       *   而那个容器有 `overflow: hidden`（为了圆角）——
                       *   于是**最后一行的菜单会被列表容器裁掉**，
                       *   看起来就像"层级不对"（其实是"被剪掉了"）。
                       *   用 fixed + 坐标算：既躲开裁剪，也不受任何祖先的
                       *   stacking context 影响。代价是滚动时要关掉它 ——
                       *   下面那个 effect 就是干这个的。
                       */
                      const r = e.currentTarget.getBoundingClientRect();
                      setMenuPos({
                        top: Math.round(r.bottom + 4),
                        // 贴右边缘：菜单右对齐到按钮右边缘
                        right: Math.round(window.innerWidth - r.right),
                      });
                      setMenuFor(openMenu ? null : inst.id);
                    }}
                  >
                    <IconMore />
                  </Button>
                  {openMenu ? (
                    <div
                      className="row-menu"
                      role="menu"
                      ref={menuRef}
                      style={menuPos ? { top: menuPos.top, right: menuPos.right } : undefined}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuFor(null);
                          openVersion(inst.id);
                        }}
                      >
                        <IconInfo /> 打开设置
                      </button>
                      {/*
                        ★★ 用户报「根本没这个功能键，我怎么装 mod 嘛」。
                          安装 Mod 的功能一直都在，但它藏在
                          「双击版本 → Mod 管理 → 右上角添加 Mod」三层里面。
                          版本列表这一行是用户最常操作的地方，菜单里直接给一条。
                      */}
                      <button
                        type="button"
                        role="menuitem"
                        title={
                          inst.loader === null
                            ? '纯原版装不了 Mod —— 先在「设置」里加一个加载器'
                            : '搜索并安装 Mod 到这个版本'
                        }
                        onClick={() => {
                          setMenuFor(null);
                          /*
                           * ★ 一次调用就把"打开这个版本 + 落在 Mod 页签"定下来。
                           *   以前要写 `setSubPage` + `openVersion` 两次 dispatch，
                           *   而 `nav/open-instance` 会把 subPage 归零 ——
                           *   顺序写反就会静默落回「概览」页（见 store 的说明）。
                           */
                          openVersion(inst.id, 'mods');
                          // ModsPanel 挂载后才订阅得到这个事件，所以推到下一个宏任务
                          window.setTimeout(
                            () => window.dispatchEvent(new CustomEvent(EVT_OPEN_MOD_BROWSE)),
                            0,
                          );
                        }}
                      >
                        <IconPuzzle /> 安装 Mod
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuFor(null);
                          window.dispatchEvent(
                            new CustomEvent('ieml:launch-request', { detail: inst.id }),
                          );
                        }}
                      >
                        <IconPlay /> 启动
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuFor(null);
                          const next = prompt('新的版本名称', inst.config.name);
                          if (next === null) return; // 取消
                          // ★ 校验在 `renameInstance` 里做（判据只有一处）
                          const why = renameInstance(inst.id, next);
                          if (why) {
                            toast('warning', '这个名字不能用', why);
                            return;
                          }
                          toast('ok', '已重命名', '目录名不变，只改显示名');
                        }}
                      >
                        <IconPencil /> 重命名
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuFor(null);
                          // ★ 真的复制目录（以前只克隆记录，副本是个空壳）
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
                            .catch((e) =>
                              toast('err', '创建副本失败', e instanceof Error ? e.message : String(e)),
                            );
                        }}
                      >
                        <IconCopy /> 创建副本
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuFor(null);
                          /*
                           * ★ 真的打开目录（之前只弹一条写着 slug 的提示，
                           *   等于"点了没反应"）。走 Rust 命令，绕开 opener
                           *   插件那个为空的前端路径白名单。
                           */
                          if (!api) {
                            toast('info', '实例目录', inst.config.slug);
                            return;
                          }
                          void api.launcher
                            .openDir('instance', inst.config.slug)
                            .then((dir) => toast('ok', '已打开实例目录', dir))
                            .catch((e) =>
                              toast('err', '打不开目录', e instanceof Error ? e.message : String(e)),
                            );
                        }}
                      >
                        <IconFolder /> 打开目录
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        title="默认移入系统回收站；按住 Shift 点击则永久删除"
                        onClick={(e) => {
                          setMenuFor(null);
                          const copy = describeDelete({
                            what: `「${inst.config.name}」`,
                            items: [
                              `实例目录 instances/${inst.config.slug}/（存档、Mod、配置都在里面）`,
                            ],
                            note:
                              '共享的游戏文件（libraries / assets）不会被删除，其他版本还能用。',
                            intent: deleteIntent(e),
                          });
                          if (!confirm(copy.message)) return;
                          /*
                           * ★ 审计发现：以前这里只从列表里删记录，
                           *   而确认框写着"存档与配置会一起删除" —— 磁盘没动。
                           *   现在真的删目录，并把结果如实报告。
                           */
                          void removeInstance(inst.id, copy.permanent)
                            .then((bytes) =>
                              toast(
                                'warning',
                                copy.doneVerb,
                                bytes > 0
                                  ? `${inst.config.name} · 磁盘上释放了 ${formatBytes(bytes)}`
                                  : `${inst.config.name}（磁盘上本来就没有这个目录）`,
                              ),
                            )
                            .catch((err) => {
                              // ★ 回收站不可用时不静默降级，先问用户
                              if (!copy.permanent && confirm(trashUnavailablePrompt(err))) {
                                void removeInstance(inst.id, true)
                                  .then(() =>
                                    toast('warning', '已永久删除', inst.config.name),
                                  )
                                  .catch((e2) =>
                                    toast(
                                      'err',
                                      '磁盘目录没删掉',
                                      e2 instanceof Error ? e2.message : String(e2),
                                    ),
                                  );
                                return;
                              }
                              toast(
                                'err',
                                '磁盘目录没删掉',
                                err instanceof Error ? err.message : String(err),
                              );
                            });
                        }}
                      >
                        <IconTrash /> 删除
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="没有符合筛选条件的版本"
          desc={`当前筛选下没有结果。试试切换筛选，或清空搜索词「${query}」。`}
          actions={
            <Button
              variant="secondary"
              onClick={() => {
                setFilter('all');
                setQuery('');
              }}
            >
              清除筛选
            </Button>
          }
        />
      ) : null}

      {/*
        ★ 「游戏文件是共享的」那段解释**删掉了**：
          它讲的是一个概念，不是这一页要做的决定，而且页头副标题已经写着
          「盘上已装 N 份游戏文件」。真需要解释的时候，是用户第一次点
          「一键补齐」时 —— 那时 `installGame` 会自己说"已存在的会跳过"。

        ★ 但"还没有游戏文件"必须留：它说明这些版本**现在起不来**，
          属于用户需要马上知道的事（不是概念解释）。
      */}
      {installedCount === 0 ? (
        <Note tone="warning" icon={<IconAlert />} title="这些版本还没有游戏文件">
          起不来。去「下载」页装一份，或点进版本后用「检查并补齐文件」补上。
        </Note>
      ) : null}
    </>
  );
}

function loaderName(kind: string): string {
  const map: Record<string, string> = {
    forge: 'Forge',
    neoforge: 'NeoForge',
    fabric: 'Fabric',
    quilt: 'Quilt',
  };
  return map[kind] ?? kind;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400000);
  if (d === 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}
