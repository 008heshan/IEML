/**
 * Mod 管理页
 * ------------------------------------------------------------------
 * 修掉的问题：
 *   ① 原稿的 5 个筛选按钮**全部没有 onclick**（点了没反应），而且侧栏还有
 *      一套重复的多选筛选，两套控件语义不同步 —— 这里只有一套，且真的生效
 *   ② 原稿没有删除 Mod 的出路（只能禁用），而 ADR-019 明确要求有删除
 *   ③ 原稿没有选中态，`bulk-bar` 是常驻的 —— 这里选中后才升起批量条
 *   ④ 更新确认弹窗里的复选框是假的（label + span，没有 input，点不动）——
 *      这里是真的 checkbox，风险项默认不勾，用户可以自己勾
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConfirm } from '../ui/confirm';
import { useApp } from '../state/AppContext';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Modal,
  Note,
  SearchBox,
  Skeleton,
  Spinner,
} from '../ui';
import {
  IconAlert,
  IconCheck,
  IconDownload,
  IconFolder,
  IconInfo,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '../ui/Icons';
import {
  availableFilters,
  filterMods,
  judgeModState,
  oldFilesToDrop,
  toggledName,
} from '../domain/mods.ts';
import type { ModEntry, ModStateResult } from '../domain/mods.ts';
import { formatBytes } from '../domain';
import { EVT_OPEN_MOD_BROWSE } from '../state/events';
import {
  deleteIntent,
  describeDelete,
  trashUnavailablePrompt,
} from '../domain/delete.ts';
import { useRealApi } from '../hooks/useRealApi';
import type { ApiLibStatus, ModUpdateCandidate, ModrinthHit } from '../bridge/tauri';
// ★ 社区资源浏览器：Mod / 资源包 / 光影 / 数据包 共用一套界面
import { ResourceBrowser } from '../components/ResourceBrowser';

/**
 * 把一批条目过一遍领域层的状态判定。
 *
 * ★ 判定规则只有一份（`domain/mods.ts` 的 `judgeModState`），UI 只呈现结论。
 *   这里只是"批量调用"的语法糖，不掺任何规则。
 */
function judgeAll(
  entries: ModEntry[],
  mcVersion: string,
  loaderKind: string | null,
): Map<string, ModStateResult['state']> {
  const states = new Map<string, ModStateResult['state']>();
  for (const e of entries) {
    states.set(
      e.path,
      judgeModState({
        entry: e,
        instanceMcVersion: mcVersion,
        instanceLoader: loaderKind as never,
        managedByModpack: false,
      }).state,
    );
  }
  return states;
}

export function ModsPanel() {
  /** 应用自己的确认弹窗（`window.confirm` 在这个壳里是坏的，见 `ui/confirm.tsx`） */
  const confirm = useConfirm();
  const {
    state,
    open: active,
    go,
    goDownloadFor,
    toast,
    backend,
    setMods,
    setModFilter,
    setModQuery,
    toggleModSelect,
    clearModSelect,

  } = useApp();
  const { api } = useRealApi();
  const [loading, setLoading] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [compatFor, setCompatFor] = useState<ModEntry | null>(null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());

  /* ---------- 浏览 Mod（在线库） ---------- */
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseQuery, setBrowseQuery] = useState('');
  const [browseResults, setBrowseResults] = useState<ModrinthHit[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);

  /*
   * ★★ 社区资源浏览器（Mod / 资源包 / 光影 / 数据包 同一套界面）。
   *
   *   这一页只从「添加 Mod」进（`browseOpen`），默认就是 Mod 那一格 ——
   *   资源包/光影/数据包搬去下载页并排了（0.1.0-beta.1）。
   *   五种资源共用 `ResourceBrowser`，选项卡由后端那张表生成
   *   （`domain/resources.rs`：到哪查、装到哪、认哪些扩展名、要不要挑加载器）。
   */
  const [resourceOpen, setResourceOpen] = useState(false);

  /**
   * ★★ 让**别的页面**能直接把人送到这里来装 Mod（用户报的"根本没这个功能键"）。
   *
   *   查下来"添加 Mod"这个按钮**一直在**（页面右上角），但它只在
   *   「版本列表 → 双击某个版本 → Mod 管理」这一条路上才看得见。
   *   而这个启动器的第一屏是「启动页」，最显眼的是版本列表里的那一行 ——
   *   用户在那一行上能看到的只有「启动」和「⋯」。
   *
   *   所以真正缺的不是功能，是**入口**。现在：
   *     · 「概览」页顶栏加了「安装 Mod」按钮（点它=切到 Mod 页 + 弹出搜索框）
   *     · 「概览」页的 Mod 事实行加了「管 / 装」两个动作
   *     · 版本列表那一行的 ⋯ 菜单里加了「安装 Mod」
   *   三处都往这里发同一个事件。
   */
  useEffect(() => {
    const onOpen = () => setBrowseOpen(true);
    window.addEventListener(EVT_OPEN_MOD_BROWSE, onOpen);
    return () => window.removeEventListener(EVT_OPEN_MOD_BROWSE, onOpen);
  }, []);

  /* ---------- 前置包（Fabric API / QFAPI）在不在 ---------- */
  /**
   * ★★ 用户报「Fabic 版本不会自动安装 API 这个 mod」。
   *
   *   查下来后端是好的（实测 26.2 能装到 `fabric-api-0.160.0+26.2.jar`），
   *   自动安装也确实写在"创建实例"那条路径上。**问题在于只有那一次机会**：
   *     · 老实例（建在这功能之前）永远没有 API；
   *     · 创建时网络抖一下装失败，事后**没有任何地方能补**。
   *   于是用户看到的就是"装的是 Fabric，mods 里却什么都没有"，
   *   之后每个依赖它的 Mod 启动都崩在 `requires fabric-api`。
   *
   *   所以这里**每次进 Mod 管理页都查一遍**，缺了就常驻一条横幅 + 一键补装。
   *   判据来自后端 `check_api_library`（按文件名认，不联网、不冒充精确结论）。
   */
  const [apiStatus, setApiStatus] = useState<ApiLibStatus | null>(null);
  const [apiInstalling, setApiInstalling] = useState(false);

  const refreshApiStatus = useCallback(async () => {
    if (!api || !active) return;
    try {
      const s = await api.modrinth.checkApiLibrary(active.config.slug, active.loader?.kind ?? null);
      setApiStatus(s);
    } catch {
      // 查不到就说"不知道"，不谎报"没有"（否则会对正常实例弹假警报）
      setApiStatus(null);
    }
  }, [api, active]);

  useEffect(() => {
    void refreshApiStatus();
  }, [refreshApiStatus, state.mods.entries.length]);

  async function installApiLib() {
    if (!api || !active || !active.loader) return;
    const kind = active.loader.kind;
    if (kind !== 'fabric' && kind !== 'quilt') return;
    setApiInstalling(true);
    try {
      const r = await api.modrinth.installApiLibrary(active.config.slug, active.mcVersion, kind);
      if (r.installed) {
        toast('ok', `已装好 ${apiStatus?.name ?? '前置包'}`, `${r.version ?? ''} 已放进 mods 目录`);
        await reloadMods();
        await refreshApiStatus();
      } else {
        toast('warning', '没能自动装上', r.note ?? '去 Modrinth 手动下载对应版本放进 mods 目录');
      }
    } catch (e) {
      toast('err', '安装前置包失败', e instanceof Error ? e.message : String(e));
    } finally {
      setApiInstalling(false);
    }
  }

  async function searchMods() {
    if (!api) {
      toast('warning', '演示模式', '桌面版才能浏览在线 Mod 库');
      return;
    }
    if (!active) return;
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const r = await api.modrinth.search({
        query: browseQuery,
        projectType: 'mod',
        mcVersion: active.mcVersion,
        loader: active.loader?.kind ?? undefined,
        limit: 20,
      });
      setBrowseResults(r.hits);
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowseLoading(false);
    }
  }

  async function installMod(hit: ModrinthHit) {
    if (!api || !active) return;
    setInstallingSlug(hit.project_id);
    try {
      // 取该项目兼容当前实例的版本，选第一个的 primary 文件
      const versions = await api.modrinth.versions(
        hit.project_id,
        active.mcVersion,
        active.loader?.kind,
      );
      const ver = versions[0];
      if (!ver) {
        toast('warning', '没有兼容版本', `${hit.title} 没有适配 ${active.mcVersion} 的版本`);
        return;
      }
      const file = ver.files.find((f) => f.primary) ?? ver.files[0];
      if (!file) {
        toast('warning', '没有可下载文件', `${hit.title} 这个版本没有文件`);
        return;
      }
      const sha1 = file.hashes?.sha1;
      await api.modrinth.installMod(file.url, file.filename, active.config.slug, sha1);
      toast('ok', '已安装 Mod', `${hit.title} ${ver.version_number} 已放进 mods 目录`);
      setBrowseOpen(false);
      // 重新读盘 + 反查（新装的这个文件现在也能在在线库里认出来了）
      await reloadMods();
    } catch (e) {
      toast('err', '下载失败', e instanceof Error ? e.message : String(e));
    } finally {
      setInstallingSlug(null);
    }
  }

  /* ---------- 载入 Mod 列表 ---------- */
  /**
   * 读盘 + 哈希反查在线库。
   *
   * ★ 「Mod 列表」这个功能的实质就在这一步：
   *   只读文件名只能给出一串 `sodium-fabric-mc1.20.1-0.5.11.jar`，
   *   而用户要知道的是**这是什么 Mod、什么版本、支不支持我现在这个版本**。
   *   这些信息只有一个来源 —— 文件 SHA1 反查 Modrinth（ADR-019）。
   *
   * ★ 反查不到就 `remote` 为空，界面显示文件名 —— 有信息显示信息，
   *   没信息就说没信息，绝不编造一个假的"在线库名称"。
   */
  /** ★ 第二段（联网反查在线库）是否还在跑 —— 界面据此显示"正在核对" */
  const [resolvingOnline, setResolvingOnline] = useState(false);

  const reloadMods = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    try {
      /*
       * ★★ 两段式加载（用户 2026-09-15："版本的 mod 列表获取版本有什么 mod 的速度太慢"）。
       *
       *   慢在哪（实测定位）：列出 Mod 要**每个 jar 都联网反查一次**
       *   （`modrinth.scanMods` = 读盘 + 算 SHA1/指纹 + 逐个查在线库），
       *   而在此之前**列表是空的** —— 装了几十个 Mod 的整合包要等很久，
       *   用户看到的是"白屏很久，然后一次性全出来"。
       *
       *   现在拆成两段：
       *     ① **本地扫描**（`backend.listMods`，只读文件名/大小）→ 列表**立刻**出现，
       *        显示文件名、大小、是否禁用 —— 这些本来就不需要联网；
       *     ② 联网反查放到后台，回来之后把"在线库名称 / 版本 / 支持情况"补上。
       *
       *   ★ 没有造假：第一段显示的是**文件名**（不是编出来的名字），
       *     补全期间界面明确写着"正在核对在线库"。
       */
      const local = await backend.listMods(active.id);
      const localEntries: ModEntry[] = local.map((f) => ({
        displayName: f.fileName.replace(/\.(jar|zip|litemod)(\.disabled)?$/i, ''),
        fileName: f.fileName,
        path: f.path,
        enabled: !f.fileName.endsWith('.disabled'),
        bytes: f.bytes,
        mtimeMs: f.mtimeMs,
      }));
      setMods(localEntries, judgeAll(localEntries, active.mcVersion, active.loader?.kind ?? null));
      setChecked(false);
      setLoading(false);

      // 浏览器演示模式没有在线库：第一段就是全部
      if (!api) return;

      setResolvingOnline(true);
      const scanned = await api.modrinth.scanMods(
        active.config.slug,
        active.mcVersion,
        active.loader?.kind ?? null,
      );

      const entries: ModEntry[] = scanned.map((s) => ({
        displayName: s.display_name,
        fileName: s.file_name,
        path: s.path,
        enabled: s.enabled,
        bytes: s.bytes,
        mtimeMs: s.mtime_ms,
        ...(s.sha1 ? { sha1: s.sha1 } : {}),
        /*
         * ★★ CurseForge 指纹（ADR-052）：**只有反查命中时后端才给**
         *    （见 `ModScanEntry::fingerprint` 的说明）。存进 `murmur2`
         *    是为了与领域层的命名一致 —— 它就是 MurmurHash2。
         */
        ...(s.fingerprint ? { murmur2: s.fingerprint } : {}),
        ...(s.remote
          ? {
              remote: {
                // ★ 来源如实映射：只在 CurseForge 上查到的 Mod 不该被标成 Modrinth
                source:
                  s.remote.source === 'curseforge'
                    ? ('curseforge' as const)
                    : ('modrinth' as const),
                projectId: s.remote.project_id,
                name: s.remote.title || s.remote.project_id,
                version: s.remote.version,
                gameVersions: s.remote.game_versions,
                loaders: s.remote.loaders as never,
                isLibrary: s.remote.is_library,
              },
            }
          : {}),
      }));

      // ★ 状态判定走领域层，UI 只呈现
      setMods(entries, judgeAll(entries, active.mcVersion, active.loader?.kind ?? null));
      setChecked(false);
    } catch (e) {
      toast('err', '读取 Mod 列表失败', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setResolvingOnline(false);
    }
  }, [active, api, backend, setMods, toast]);

  useEffect(() => {
    void reloadMods();
  }, [reloadMods]);

  /* ---------- 检查更新（真的去问在线库） ---------- */
  const [checking, setChecking] = useState(false);
  const [updates, setUpdates] = useState<ModUpdateCandidate[]>([]);
  const [checked, setChecked] = useState(false);

  async function checkUpdates() {
    if (!active || !api) {
      toast('warning', '演示模式', '桌面版才能向在线库核对更新');
      return;
    }
    /*
     * ★★ 两个列表**按位置一一对应**（ADR-052）：
     *   第 i 个 sha1 与第 i 个指纹是同一个文件。没有指纹的文件传空串
     *   （后端保位置，空位不会让后面错位）。
     *
     *   为什么要同时给指纹：Modrinth 用 SHA1 反查，而 **CurseForge 只认
     *   MurmurHash2 指纹** —— 只发 SHA1 的话，那些只在 CurseForge 上发布的
     *   Mod 永远查不到更新（而且没有任何报错，静默地"就是没有更新"）。
     */
    const rows = state.mods.entries.filter((e) => Boolean(e.sha1));
    const hashes = rows.map((e) => e.sha1!);
    const fingerprints = rows.map((e) => e.murmur2 ?? '');
    const hasFingerprint = fingerprints.some((f) => f !== '');
    if (hashes.length === 0) {
      toast(
        'info',
        '没有可核对的 Mod',
        '这些文件都没能在在线库里找到（Modrinth 用 SHA1、CurseForge 用指纹），无法判断更新。',
      );
      setChecked(true);
      return;
    }
    setChecking(true);
    try {
      const list = await api.modrinth.checkUpdates(
        hashes,
        fingerprints,
        active.mcVersion,
        active.loader?.kind ?? null,
      );
      setUpdates(list);
      setChecked(true);
      /*
       * ★ 风险项**默认不勾选**（与弹窗里的说明一致）。
       *
       *   审计发现：`unchecked` 初始为空集，而勾选状态是 `!unchecked.has(sha1)`，
       *   于是"可能不兼容"的更新默认是被勾上的 —— 用户点一下"更新"
       *   就会替换掉弹窗刚刚警告过的那几个 Mod。
       *   这里按 risky 预置：风险项进 unchecked，其余保持勾选。
       */
      setUnchecked(
        new Set(
          list
            .filter((u) => {
              const entry = state.mods.entries.find((e) => e.sha1 === u.sha1);
              return entry ? state.mods.states.get(entry.path) === 'maybe-incompatible' : false;
            })
            .map((u) => u.sha1),
        ),
      );
      // 把"可更新"写回状态与领域层，标记在列表上
      window.dispatchEvent(new CustomEvent('ieml:mods-updates', { detail: list }));
      /*
       * ★ 提示里如实说清**查了哪几个源**（CurseForge 那一路没工作时，
       *   用户有权知道"这次只查了一半"，而不是以为"全都最新"）。
       */
      const via = hasFingerprint ? 'Modrinth + CurseForge' : 'Modrinth';
      toast(
        list.length > 0 ? 'ok' : 'info',
        list.length > 0 ? `${list.length} 个 Mod 有可用更新` : '所有 Mod 都是最新',
        list.length > 0
          ? `点列表里的「更新」逐个处理 —— IEML 不会自动替换文件。`
          : `已核对 ${Math.min(hashes.length, 40)} 个 Mod（源：${via}）`,
      );
    } catch (e) {
      toast('err', '检查更新失败', e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  /** 把一批更新候选应用到列表状态上（`can-update` 角标的来源） */
  useEffect(() => {
    const onUpdates = (e: Event) => {
      const list = (e as CustomEvent<ModUpdateCandidate[]>).detail ?? [];
      if (list.length === 0) return;
      const bySha = new Map(list.map((u) => [u.sha1, u]));
      const next = state.mods.entries.map((entry) => {
        const hit = entry.sha1 ? bySha.get(entry.sha1) : undefined;
        if (!hit) return entry;
        return { ...entry, updateAvailable: true, latestVersion: hit.latest_version };
      });
      setMods(next, judgeAll(next, active?.mcVersion ?? '', active?.loader?.kind ?? null));
    };
    window.addEventListener('ieml:mods-updates', onUpdates);
    return () => window.removeEventListener('ieml:mods-updates', onUpdates);
  }, [state.mods.entries, setMods, active]);

  /**
   * 批量启用 / 禁用：真的改文件名后缀，然后重新读盘（不靠前端本地改状态）
   *
   * ★ 必须重新读盘：`.disabled` 后缀是**文件系统上的真实状态**，
   *   前端自己改一遍状态就会出现"界面说禁用了、盘上还是启用的"两份真相。
   */
  async function bulkSetEnabled(enabled: boolean) {
    if (!api || !active) return;
    const paths = state.mods.entries
      .filter((e) => state.mods.selected.has(e.path))
      .map((e) => e.path);
    if (paths.length === 0) return;
    try {
      const done = await api.modrinth.setModEnabled(active.config.slug, paths, enabled);
      toast(
        'ok',
        enabled ? '已启用' : '已禁用',
        `${done} 个 Mod 已${enabled ? '启用' : '禁用'}（文件名改了 .disabled 后缀）`,
      );
    } catch (e) {
      toast('err', '操作失败', e instanceof Error ? e.message : String(e));
    }
    clearModSelect();
    void reloadMods();
  }

  /**
   * 批量删除：真的删文件。
   *
   * ★ 默认进系统回收站（PCL 的语义），按住 Shift 才是永久删 ——
   *   文案由 `describeDelete` 生成，**和实际行为同源**，
   *   不会再出现"写着不可撤销、其实进了回收站"或反过来的谎话。
   */
  async function bulkDelete(e?: { shiftKey?: boolean }) {
    if (!api || !active) return;
    const targets = state.mods.entries.filter((e) => state.mods.selected.has(e.path));
    const names = targets.map((e) => e.displayName);
    if (names.length === 0) return;
    const copy = describeDelete({
      what: `这 ${names.length} 个 Mod`,
      items: [
        ...names.slice(0, 8).map((n) => n),
        ...(names.length > 8 ? [`等共 ${names.length} 个`] : []),
      ],
      bytes: targets.reduce((s, t) => s + (t.bytes ?? 0), 0),
      intent: deleteIntent(e),
    });
    /* ★★ 2026-09-24（A-0）：原来写的是 if (!confirm(copy.message)) return; ——
       而 window.confirm 被 Tauri 换成了 async 包装（返回 Promise），
       那句判断**永远为假**，于是"删除 Mod"从来不问、直接就删。
       改成应用自己的弹窗，**必须 await**。 */
    if (
      !(await confirm({
        title: '删除 Mod',
        danger: true,
        confirmText: copy.permanent ? '永久删除' : '删除',
        message: copy.message,
      }))
    ) {
      return;
    }
    const paths = targets.map((t) => t.path);
    try {
      const done = await api.modrinth.deleteMods(active.config.slug, paths, copy.permanent);
      toast('ok', copy.doneVerb, `${done} 个 Mod 已处理`);
    } catch (err) {
      // ★ 回收站不可用时不静默降级：把后端原话给用户，问他要不要永久删
      if (
        !copy.permanent &&
        (await confirm({
          title: '回收站用不了',
          danger: true,
          confirmText: '永久删除',
          message: trashUnavailablePrompt(err),
        }))
      ) {
        try {
          const done = await api.modrinth.deleteMods(active.config.slug, paths, true);
          toast('ok', '已永久删除', `${done} 个 Mod 已处理`);
        } catch (e2) {
          toast('err', '删除失败', e2 instanceof Error ? e2.message : String(e2));
        }
      } else {
        toast('err', '删除失败', err instanceof Error ? err.message : String(err));
      }
    }
    clearModSelect();
    void reloadMods();
  }

  /** 把勾选的更新真的下下来（替换旧文件） */
  async function applyUpdates() {
    if (!active || !api) {
      toast('warning', '演示模式', '桌面版才能真的更新文件');
      return;
    }
    const targets = updates.filter((u) => !unchecked.has(u.sha1));
    if (targets.length === 0) return;
    setUpdateOpen(false);
    setUnchecked(new Set());
    let done = 0;
    /** ★ B-1：被移进回收站的旧文件数（"替换"这件事的证据） */
    let dropped = 0;
    const failed: string[] = [];
    for (const u of targets) {
      if (!u.download_url || !u.file_name) {
        failed.push(u.file_name || u.project_id);
        continue;
      }
      try {
        await api.modrinth.installMod(u.download_url, u.file_name, active.config.slug);
        /*
         * ★★ 2026-09-24（B-1 修复）：装完**必须删掉旧的**那一份。
         *
         *   以前这里只装不删，而提示写着「已替换为新版本」——
         *   于是 mods/ 里同时留下新旧两个 jar：游戏可能加载旧的那个，
         *   而界面说"已替换"。判据在 `domain/mods.ts::oldFilesToDrop`
         *   （只认同一个 sha1、同名不删），**删除走系统回收站**（默认 non-permanent）。
         */
        const stale = oldFilesToDrop(state.mods.entries, u.sha1, u.file_name);
        if (stale.length > 0) {
          try {
            dropped += await api.modrinth.deleteMods(active.config.slug, stale, false);
          } catch (e) {
            /* 新文件已经装好了 —— 删不掉不算更新失败，但必须如实说 */
            failed.push(`旧文件没删掉：${stale.join('、')}（${e instanceof Error ? e.message : String(e)}）`);
          }
        }
        done += 1;
      } catch (e) {
        failed.push(`${u.file_name}（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
    await reloadMods();
    if (failed.length === 0) {
      toast(
        'ok',
        '更新完成',
        `${done} 个 Mod 已替换为新版本` +
          (dropped > 0 ? `；${dropped} 个旧文件已移入系统回收站（删错了还能捞回来）` : ''),
      );
    } else {
      toast(
        done > 0 ? 'warning' : 'err',
        done > 0 ? `更新了 ${done} 个，${failed.length} 个失败` : '更新失败',
        failed.slice(0, 3).join('；'),
      );
    }
  }

  /**
   * 单条 Mod 的启用 / 禁用。
   *
   * ★ 审计发现：这个按钮以前**只弹一句 toast**（还写着"演示模式未真正改名"），
   *   在桌面版上也是假的 —— 文件名没改、游戏照样加载它。
   *   批量版本的 `bulkSetEnabled` 一直是真的，唯独最常用的单条是假的。
   *   现在走同一条真实路径：改 `.disabled` 后缀 → 重新读盘。
   */
  async function toggleOne(entry: ModEntry) {
    if (!active) return;
    if (!api) {
      toast('warning', '演示模式', '浏览器里改不了真实文件');
      return;
    }
    const next = toggledName(entry.fileName, !entry.enabled);
    try {
      const done = await api.modrinth.setModEnabled(active.config.slug, [entry.path], !entry.enabled);
      if (done === 0) {
        toast('warning', '没有改动', '文件可能已经被别的程序占用或删掉了。');
      } else {
        toast(
          'ok',
          entry.enabled ? '已禁用' : '已启用',
          `${entry.fileName} → ${next}（下次启动生效）`,
        );
      }
    } catch (e) {
      toast('err', '操作失败', e instanceof Error ? e.message : String(e));
    }
    // ★ 必须重新读盘：`.disabled` 是磁盘上的真实状态，
    //   前端自己改状态就会出现"界面说禁用了、盘上还是启用的"两份真相
    void reloadMods();
  }

  const entries = state.mods.entries;
  const states = state.mods.states;

  /* 状态详情（含推断依据） */
  const stateDetail = useMemo(() => {
    const map = new Map<string, ModStateResult>();
    for (const e of entries) {
      map.set(
        e.path,
        judgeModState({
          entry: e,
          instanceMcVersion: active?.mcVersion ?? '1.20.1',
          instanceLoader: (active?.loader?.kind ?? null) as never,
          managedByModpack: false,
        }),
      );
    }
    return map;
  }, [entries, active]);

  const filters = useMemo(() => availableFilters(entries, states, state.mods.filter), [entries, states, state.mods.filter]);

  const visible = useMemo(() => {
    const byState = filterMods(entries, states, state.mods.filter);
    if (!state.mods.query) return byState;
    const q = state.mods.query.toLowerCase();
    return byState.filter(
      (e) =>
        e.displayName.toLowerCase().includes(q) ||
        (e.remote?.name.toLowerCase().includes(q) ?? false),
    );
  }, [entries, states, state.mods.filter, state.mods.query]);

  const updateCandidates = useMemo(
    () => entries.filter((e) => states.get(e.path) === 'can-update'),
    [entries, states],
  );

  /* ---------- 没有实例 / 没有 Mod ---------- */
  if (!active) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Mod 管理</h1>
          </div>
        </div>
        <EmptyState
          title="先选择或创建一个实例"
          desc="Mod 是装在具体实例里的，选择一个实例后才能管理它的 Mod。"
          actions={
            <Button variant="primary" onClick={() => go('versions')}>
              去选择实例
            </Button>
          }
        />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Mod 管理</h1>
          <p className="page-desc">
            当前实例 <b>{active.config.name}</b> · {active.mcVersion}
            {active.loader ? ` · ${loaderName(active.loader.kind)}` : ' · 原版'} · 共 {entries.length} 个 Mod
            {/* ★ 更新数量来自**真实核对**（SHA1 反查在线库），不是猜的 */}
            {checked
              ? updates.length > 0
                ? ` · ${updates.length} 个可更新`
                : ' · 已核对：都是最新'
              : ''}
          </p>
        </div>
        <div className="page-actions">
          <Button
            variant="secondary"
            loading={checking}
            onClick={() => void checkUpdates()}
          >
            <IconRefresh /> 检查更新
          </Button>
          <Button variant="secondary" onClick={() => void reloadMods()} loading={loading}>
            <IconRefresh /> 刷新列表
          </Button>
          {/*
            ★★ 0.1.0-beta.1：这里原来还有一个「资源包 / 光影 / 数据包」按钮 ——
              用户要求"资源包、光影、数据包也一字排开，其他地方的入口删除"。
              那三格现在在**下载页**并排（和 Mod 同一排页签），
              这一页只留「添加 Mod」（它仍然走同一个资源中心，默认 Mod 那一格）。
          */}
          {/*
            ★★ 改为**跳下载页的 Mod 页签，并默认选中这个版本**（用户 2026-09-15：
            "这个添加 mod 的按钮应该直接跳转下载页的 mod 页，并默认选择该跳转版本"）。

            以前它弹一个 Modal —— 于是同一个"浏览 Mod"在启动器里有**两个界面**：
            弹窗里一个（`ResourceBrowser`），下载页里一个（`ResourceCenterBody`）。
            两处的搜索、翻页、装到哪个版本都得各维护一遍，而用户还得记住
            "我上次是在哪儿找的"。现在只有下载页那一个入口。

            ★★ 2026-09-17 修正："默认选中该版本"**以前是坏的**。
            原实现是 `goDownloadTab('mod')` 之后立刻派发 `ieml:download-target` 事件，
            当时的注释还写着"比把状态提到全局更小、更局部"—— **那个判断是错的**：
            `DownloadPage` 的监听器在它**挂载之后**的 effect 里才注册，
            而这里发事件时它还没挂载，事件当场被丢掉。
            后果是：从这里点「添加 Mod」，下载页会用"最近玩过的那个"版本，
            **不是你现在这个**，而且界面上看不出来 —— 用户会把 Mod 装错版本。

            （`goDownloadTab` 本身就是为了同类时序问题才被造出来的，
              见它上面那段注释；但"带哪个版本"这件事当时漏掉了，没一起放进去。）

            现在统一走 `goDownloadFor('mod', active.id)`：
            页签、目标版本、页面切换在**同一次派发**里定下来，不依赖任何事件时序。
          */}
          <Button
            variant="primary"
            onClick={() => goDownloadFor('mod', active?.id ?? null)}
          >
            <IconPlus /> 添加 Mod
          </Button>
          {/*
            ★ 「打开 mods 目录」从说明块里升到工具条（2026-09-14 第十四轮）。
              很多人是从群里/网上下的 .jar，需要知道往哪放 —— 这是**动作**，
              和「添加 Mod」并列才找得到。
          */}
          <Button
            variant="secondary"
            onClick={() => {
              if (!api) {
                toast('info', '演示模式', '桌面版才能打开目录');
                return;
              }
              /*
               * ★★ 2026-09-24（C-2 修复）：这里原来传的是 `'instance'` ——
               *   按钮写着「mods 目录」、当时的 `title` 写着「打开这个实例的 mods 目录
               *   （game\mods）」，点下去打开的却是**实例根目录**。Rust 有 `"mods"` 分支
               *   （崩溃弹窗用的就是它），所以传对参数就行。
               *   ★ 按钮说的和做的不一样，用户会以为 Mod 装错了地方。
               *   （那句 `title` 本身已在 2026-09-26"去掉所有悬停显示描述"时删掉。）
               */
              void api.launcher
                .openDir('mods', active.config.slug)
                .then((dir) => toast('ok', '已打开 mods 目录', dir))
                .catch((e) =>
                  toast('err', '打不开目录', e instanceof Error ? e.message : String(e)),
                );
            }}
          >
            <IconFolder /> mods 目录
          </Button>
          {/*
            ★★ 社区资源入口已删（0.1.0-beta.1）：资源包 / 光影 / 数据包三格
            搬到下载页与 Mod 并排。这一页不再重复放一份入口。
          */}
        </div>
      </div>

      {/*
        ★★ 缺前置包 → 常驻横幅 + 一键补装（用户报「Fabic 版本不会自动安装 API」）。

          自动安装只发生在"创建实例"那一次，老实例与失败过的实例事后没地方补。
          这条横幅让状态**随时可见、随时可修**，而不是等用户下次装 Mod 崩了才发现。
      */}
      {apiStatus?.needed && !apiStatus.present ? (
        <Note
          tone="warning"
          icon={<IconAlert />}
          title={`缺 ${apiStatus.name ?? 'API 前置包'} —— 依赖它的 Mod 会加载失败`}
          actions={
            <Button variant="primary" size="sm" loading={apiInstalling} onClick={() => void installApiLib()}>
              <IconDownload /> 一键补装
            </Button>
          }
        >
          {apiStatus.reason}
          <br />
          判据是 mods 目录里的文件名（找 <span className="mono">{apiStatus.project}</span> 对应的 jar）。
          {apiStatus.modsDir ? (
            <>
              <br />
              目录：<span className="mono">{apiStatus.modsDir}</span>
            </>
          ) : null}
        </Note>
      ) : null}

      <div className="split" style={{ marginTop: 'var(--space-4)' }}>
        {/* ==================== 侧栏筛选（唯一一套） ==================== */}
        <Card>
          <div className="filter-list" role="group" aria-label="按状态筛选">
            <div className="filter-title">状态</div>
            {filters.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`filter-item${state.mods.filter === f.id ? ' on' : ''}`}
                aria-pressed={state.mods.filter === f.id}
                onClick={() => setModFilter(f.id)}
              >
                <span className="filter-check" aria-hidden="true">
                  {state.mods.filter === f.id ? <IconCheck /> : null}
                </span>
                <span className="filter-label">{f.label}</span>
                <span className="filter-count mono">{f.count}</span>
              </button>
            ))}
          </div>
        </Card>

        {/* ==================== 列表 ==================== */}
        <div>
          <div className="row" style={{ marginBottom: 'var(--space-3)' }}>
            <div style={{ flex: 1, maxWidth: 300 }}>
              <SearchBox
                label="搜索已安装的 Mod"
                placeholder="搜索 Mod（支持中文名，如「物品管理器」）"
                value={state.mods.query}
                onChange={(v) => setModQuery(v)}
              />
            </div>
            <div style={{ flex: 1 }} />
            {/*
              ★ 第二段还在跑时**明确说出来**：这时列表里显示的是**文件名**，
                在线库名称还没到。不说的话用户会以为"这就是它的名字"，
                而下一步（检查更新）又要求先反查完 —— 那才是"点了没反应"的观感。
            */}
            {resolvingOnline ? (
              <span className="dim">
                <Spinner label="正在核对在线库…" />
              </span>
            ) : null}
            <span className="dim mono">
              {visible.length} / {entries.length} 个 · 占用{' '}
              {formatBytes(entries.reduce((s, e) => s + e.bytes, 0))}
            </span>
          </div>

          {/* 批量条：只在选中后出现（ADR-019） */}
          {state.mods.selected.size > 0 ? (
            <div className="bulk-bar">
              <span>
                已选中 <b>{state.mods.selected.size}</b> 个
              </span>
              <div className="spacer" />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void bulkSetEnabled(true)}
              >
                启用
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void bulkSetEnabled(false)}
              >
                禁用
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={(e) => void bulkDelete(e)}
              >
                <IconTrash /> 删除
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => clearModSelect()}
              >
                取消选择
              </Button>
            </div>
          ) : updateCandidates.length > 0 ? (
            <div className="bulk-bar hint">
              <IconInfo />
              <span>
                有 <b>{updateCandidates.length}</b> 个 Mod 可以更新。勾选列表项可以批量操作，
                或直接看下面的提示。
              </span>
              <div className="spacer" />
              <Button size="sm" variant="secondary" onClick={() => setUpdateOpen(true)}>
                查看更新…
              </Button>
            </div>
          ) : null}

          {/* ---------- 加载态（原稿完全没有） ---------- */}
          {loading ? <Skeleton rows={5} /> : null}

          {/* ---------- 空状态 ---------- */}
          {!loading && entries.length === 0 ? (
            <EmptyState
              icon={<IconPlus />}
              title="这个实例还没有 Mod"
              desc={
                active.loader === null
                  ? '纯原版实例不能加载 Mod。如果需要装 Mod，请先在实例设置里给它加上一个加载器。'
                  : /*
                     * ★★ 2026-09-24（C-3 修复）：这句话原来还有后半句
                     *   「也可以把 .jar 文件直接拖进窗口。」—— **拖放根本没有实现**：
                     *   `onDrop/onDragOver/dataTransfer` 在 `src` 里 0 命中，
                     *   而 `tauri.conf.json` 是 `dragDropEnabled: true`（原生拖放被接管，
                     *   没有 JS 监听就等于什么都不做）。承诺一个做不到的动作，
                     *   比不说更糟 —— 用户会以为是自己拖的方式不对。
                     *   现在改成指向**真的存在**的那条路：左边那个「mods 目录」按钮。
                     */
                    '可以点右上角「添加 Mod」浏览；从别处下的 .jar，用左边「mods 目录」按钮打开目录后放进去。'
              }
              actions={
                active.loader === null ? (
                  <Button variant="primary" onClick={() => go('versions')}>
                    去加加载器
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => setBrowseOpen(true)}>
                    浏览 Mod
                  </Button>
                )
              }
            />
          ) : null}

          {/* ---------- 搜索无结果 ---------- */}
          {!loading && entries.length > 0 && visible.length === 0 ? (
            <EmptyState
              title={`没有匹配「${state.mods.query}」的 Mod`}
              desc="试试换一个关键词，或者清空搜索框。中文名与英文名都可以搜。"
              actions={
                <Button
                  variant="secondary"
                  onClick={() => setModQuery('')}
                >
                  清空搜索
                </Button>
              }
            />
          ) : null}

          {/* ---------- 列表 ---------- */}
          {!loading &&
            visible.map((entry) => {
              const detail = stateDetail.get(entry.path);
              const st = states.get(entry.path) ?? 'fine';
              const selected = state.mods.selected.has(entry.path);
              return (
                <div key={entry.path} className={`mod-item${selected ? ' selected' : ''}`}>
                  <label className="mod-select">
                    <input
                      type="checkbox"
                      checked={selected}
                      aria-label={`选择 ${entry.displayName}`}
                      onChange={() =>
                        toggleModSelect(entry.path)
                      }
                    />
                  </label>

                  <div className="mod-main">
                    <div className="mod-name-row">
                      <span className="mod-name">{entry.displayName}</span>
                      <StateChip
                        state={st}
                        onClick={
                          st === 'maybe-incompatible' || st === 'can-update'
                            ? () => setCompatFor(entry)
                            : undefined
                        }
                      />
                    </div>
                    {entry.remote?.name && entry.remote.name !== entry.displayName ? (
                      <div className="mod-remote">
                        在线库名称：{entry.remote.name}
                        {entry.latestVersion ? ` · 可更新到 ${entry.latestVersion}` : ''}
                      </div>
                    ) : null}
                    {detail?.evidence && detail.evidence.length > 0 && st !== 'can-update' ? (
                      <div className="mod-evidence">
                        {detail.evidence.map((e, i) => (
                          <div key={i}>· {e}</div>
                        ))}
                      </div>
                    ) : null}
                    <div className="mod-foot">
                      <span className="mono">{formatBytes(entry.bytes)}</span>
                      <span className="dot" />
                      <span>{entry.fileName.endsWith('.disabled') ? '已禁用（.disabled）' : '已启用'}</span>
                    </div>
                  </div>

                  <div className="mod-act">
                    {st === 'can-update' ? (
                      <Button size="sm" variant="primary" onClick={() => setUpdateOpen(true)}>
                        更新
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void toggleOne(entry)}
                    >
                      {entry.enabled ? '禁用' : '启用'}
                    </Button>
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* ==================== 更新确认弹窗 ==================== */}
      <Modal
        open={updateOpen}
        onClose={() => setUpdateOpen(false)}
        title="更新 Mod"
        subtitle="IEML 不会自动更新 Mod —— 这一步是你手动触发的"
        footer={
          <>
            <span className="dim">
              已选 {updateCandidates.length - unchecked.size} / {updateCandidates.length} 个
            </span>
            <div className="spacer" />
            <Button variant="ghost" onClick={() => setUpdateOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              // ★ 禁用条件**同时**要满足：没勾选任何项，或当前是演示模式
              disabled={!api || updateCandidates.length - unchecked.size === 0}
              onClick={() => void applyUpdates()}
            >
              更新 {updateCandidates.length - unchecked.size} 个
            </Button>
          </>
        }
      >
        {!api ? (
          <Note tone="info" icon={<IconInfo />} title="演示模式">
            浏览器里没有真实文件系统，更新不会真的落盘。
          </Note>
        ) : null}
        <Note tone="warning" icon={<IconAlert />} title="注意版本兼容">
          更新后的 Mod 可能不再支持当前的游戏版本或加载器。
          {/* ★ 审计发现：这句原来写着"默认不勾选"，而 unchecked 初始是空的 ——
              风险项其实**默认是勾上的**。现在两者一致了：风险项真的默认不勾。 */}
          带「可能不兼容」标记的项<b>默认不勾选</b>，确认要用再自己勾上。
        </Note>

        <div className="upd-list">
          {updates.length === 0 ? (
            <div className="dim" style={{ padding: 'var(--space-3)' }}>
              {checked
                ? '核对过了：兼容当前版本的可更新文件最上面列出的那些就是全部。'
                : '还没有核对过更新。回到列表点右上角「检查更新」。'}
            </div>
          ) : null}
          {updates.map((u) => {
            // 用 SHA1 找到列表里对应的那条（哈希是文件的唯一身份）
            const entry = state.mods.entries.find((e) => e.sha1 === u.sha1);
            const risky = entry ? states.get(entry.path) === 'maybe-incompatible' : false;
            const on = !unchecked.has(u.sha1);
            return (
              <label key={u.sha1} className={`upd-row${risky ? ' risk' : ''}`}>
                {/* ★ 真的 checkbox —— 原稿这里是 label + span，根本点不动 */}
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    setUnchecked((prev) => {
                      const next = new Set(prev);
                      if (next.has(u.sha1)) next.delete(u.sha1);
                      else next.add(u.sha1);
                      return next;
                    });
                  }}
                />
                <span className="upd-main">
                  <span className="upd-name">
                    {entry?.remote?.name ?? entry?.displayName ?? u.file_name}
                    <span className="mono">
                      {' '}
                      {u.current_version} → {u.latest_version}
                    </span>
                  </span>
                  <span className="upd-meta">
                    兼容 {active.mcVersion}
                    {active.loader ? ` · ${loaderName(active.loader.kind)}` : ''}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </Modal>

      {/* ==================== 兼容性说明弹窗（ADR-021：只能提示不能判定） ==================== */}
      <Modal
        open={compatFor !== null}
        onClose={() => setCompatFor(null)}
        title={compatFor ? `关于「${compatFor.displayName}」` : ''}
        subtitle="这是提醒，不是结论"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCompatFor(null)}>
              我知道了
            </Button>
            <div className="spacer" />
            <Button
              variant="primary"
              onClick={() => {
                setCompatFor(null);
                /*
                 * ★ 审计发现：这里原来写着「已在后台检查」——**根本没有这个检查**，
                 *   是一句凭空承诺。如实说：这是一个提醒，启动结果才是判据。
                 */
                toast(
                  'info',
                  '知道了',
                  'IEML 不会因为这个提醒改动你的 Mod。真不兼容时启动日志里会有明确特征，可以回这一页禁用。',
                );
              }}
            >
              仍然使用
            </Button>
          </>
        }
      >
        {compatFor ? (
          <>
            <div className="compat-block">
              <div className="compat-title">推断依据</div>
              {(stateDetail.get(compatFor.path)?.evidence ?? []).map((e, i) => (
                <div key={i} className="compat-line">
                  {e}
                </div>
              ))}
            </div>
            <Note tone="info" icon={<IconInfo />} title="请注意">
              · 我们读的是在线库记录的元数据，作者经常没写全或写得不准确
              <br />· 所以这只是一个提醒，Mod 很可能仍然能正常工作
              <br />· 是否兼容以实际启动结果为准 —— 真的不兼容时崩溃日志里会有明确特征
              <br />· 我们不会因此阻止你启动，也不会自动禁用这个 Mod
            </Note>
          </>
        ) : null}
      </Modal>

      {/* ==================== 浏览 Mod（在线库） ==================== */}
      <Modal
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        title="添加 Mod"
        subtitle={`从 Modrinth 搜索，按 ${active?.mcVersion ?? ''}${active?.loader ? ' + ' + loaderName(active.loader.kind) : ''} 过滤`}
        footer={
          <Button variant="ghost" onClick={() => setBrowseOpen(false)}>
            关闭
          </Button>
        }
      >
        <div className="row" style={{ marginBottom: 'var(--space-3)' }}>
          <div style={{ flex: 1 }}>
            <SearchBox
              label="搜索 Mod"
              placeholder="输入 Mod 名，如 sodium、jei、create"
              value={browseQuery}
              onChange={setBrowseQuery}
            />
          </div>
          <Button variant="primary" loading={browseLoading} onClick={() => void searchMods()}>
            搜索
          </Button>
        </div>

        {browseError ? <Note tone="danger" icon={<IconAlert />}>{browseError}</Note> : null}

        {browseLoading ? <Skeleton rows={5} height={48} /> : null}

        {!browseLoading && browseResults.length === 0 && !browseError ? (
          <EmptyState title="搜一下" desc="输入 Mod 名字搜索在线库，比如「sodium」「jei」「create」。" />
        ) : null}

        {browseResults.map((hit) => (
          <div key={hit.project_id} className="mod-item">
            <div className="mod-main">
              <div className="mod-name-row">
                <span className="mod-name">{hit.title}</span>
                <span className="dim mono">{hit.downloads > 1000 ? `${Math.round(hit.downloads / 1000)}k 下载` : `${hit.downloads} 下载`}</span>
              </div>
              <div className="mod-remote">{hit.description.slice(0, 120)}</div>
              <div className="mod-foot">
                <span>{hit.author || '未知作者'}</span>
                <span className="dot" />
                <span>{hit.versions.slice(-1)[0] ?? '—'}</span>
              </div>
            </div>
            <div className="mod-act">
              <Button
                size="sm"
                variant="primary"
                loading={installingSlug === hit.project_id}
                onClick={() => void installMod(hit)}
              >
                安装
              </Button>
            </div>
          </div>
        ))}
      </Modal>

      {/*
        ★★ 社区资源浏览器：**Mod / 资源包 / 光影 / 数据包 同一套界面**。
        选项卡由后端那张表生成，加一种资源不用动这里。
        ★ 这一页只从「添加 Mod」进，所以默认种类就是 Mod。
      */}
      <ResourceBrowser
        open={resourceOpen}
        onClose={() => setResourceOpen(false)}
        instance={active}
        initialKind="mod"
        onInstalled={() => void reloadMods()}
        toast={toast}
      />
    </>
  );
}

/* ====================== 状态徽标 ====================== */

function StateChip({ state: st, onClick }: { state: string; onClick?: () => void }) {
  const map: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'danger' }> = {
    fine: { label: '', tone: 'neutral' },
    disabled: { label: '已禁用', tone: 'neutral' },
    'can-update': { label: '可更新', tone: 'info' },
    'maybe-incompatible': { label: '可能不兼容', tone: 'warning' },
    errored: { label: '有错误', tone: 'danger' },
    library: { label: '前置库', tone: 'neutral' },
  };
  const m = map[st];
  if (!m || !m.label) return null;
  return (
    <Chip tone={m.tone} onClick={onClick}>
      {m.label}
    </Chip>
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

