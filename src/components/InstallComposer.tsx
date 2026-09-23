/**
 * 组合安装器 —— 「选版本」与「选加载器」在**同一个页面**里完成
 * ------------------------------------------------------------------
 * 为什么必须是一页而不是两个页签：
 *   玩家的脑子里想的是「我要玩 1.20.1 的 Forge」，不是「我要走哪条操作模型」。
 *   拆成「游戏版本」「加载器」两个页签后，加载器页签根本不知道要装到哪个版本上，
 *   只能让用户手打版本号（旧实现就是这样，这是设计退步）。
 *
 * 三件事在这一页里同时成立：
 *   ① 左栏是**真实**版本清单（Mojang / BMCLAPI manifest，900+ 个）
 *   ② 右栏是三层加载器模型（基础加载器单选 / 附加组件多选 / API 包只读）
 *   ③ 底部常驻摘要 + 一个按钮，一步装好「版本 + 加载器」
 *
 * ★ 铁律：本文件**一行校验规则都不写**。
 *   加载器能不能用、附加组件冲突不冲突、要不要桥接包、自动补哪个 API 包，
 *   全部来自 `domain/loader-caps.ts` 与 `domain/combination.ts`。
 *
 * ★ 加载器可用性以**在线清单**为准，静态表只作离线兜底：
 *   静态表只有 10 个版本，而真实清单有 900+ 个。若不在线查，
 *   1.21.4 会被判成「只有 Fabric」——那是**错误的禁用**，用户会以为启动器不支持。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, CustomSelect, Note, SearchBox, Segmented, Skeleton, Spinner } from '../ui';
import { defaultInstanceName } from '../state/instance-name';
import { useApp } from '../state/AppContext';
import { IconAlert, IconCheck, IconChevronDown, IconChevronRight, IconInfo, IconPlus, IconRefresh } from '../ui/Icons';
import {
  BASE_LOADER_NAME,
  ADDON_DESC,
  autoMemory,
  formatBytes,
  formatDuration,
  getLoaderCapabilities,
  getProfile,
  isAprilFoolsVersion,
  isSnapshotVersion,
  knownVersions,
  resolveJavaRequirement,
  validateCombination,
  // ★ 单个附加组件的兼容性判据（与 validateCombination 同一套规则，见它上面的注释）
  addonCompatibility,
} from '../domain';
import type {
  AddonKind,
  BaseLoaderKind,
  Instance,
  LoaderSelection,
} from '../domain';
import { useRealApi } from '../hooks/useRealApi';
// ★ Java 要求：`declaredJava` 是后端取回来的「Mojang 声明的版本」
import { useDeclaredJava } from '../hooks/useJavaRequirement.ts';
// ★ 字段映射只有一份（`toEngineInput`），带上加载器版本 —— 见它的说明
import { toEngineInput } from '../domain/java-requirement.ts';
// ★ C-26：取消不是故障 —— 判据只有一处（见 `domain/cancel.ts` 的说明）
import { isCancellation } from '../domain/cancel.ts';
import type { ManifestRow, OptifineVersion } from '../bridge/tauri';
import {
  loaderCatalog,
  type VersionLoaderRecord,
} from '../domain/loader-catalog.ts';
import { installGame } from '../flows/install';
// ★ 版本图标与世代分组（自绘方块，不复制任何官方美术资源）
import { VersionIcon, groupByFamily } from './VersionIcon';

/** 加载器可用性的在线数据：kind → 真实可选版本（空数组 = 在线确认没有） */
export type OnlineBases = Partial<Record<BaseLoaderKind, string[]>>;

/**
 * 加载器清单的进程内缓存 —— 键是 **MC 版本 + 下载源**。
 *
 * ★ 为什么必须带下载源：`fetch_loaders` 会按源走不同的后端（BMCLAPI / 官方），
 *   只按版本号缓存会让"换了源但还在用旧源的清单"，两个源的清单可能不同。
 *
 * ★ 为什么只缓存**成功**的结果：失败的查询如果也被缓存住，
 *   用户会在接下来的一整段时间里一直看到"没有这个加载器"——
 *   而那只是**这一次**没查到。失败必须允许重试。
 */
const baseVersionCache = new Map<string, OnlineBases>();

/** 所有会被这套缓存影响的加载器种类 */
const BASE_KINDS: BaseLoaderKind[] = ['forge', 'neoforge', 'fabric', 'quilt'];

/**
 * 一个加载器种类的查询状态。
 *
 * ★ 三种状态必须分开，这是本文件最核心的修正：
 *     loading     —— 正在查
 *     ok          —— 查到了，`versions` 为空表示**确认**这个版本没有它
 *     error       —— **没查到**（网络/镜像问题），绝不等于"没有"
 *
 *   修正前的写法只有"有没有数据"两种，于是"查询失败"和"确认没有"都是空数组，
 *   界面把 Forge 置灰并写"没有 Forge 版本" —— 而 Forge 其实有最新版。
 *   用户看到的不是"查询失败"，是**启动器在说谎**。
 */
type LoaderQuery<T = string> =
  | { status: 'loading' }
  | { status: 'ok'; versions: T[] }
  | { status: 'error'; message: string };

type LoaderQueryMap = Record<BaseLoaderKind, LoaderQuery>;

function emptyQueryMap(): LoaderQueryMap {
  return {
    forge: { status: 'loading' },
    neoforge: { status: 'loading' },
    fabric: { status: 'loading' },
    quilt: { status: 'loading' },
  };
}

/** 查询状态 → 能力表用的在线数据（只有 ok 的才算"确认"，error 一律不下结论） */
function toOnlineBases(map: LoaderQueryMap): OnlineBases | undefined {
  const bases: OnlineBases = {};
  for (const k of BASE_KINDS) {
    const q = map[k];
    if (q.status === 'ok') bases[k] = q.versions;
  }
  return Object.keys(bases).length > 0 ? bases : undefined;
}

/** 缓存命中时把 OnlineBases 还原成查询状态（缓存里只有成功的结果） */
function fromOnlineBases(bases: OnlineBases): LoaderQueryMap {
  const m = emptyQueryMap();
  for (const k of BASE_KINDS) {
    const v = bases[k];
    m[k] = v ? { status: 'ok', versions: v } : { status: 'error', message: '缓存里没有这一项' };
  }
  return m;
}

/** 版本从「先看这些」开始 —— 都是模组生态最厚的版本，省得用户在 900 个版本里翻 */
const POPULAR_VERSIONS = ['1.21.1', '1.20.1', '1.19.2', '1.18.2', '1.16.5', '1.12.2'];

type Channel = 'release' | 'snapshot' | 'all' | 'fools';

/**
 * **最终发布版**的版本号形状：只有 `x.y` / `x.y.z` 两种。
 *
 * ★★ 2026-09-15（用户第二次报"正式版里还有 rc/pre"，并说"学学 PCL 怎么做的"）：
 *   真机实测确认**上游数据是对的** —— 用 CDP 直接调 `fetch_version_manifest` 读原始行，
 *   `26.2-rc-2` 就是 `release_type: "snapshot"`。可界面上「正式版」那一档照样出现 rc/pre。
 *   这说明**只看 `release_type` 不够**：数据链路上任何一处把它丢了或默认成 release
 *   （缓存、老版本写下的清单、以后新增的某个来源），筛选就会失效，而且**一点提示都没有**。
 *
 *   所以判据改成**两个条件都满足才算正式版**：
 *     ① 上游 `type === "release"`；
 *     ② 版本号**长得像**最终版（这条正则）。
 *   ② 是纯本地兜底：`26.2-rc-2` / `26.2-pre-6` / `24w14a` 永远过不了。
 *   两个都成立才放行 —— 上游字段再出任何问题，预发布版都不会混进正式版。
 *   （PCL 判断版本类型时也是同时看清单的 type 和版本号本身。）
 */
const FINAL_RELEASE_RE = /^\d+\.\d+(\.\d+)?$/;

export interface InstallComposerProps {
  /** page = 整页（下载页）；modal = 创建版本弹窗内部 */
  variant?: 'page' | 'modal';
  /** 预选版本（从别处带过来的） */
  initialVersion?: string;
  /** 安装成功并建好实例后回调 */
  onInstalled?: (inst: Instance) => void;
  /** 取消（modal 用） */
  onCancel?: () => void;
  /**
   * ★★ 2026-09-23 晚：整页形态**换屏**时通知外层。
   *
   *   `true` = 正在「模组加载器」那一屏（它是**自己的一页**，要整屏显示），
   *   外层（下载页）据此把**页头与页签收起来** ——
   *   与整合包安装页用的是同一套做法（见 ADR-059 那条"整屏"的历史）。
   *
   *   ★ 为什么要通知外层而不是自己开一条路由：安装流程的状态（选中的版本、
   *     加载器、附加组件、名称）都在这个组件里，**换路由会把它整份丢掉** ——
   *     那正是这个仓库反复踩过的"事件/状态在挂载前被丢掉"那一类。
   */
  onStepChange?: (inLoaderPage: boolean) => void;
}

export function InstallComposer({
  variant = 'page',
  initialVersion,
  onInstalled,
  onCancel,
  onStepChange,
}: InstallComposerProps) {
  const { state, createInstance, toast } = useApp();
  const { api } = useRealApi();

  /* ====================== 版本清单 ====================== */
  const [rows, setRows] = useState<ManifestRow[]>([]);
  const [latest, setLatest] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);
  /*
   * ★★ 2026-09-23：下载源**不再是用户的选择**（用户："下载页的这个才是要删的"）——
   *   固定「自动」：官方优先、慢或失败自动换镜像（见 Rust `parse_source`）。
   *   这里保留常量而不是删掉变量：下面几处调用（取清单 / 取加载器版本）都要显式传它，
   *   传一个具名常量比到处写字符串更不容易写错。
   */
  const source = 'auto' as const;
  const [channel, setChannel] = useState<Channel>('release');
  /**
   * 世代分组的折叠状态（用户建议："做一个版本折叠功能"）。
   *
   * ★ 只记**用户手动点过的**那些组：没点过的按规则算
   *   （含当前选中版本 → 展开；搜索中 → 全展开；其余 → 收起）。
   *   这样"默认收起"既能随选中版本走动，又不会在清单刷新后把用户的展开状态冲掉。
   */
  const [foldOverride, setFoldOverride] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');

  const loadManifest = useCallback(async () => {
    if (!api) {
      /* 浏览器演示模式：没有真实清单，退回内置版本子集。
         这样这一页在浏览器里也能看、能点、能试组合，而不是一片空白 ——
         但**必须说出来**这是子集，不能让人以为真实清单只有 10 个版本。 */
      const list = knownVersions();
      setRows(
        list.map((id) => ({
          id,
          release_type: isSnapshotVersion(id) ? 'snapshot' : 'release',
          released_at: '',
          installed: false,
        })),
      );
      setLatest(list.find((v) => !isSnapshotVersion(v)) ?? list[0] ?? null);
      return;
    }
    setManifestLoading(true);
    setManifestError(null);
    try {
      const m = await api.metadata.manifest(source);
      setRows(m.versions);
      setLatest(m.latest_release);
    } catch (e) {
      setManifestError(e instanceof Error ? e.message : String(e));
    } finally {
      setManifestLoading(false);
    }
  }, [api, source]);

  useEffect(() => {
    void loadManifest();
  }, [loadManifest]);

  /* ====================== 选中的版本与组合 ====================== */
  const [mcVersion, setMcVersion] = useState(initialVersion ?? '');
  const [base, setBase] = useState<BaseLoaderKind | null>(null);
  const [baseVersion, setBaseVersion] = useState('');
  const [addons, setAddons] = useState<AddonKind[]>([]);
  /**
   * 附加组件的**版本选择**（目前只有 OptiFine 用得上）。
   *
   * ★ 以前这里没有这个东西：OptiFine 既没有在线清单、也没有版本选择，
   *   用户只能接受静态表里手抄的那一个版本号。现在选中的版本会真的
   *   传给安装流程（见 handleInstall 里的 addonVersions）。
   */
  const [addonVersions, setAddonVersions] = useState<Partial<Record<AddonKind, string>>>({});
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [installing, setInstalling] = useState(false);

  /* 清单到位后没有选中版本时，默认挑最新正式版 */
  useEffect(() => {
    if (mcVersion) return;
    if (initialVersion) {
      setMcVersion(initialVersion);
      return;
    }
    if (latest) setMcVersion(latest);
    else if (rows[0]) setMcVersion(rows[0].id);
  }, [mcVersion, latest, rows, initialVersion]);

  /* ====================== 在线加载器清单 ====================== */
  const [queries, setQueries] = useState<LoaderQueryMap>(emptyQueryMap);
  const [loadersLoading, setLoadersLoading] = useState(false);

  /**
   * 在线查到的 OptiFine 版本清单（**带文件名与 Forge 兼容要求**）。
   *
   * ★ 这是本轮新增的能力：OptiFine 以前**没有任何自动来源**，界面上只能写
   *   "版本清单尚未接入自动查询"，静态表里那几条还是手抄的（而且抄错了 ——
   *   1.21.1 其实有正式版）。现在走 BMCLAPI 的结构化 JSON。
   *
   * `status === 'error'` = 这次没查到（≠ 没有这个版本）；
   * `status === 'ok'` 且列表为空 = 确认真没有（例如 1.20.5）。
   */
  const [optifine, setOptifine] = useState<LoaderQuery<OptifineVersion> | null>(null);
  /** 同一份数据的纯版本号视图（给"有几个版本"这类展示用） */
  const optifineReal = useMemo(
    () => (optifine?.status === 'ok' ? optifine.versions : null),
    [optifine],
  );
  const optifineFirst = optifineReal?.[0];

  /**
   * ★★ 从一个版本记录里推出 OptiFine 的查询状态（**唯一一份判据**）。
   *
   *   抽出来是因为它以前在两条路径上各写了一份，而**缓存命中那条忘了写** ——
   *   那就是用户报的"幽灵 OptiFine"：
   *
   *   复现：装了 OptiFine 的版本 A → 点没有 OptiFine 的版本 B → 再点回 A。
   *   回到 A 时走的是缓存命中分支，它 `setQueries(...)` 之后**直接 return**，
   *   一句都没提 `setOptifine`，于是 `optifine` 还是**B 的那一份**
   *   （`{status:'error'}` 或空列表）。界面上 A 的 OptiFine 开关就变成
   *   "有这个名字、但点了没反应/不让选"的样子 —— 用户看到的就是这个。
   *
   *   现在两条路径都调它，缓存命中也会**如实**把状态切过来。
   */
  const optifineStateOf = useCallback(
    (rec: VersionLoaderRecord): LoaderQuery<OptifineVersion> => {
      const ofVersions = (rec.addons?.['optifine'] ?? null) as OptifineVersion[] | null;
      /*
       * ★ 判据是"**这一项在 records 里有没有**"，不是"数组长度"。
       *   长度 0 是**有效结论**（OptiFine 确实没发布这个 MC 版本，比如 1.20.5），
       *   拿不到这一项才是"这次没查到"。两者在界面上必须长得不一样。
       */
      const known = rec.bases['optifine'] !== undefined || ofVersions !== null;
      if (!known) {
        return { status: 'error', message: rec.errors['optifine'] ?? '这次没查到（可以重试）' };
      }
      return { status: 'ok', versions: ofVersions ?? [] };
    },
    [],
  );

  /**
   * 每次查询发一个自增号，只有**最新那次**的结果会被采纳。
   *
   * ★ 没有它会出真实事故：快速连点两个版本时，先发的那次请求后回来，
   *   会把旧版本的结论写到新版本头上 —— 界面上就是"点了 A 之后 B 说没装"。
   *   用户报的「点击一个没有 Forge 的版本，会导致有 Forge 的版本说没有 Forge」
   *   正是这类串台。
   */
  const querySeq = useRef(0);

  const loadLoaderQueries = useCallback(
    async (mcVersion: string, force: boolean) => {
      if (!api || !mcVersion) return;
      const cacheKey = `${source}:${mcVersion}`;
      const cached = baseVersionCache.get(cacheKey);
      if (cached && !force) {
        /*
         * ★★ 缓存命中也要**把 OptiFine 的状态一起切过来**。
         *
         *   这里以前只有两行（setQueries + setLoadersLoading(false)）就 return，
         *   `optifine` 留着上一个版本的值 —— 用户报的"切回去就显示有高清修复、
         *   实际上不让选"就是这么来的。
         *
         *   缓存里存的是 `OnlineBases`（只有 base 加载器的版本号数组），
         *   没有 OptiFine 的完整信息，所以这里**主动去目录里取一次**
         *   （`loaderCatalog.get` 是纯内存查表，不联网）；
         *   目录里也没有就如实说"正在查"，交给下面的真查询填。
         */
        setQueries(fromOnlineBases(cached));
        const rec = loaderCatalog.get(mcVersion);
        if (rec) {
          setOptifine(optifineStateOf(rec));
          setLoadersLoading(false);
          return;
        }
        // 目录里没有这一条 → 这一版不能用旧结论充数，重新查
      }

      const seq = ++querySeq.current;
      setLoadersLoading(true);
      // ★ 立刻把界面切到"正在查"，**不留上一版版本的数据**：
      //   留着旧数据会让新版本短暂显示旧版本的结论，那是最容易骗到人的一瞬。
      setQueries(emptyQueryMap());
      setOptifine({ status: 'loading' });

      /*
       * ★ 一次 IPC 拿五种来源（后端 **并行** 拉）。
       *   以前是前端并发 4 次 IPC，而且 OptiFine 根本没人问 ——
       *   实测串行合计约 18 秒，并行后由最慢的一个决定（本机 5.9 秒）。
       */
      /*
       * ★★ 走**加载器目录**（`domain/loader-catalog.ts`）★★
       *
       *   目录里只装**真实查到的结果**，按 MC 版本缓存 1 小时；后台还会按优先级
       *   把其它版本也查回来（见下面的预热 effect）。这样：
       *     · 命中目录 → **即时**出结果，不用等那 5.9 秒
       *     · 没命中   → 真去查，结果同时进目录（下次/别处直接用）
       *     · 查不到   → 目录里**不留条目**，界面如实说"没查到"，
       *                  绝不退回内置表去猜（内置表连 26.2 都没有）
       */
      let rec: VersionLoaderRecord;
      try {
        rec = await loaderCatalog.ensure(mcVersion, (mc) =>
          api.metadata.availableLoaders(mc, source),
        );
      } catch (e) {
        if (seq !== querySeq.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        // 整体失败 → 每一项都如实报"没查到"，**绝不**说成"没有"
        const all = emptyQueryMap();
        for (const k of BASE_KINDS) all[k] = { status: 'error', message: msg };
        setQueries(all);
        setOptifine({ status: 'error', message: msg });
        setLoadersLoading(false);
        return;
      }

      // 迟到的结果直接丢掉（用户已经切到别的版本了）
      if (seq !== querySeq.current) return;

      const next = emptyQueryMap();
      const okBases: OnlineBases = {};
      for (const k of BASE_KINDS) {
        const versions = rec.bases[k];
        if (versions) {
          next[k] = { status: 'ok', versions };
          okBases[k] = versions;
        } else {
          // 目录里没有这一项 = 这个加载器**这次没查到**（不是"没有"）
          next[k] = {
            status: 'error',
            message: rec.errors[k] ?? '这次没查到（可以重试）',
          };
        }
      }
      setQueries(next);

      // ★ 与缓存命中那条路径用**同一个**判据（以前这里是第二份实现，
      //   而缓存那条根本没有 —— 幽灵 OptiFine 就是这么来的）
      setOptifine(optifineStateOf(rec));

      setLoadersLoading(false);
      // 只缓存成功的那部分（失败的允许下次重试）
      if (Object.keys(okBases).length > 0) baseVersionCache.set(cacheKey, okBases);
    },
    [api, source, optifineStateOf],
  );

  /* ★ 切版本 / 切源 → **立刻**清空并重新查，不留任何旧结论 */
  useEffect(() => {
    if (!api || !mcVersion) return;
    void loadLoaderQueries(mcVersion, false);
  }, [api, mcVersion, loadLoaderQueries]);

  /* ====================== 后台把真实清单拉回来（"所有版本"的落点） ====================== */
  /**
   * ★ 这是本文件里最接近用户要求的那段代码：
   *   「所有 MC 版本都要检测，能装就是能装，不能装就是不能装」。
   *
   * 900+ 个版本 × 5 个接口不可能一次全查，所以按**用户真正会碰到的顺序**预热：
   *   ① 已装版本（`state.instances`）—— 最可能马上要用
   *   ② 列表里排在前面 / 搜到的版本 —— 用户正在看
   *   ③ 常用版本（POPULAR_VERSIONS）
   *   ④ 其余按清单顺序（900 个也不怕，慢慢来，并发 3）
   *
   * 结果全部进 `loaderCatalog`（内存 + localStorage 持久化，1 小时新鲜期），
   * 所以点开任何一个**已经预热过**的版本都是即时的。
   *
   * 预热只做一次（`primedRef`），失败的那条留在"没查到"，用户点开时自然重试。
   */
  const primedRef = useRef(false);
  useEffect(() => {
    if (!api || primedRef.current) return;
    if (rows.length === 0) return; // 等清单到位，否则不知道有哪些版本
    primedRef.current = true;

    loaderCatalog.dropStale();

    // ① 已装版本最优先
    const installedVersions = state.instances.map((i) => i.mcVersion);
    // ② 常用版本
    // ③ 其余按清单顺序（新版本在前）
    const ordered = [
      ...installedVersions,
      ...POPULAR_VERSIONS,
      ...rows.map((r) => r.id),
    ];
    // 去重，保持优先级顺序
    const seen = new Set<string>();
    const queue = ordered.filter((v) => (v && !seen.has(v) ? (seen.add(v), true) : false));

    let alive = true;
    void loaderCatalog
      .prime(
        queue,
        (mc) => api.metadata.availableLoaders(mc, source),
        {
          concurrency: 3,
          // 一次会话最多预热这么多（够覆盖常见几十个版本；剩下的点开时现查）
          limit: 120,
          shouldStop: () => !alive,
        },
      )
      .then((done) => {
        if (alive && done > 0) {
          console.info(`[IEML] 后台预热了 ${done} 个 MC 版本的加载器清单`);
        }
      })
      .catch(() => {
        /* 预热失败无所谓 —— 点开时还会再查 */
      });

    return () => {
      alive = false;
    };
  }, [api, rows, state.instances, source]);

  /* 目录更新（含后台预热完成）→ 刷新当前版本的结论 */
  useEffect(() => {
    return loaderCatalog.subscribe(() => {
      if (!mcVersion) return;
      const rec = loaderCatalog.get(mcVersion);
      if (!rec || !loaderCatalog.isFresh(mcVersion)) return;
      // 当前版本刚被后台查到 → 直接更新界面，不用用户再点一次
      setQueries((prev) => {
        if (prev.forge.status !== 'loading' && prev.forge.status !== 'error') return prev;
        const next = emptyQueryMap();
        for (const k of BASE_KINDS) {
          const v = rec.bases[k];
          next[k] = v
            ? { status: 'ok', versions: v }
            : { status: 'error', message: rec.errors[k] ?? '这次没查到' };
        }
        return next;
      });
      const ofV = (rec.addons?.['optifine'] ?? null) as OptifineVersion[] | null;
      setOptifine((prev) =>
        prev?.status === 'ok'
          ? prev
          : ofV && rec.bases['optifine']
            ? { status: 'ok', versions: ofV }
            : prev,
      );
    });
  }, [mcVersion]);

  /*
   * ★★ 「这一页显示盘上装了什么加载器」那条链路**整个删掉了**（用户明确要求：
   *    「下载页的版本的模组加载器已装xxx那个提示不要了」）。
   *
   *    删掉的不只是文案，还有它背后的 `detect_installed_loaders` IPC 调用 ——
   *    留着一段没人显示的代码就是半成品，而且它每次切版本都要读一遍盘。
   *
   *    「盘上有什么、有没有版本在用」现在只在**两个对的地方**说：
   *      · 「版本列表」页 —— 用户管理已有版本的地方；
   *      · 版本清单每一行的副标题（`26.1.2 · 盘上有 Forge 64.1.3
   *        （暂无版本在用）`），选版本时顺带看到。
   */

  /* ====================== 规则（全部来自 domain） ====================== */
  const onlineBases = useMemo(() => toOnlineBases(queries), [queries]);

  /*
   * ★★ 把 OptiFine 的**在线清单**也交给规则层（2026-09-14 第九轮）。
   *
   *   这个开关的"能不能点"本来就是在线的（`ofVersionsKnown`），
   *   而 `validateCombination` 走的是静态表（只有 10 个版本）。
   *   两边不一致的后果实测过：`1.16.1 + Fabric + OptiFine` 开关点得动，
   *   勾上却报"不兼容" —— 因为静态表里没有 1.16.1。
   *
   *   现在同一份在线数据同时喂给能力表和组合校验，判据只剩一个。
   *   注意 `null` 与 `[]` 的区别：查不到（null）→ 不传，走静态兜底；
   *   查到了但是空数组 → 传空数组，那是"上游确实没有"。
   */
  const online = useMemo(() => {
    const addons = optifineReal ? { optifine: optifineReal.map((v) => v.version) } : undefined;
    if (!onlineBases && !addons) return undefined;
    return { ...(onlineBases ? { bases: onlineBases } : {}), ...(addons ? { addons } : {}) };
  }, [onlineBases, optifineReal]);

  const caps = useMemo(
    () => getLoaderCapabilities(mcVersion || '1.20.1', online),
    [mcVersion, online],
  );

  const selection: LoaderSelection = useMemo(
    () => ({
      mcVersion,
      base,
      addons,
      ...(baseVersion ? { baseVersion } : {}),
    }),
    [mcVersion, base, addons, baseVersion],
  );

  const verdict = useMemo(
    () => validateCombination(selection, online),
    [selection, online],
  );

  /**
   * 基础加载器**确认**不可用 → 退回原版并说明。
   *
   * ★ 只在"确认"时动手（`query.status === 'ok'` 且列表为空）。
   *   老实现是"能力表里 available === false 就退回"，而能力表在**查询失败**时
   *   会退回静态表 —— 静态表只有 10 个版本，于是查 1.21.4 的 Forge 只要网络
   *   抖一下，界面就会弹出"已切换为原版 · Forge 没有 1.21.4 的版本"，
   *   而 Forge 其实有。这条误报比不提示危险得多。
   */
  useEffect(() => {
    if (base === null) return;
    const q = queries[base];
    if (q.status !== 'ok') return; // 正在查 / 没查到 → 什么都不做
    if (q.versions.length > 0) return; // 确认有 → 什么都不做
    setBase(null);
    setBaseVersion('');
    setAddons([]);
    toast('warning', '已切换为原版', `${BASE_LOADER_NAME[base]} 没有 ${mcVersion} 的版本`);
  }, [queries, base, mcVersion, toast]);

  /*
   * ★★ **不要"自动把不兼容的附加组件移出"。**
   *
   *   这里原来有一个 `useEffect`，一发现 `verdict.removed` 非空就
   *   `setAddons(prev => prev.filter(...))` —— 用户勾了高清修复，
   *   它**悄悄**把勾去掉了，界面上只剩一句原因，看起来像"已经帮你处理好了"。
   *
   *   用户的要求恰恰相反：「当我们选择 Fabic 时如果有版本的 Fabic 与高清修复
   *   不兼容，**应提示玩家不兼容**」。
   *   更基本的一条：**勾了就得装上**。装不上是阻断性错误，
   *   去掉那个勾必须由用户自己决定，不能替他决定。
   *
   *   所以现在：`validateCombination` 会把不兼容的组件同时放进
   *   `removed`（用于在选项上标红说明）和 `errors`（→ `valid=false`，
   *   安装按钮被拦住 + 顶部红条列出原因）。用户取消勾选就能继续。
   */

  /*
   * ★★ **选择变了之后，把因此变得不兼容的附加组件去掉，并**说出来**
   *   （2026-09-15，用户报："这怎么警告不让装了之后又不让点，不应该是直接不让点吗"）。
   *
   *   死局是怎么形成的（截图里那一屏）：
   *     OptiFine 是**之前**选的（那时加载器还兼容）→ 用户把基础加载器改成
   *     Fabric 1.21.11 → 它变成"不兼容" → 按上面那条规矩，不兼容的选项**被禁用**
   *     （不让选）—— 可是它**已经被选中了**，于是：
   *       · 用户点不掉它（禁用）；
   *       · 安装按钮又因为组合非法被拦住。
   *     **卡死，而且界面上没有任何出路。**
   *
   *   上面那条"不自动移除"的规矩针对的是**悄悄移除**（用户原话是"应提示玩家不兼容"）。
   *   所以这里两者都做：**移除 + 明确告知**（弹一条"已取消 高清修复 —— 原因"），
   *   并且让"已选中但不兼容"的选项**永远可以取消勾选**（见选项按钮的 `disabled` 条件）。
   *
   *   ★ 只在**选择本身变了**（基础加载器 / 版本 / MC 版本）时做这件事：
   *     不跟着 `verdict` 跑 —— 否则用户刚勾上、后台清单才回来把组合判成不兼容，
   *     那一下也会被"自动取消"，又回到"勾了却没了"的老毛病。
   */
  const lastComboRef = useRef('');
  useEffect(() => {
    const key = `${base}|${baseVersion}|${mcVersion}`;
    if (lastComboRef.current === key) return;
    lastComboRef.current = key;

    const killed = verdict.removed.filter((r) => addons.includes(r.kind));
    if (killed.length === 0) return;
    setAddons((prev) => prev.filter((k) => !killed.some((r) => r.kind === k)));
    for (const r of killed) {
      const name = caps.addons.find((a) => a.kind === r.kind)?.name ?? r.kind;
      toast(
        'warning',
        `已取消「${name}」`,
        `${r.reason}\n（换加载器/版本后它不再兼容 —— 想用它请换回兼容的组合）`,
      );
    }
  }, [base, baseVersion, mcVersion, verdict, addons, caps.addons, setAddons, toast]);

  const baseOpts = caps.baseLoaders.find((b) => b.kind === base);
  const availableBaseVersions = baseOpts?.versions ?? [];

  /* 切版本/切加载器后，把加载器版本收敛到一个合法值 */
  useEffect(() => {
    if (!base) {
      setBaseVersion('');
      return;
    }
    if (!availableBaseVersions.includes(baseVersion)) {
      setBaseVersion(availableBaseVersions[0] ?? '');
    }
  }, [base, availableBaseVersions, baseVersion]);

  /* ====================== 摘要 ====================== */
  /**
   * 建议名称 = **版本命名规范**（用户给定）：
   *
   *     {mc_version}-{loader_type}-{loader_version}      例：1.20.1-forge-47.2.0
   *     不装加载器时就是纯 MC 版本号                    例：1.20.1
   *
   * ★ 为什么值得立成规矩：以前叫「Forge 1.20.1」—— 同一个 MC 版本装两个不同的
   *   Forge 构建，两个名字**一模一样**，只能靠 "(2)" 区分；名字里也看不出
   *   加载器版本，而加载器版本恰恰是"这个包能不能跑"的关键。
   *   规范之后：名字本身就是一份可读的清单，鼠标扫一眼就知道装的是什么。
   *
   * ★ 只影响**新建**的版本。已有的不改名 —— 改名会让存档/攻略/群里的说法对不上，
   *   那是用户的东西，不该被一次升级改掉。
   */
  const versionLabel = useMemo(() => {
    if (base === null) return mcVersion;
    const loaderVer = baseVersion || availableBaseVersions[0] || '';
    return loaderVer ? `${mcVersion}-${base}-${loaderVer}` : `${mcVersion}-${base}`;
  }, [base, mcVersion, baseVersion, availableBaseVersions]);

  const suggestedName = useMemo(() => {
    /*
     * ★★ 2026-09-23 用户（截图）：「版本名称」那个输入框里默认写着 `26.3 (2)` ——
     *   那是**内部版本标签**（`26.3-fabric-0.19.5` 之类）去重后的产物：
     *   既看不出是原版还是加载器，也和列表里别处的命名对不上。
     *   现在默认名直接用统一格式：`Minecraft 26.3` / `Minecraft 26.3 + Fabric 0.19.5`。
     *   ★ 重名才加 `(2)` —— 那个后缀在显示时**保留**（否则两个实例会同名）。
     */
    const stem = defaultInstanceName(mcVersion, base ? { kind: base, version: baseVersion || null } : null);
    const taken = new Set(state.instances.map((i) => i.config.name));
    if (!taken.has(stem)) return stem;
    let i = 2;
    while (taken.has(`${stem} (${i})`)) i++;
    return `${stem} (${i})`;
  }, [mcVersion, base, baseVersion, state.instances]);

  useEffect(() => {
    if (!nameTouched) setName(suggestedName);
  }, [suggestedName, nameTouched]);

  const estimate = useMemo(() => {
    const profile = getProfile(mcVersion);
    const vanilla = profile?.vanillaBytes ?? estimateVanillaBytes(mcVersion);
    let extra = 0;
    if (base === 'forge') extra += 120 * 1024 * 1024;
    if (base === 'neoforge') extra += 135 * 1024 * 1024;
    if (base === 'fabric') extra += 12 * 1024 * 1024;
    if (base === 'quilt') extra += 14 * 1024 * 1024;
    for (const a of addons) extra += a === 'optifine' ? 38 * 1024 * 1024 : 6 * 1024 * 1024;
    for (const _b of verdict.autoBridges) extra += 1.2 * 1024 * 1024;
    for (const lib of verdict.autoApis) extra += lib.bytes;
    const total = vanilla + extra;
    // 库与资源高度可复用，只算新增部分
    const cached = Math.round(extra * 0.75) + Math.round(vanilla * 0.9);
    const download = Math.max(0, total - cached);
    return {
      total,
      download,
      cached,
      seconds: Math.max(8, Math.round(download / (12.4 * 1024 * 1024))),
    };
  }, [mcVersion, base, addons, verdict]);

  /*
   * ★★ Java 要求：走唯一入口，并且**带上 Mojang 在版本 JSON 里声明的那个数**。
   *
   *   只按版本号基线算的话，26.2 会得到 21，而它真正需要 25
   *   （版本 JSON 里写着 `"javaVersion": {"majorVersion": 25}`）——
   *   用户看到的 Java 提示就会是错的。
   *
   *   `declaredJava` 由 hook 从后端取（`fetch_version_json` 一直在返回
   *   `java_major`，在此之前全仓库没有任何地方调用过它）。
   */
  const declaredJava = useDeclaredJava(mcVersion);
  const javaReq = useMemo(
    () =>
      resolveJavaRequirement(
        /*
         * ★★ 用**同一个**字段映射函数（`toEngineInput`），并且带上加载器版本
         *   （P0-7）：Forge 的补丁号段、Fabric Loader 的版本都会改变要求，
         *   而这里是"装之前先算一遍"的地方 —— 算错了用户会先装一个
         *   不需要的 Java，或者反过来缺 Java 而装不上。
         */
        toEngineInput(
          {
            mcVersion,
            loaderKind: base,
            loaderVersion: baseVersion,
            modCount: 0,
            hasOptifine: addons.includes('optifine'),
          },
          declaredJava,
        ),
      ),
    [mcVersion, base, baseVersion, addons, declaredJava],
  );

  const hasJava = useMemo(
    () => state.java.runtimes.some((r) => r.major === javaReq.major),
    [state.java.runtimes, javaReq.major],
  );

  /* ====================== 安装 ====================== */
  async function handleInstall() {
    if (!verdict.valid) {
      toast('err', '这个组合装不了', verdict.errors.join('；'));
      return;
    }
    if (!api) {
      toast('warning', '当前是浏览器演示模式', '真实下载需要桌面版：pnpm desktop:dev');
      return;
    }
    if (!hasJava) {
      toast(
        'warning',
        `需要 Java ${javaReq.major}`,
        `${javaReq.reason}。装完游戏版本后可以在设置页一键下载 Java。`,
      );
    }

    setInstalling(true);
    try {
      const outcome = await installGame({
        mcVersion,
        loaderKind: base,
        loaderVersion: base ? baseVersion || availableBaseVersions[0] || null : null,
        source,
        concurrency: state.prefs.concurrentDownloads,
        loaderName: base ? BASE_LOADER_NAME[base] : undefined,
      });
      /*
       * ★★ **暂停不是失败**（P0-3 / ADR-051）。
       *
       *   老代码只有一个 boolean，于是"用户按了暂停"也会走到
       *   `toast('err','安装没完成')` —— 一句红色报错，而任务中心那边
       *   正好好地写着「已暂停」。同一个动作两句话打架。
       *   现在 `installGame` 返回三态，暂停时**什么都不说**（流程内部已经
       *   发过一条"已暂停，可继续"的提示），也不建实例。
       */
      if (outcome === 'paused') return;
      if (outcome !== 'done') {
        toast('err', '安装没完成', '看顶栏任务中心的失败原因，可以重试。');
        return;
      }

      /* ★ 装完才建实例：
         反过来的话，安装失败会在版本列表里留下一个永远起不来的空壳。 */

      /*
       * ★ slug 必须**全局唯一** —— 它是磁盘目录名。
       *
       * 实测踩过：连装两次同一个版本，得到两个实例
       *   name: "Minecraft 26.2" / "Minecraft 26.2 (2)"   ← 显示名区分了
       *   slug: "vanilla-262"    / "vanilla-262"          ← 目录名没区分
       * 两个实例于是共用同一个 `instances/vanilla-262/` ——
       * 共用 game/、natives/、mods/、saves/，互相覆盖。
       * 显示名去重了、目录名没去重，是最容易漏的一种。
       *
       * ★★ 0.1.0-beta.1：目录名跟显示名**用同一套规范**
       *   （`1.20.1-forge-47.2.0`）。以前是 `forge-1201` ——
       *   同一个 MC 版本换一个 Forge 构建，目录名还是一样（照样会撞），
       *   而且看不出加载器版本。现在名字与目录一一对应，
       *   去重只可能发生在"真的同名"上。
       */
      const baseSlug = versionLabel;
      const takenSlugs = new Set(state.instances.map((i) => i.config.slug));
      let slug = baseSlug;
      for (let n = 2; takenSlugs.has(slug); n++) {
        slug = `${baseSlug}-${n}`;
      }

      const inst: Instance = {
        id: `inst-${Date.now().toString(36)}`,
        mcVersion,
        loader:
          base === null
            ? null
            : {
                kind: base,
                version: baseVersion || (availableBaseVersions[0] ?? ''),
                mcVersion,
              },
        addons: addons.map((kind) => {
          const bridge = verdict.autoBridges.find((b) => b.after === kind);
          // ★ 用用户真正选中的版本（OptiFine 现在有版本选择了，不再写死空串）
          const picked = addonVersions[kind] ?? '';
          return bridge
            ? { kind, version: picked, bridge: { kind: bridge.kind, version: 'latest' } }
            : { kind, version: picked };
        }),
        config: {
          name: name || suggestedName,
          slug,
          isolation: 'auto',
          memoryMb: Math.round(
            autoMemory(
              0,
              addons.includes('optifine') ? 'optifine' : 'vanilla',
              state.machine?.totalMemoryGb ?? 16,
              state.machine?.availableMemoryGb ?? 8,
            ).gb * 1024,
          ),
          memorySource: 'auto',
          javaMode: 'auto',
        },
        createdAt: new Date().toISOString(),
        lastPlayedAt: null,
        totalPlaySeconds: 0,
      };
      await createInstance(inst);

      /*
       * ★★ 自动安装 API 前置包（Fabric API / Quilted Fabric API）★★
       *
       *   界面上一直写着「将自动安装 Fabric API」，体积也计入了估算 ——
       *   但**安装流程里从来没有这一步**。后果是最要命的一类：
       *   用户装完 Fabric、把 Mod 丢进 mods，启动就崩，日志只有
       *   `requires fabric-api`。
       *
       *   现在真装了：版本号**动态查 Modrinth**（不硬编码 —— Fabric API 的
       *   版本号与 MC 版本强绑定，抄一个值换个版本就失效）。
       *
       *   ★ 这一步失败**不算安装失败**：游戏本体和加载器已经装好了，
       *     只是少了前置包 —— 如实告诉用户，让他知道该手动补什么。
       */
      const needApi = verdict.autoApis[0];
      if (needApi && base && (base === 'fabric' || base === 'quilt')) {
        try {
          const r = await api.modrinth.installApiLibrary(slug, mcVersion, base);
          if (r.installed) {
            toast(
              'ok',
              `已装好 ${needApi.name}`,
              `${r.version ?? ''} 已放进 mods 目录 —— 依赖它的 Mod 现在能正常加载了`,
            );
          } else {
            // 没装成也要说清为什么，不能静默
            toast(
              'warning',
              `${needApi.name} 没能自动安装`,
              r.note ?? '去 Modrinth 手动找对应版本放进 mods 目录。',
            );
          }
        } catch (e) {
          toast(
            'warning',
            `${needApi.name} 自动安装失败`,
            `${e instanceof Error ? e.message : String(e)}。不影响游戏本体 —— 可以稍后在 Mod 管理页手动添加。`,
          );
        }
      }

      /*
       * ★★ 自动安装附加组件（OptiFine / LiteLoader）★★
       *
       *   界面上一直写着「会装 OptiFine」，而上一轮之前**没有任何安装实现** ——
       *   勾上、点安装、报成功，磁盘上什么都没多（用户报的就是这个）。
       *
       *   现在两个都真的实现了，而且都走**专用命令**，不走通用安装流程：
       *     · `install_optifine`   —— 下载安装器 → 读 class 头选 Java →
       *                               跑 OptiFine 的 Patcher → 拷回产物
       *     · `install_liteloader` —— 写带 tweaker 的版本描述 + 下三个 jar
       *
       *   为什么放在基础版本装完之后：两者都是挂在**原版**之上的
       *   （OptiFine 要在原版 jar 上打补丁；LiteLoader 用 inheritsFrom），
       *   原版没装好它们没法装。
       *
       *   失败**不算整套安装失败** —— 游戏本体已经装好了，
       *   只是附加组件没上，如实告诉用户即可。
       */
      const addonErrors: string[] = [];

      if (addons.includes('optifine')) {
        const ofVer = addonVersions.optifine ?? optifineReal?.[0]?.version ?? '';
        if (!ofVer) {
          addonErrors.push('OptiFine：没有拿到可用的版本号（清单没查到？可以稍后重试）');
        } else {
          try {
            const r = await api.installer.installOptifine(mcVersion, ofVer);
            toast('ok', 'OptiFine 已装好', r.summary);
          } catch (e) {
            addonErrors.push(`OptiFine：${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      if (addons.includes('liteloader')) {
        try {
          /*
           * ★ `base` 必须传下去 —— 后端靠它把 LiteLoader 的 `inheritsFrom`
           *   指到 **Forge 的版本目录**上。不传（或传错）会装成"挂原版的
           *   LiteLoader"，Forge 的库一个都进不了 classpath：
           *   安装照样"成功"，只在启动时缺库，是最难查的一类。
           */
          const r = await api.installer.installLiteLoader(mcVersion, base);
          toast('ok', 'LiteLoader 已装好', r.summary);
        } catch (e) {
          addonErrors.push(`LiteLoader：${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (addonErrors.length > 0) {
        toast(
          'warning',
          '附加组件没能装全',
          `${addonErrors.join('\n')}\n\n游戏本体已经装好了，可以直接启动 —— ` +
            /*
             * ★★ 2026-09-24（C-19 修复）：这里原来写「可以稍后在「下载」页对这个版本重试」——
             *   **那个入口不存在**（我核对过：附加组件的安装只在 `InstallComposer` 里、
             *   也就是"安装游戏"这一步，实例设置页没有附加组件那一栏）。
             *   现在说的是**真的能走的那条路**：再走一次「安装游戏」并勾上它 ——
             *   游戏文件是共享的，不会重复下载。
             */
            `附加组件这次没装上。想再试一次：回「下载」页重新走一遍「安装游戏」并勾上它 ` +
            `（游戏文件是共享的，不会重复下载）。`,
        );
      }

      toast(
        'ok',
        '装好了',
        `${inst.config.name} 已经可以启动${hasJava ? '' : ` —— 记得先装 Java ${javaReq.major}`}`,
      );

      /*
       * ★ 装完**立刻重读盘**，让版本清单每一行的"已装 Forge xx"马上更新。
       *   这是"实时监测"的最后一环：界面上的事实必须紧跟磁盘，
       *   而不是等用户下次进这一页才变。
       */
      await loadManifest();

      onInstalled?.(inst);
    } catch (e) {
      /* ★★ C-26：用户自己取消 → 说"已取消"，不报成红色「安装失败」（判据在 domain/cancel.ts） */
      const why = e instanceof Error ? e.message : String(e);
      if (isCancellation(why)) {
        toast('info', '已取消安装', '已经下载的文件保留着，下次会从断点继续。');
      } else {
        toast('err', '安装失败', why);
      }
    } finally {
      setInstalling(false);
    }
  }

  /* ====================== 过滤后的版本列表 ====================== */
  /** 搜索中：全部展开（搜了却看不到结果是最气人的） */
  const searching = query.trim().length > 0;
  const filtered = useMemo(() => {
    const q = query.trim();
    return rows.filter((r) => {
      if (q && !r.id.toLowerCase().includes(q.toLowerCase())) return false;
      const finalRelease = r.release_type === 'release' && FINAL_RELEASE_RE.test(r.id);
      if (channel === 'release') return finalRelease;
      /*
       * ★★ 2026-09-23（用户第 6 条：愚人节单独一档）。
       *   ★ 顺序很重要：愚人节版本**也**是快照（`24w14potato` 不是正式版），
       *     所以它必须在 `snapshot` 这一档**之前**判 ——
       *   否则"快照"里会混着愚人节版本，而"愚人节"永远轮不到。
       */
      if (channel === 'fools') return isAprilFoolsVersion(r.id);
      if (channel === 'snapshot') return !finalRelease && !isAprilFoolsVersion(r.id);
      return true;
    });
  }, [rows, query, channel]);

  const baseOptions: Array<{ value: '' | BaseLoaderKind; label: string }> = [
    { value: '', label: '无 · 纯原版' },
    ...caps.baseLoaders.map((b) => ({ value: b.kind, label: b.name })),
  ];

  /** 没查到清单的加载器（**不等于**这个版本没有它） */
  const failedKinds = BASE_KINDS.filter((k) => queries[k].status === 'error');
  /** 正查不到的加载器里，第一个的错误原因（给用户看具体是什么错） */
  const firstError = BASE_KINDS.map((k) => queries[k]).find(
    (q): q is { status: 'error'; message: string } => q.status === 'error',
  );

  /**
   * ★★ 2026-09-23（用户第 4 条）：整页形态的**两步向导**当前在哪一步。
   *
   *   `'version'`（默认）→ 选游戏版本；`'loader'` → 选模组加载器。
   *
   * ★ 为什么不是"两个页签"：页签是**并列**的关系，而这两步是**先后**关系
   *   （先有版本，才知道有哪些加载器可用）。
   * ★ 弹窗形态（`variant === 'modal'`）不看这个值：弹窗里一屏选完，
   *   没有"下一页"可翻（modal 分支在下面直接 return）。
   * ★★ 2026-09-23 晚：换屏要**通知外层**（`onStepChange`）——
   *   第 2 屏是"模组加载器自己的一页"，下载页的页头与页签在那时要收起来。
   */
  const [step, setStep] = useState<'version' | 'loader'>('version');
  useEffect(() => {
    onStepChange?.(step === 'loader');
  }, [step, onStepChange]);
  /* 组件卸载（换页签/离开下载页）时也要把外层那个标记复位，否则回来只剩一屏 */
  useEffect(() => () => onStepChange?.(false), [onStepChange]);

  /* ====================== 渲染 ======================
   *
   * ★★ 2026-09-23（用户第 4 条）：「安装游戏我也要单开一页，以解放视觉繁乱……
   *   默认页面：游戏版本选择。单开一页选择模组加载器」。
   * ★★ 2026-09-23 晚（用户）：「**像 mod 一样点击那行比较不错，然后给模组加载器
   *   像 mod 页那样单开一页**」——第 2 屏真的成了**整屏的一页**（见下面那段注释）。
   *
   *   于是**同一份逻辑**现在有两种排布：
   *     · `modal` —— 「创建版本」弹窗，仍然左右两栏（弹窗里没有"下一页"，一屏选完最省事）；
   *     · `page`  —— 「安装游戏」：**一列版本清单** → 点一行 → **模组加载器整屏页**。
   *   零件（版本清单 / 加载器 / 名称 / 校验结论 / 底部按钮）在下面各写**一次**，
   *   两种排布只是把它们摆进不同的容器 —— 规则、文案、判据都不会漂移。
   */
  /**
   * 版本清单里的**一行** —— 只有这一份实现。
   *
   * ★★ 2026-09-23 晚（用户）：「**愚人节那一档的分类莫名其妙**」——
   *   那一档整档本来就是同一类东西，再按"世代"切就会切出
   *   「其他 / 愚人节 / 快照」这种说不通的标题（根因见 `VersionIcon.versionFamily`：
   *   愚人节的白名单曾经抄了两份、还排在快照规则后面）。
   *   现在愚人节那一档**平铺**显示、组标题一概不出现；
   *   而"行长什么样"仍然只有这一处，两种排布不会漂移。
   */
  const versionRow = (v: ManifestRow) => (
    <button
      key={v.id}
      type="button"
      role="option"
      aria-selected={v.id === mcVersion}
      className={`wz-item${v.id === mcVersion ? ' on' : ''}`}
      onClick={() => {
        setMcVersion(v.id);
        // ★ 切版本必须同时清掉加载器选择：留着上一个版本选好的 Forge
        //   会让"这个版本没有 Forge"和"已经选了 Forge"同时成立，
        //   界面自相矛盾（用户报的串台 bug 就是从这来的）。
        setBase(null);
        setBaseVersion('');
        setAddons([]);
        /*
         * ★★ 2026-09-23 晚（用户）：「**像 mod 一样点击那行比较不错**」——
         *   **点一行就进下一页**（Mod 页是"点一行就开始装"，同一个手感），
         *   不再需要"先选中、再点下一步"两下。
         * ★ 只有整页形态这样走：弹窗里没有"下一页"，点了就是选中
         *   （见上面 `variant === 'modal'` 那条分支）。
         */
        if (variant === 'page') setStep('loader');
      }}
    >
      <VersionIcon version={v.id} size={30} />
      <span className="wz-item-body">
        <span className="wz-item-name mono">{v.id}</span>
        <span className="wz-item-sub">
          {v.released_at ? v.released_at.slice(0, 10) : ''}
          {/*
            ★★ **"盘上有"与"有版本在用"必须分开说**（用户报的 bug）。

            原话：「版本列表删除有模组加载器的版本之后，下载列表的
            对应版本有模组加载器的版本，**还显示已装**」。

            因为两张表读的是两个不同的东西：版本列表读
            `instances.json`，这一页直接扫 `shared/versions/`。
            删实例只删 `instances/{slug}/`，**共享的游戏文件**
            （`shared/versions/`、`libraries/`）故意留着 ——
            别的实例可能还在用。于是这里照旧扫到那个加载器目录。

            两句话都对，但只写"已装"就是在骗人：
            它让人以为那个版本能用，而其实没有任何版本在用它。

            现在分三种写法：
              · 有实例在用          → 「已装 Forge 47.4.23」
              · 盘上有、没实例在用   → 「盘上有 Forge 47.4.23（暂无版本在用）」
              · 都没有              → 什么都不写
          */}
          {v.loaders && v.loaders.length > 0
            ? ` · ${
                v.in_use === false ? '盘上有 ' : '已装 '
              }` +
              v.loaders
                .map((l) => (l.version ? `${l.name} ${l.version}` : l.name))
                .join(' + ') +
              (v.in_use === false ? '（暂无版本在用）' : '')
            : v.installed
              ? v.in_use === false
                ? ' · 盘上有原版（暂无版本在用）'
                : ' · 已装原版'
              : ''}
        </span>
      </span>
      {latest === v.id ? <Chip tone="success">最新</Chip> : null}
    </button>
  );

  /** ① 版本清单的正文（演示模式提示 + 搜索与筛选 + 分组列表） */
  const versionPaneBody = (
    <>
      {!api ? (
        <div className="cw-left-tip">
          <IconAlert /> 演示模式只有内置 {rows.length} 个版本，桌面版拉 900+ 个
        </div>
      ) : null}

      <div className="cw-left-tools">
        <SearchBox
          label="搜索游戏版本"
          placeholder="搜索版本号，如 1.20.1"
          value={query}
          onChange={setQuery}
        />
        <div className="row row-wrap" style={{ gap: 'var(--space-2)' }}>
          <Segmented
            label="渠道"
            size="sm"
            value={channel}
            onChange={setChannel}
            options={[
              { value: 'release', label: '正式版' },
              { value: 'snapshot', label: '快照' },
              // ★★ 2026-09-23（用户第 6 条）：愚人节单独一档
              { value: 'fools', label: '愚人节' },
              { value: 'all', label: '全部' },
            ]}
          />
        </div>
        {/*
          ★★ 2026-09-23 用户：「**下载页的这个（图五），才是把这个选择源的按钮删了**」
            —— 上一轮我理解反了：把设置页那个选择器删了、把这个留下了。
            这里不再给选择：源由后端自动决定（官方优先、慢或失败换镜像，见 Rust parse_source）。
        */}
        {/*
          ★★ 2026-09-23 晚：**把"点一行会发生什么"说出来**。
            这一步的交互是"点一行就进下一页"，而页面上没有任何按钮提示这件事
            （下一步那个按钮连同右栏一起删了）。一句话比一条步骤条省地方，
            也正是它替代了原来那条步骤条的位置。
        */}
        {variant === 'page' ? (
          <p className="gw-tip">
            点一行就进下一页（选模组加载器）—— 不选加载器就是纯原版
          </p>
        ) : null}
      </div>

      {/*
        ★★ 2026-09-23 用户（图五）：「**推荐版本也删掉**」——
          这里原来有一排"常用版本" chips（1.21.1 / 1.20.1 / …），
          它其实就是在替用户推荐版本。删掉。
          版本照样能选：左边那份**完整清单**（900+ 个，带搜索与正式/快照分档）才是入口。
        ★ 注意 `POPULAR_VERSIONS` 这个常量在下面 `rows` 的排序里还用到，所以别删常量。
      */}

      {/*
        ★★ `key={channel|query}`：**换筛选时整列表重建**（2026-09-15，用户复现出来的）。

        现象（真机复现，读 DOM）：点「快照」→「正式版」之后，分段控件的高亮**跟着走**，
        但列表里**同时留着上一次的分组**（`26.2-rc-2(15 个)` 和 `26.2(1 个)` 并列），
        再点「全部」/「正式版」/「快照」就**再也不变了**。

        根因：分组用的 key 是 `g.fam.key` —— **世代键**。而 `26.2-rc-2` 与 `26.2`
        的世代键**是同一个**（都是 `26.2`），于是两次渲染的分组 key 一一相同，
        React 按 key 复用节点，旧分组没有被清掉 → 看起来就是"列表卡住"。

        修法：key 里带上筛选条件。代价是换筛选时重建这棵子树（几十个节点，肉眼无感），
        换来的是"看到的永远等于筛出来的"。
      */}
      <div className="cw-list" role="listbox" aria-label="选择游戏版本" key={`${channel}|${query}`}>
        {manifestLoading ? (
          <div style={{ padding: 'var(--space-2)' }}>
            <Skeleton rows={8} height={40} />
          </div>
        ) : manifestError ? (
          <div style={{ padding: 'var(--space-2)' }}>
            <Note
              tone="danger"
              icon={<IconAlert />}
              title="拉取版本清单失败"
              actions={
                <Button size="sm" variant="secondary" onClick={() => void loadManifest()}>
                  <IconRefresh /> 重试
                </Button>
              }
            >
              {manifestError}
            </Note>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-note" style={{ padding: 'var(--space-3)' }}>
            {rows.length === 0 ? '还没有拿到版本清单' : `没有匹配「${query}」的版本`}
          </div>
        ) : channel === 'fools' ? (
          /*
           * ★★ 2026-09-23 晚（用户看着这一档的截图）：「**这个分类就有点莫名其妙了**」。
           *
           *   那一档里每一行**本来就是同一类东西**（都是愚人节版本），
           *   再按"世代"切只会切出「其他 / 愚人节 / 快照」这种说不通的标题 ——
           *   根因是愚人节白名单曾经抄了两份、还排在快照规则后面
           *   （见 `VersionIcon.versionFamily` 上面的说明，已改成只留一份并提前判）。
           *
           *   ★ 所以这一档**平铺**：一行一个，没有组标题，也没有折叠。
           *     愚人节版本总共不到十个，本来就不需要"一堵墙"的管理手段。
           *   ★ 行的实现仍然只有 `versionRow` 一处 —— 两种排布不会漂移。
           */
          <>{filtered.slice(0, 200).map((v) => versionRow(v))}</>
        ) : (
          /*
           * ★★ 分组显示（0.1.0-beta.1，用户要求"不要展开后看到版本们
           *   一堆堆在一起"）：按世代切开，每组一个标题行，标题带那个
           *   世代的方块图标。清单顺序**保持上游给的新→旧**，分组只负责
           *   "切开"，不自己造一份顺序。
           */
          groupByFamily(filtered.slice(0, 200), (v) => v.id).map((g) => {
            const holdsSelected = g.rows.some((r) => r.id === mcVersion);
            const folded = foldOverride[g.fam.key] ?? !(holdsSelected || searching);
            return (
            /*
             * ★ 分组 key 也要**唯一**：`g.fam.key` 是世代键，
             *   而 `26.2` 与 `26.2-rc-2` 的世代键相同 —— 只用它会让
             *   两个不同筛选结果里的分组"撞 key"（上面那段注释记的就是这个坑）。
             */
            <div key={`${channel}|${g.fam.key}|${g.rows[0]?.id ?? ''}`} className="wz-group">
              {/*
                ★★ 标题行可点 = 折叠这一世代（用户建议："做一个版本折叠功能"）。
                  清单 900+ 个版本铺开是一堵墙；默认只展开含当前选中版本的那组，
                  搜索时全部展开（搜了看不到结果最气人）。
              */}
              <button
                type="button"
                className="ver-group ver-group-btn"
                aria-expanded={!folded}
                onClick={() => setFoldOverride((o) => ({ ...o, [g.fam.key]: !folded }))}
              >
                <IconChevronDown className={`fold-caret${folded ? ' folded' : ''}`} />
                <VersionIcon version={g.rows[0]?.id ?? ''} size={18} title={g.fam.label} />
                <span>{g.fam.label}</span>
                {/*
                  ★ 2026-09-16 用户（看图）："后面的这个详细版本就不用了，去掉即可"。
                    这里曾经在收起时列出组内的版本号（beta.21 加的 `.ver-group-ids`，
                    最多 4 个 + "…等 N 个"）—— 用户看过后不要了：
                    收起状态只留**世代号 + 个数**，别再往回加。
                */}
                <span className="ver-group-line" />
                <span className="dim">{g.rows.length} 个</span>
              </button>
              {folded ? null : g.rows.map(versionRow)}
            </div>
            );
          })
        )}
        {filtered.length > 200 ? (
          <div className="empty-note" style={{ padding: 'var(--space-2)' }}>
            还有 {filtered.length - 200} 个没显示，用搜索框缩小范围
          </div>
        ) : null}
      </div>
    </>
  );

  /** ② 加载器 / 附加组件 / 自动安装的 API 包 */
  const loaderPaneBody = (
    <>
      <section className="wz-block" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
        <div className="wz-block-title">
          {/*
            ★ 整页向导里**不写「2 ·」** —— 上面那排步骤条已经写着"第 2 步"了，
              同一句话写两遍就是 ADR-054 说的"繁"；弹窗里没有步骤条，所以留着。
          */}
          {variant === 'modal' ? '2 · 模组加载器' : '模组加载器'}
          <span className="wz-block-hint">
            四选一{loadersLoading ? ' · 正在查在线清单…' : ''}
          </span>
        </div>

        {/*
          ★★ 「已装 xxx」这一段**已经删掉**（用户明确要求）。

            原话：「下载页的版本的模组加载器已装xxx那个提示不要了」。

            它本来想说"实时监测盘上装了什么"，但同时带来三个问题：
              · 这一页的职责是**装新的**，不是汇报旧状态；
              · 「盘上有」≠「有版本在用」（删掉实例后共享文件会被故意
                留下），这个区别在这一页怎么措辞都容易被读成"可以直接玩"；
              · 它占掉右栏最显眼的位置，把"选哪个加载器"挤下去了。
        */}

        {/*
          ★ 查不到清单时**必须说清是"没查到"而不是"没有"**，并给重试。
            老实现把这两种情况混成一个空数组，界面于是把 Forge 置灰、
            写"没有 Forge 版本"—— 那是启动器在说谎（用户报的 bug）。
        */}
        {failedKinds.length > 0 ? (
          <Note
            tone="warning"
            icon={<IconAlert />}
            title="有加载器的版本清单没查到"
            actions={
              <Button
                size="sm"
                variant="secondary"
                loading={loadersLoading}
                onClick={() => void loadLoaderQueries(mcVersion, true)}
              >
                <IconRefresh /> 重新查询
              </Button>
            }
          >
            {failedKinds.map((k) => BASE_LOADER_NAME[k]).join('、')} 的在线清单这次没拉到
            {firstError ? `（${firstError.message}）` : ''}。
            <b>这不代表这个版本没有它</b> —— 上面这几项暂时不能选，重试一次通常就好。
          </Note>
        ) : null}

        <div className="base-list">
          {baseOptions.map((o) => {
            const opt = o.value === '' ? null : caps.baseLoaders.find((b) => b.kind === o.value);
            const q = o.value === '' ? null : queries[o.value];
            /*
             * ★ 只有**确认**（查询成功且列表非空）才允许选。
             *   查询失败 → 置灰 + 说明"没查到，可重试"，
             *   **绝不**显示成"这个版本没有它"。
             */
            const liveOk = q?.status === 'ok' && (q?.versions.length ?? 0) > 0;
            const loading = q?.status === 'loading';
            /*
             * ★★ 2026-09-17（用户："与其这样，直接不让选不就好了"）。
             *
             *   用户看到的：1.7.10 上 Fabric **点得动、能选中**，选完下面
             *   才弹一句「当前组合不可用」。既然我们的结论就是"不能用"，
             *   就不该让它选得上 —— 让用户先选、再被拒绝，等于把我们自己的
             *   判断变成他的一次操作失误。
             *
             *   **为什么上一轮那道闸没生效**：`disabled` 原来只看
             *   `liveOk`（在线清单非空），**完全没读 `opt.available`**。
             *   Fabric 加载器在 1.7.10 上确实有 253 个构建 ——
             *   于是"在线清单非空 → 点得动"，而能力表早就判它不可用了。
             *
             *   ★ 两者必须分开看：`liveOk` 说的是"清单到没到"，
             *     `available` 说的是"我们判它能不能用"。只有后者为假时，
             *     才该说"这个版本没有它"。
             */
            const blockedByCapability = liveOk && opt != null && !opt.available;
            const disabled = o.value === '' ? false : blockedByCapability || !liveOk;
            const selected = (o.value === '' && base === null) || o.value === base;
            const reason =
              o.value === ''
                ? undefined
                : loading
                  ? '正在查询在线清单…'
                  : q?.status === 'error'
                    ? `没查到 ${o.label} 的版本清单（${q.message}）—— 这不等于是没有，可以点上面「重新查询」`
                    : blockedByCapability
                      ? (opt?.unavailableReason ?? `${o.label} 不支持 ${mcVersion}`)
                      : (opt?.unavailableReason ?? `${o.label} 没有 ${mcVersion} 的版本`);
            /*
             * ★★ 一行短状态（0.1.0-beta.1，用户要求）。
             *
             *   原文是整句告警，四个加载器各铺两三行，右栏全是字。
             *   现在分三种，**一字不差地对应三种真实状态**：
             *     loading → 转圈（"正在查"，不是"没有"）
             *     error   → 「查不到」（≠ 没有；整句仍挂在 title 上）
             *     确认没有 → 「无」
             *   把长句删掉换成"无"是可以的；把"查不到"说成"无"不行 ——
             *   那正是 ADR-050 记着的那类假话。
             */
            const shortReason = loading ? null : q?.status === 'error' ? '查不到' : '无';
            return (
              <div key={o.value || 'none'} className="base-item">
                <button
                  type="button"
                  className={`base-opt${selected ? ' on' : ''}${disabled ? ' dis' : ''}`}
                  aria-pressed={selected}
                  disabled={disabled}
                  /*
                   * ★★ 2026-09-16 用户："鼠标停在选项上时同一句仍在 title 里，
                   *   这个也不要，大伙都知道是什么"。
                   *
                   *   所以 title **只在不可用时给理由**（那是"为什么点不了"，
                   *   必须留着），可点时一律不给 —— 加载器的名字本身就说清了，
                   *   再挂一句"老牌加载器，Mod 数量最多"是在教用户常识。
                   */
                  title={disabled ? reason : undefined}
                  onClick={() => {
                    setBase(o.value === '' ? null : o.value);
                    setAddons([]);
                  }}
                >
                  <span className="radio" aria-hidden="true" />
                  <span className="b-info">
                    <span className="b-name">{o.label}</span>
                    {/*
                      ★★ 2026-09-16 用户："图三这个副标题提示，可以去掉"。
                        原来选中/不可用时会在这里多铺一行说明
                        （"老牌加载器，Mod 数量最多…"）—— 删掉。
                        **没有丢信息**：鼠标停在这个选项上时，
                        同一句说明仍然在 `title` 里（上面那个 title 属性）。
                    */}
                    {disabled && reason ? (
                      <span className="b-reason" title={reason}>
                        {shortReason === null ? (
                          <Spinner label="正在查在线清单…" />
                        ) : (
                          <>
                            <IconAlert /> {shortReason}
                          </>
                        )}
                      </span>
                    ) : null}
                  </span>
                </button>

                {selected && opt && availableBaseVersions.length > 0 ? (
                  <div className="loader-detail">
                    <label htmlFor={`bv-${o.value}`}>{o.label} 版本</label>
                    {/*
                      ★★ 2026-09-22（用户：「模组加载器选择版本时，这个展开栏**没统一风格**」）：
                        原生 `<select>` 的下拉列表由**操作系统**画（图五那张白底黑字的
                        方框就是它）—— 在深色玻璃界面里出戏，也不跟主题走。
                        换成应用自己的 `CustomSelect`（与「要启动的版本」同款）。
                    */}
                    <CustomSelect
                      value={baseVersion}
                      onChange={setBaseVersion}
                      ariaLabel={`${o.label} 版本`}
                      options={availableBaseVersions.map((ver) => ({ value: ver, label: ver }))}
                    />
                    <Chip tone="success">在线清单 · {availableBaseVersions.length} 个版本</Chip>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {/*
          ★ 0.1.0-beta.1：删掉「不装加载器也能玩 —— 想加光影的话，OptiFine
            会对原版 jar 打补丁安装」。用户明确要求去掉 ——
            选了「无 · 纯原版」的人知道自己在干什么，不用再劝一遍；
            选中那一行自己的说明已经写清了它是什么。
        */}
      </section>

      <section className="wz-block">
        <div className="wz-block-title">
          附加组件
          {/* ★ 2026-09-16 用户（截图）：删掉"可叠加 · 受加载器兼容性约束" */}
          {optifineReal && optifineReal.length > 0 ? (
            <span className="wz-block-hint">OptiFine 清单来自在线</span>
          ) : null}
        </div>
        <div className="addon-grid">
          {caps.addons.map((a) => {
            const bridge = verdict.autoBridges.find((b) => b.after === a.kind);
            const selected = addons.includes(a.kind);
            const removed = verdict.removed.find((r) => r.kind === a.kind);
            /*
             * ★ OptiFine 的可用性以**在线清单**为准（静态表只作离线兜底）。
             *   实测静态表里那句"1.20.5 起不再支持"是错的：1.20.6 有预览版、
             *   1.21.1 有正式版。所以这里有在线数据就用在线数据，没有才退回表。
             *
             * ★★ 2026-09-14：这里原来**只看在线清单，完全没看 `implemented`**。
             *   而 IEML 并没有 OptiFine 的安装实现（见
             *   `ADDON_INSTALL_IMPLEMENTED`）。于是：
             *     · 在线清单查到了 → `disabled = false` → 按钮**点得动**、
             *       勾得上、点安装、报告成功 —— 磁盘上什么都没多；
             *     · 清单没查到（或上一个版本的残留状态）→ 灰掉、点不动。
             *   用户看到的"显示有高清修复，实际上点击后不让选"，
             *   就是这个开关一半能点一半不能点造成的。
             *
             *   现在的判据是**三件事的与**：上游有 + 我们做了 + 版本清单拿到了。
             *   任何一条不成立都必须灰掉，并说清**是哪一条**不成立。
             */
            const isOf = a.kind === 'optifine';
            const online = isOf ? optifine : null;
            const ofVersionsKnown =
              !!online && online.status === 'ok' && online.versions.length > 0;
            /*
             * ★★ 「与当前加载器不兼容」必须**直接不让选**（用户 2026-09-15）：
             *   「既然 Fabric 和高清修复不兼容，为什么还要选了再警告，
             *     而不是直接不让选来的实在」。
             *
             *   原来 `verdict.removed`（组合校验的结论）只被用来**画一个红角标**，
             *   开关本身照旧点得动 —— 于是用户可以"勾上它、再读一句它不行"。
             *   现在把 `removed` 也算进 `disabled`：结论只有一个，界面照它执行。
             *   理由仍然显示（灰掉 + 说明为什么），不让选但**不瞒着**。
             */
            /*
             * ★★ **不管选没选，都先问一次"这个组件跟当前组合兼容吗"**
             *   （2026-09-15，用户："选了 Fabric 之后还能点，还是能点，
             *     就不能黑了，然后显示不兼容吗"）。
             *
             *   以前 `disabled` 只看 `verdict.removed` —— 而 `removed` 里
             *   **只有已经勾上的组件**（`validateCombination` 是遍历选中项算的）。
             *   于是没勾的高清修复永远"点得动"：用户点上去，它才变成
             *   "不兼容"、才被禁用、安装按钮才被拦 —— 正是用户说的
             *   "选了才知道不行"。
             *
             *   现在用 `addonCompatibility`（**同一个判据**，只是提前问）：
             *   不兼容的**从一开始就是灰的**，并把理由显示出来。
             */
            const compat = addonCompatibility(
              mcVersion,
              base,
              a.kind,
              {
                baseVersion: baseVersion || undefined,
                addonVersion: isOf ? optifineFirst?.version : undefined,
              },
              // 与 `validateCombination` 拿到的是**同一个** online（判据只有一份）
              online as never,
            );
            const blockedReason = compat.ok ? null : (compat.reason ?? '与当前组合不兼容');
            const disabled = !a.implemented
              ? true
              : !!removed || !!blockedReason
                ? true
                : isOf && online
                  ? !ofVersionsKnown
                  : !a.available;
            const reason = !a.implemented
              ? (a.unavailableReason ??
                // ★ 不可达的分支（两个附加组件都实装了），但留着是**故意的**：
                //   万一将来新增一个没做安装的组件，这里必须仍然说真话，
                //   而不是显示一个点得动却什么也不做的开关。
                `${a.name} 的安装 IEML 还没做 —— 可以先用别的启动器装好，再用 IEML 启动`)
              /*
               * ★★ **"与当前组合不兼容"排在最前面**（2026-09-15）：
               *   灰掉一个选项必须同时说清为什么 —— 否则用户只会觉得
               *   "这个功能坏了"。而且它比"清单没查到"更确定：
               *   前者是**怎么都装不了**，后者只是这次没问到。
               */
              : blockedReason
                ? blockedReason
                : isOf && online
                  ? online.status === 'loading'
                    ? '正在查询 OptiFine 版本清单…'
                    : online.status === 'error'
                      ? `没查到 OptiFine 的版本清单（${online.message}）—— 这不等于没有，可以点上面「重新查询」`
                      : online.versions.length === 0
                        ? `OptiFine 确实没有发布 ${mcVersion} 的版本`
                        : undefined
                  : a.unavailableReason;
            /*
             * ★★ 短状态（0.1.0-beta.1，用户对着截图说"这个下面的提示，
             *   还有诸如此类的提示可以直接简写一个'无'，所有人就知道啥意思了"）。
             *
             *   三种状态三种写法，一个都不许混：
             *     正在查 → 转圈（Windows 开机那种），因为这时**还不知道**
             *     没查到 → 「查不到」（网络/上游问题，长句留在 title 里）
             *     选不了 → 「无」
             *
             * ★★ 2026-09-23 晚（用户第二次说，看图）：「**2.写「无」**」。
             *   这里原本给"不兼容"单开一档显示「不兼容」—— 那是我 2026-09-15
             *   自己的想法（想在字面上区分"我们的限制"与"上游没有"）。
             *   用户明确不要这个区分：**选不了就是「无」**，理由在 `title` 里。
             *   ⚠️ 于是有一件事必须靠别的路径保住（见上面那张卡片的注释）：
             *     **已经勾上、后来被判不兼容**的组件（`removed`）仍然把整句写出来，
             *     否则用户会以为自己的选择凭空消失。
             */
            const addonLoading = isOf && online?.status === 'loading';
            const shortReason = addonLoading
              ? null
              : isOf && online?.status === 'error'
                ? '查不到'
                : disabled || blockedReason
                  ? '无'
                  : null;
            return (
              <button
                key={a.kind}
                type="button"
                className={`addon-opt${selected ? ' on' : ''}${disabled || removed ? ' dis' : ''}`}
                aria-pressed={selected}
                /*
                 * ★★ **已选中的永远可以取消勾选**，即使它现在被判成不兼容。
                 *   否则就会出现"点不掉它 + 安装按钮被拦"的死局
                 *   （用户报的那一屏）。不让**选**是对的；让人**取消不掉**是错的。
                 */
                disabled={disabled && !selected}
                title={disabled ? reason : undefined}
                onClick={() =>
                  setAddons((prev) =>
                    prev.includes(a.kind)
                      ? prev.filter((x) => x !== a.kind)
                      : [...prev, a.kind],
                  )
                }
              >
                <span className="checkbox" aria-hidden="true">
                  {selected ? <IconCheck /> : null}
                </span>
                <span className="a-info">
                  <span className="a-name">
                    {a.name}
                    {isOf && online?.status === 'ok' && online.versions.length > 0 ? (
                      <Chip tone="neutral">{online.versions.length} 个版本</Chip>
                    ) : null}
                    {/*
                      ★ "上游有、但我们还没做"要**单独标出来**。
                        只写一句"不可用"，用户会以为这个组件不存在，
                        于是放弃；真相是"它在，是我们没实现"——
                        这条信息决定他是等待还是换个启动器装。
                    */}
                    {a.exists && a.implemented === false ? (
                      <Chip tone="warning">没做安装</Chip>
                    ) : null}
                    {/*
                      ★★ 2026-09-23 晚（用户，看图）：「**2.写「无」**」。
                        这里原来挂着一个红角标「与当前加载器不兼容」——
                        它**说的不是同一件事**：LiteLoader 在 26.3 上被禁用，
                        原因是"这个 MC 版本没有它"，与加载器无关。
                        用户要的就是短：「无」（短状态在下面那一行，见 `shortReason`）。
                      ★ 理由没有丢：整句仍在 `title`（悬停即见）——
                        本项目的铁律是**禁用必须给具体理由**，
                        只是不必把整句一直摆在脸上。
                      ★★ 唯一例外是**已经勾上、后来被判不兼容**的那种（`removed`）：
                        下面 `removed.reason` 那一行仍然把整句写出来 ——
                        那是"你明明选了它"，只写「无」会让人以为自己的选择凭空消失。
                    */}
                  </span>
                  <span className="a-desc">{ADDON_DESC[a.kind]}</span>
                  {/* 在线清单的第一项就是最新版 —— 直接把"会装哪个"写出来 */}
                  {isOf && online?.status === 'ok' && optifineFirst ? (
                    <span className="a-note info">
                      <IconInfo /> 最新：{optifineFirst.version}
                      {optifineFirst.preview ? '（预览版，非正式版）' : ''}
                      {optifineFirst.required_forge
                        ? ` · 需要 Forge ${optifineFirst.required_forge}`
                        : ''}
                    </span>
                  ) : null}
                  {disabled && reason ? (
                    <span className="a-note bad" title={reason}>
                      {shortReason === null ? (
                        <Spinner label="正在查版本清单…" />
                      ) : (
                        <>
                          <IconAlert /> {shortReason}
                        </>
                      )}
                    </span>
                  ) : null}
                  {/*
                    ★ 不兼容的理由**要照常显示**（以前这里是 `!disabled && removed`）：
                      现在 `removed` 会让这一项直接 `disabled`，如果还按老条件写，
                      用户就会看到一个灰掉、又完全不说为什么的开关 ——
                      "不让选"和"说清为什么"是两件事，都要做。
                  */}
                  {removed ? (
                    <span className="a-note bad">
                      <IconAlert /> {removed.reason}
                    </span>
                  ) : null}
                  {!disabled && !removed && bridge ? (
                    <span className="a-note info">
                      <IconInfo /> 需要桥接包{' '}
                      {bridge.kind === 'optifabric' ? 'OptiFabric' : 'OptiFabric Origins'}
                      {bridge.kind === 'optifabric' ? '（会自动装）' : '（需手动下载）'}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        {/*
          ★ 选中 OptiFine 之后**让它自己选版本**（以前完全不可选，
            用户只能装静态表里那几个手抄的版本号）。
            预览版带「预览版」标注：用户有权知道它不是正式版。
        */}
        {addons.includes('optifine') && optifineReal && optifineReal.length > 0 ? (
          <div className="loader-detail">
            <label htmlFor="of-ver">OptiFine 版本</label>
            {/* ★ 同上一处：原生 select → CustomSelect（用户："这个展开栏没统一风格"） */}
            <CustomSelect
              value={addonVersions.optifine ?? optifineReal[0]?.version ?? ''}
              onChange={(v) => setAddonVersions((p) => ({ ...p, optifine: v }))}
              ariaLabel="OptiFine 版本"
              options={optifineReal.map((v) => ({
                value: v.version,
                label: `${v.version}${v.preview ? '（预览版）' : ''}`,
              }))}
            />
            <Chip tone="success">在线清单 · {optifineReal.length} 个版本</Chip>
          </div>
        ) : null}
      </section>

      {/*
        ★ 没有 API 包可装时**整块不渲染**。
          以前这里永远显示一个虚线空框写着"当前配置无需额外 API 包"——
          用户没问 API 包，也不需要知道"没有"这件事。
      */}
      {verdict.autoApis.length > 0 ? (
        <section className="wz-block">
          <div className="wz-block-title">
            将自动安装
            <span className="wz-block-hint">API 前置包 · 由加载器决定</span>
          </div>
          <div className="api-list">
            {verdict.autoApis.map((lib) => (
              <div key={lib.kind} className="api-item">
                <span className="api-name">{lib.name}</span>
                <span className="api-ver mono">{lib.version}</span>
                <span className="api-desc" title={lib.description}>
                  {lib.description}
                </span>
                <span className="api-size mono">{formatBytes(lib.bytes)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );

  /**
   * ③ 版本名称 —— **只有一份**输入框，两种排布共用。
   *
   * ★★ 2026-09-23 晚：整页形态把它放进了**页头右侧**（见下面 `gw-name`）。
   *   原因是真的量出来的：那一页正文的可视高度 507px，而"加载器 + 附加组件 +
   *   版本名称"三块加起来 589px —— 名字那一块被挤到**折线以下**，
   *   不滚动就看不见（截图里那块是空白，我第一版的检查只从 DOM 读了值，
   *   **看不见这个问题**）。放进页头之后它永远在屏幕上，也不受窗口高度影响。
   */
  const nameField = (
    <>
      <input
        className="input"
        value={name}
        aria-label="版本名称"
        placeholder="给这个版本起个名字"
        onChange={(e) => {
          setName(e.target.value);
          setNameTouched(true);
        }}
        onFocus={(e) => e.currentTarget.select()}
      />
      {nameTouched && name !== suggestedName ? (
        <button
          type="button"
          className="wz-reset-name"
          onClick={() => {
            setName(suggestedName);
            setNameTouched(false);
          }}
        >
          改回建议名称「{suggestedName}」
        </button>
      ) : null}
    </>
  );

  /** ③′ 弹窗形态：名字是正文里的一块 */
  const nameBlock = (
    <section className="wz-block">
      <div className="wz-block-title">
        版本名称
        <span className="wz-block-hint">之后可以在设置里改</span>
      </div>
      {nameField}
    </section>
  );

  /** ④ 组合校验的结论（错误红条 / 警告蓝条） */
  const notesBlock = (
    <div className="cw-notes">
      {verdict.errors.length > 0 ? (
        <Note tone="danger" title="当前组合不可用">
          {verdict.errors.join('；')}
        </Note>
      ) : verdict.warnings.length > 0 ? (
        <Note tone="info" title="安装前请确认">
          <ul className="note-list">
            {verdict.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Note>
      ) : null}

    </div>
  );

  /** ⑤ 底部常驻摘要 + 唯一的按钮（弹窗形态用） */
  const footBar = (
    <div className="cw-foot">
      <span className="dim">
        约下载 <b className="mono">{formatBytes(estimate.download)}</b> · 可复用{' '}
        {formatBytes(estimate.cached)} · Java <b className="mono">{javaReq.major}</b>
        {hasJava ? <Chip tone="success">已就绪</Chip> : <Chip tone="warning">未安装</Chip>} ·
        预计 <b className="mono">{formatDuration(estimate.seconds)}</b>
      </span>
      <div className="spacer" />
      {onCancel ? (
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
      ) : null}
      <Button
        variant="primary"
        loading={installing}
        disabled={!verdict.valid || !mcVersion}
        onClick={() => void handleInstall()}
      >
        <IconPlus /> 安装 {name || suggestedName}
      </Button>
    </div>
  );

  /** 选中的那个版本在清单里的记录（用它说清"盘上有没有"） */
  const pickedRow = rows.find((r) => r.id === mcVersion) ?? null;
  /**
   * 版本的渠道名 —— 三种写法对应三种**真实**的东西。
   * ★ 判据与上面 `filtered` 里那一套**同源**（`release_type` + `FINAL_RELEASE_RE`
   *   + `isAprilFoolsVersion`）：正式版要两个条件都满足，愚人节要在快照之前判。
   */
  const pickedChannel =
    pickedRow && pickedRow.release_type === 'release' && FINAL_RELEASE_RE.test(pickedRow.id)
      ? '正式版'
      : isAprilFoolsVersion(mcVersion)
        ? '愚人节版本'
        : '快照 / 预发布';
  /** 加载器那一步的一行摘要（步骤条上写"这一步选了什么"） */
  const loaderSummary =
    base === null
      ? '无 · 纯原版'
      : `${BASE_LOADER_NAME[base]} ${baseVersion || availableBaseVersions[0] || ''}` +
        (addons.length > 0 ? ` + ${addons.length} 个附加组件` : '');
  /** 两步共用的「要下载 / Java」那一小段结论 */
  /*
   * ★★ 真机实测抓到的：`declaredJava`（Mojang 在版本 JSON 里声明的那个数）
   *   是**异步**取回来的。26.3 声明的是 25，而取回来之前按版本号基线算是 21 ——
   *   于是"第 1 步显示 21、翻到第 2 步变成 25"，同一个界面里两个数。
   *   两个数都不是编的，但**把一个还没核对的数当成结论**就是在骗人。
   *   所以没核对完时明确写「正在核对」—— 数字照给（它是最好的现有估计），
   *   但一眼就能看出它还会变。
   */
  const javaPending = mcVersion !== '' && declaredJava === undefined;
  const javaLine = (
    <>
      <span className="mono">{javaReq.major}</span>
      {javaPending ? (
        <Chip tone="neutral">正在核对</Chip>
      ) : hasJava ? (
        <Chip tone="success">已就绪</Chip>
      ) : (
        <Chip tone="warning">未安装</Chip>
      )}
    </>
  );

  /* ------------------------------------------------------------------
   * 弹窗形态：与改动**逐字一致**（左栏选版本 / 右栏选加载器 + 名称 + 底部按钮）
   * ------------------------------------------------------------------ */
  if (variant === 'modal') {
    return (
      <div className="cw-shell cw-shell-modal">
        <div className="cw-body">
          {/* ============ 左栏：真实版本清单 ============ */}
          <div className="cw-left">
            <div className="cw-left-head">1 · 选择游戏版本</div>
            {versionPaneBody}
          </div>

          {/* ============ 右栏：加载器（三层） ============ */}
          <div className="cw-right">
            <div className="cw-right-body">
              {loaderPaneBody}
              {nameBlock}
            </div>
            {notesBlock}
            {footBar}
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------------
   * 整页形态（下载页第一格）
   * ------------------------------------------------------------------
   * ★★ 2026-09-23 晚（用户）：「**像 mod 一样点击那行比较不错，然后给模组加载器
   *   像 mod 页那样单开一页**」。
   *
   *   于是这一形态下不再是"一页里翻两步"：
   *     · **第 1 屏 = 一列版本清单**（整宽，没有右栏）——
   *       **点任意一行就进下一页**，与 Mod 页"点一行就装"是同一个手感；
   *     · **第 2 屏 = 模组加载器整屏页**（`page-head` + `← 返回` + 标题 +
   *       底部动作条），与 Mod 的安装页（`ResourceInstallPage`）同一套语言。
   *
   *   ★ 所以**步骤条删掉了**：它说的是"现在在第几步"，而现在"在哪一步"由
   *     **页面本身**回答（第 2 屏没有下载页的页头和页签，自己带页头）。
   *     清单上面留**一句**提示，把"点一行会发生什么"说清楚，比一条步骤条省地方。
   *
   *   ★ 第 2 屏是"自己的页"这件事要**外层配合**：下载页的头与页签由
   *     `onStepChange` 通知后收起来（与整合包安装页同一套做法，见 §46）。
   */
  if (step === 'loader') {
    return (
      <div className="gw-full">
        <div className="page-head">
          <div>
            <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
              <Button size="sm" variant="ghost" onClick={() => setStep('version')}>
                <IconChevronRight className="gw-back" /> 返回
              </Button>
              <h1 className="page-title">模组加载器</h1>
            </div>
            <p className="page-desc">
              装到 <b className="mono">{mcVersion}</b> · {pickedChannel}
              {pickedRow?.released_at ? ` · ${pickedRow.released_at.slice(0, 10)}` : ''}
              {' —— '}不选加载器就是纯原版
            </p>
          </div>
          {/*
            ★ 「盘上有没有」这一条留着：它决定这次要不要真下载游戏文件
              （盘上有 → 只补加载器，几秒钟的事）。
          */}
          {/*
            ★★ 版本名称放**页头右侧**（2026-09-23 晚，量出来之后改的）：
              原来它在正文最后一块，而正文可视高度只有 507px、内容 589px ——
              它被挤到折线以下，**不滚动就看不见**。放这里永远看得见，
              而且与右下角那个「安装 X」按钮的文案是同一个值（改名按钮上的字会跟着变）。
          */}
          <div className="gw-name">
            <span className="gw-name-label">
              版本名称
              <Chip tone={pickedRow?.installed ? 'success' : 'neutral'}>
                {pickedRow?.installed
                  ? pickedRow.in_use === false
                    ? '盘上有游戏文件（暂无版本在用）'
                    : '盘上有游戏文件'
                  : '要下载游戏文件'}
              </Chip>
            </span>
            {nameField}
          </div>
        </div>

        <div className="gw-full-body">{loaderPaneBody}</div>

        {/* 组合不可用的红条永远看得见（它挡着下面那个按钮） */}
        {notesBlock}

        {/*
          ★ 底部动作条 = **装之前最后一次确认**：
            版本 / 加载器 / 体积 / Java / 耗时一句话说完，右边**一个**按钮。
            （原来那套「这次会装什么」的表格删掉了 —— 它列的六项里，
              版本与加载器现在就在屏幕上，重复列一遍只是增加一屏字。）
        */}
        <div className="cw-foot">
          <span className="dim">
            <b className="mono">{mcVersion}</b> · {loaderSummary} · 约下载{' '}
            <b className="mono">{formatBytes(estimate.download)}</b> · 可复用{' '}
            {formatBytes(estimate.cached)} · Java {javaLine} · 预计{' '}
            <b className="mono">{formatDuration(estimate.seconds)}</b>
          </span>
          <div className="spacer" />
          {/*
            ★★ 2026-09-23 夜（用户看着这一页问：「**两个返回按键？**」）：
              这里原来还有一个「← 换一个版本」，而页头左上角已经有一个「← 返回」——
              **两处一模一样的作用**（都是回版本清单），只是措辞不同。
              按本项目的规矩（同一个动作不该有两个入口），**删掉这一个**，
              保留页头那个标准位置的回退（与 Mod 的安装页一致）。
          */}
          <Button
            variant="primary"
            loading={installing}
            disabled={!verdict.valid || !mcVersion}
            onClick={() => void handleInstall()}
          >
            <IconPlus /> 安装 {name || suggestedName}
          </Button>
        </div>
      </div>
    );
  }

  /* 第 1 屏：整宽的版本清单（点一行 = 进下一页） */
  return (
    <div className="cw-shell cw-shell-page gw">
      <div className="cw-body gw-body">
        <div className="gw-col">{versionPaneBody}</div>
      </div>
    </div>
  );
}

/**
 * 静态表里没有的版本，按版本号给一个粗略的原版体积估算。
 * ★ 这个值**只用于底部摘要**，不参与任何判断 —— 真下载量以实际任务为准。
 */
function estimateVanillaBytes(mcVersion: string): number {
  const MB = 1024 * 1024;
  const segs = mcVersion.split('.').map((x) => parseInt(x, 10));
  const major = segs[0] ?? 1;
  const minor = segs[1] ?? 0;
  if (major >= 1 && minor >= 21) return 480 * MB;
  if (minor === 20) return 450 * MB;
  if (minor === 19) return 410 * MB;
  if (minor === 18) return 380 * MB;
  if (minor === 17) return 350 * MB;
  if (minor === 16) return 330 * MB;
  if (minor === 13 || minor === 14 || minor === 15) return 300 * MB;
  if (minor === 12) return 240 * MB;
  return 220 * MB;
}
