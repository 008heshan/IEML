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
} from '../domain/mods.ts';
import type { ModEntry, ModStateResult } from '../domain/mods.ts';
import { formatBytes, modUpdateLock } from '../domain';
import { instanceDirSlug } from '../domain/instance-path.ts';
import { EVT_OPEN_MOD_BROWSE } from '../state/events';
import {
  deleteIntent,
  describeDelete,
  trashUnavailablePrompt,
} from '../domain/delete.ts';
import { useRealApi } from '../hooks/useRealApi';
import type { ApiLibStatus, ModUpdateCandidate, ModrinthHit, PackInfo } from '../bridge/tauri';
// ★ 社区资源浏览器：Mod / 资源包 / 光影 / 数据包 共用一套界面
import { ResourceBrowser } from '../components/ResourceBrowser';

/**
 * 「这是个前置库」那两条说明（用户要求不在卡片上念）。
 *
 * ★ 判据放模块级而不是组件里：组件每次渲染都会新建一个正则，
 *   而这个值从模块加载到卸载都不会变。
 *
 * ★ 认的是 `judgeModState` 里那两条**原文**（`domain/mods.ts:268-269`）——
 *   判定层没动，只是展示层把它们滤掉。改文案时这里要跟着改，
 *   否则那两句会悄悄回到卡片上（`tests/domain.test.js` 里有前置库判定的用例）。
 */
const LIBRARY_EVIDENCE = /前置库|依赖它的 Mod/;

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
    /* ★ 2026-09-30：点「详情」要转到**下载页的资源详情页**（见 `openModDetail`） */
    openResource,
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
  /*
   * ★★ 2026-09-30：点「详情」之后**正在取那个 Mod 的资源信息**时的加载态。
   *
   *   只有"还没核对过"那条路会用到它（那时要先扫一次拿 project id）——
   *   而那条路要读盘 + 联网，几百毫秒到几秒，**必须让按钮转起来**，
   *   否则用户会以为点了没反应而重复点。
   *
   *   ★ 存路径而不是布尔：列表里可能有多个 Mod，转的必须是**被点的那一个**。
   */
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
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
  /*
   * ★ 2026-09-30：`resolvingOnline` 已删 —— 列表不再联网，那个状态永远不会真。
   */

  const reloadMods = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    try {
      /*
       * ★★★★ 2026-09-30（用户）：「**我倒是觉得，我们本来就不该联网读取 mod 列表的 mod**」
       *   以及「**并且，我不想要在线名称了**」。
       *
       *   这两句把方向纠正了 —— 上一轮我在给一条**不该存在的前置条件**提速
       *   （把 20 秒优化成 5 秒），而真正的修法是**把那一整段从加载路径里删掉**。
       *
       *   ## 列表要显示的东西**全在盘上**
       *
       *     文件名、大小、mtime、启用/禁用（`.disabled` 后缀）—— 一个字段都不需要联网。
       *     "这是哪个 Mod、有没有新版"才是联网的事，而它有自己的按钮（【检查更新】）。
       *
       *   ## 以前是怎么错的
       *
       *     进页面就自动反查在线库、把每个 Mod 的名字换成"在线库名称"，于是：
       *       · `api.modrinth.com` 国内连不上 ⇒ **每次进页面白等 20 秒**
       *         （补上镜像兜底后仍要 5 秒）；
       *       · 用户没点任何东西，没有理由为"在线库叫什么"付这个钱；
       *       · 最刺眼的是：**改个文件名（启用/禁用）也要等这一圈网络**。
       *
       *   ⇒ 现在这一段就是全部：`backend.listMods` 只读目录（Rust 侧 `scan_mods`，
       *     它是纯 `read_dir`，本来就不联网）。联网只剩【检查更新】那一个入口。
       *
       *   ★ 名字是**从文件名去掉扩展名**得来的（本地推导，零成本）——
       *     "在线库名称"那个字段用户明确不要了。
       */
      /*
       * ★★★★ 2026-09-30：**这里原来传的是 `active.id`，那是错的** —— 一个真机 bug。
       *
       *   `id`（`inst-mulcf1gv`）是**账本里的实例身份**，只在启动器内部用；
       *   磁盘上的目录名是 **`config.slug`**（`26.3-fabric-0.19.5`）。
       *   后端拿它当目录名拼路径 ⇒ 读的是
       *   `.minecraft/versions/inst-mulcf1gv/mods` ⇒ **不存在** ⇒ 列表 0 个。
       *
       *   真机证据（`<own_root>/mods-diag.txt`，用户点一下就能看到）：
       *   ```
       *   scan_mods(instance_id="inst-mulcf1gv", …)
       *   实际读的目录：D:\IEML\.minecraft\versions\inst-mulcf1gv\mods
       *   结果：目录不存在或读不出来
       *   ```
       *   而 `D:\IEML\.minecraft\versions\26.3-fabric-0.19.5\mods` 里确实有 jar。
       *
       *   ★ 判定收进 `instanceDirSlug`（有测试），不在页面里各自猜字段。
       */
      const slug = instanceDirSlug(active);
      if (!slug) {
        toast('err', '这个实例没有目录名', '实例记录里的 slug 是空的，无法定位它的 Mod 目录。');
        return;
      }
      const local = await backend.listMods(slug);
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

      /*
       * ★★ 图标**单独取一次**（用户：「我还要 mod 的图标」，方案是"从 jar 里解"）。
       *
       *   为什么不塞进上面那次 listMods：图标是 base64，一个几 KB，
       *   几十个 Mod 就是几百 KB —— 而列表只需要文件名/大小。
       *   分开取的好处是**列表不等图标**：先出文件与状态，图标回来再补上。
       *
       *   ★ 它也是纯本地的（后端按 mtime 解一次并缓存），不联网。
       *   ★ 失败就当作"都没有图标"（界面用首字母占位块）——
       *     图标是锦上添花，绝不能因为它让列表读不出来。
       */
      try {
        const icons = await backend.modIcons(slug);
        if (Object.keys(icons).length > 0) {
          // ★ 只在**路径仍然存在**的条目上贴图标（用户可能刚好删了一个）
          const withIcons = localEntries.map((entry) =>
            icons[entry.path] ? { ...entry, icon: icons[entry.path] } : entry,
          );
          setMods(withIcons, judgeAll(withIcons, active.mcVersion, active.loader?.kind ?? null));
        }
      } catch {
        /* 图标取不到就算了 —— 首字母占位块本来就是兜底方案 */
      }
    } catch (e) {
      toast('err', '读取 Mod 列表失败', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [active, backend, setMods, toast]);

  useEffect(() => {
    void reloadMods();
  }, [reloadMods]);

  /* ---------- 检查更新（真的去问在线库） ---------- */
  const [checking, setChecking] = useState(false);
  const [updates, setUpdates] = useState<ModUpdateCandidate[]>([]);
  const [checked, setChecked] = useState(false);
  /**
   * ★★ 这个实例是不是**从整合包装的**（ADR-025 的记录）——
   *   ADR-018 第 ⑥ 条据此**锁住单个 Mod 的更新**：
   *   作者验证过的那套组合，不该被我们一个个换掉（换坏了极难查）。
   *   `null` = 没有记录 ⇒ 不锁（误锁会让用户连自己装的 Mod 都更新不了）。
   */
  const [packInfo, setPackInfo] = useState<PackInfo | null>(null);
  const packLock = useMemo(() => modUpdateLock(packInfo), [packInfo]);
  useEffect(() => {
    if (!api || !active) return;
    let alive = true;
    void api.pack
      .info(active.config.slug)
      .then((p) => {
        if (alive) setPackInfo(p);
      })
      .catch(() => {
        /* 读不到记录 = 不是整合包（后端返回 null，不该抛）—— 抛了也别锁 */
        if (alive) setPackInfo(null);
      });
    return () => {
      alive = false;
    };
  }, [api, active]);

  async function checkUpdates() {
    if (!active || !api) {
      toast('warning', '演示模式', '桌面版才能向在线库核对更新');
      return;
    }
    setChecking(true);
    try {
      /*
       * ★★★★ 2026-09-30：**这里是全页唯一联网的地方**（用户：
       *   「我们本来就不该联网读取 mod 列表的 mod」）。
       *
       *   列表已经不再算哈希了（那是为了联网反查才需要的），所以这一步
       *   自己先把哈希与在线库信息拿回来 —— 一次联网把两件事办完：
       *     ① `scanMods`  → 读盘 + SHA1/指纹 + 反查在线库（名称/版本/是否前置库）
       *     ② `checkUpdates` → 用①拿到的 sha1 + 指纹核对更新
       *
       *   ⇒ 代价是"点这个按钮会读一遍所有 jar"（按 mtime 有哈希缓存，
       *     第二次很快），但**这笔钱只在用户主动点的时候付** ——
       *     而不是每次进页面、每次改个文件名都付。
       *
       *   ★ 结果同时被用来**补全列表**（见下面的 `hydrated`）：这样
       *     "检查更新"顺便把版本信息也带回来了，不需要另一个按钮。
       */
      const scanned = await api.modrinth.scanMods(
        active.config.slug,
        active.mcVersion,
        active.loader?.kind ?? null,
      );
      const hydrated: ModEntry[] = state.mods.entries.map((entry) => {
        const hit = scanned.find((s) => s.path === entry.path);
        if (!hit) return entry;
        return {
          ...entry,
          ...(hit.sha1 ? { sha1: hit.sha1 } : {}),
          ...(hit.fingerprint ? { murmur2: hit.fingerprint } : {}),
          ...(hit.remote
            ? {
                remote: {
                  // ★ 来源如实映射：只在 CurseForge 上查到的 Mod 不该被标成 Modrinth
                  source:
                    hit.remote.source === 'curseforge'
                      ? ('curseforge' as const)
                      : ('modrinth' as const),
                  projectId: hit.remote.project_id,
                  name: hit.remote.title || hit.remote.project_id,
                  version: hit.remote.version,
                  gameVersions: hit.remote.game_versions,
                  loaders: hit.remote.loaders as never,
                  isLibrary: hit.remote.is_library,
                },
              }
            : {}),
        };
      });

      /*
       * ★★ 两个列表**按位置一一对应**（ADR-052）：
       *   第 i 个 sha1 与第 i 个指纹是同一个文件。没有指纹的文件传空串
       *   （后端保位置，空位不会让后面错位）。
       *
       *   为什么要同时给指纹：Modrinth 用 SHA1 反查，而 **CurseForge 只认
       *   MurmurHash2 指纹** —— 只发 SHA1 的话，那些只在 CurseForge 上发布的
       *   Mod 永远查不到更新（而且没有任何报错，静默地"就是没有更新"）。
       */
      const rows = hydrated.filter((e) => Boolean(e.sha1));
      const hashes = rows.map((e) => e.sha1!);
      const fingerprints = rows.map((e) => e.murmur2 ?? '');
      const hasFingerprint = fingerprints.some((f) => f !== '');
      if (hashes.length === 0) {
        setMods(hydrated, judgeAll(hydrated, active.mcVersion, active.loader?.kind ?? null));
        toast(
          'info',
          '没有可核对的 Mod',
          '这些文件都没能在在线库里找到（Modrinth 用 SHA1、CurseForge 用指纹），无法判断更新。',
        );
        setChecked(true);
        return;
      }
      const list = await api.modrinth.checkUpdates(
        hashes,
        fingerprints,
        active.mcVersion,
        active.loader?.kind ?? null,
      );
      setUpdates(list);
      setChecked(true);
      // ★ 补全后的列表**在核对成功之后**才落坐（失败时保留原来那份，不闪）
      setMods(hydrated, judgeAll(hydrated, active.mcVersion, active.loader?.kind ?? null));
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
   * ★★★★ 2026-09-30（用户）：「**直接转到下载页的 mod 详情页**」。
   *
   *   点「详情」= 把那个项目的**资源信息**交给下载页，然后切过去。
   *   详情页本身（资源信息卡 + 版本列表）是现成的（`ResourceInstallPage`），
   *   这里只负责**凑出它要的那个 `ModrinthHit`**。
   *
   * ## 两个来源
   *
   *   ① **已经核对过**（列表里带 `remote`）⇒ 直接拼出来，一次网络请求都不发；
   *   ② **还没核对过** ⇒ 先扫一次（读盘 + 按 SHA1/指纹精确反查），
   *      拿到 project id 再转。列表现在是纯本地的（用户要求"不该联网读列表"），
   *      所以大多数人点详情时手上只有文件名 —— 这是常态路径。
   *
   * ## 为什么**不**按文件名搜索来兜底
   *
   *   我一开始想那样做，但它**会给出错的详情页**：文件名与项目往往对不上
   *   （`fabric-api-0.161.0+26.3.jar` 搜出来可能是别的项目），而详情页
   *   看起来又是"权威"的 —— 用户会照着它去装一个不相干的版本。
   *   ⇒ 宁可**如实说"在线库里没有它的记录"**，也不猜一个。
   */
  async function openModDetail(entry: ModEntry) {
    if (!api || !active) {
      toast('info', '演示模式', '桌面版才能看在线详情');
      return;
    }
    /** 从这几个字段拼出资源详情页要的 hit（详情页会自己去取真正的项目信息） */
    const hitOf = (o: {
      project_id: string;
      title: string;
      source?: string;
    }): ModrinthHit => ({
      project_id: o.project_id,
      slug: o.project_id,
      title: o.title,
      description: '',
      categories: [],
      project_type: 'mod',
      downloads: 0,
      icon_url: null,
      versions: [],
      author: '',
      page_url: null,
    });

    // ① 已核对过 —— 手上的信息就够
    if (entry.remote?.projectId) {
      openResource(
        hitOf({
          project_id: entry.remote.projectId,
          title: entry.remote.name,
          source: entry.remote.source,
        }),
        'mod',
        entry.remote.source === 'curseforge' ? 'curseforge' : 'modrinth',
      );
      return;
    }

    // ② 还没核对过 —— 扫一次拿 project id（与【检查更新】同一条路，哈希有缓存）
    setDetailLoading(entry.path);
    try {
      const scanned = await api.modrinth.scanMods(
        active.config.slug,
        active.mcVersion,
        active.loader?.kind ?? null,
      );
      const hit = scanned.find((s) => s.path === entry.path)?.remote;
      if (!hit) {
        toast(
          'info',
          '在线库里没有这个 Mod',
          '按内容核对（Modrinth 用 SHA1、CurseForge 用指纹）都没找到它 —— 可能是本地改过的包，或者国内暂时连不上在线库。',
        );
        return;
      }
      openResource(
        hitOf({ project_id: hit.project_id, title: hit.title || hit.project_id, source: hit.source }),
        'mod',
        hit.source === 'curseforge' ? 'curseforge' : 'modrinth',
      );
    } catch (e) {
      toast('err', '打不开详情', e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(null);
    }
  }

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

  /*
   * ★★ 2026-09-30（用户）：「不要那个按钮；做一个公共的禁用启用按钮」。
   *
   *   所以**整个列表只有顶部这一个按钮**管启用/禁用，卡片上不再有它。
   *   每行的对勾（行尾）只负责"我要处理哪几个"。
   *
   *   按钮说什么，判据是用户点的名（原话）：
   *
   *   > 选择被禁用的 mod 时，按钮显示启用；选择没被禁用的 mod 时，按钮显示禁用。
   *
   *   也就是**按钮说的是"点下去会发生什么"**，不是"它们现在是什么状态"。
   *   三种情形：
   *
   *   | 勾选的 Mod | 按钮显示 | 点下去 |
   *   |---|---|---|
   *   | 被禁用的（一个启用的都没有） | **启用** | 全部启用 |
   *   | 没被禁用的（至少一个启用） | **禁用** | 全部禁用 |
   *   | 混着选（有启用也有禁用） | **禁用** | 全部禁用 |
   *
   *   ★ 混选归到「禁用」是**跟着上面那句话推出来的**，不是我自己加的一条规则：
   *     "选择没被禁用的 mod"在混选里也成立（其中确实有没被禁用的），
   *     所以按钮显示「禁用」。逆过来读（有被禁用的就显示启用）会把纯启用的一组
   *     也判成"禁用" —— 那与用户给的第一句冲突。
   *
   *   ★ 文案与它真做的事**必须同源**（ADR-041）：按钮上的字就是从 `bulkTarget`
   *     推出来的，不会出现"写着启用、点下去却是禁用"。
   */
  const selectedEntries = state.mods.entries.filter((e) => state.mods.selected.has(e.path));
  const bulkTarget: 'enable' | 'disable' =
    selectedEntries.length > 0 && selectedEntries.every((e) => !e.enabled)
      ? 'enable'
      : 'disable';

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

  /*
   * ★★★★ 2026-09-30（用户纠正）：「**不不不，直接转到下载页的 mod 详情页**」。
   *
   *   我上一版在这一页**自己造了一个详情页**（文件表 + 在线库信息表）——
   *   而那个界面**已经存在**：下载页的资源详情页（`ResourceInstallPage`，
   *   照 PCL 做的那个：资源信息卡 + 版本列表）。
   *
   *   自己造一份的代价是立刻可见的：
   *     · 同一个东西两套界面，用户要学两次、我们要维护两处；
   *     · 我那份只能显示"当前装的这一个版本"，而资源详情页能**列出所有版本并直接换版本**；
   *     · 我那份里的"在线库信息"还得等用户先点过【检查更新】才有数据 —— 一份残废的表。
   *
   *   ⇒ 这一页不再有详情视图。点「详情」只做一件事：
   *     **拿到那个项目的资源信息，转到下载页的详情页**（见 `openModDetail`）。
   */

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
          {/*
            ★★ ADR-018 第 ⑥ 条：**整合包实例不许一个个更新 Mod**。
              作者验证过的组合被我们换掉一个，崩法极难查 —— 所以这里直接不让查、
              也不让点，并把理由写在按钮旁边（而不是点下去才弹一句"不行"）。
              ★ 这一条只对"有安装记录的实例"生效（`pack_info` 读得到）；
                不是整合包的实例照常能更新。
          */}
          {packLock.locked ? (
            <span className="dim" role="status">
              {packLock.reason}
            </span>
          ) : null}
          <Button
            variant="secondary"
            loading={checking}
            disabled={packLock.locked}
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
             * ★ 2026-09-30：这里原来有一个「正在核对在线库…」的转圈。
             *   列表不再联网（见 `reloadMods` 的说明），所以这一段的等待没有了 ——
             *   转圈也跟着删掉：**留着一个不会出现的指示器，比没有更糟**
             *   （下一个人会以为"联网那段还在，只是慢得没显示"）。
             */}
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
              {/*
               * ★ 按钮上的字就是"点下去会发生什么"，**不再加 `title`**：
               *   用户要求过"去掉所有悬停显示描述"，而这里也不需要 ——
               *   按钮文案与动作同源，鼠标停上去再解释一遍是多余的一层。
               *   （门禁 `check-tooltips` 会拦住这类 `title`，它是真的跑着的。）
               */}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void bulkSetEnabled(bulkTarget === 'enable')}
              >
                {bulkTarget === 'enable' ? '启用' : '禁用'}
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
                /*
                 * ★★ 2026-09-30（用户）：「**我想要点一下这个栏就可以选择**」。
                 *
                 *   整行可点 —— 但只做**一件事**：切换这一条的勾选。
                 *   ★ 为什么敢把整行做成选择区：这一行里现在只有两样能点的东西
                 *     （状态标签、行尾的对勾），而"选中"是这一行**唯一**的默认动作。
                 *   ★ 不双击进详情、不右键出菜单 —— 那些是"顺手加的"，而用户没要。
                 *     加了口子就得处理"点到链接/点到按钮时别触发"的一堆边界。
                 *
                 *   ★ 键盘与无障碍走**原生 checkbox**（藏在下面的 `.mod-select` 里）：
                 *     整行点击只是给鼠标的捷径，Tab/Space 那条路一个字都没变。
                 */
                <div
                  key={entry.path}
                  className={`mod-item${selected ? ' selected' : ''}`}
                  onClick={() => toggleModSelect(entry.path)}
                >
                  {/*
                   * ★★ 2026-09-30（用户）：「**我还要 mod 的图标**」，方案是"从 jar 里解"。
                   *
                   *   `entry.icon` 是后端从 jar 里解出来的 `data:image/...;base64,…`
                   *   （见 `mod_icons` 命令）。**没有图标时**（大多数 Mod 不打包图标）
                   *   用[文件名首字母 + 色块]做占位 —— 用户选的方案。
                   *
                   *   ★ 为什么用"首字母色块"而不是一个统一的小图标：
                   *     列表里一眼扫过去时，缺图标的那些会变成一片相同的方块；
                   *     用名字首字母（`fabric-api…` → `F`）能让人**在扫视时区分开**，
                   *     而且颜色由名字决定（同名同色，稳定不乱跳）。
                   *
                   *   ★ 图片加载失败不显示破图：`onError` 里退成首字母块。
                   *     base64 内嵌理论上不会失败，但"理论上"三个字在这个仓库不值钱。
                   */}
                  <ModIcon entry={entry} />
                  <div className="mod-main">
                    <div className="mod-name-row">
                      <span className="mod-name">{entry.displayName}</span>
                      <StateChip
                        state={st}
                        onClick={
                          st === 'maybe-incompatible' || st === 'can-update'
                            ? /* ★ 拦冒泡：整行是选择区，而"看兼容性/更新说明"是另一件事 */
                              (e) => {
                                e.stopPropagation();
                                setCompatFor(entry);
                              }
                            : undefined
                        }
                      />
                    </div>
                    {/*
                     * ★★ 2026-09-30（用户）：「**并且，我不想要在线名称了**」。
                     *
                     *   这里原来有一行「在线库名称：Fabric API · 可更新到 x.y.z」。
                     *   删掉的理由不只是"不好看"：它**要求先联网反查**才能有值，
                     *   而列表已经改成纯本地（见 `reloadMods`）——
                     *   留着它就会让每一行显示成"半截信息"，或者逼着列表重新联网。
                     *
                     *   ★ 版本信息没有丢：**可更新**仍然由右边那颗状态标签与
                     *     卡片上的「更新」按钮表达（它们来自【检查更新】的结果）。
                     */}
                    {detail?.evidence && detail.evidence.length > 0 && st !== 'can-update' ? (
                      <div className="mod-evidence">
                        {/*
                         * ★★ 2026-09-30（用户给了一张"在线库名称：Fabric API"的截图）：
                         *   「这些文字去掉」—— 指的是 `library` 那两条说明：
                         *     · `Fabric API 是其他 Mod 的前置库`
                         *     · `单独禁用它会导致依赖它的 Mod 无法加载`
                         *
                         *   ★ 只在**展示**这一层滤掉，`judgeModState` 里的判定一个字没动 ——
                         *     "前置库"这个状态还成立（右边那颗 `前置库` 标签照旧显示），
                         *     变的只是"要不要在卡片上把这两句解释念一遍"。
                         *     把判定也删掉的话，这类 Mod 会落回 `fine`，
                         *     连"它是前置库"这件事都看不出来了 —— 那是另一个改动，
                         *     用户没要求，不做。
                         */}
                        {detail.evidence
                          .filter((e) => !LIBRARY_EVIDENCE.test(e))
                          .map((e, i) => (
                            <div key={i}>· {e}</div>
                          ))}
                      </div>
                    ) : null}
                    {/*
                     * ★★ 2026-09-30（用户）：「把 mod 上的『禁用』去掉」。
                     *
                     *   去掉的是**这行状态文字**（原来写作
                     *   `· 已启用 / 已禁用（.disabled）`），不是"启用/禁用"这个动作 ——
                     *   动作仍然在（顶部那个公共按钮），这里只是不再把状态念第二遍。
                     *
                     *   ★ 这个区分我一开始搞反过（把动作删了、留下状态文字），
                     *     结果用户问「单个 mod 的禁用与启用呢？」—— 记在这里免得下次再错。
                     */}
                    <div className="mod-foot">
                      <span className="mono">{formatBytes(entry.bytes)}</span>
                    </div>
                  </div>

                  <div className="mod-act">
                    {/*
                      ★★ 2026-09-30（用户）：「**为版本的 mod 列表的 mod 加一个详情按钮，
                        然后点击后进入 mod 的详情页**」。
                      ★ `stopPropagation`：整行是选择区（点一下切换勾选），
                        而"看详情"是另一件事 —— 不拦住的话点它会顺手把这一行选上。
                    */}
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={detailLoading === entry.path}
                      onClick={(e) => {
                        e.stopPropagation();
                        void openModDetail(entry);
                      }}
                    >
                      <IconInfo /> 详情
                    </Button>
                    {st === 'can-update' ? (
                      /*
                       * ★ `stopPropagation`：整行现在是选择区（见上面的 onClick），
                       *   而"更新"是**另一件事** —— 不拦住的话点它会顺手把这一行选上，
                       *   于是顶部那个公共按钮跟着冒出来，用户会以为"更新"顺带做了什么。
                       */
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          setUpdateOpen(true);
                        }}
                      >
                        更新
                      </Button>
                    ) : null}
                    {/*
                     * ★★ 2026-09-30（用户）：「打对勾的那个，移到 mod 的『禁用』两字的位置」；
                     *   随后明确：「不要那个按钮；做一个公共的禁用启用按钮」。
                     *   再后来：「我觉得框选框有些难看，可以做一个更好的效果吗」。
                     *
                     *   ⇒ 卡片上**没有**启用/禁用按钮了，这里只有对勾：
                     *      勾它 = 把这一行交给顶部那个公共按钮处理（语义一个字没改）。
                     *   ⇒ 对勾**不用系统原生那个方块**：原生框视觉隐藏（但仍可 Tab 聚焦、
                     *      仍可用空格切换 —— 无障碍不能丢），自己画一个圆圈 + 勾
                     *      （见 `.mod-select` 那一组样式）。
                     *
                     *   ★ 为什么不留那个即时按钮：用户点名不要 ——
                     *     它与对勾在同一行里管两件不同的事（一个选中、一个改状态），
                     *     并排摆着最容易点错（"我只想选中它，结果把它禁用了"）。
                     */}
                    <label
                      className="mod-select"
                      /*
                       * 点圆圈本身也要能切换 —— 但别让它冒泡到整行（会切两次，等于没切）。
                       * label 与 input 的联动本来就会触发一次 change，这里只负责拦住冒泡。
                       */
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/*
                       * ★ 无障碍名字用 `aria-label`（不是 `title`）：读屏软件要它，
                       *   而鼠标悬停**不弹**任何东西 —— 用户要求过"去掉所有悬停显示描述"。
                       *   `check-tooltips` 门禁把两者分得很清（`aria-label` 放行）。
                       */}
                      <input
                        type="checkbox"
                        checked={selected}
                        aria-label={`选择 ${entry.displayName}`}
                        onChange={() => toggleModSelect(entry.path)}
                      />
                      {/*
                       * ★ 自己画的那个圈与勾（原生框被 CSS 视觉隐藏）。
                       *   它是**纯装饰**：`aria-hidden`，因为语义与键盘操作都由
                       *   上面那个原生 `input` 承担 —— 读屏软件读的是它。
                       */}
                      <span className="box" aria-hidden="true">
                        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M2.5 6.4 L4.8 8.7 L9.5 3.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </label>
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

function StateChip({
  state: st,
  onClick,
}: {
  state: string;
  /**
   * ★ 2026-09-30：参数从 `() => void` 改成 `(e) => void` ——
   *   因为整行现在是选择区，这个标签得能**拦住冒泡**
   *   （点"兼容性"不该顺手把这一行选上）。
   */
  onClick?: (e: React.MouseEvent) => void;
}) {
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


/* ====================== Mod 图标 ====================== */

/**
 * 一行 Mod 左侧的图标（2026-09-30，用户：「我还要 mod 的图标」）。
 *
 * ## 两条路
 *
 *   · `entry.icon` 有值 → 它就是从 jar 里解出来的 `data:` URI，直接显示；
 *   · 没有 → **文件名首字母 + 色块**（用户选的兜底方案）。
 *
 * ## 为什么首字母色块比一个统一小图标好
 *
 *   Mod 里大多数**不打包图标**，于是列表里会有一大片长得一模一样的方块。
 *   用名字首字母（`fabric-api-0.161.0+26.3` → `F`）能让人在扫视时区分开，
 *   而颜色由名字算出来（**同名同色**，刷新多少次都不跳）。
 *
 * ★ 颜色只从**名字**推，不用随机数：随机会让每次渲染颜色都变，
 *   那比没有颜色更让人分心。
 */
function ModIcon({ entry }: { entry: ModEntry }) {
  const [broken, setBroken] = useState(false);
  const name = entry.displayName || entry.fileName;
  if (entry.icon && !broken) {
    return (
      <img
        className="mod-icon"
        src={entry.icon}
        alt=""
        // 加载失败就退回首字母块（内嵌 base64 理论上不会失败，但别显示破图）
        onError={() => setBroken(true)}
      />
    );
  }
  const letter = firstLetter(name);
  return (
    <span className="mod-icon placeholder" data-tone={toneOf(name)} aria-hidden="true">
      {letter}
    </span>
  );
}

/** 首字母：跳过开头的非字母数字（有些文件名以 `.` 或 `[` 开头） */
function firstLetter(name: string): string {
  for (const ch of name) {
    if (/[A-Za-z0-9\u4e00-\u9fa5]/.test(ch)) return ch.toUpperCase();
  }
  return '?';
}

/** 名字 → 0..5 的色调档（稳定：同一个名字永远同一档） */
function toneOf(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) % 997;
  }
  return String(h % 6);
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

