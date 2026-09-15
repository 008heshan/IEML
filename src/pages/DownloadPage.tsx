/**
 * 下载页（一级页）
 * ------------------------------------------------------------------
 * 六个页签（0.1.0-beta.1）：
 *   安装游戏 · 整合包 · Mod · 资源包 · 光影 · 数据包
 *
 * ★ 「游戏版本」与「加载器」曾经是两个独立页签 —— 那是设计退步：
 *   用户的脑子里想的是「我要玩 1.20.1 的 Forge」，不是「我要走哪条操作模型」。
 *   拆成两个页签后，「加载器」那页根本不知道要装到哪个版本上，
 *   只能让用户手打版本号。现在合并成**一页**（`InstallComposer`）：
 *   左栏选真实版本，右栏选加载器，底部一个按钮装完。
 *
 * ★★ 后四格（Mod / 资源包 / 光影 / 数据包）都是**同一个资源中心**
 *   （`ResourceCenterBody`），只是换了个种类。用户的原话是"下载页里的
 *   mod 列表应该是显示 mod，不要显示版本"—— 旧的第三格列的是每个版本
 *   各装了什么，那是"已有"，而这一页要回答的是"能装什么"。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { Button, Chip, CustomSelect, EmptyState, Note, SearchBox, Segmented } from '../ui';
import { IconAlert, IconBox, IconDownload, IconLayers, IconPuzzle, IconRefresh, IconImage, IconGrid, IconPackage } from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import type { DownloadTab } from '../state/store';
import { InstallComposer } from '../components/InstallComposer';
import { ResourceCenterBody } from '../components/ResourceBrowser';
import { autoMemory } from '../domain';
import type { Instance } from '../domain';
import type { ResourceKindName } from '../bridge/tauri';
import { registerTaskReplay } from '../flows/install';

/** 后四格页签 ↔ 资源种类（**一一对应**，界面不自己编种类） */
const RESOURCE_TABS: Array<{ tab: DownloadTab; kind: ResourceKindName; label: string }> = [
  { tab: 'mod', kind: 'mod', label: 'Mod' },
  { tab: 'resourcepack', kind: 'resourcepack', label: '资源包' },
  { tab: 'shader', kind: 'shader', label: '光影' },
  { tab: 'datapack', kind: 'datapack', label: '数据包' },
];

/** 整合包每页几个（写死的 20 个 = "没有翻页"，见 `load`） */
const PAGE_SIZE = 20;

export function DownloadPage() {
  const { state, go, toast, setDownloadTab } = useApp();
  const { isDesktop } = useRealApi();
  const tab = state.downloadTab;

  /* 其他页面可以通过事件切换页签 */
  useEffect(() => {
    const onTab = (e: Event) => {
      const t = (e as CustomEvent<DownloadTab>).detail;
      if (t) setDownloadTab(t);
    };
    window.addEventListener('ieml:download-tab', onTab);
    return () => window.removeEventListener('ieml:download-tab', onTab);
  }, [setDownloadTab]);

  /*
   * 资源要装进**某个**实例里（mods/ resourcepacks/ shaderpacks/ datapacks/
   * 都是实例目录下的子目录）。下载页没有"当前版本"这个上下文，所以给一个
   * 显式选择器：默认挑最近玩过的那个（最可能就是玩家现在要装的），
   * 玩家随时能换 —— **不替他决定**，但也不让他每次重选。
   */
  const [targetId, setTargetId] = useState<string | null>(null);
  /*
   * ★★ 别的页面可以把"装到哪个版本"带过来（用户 2026-09-15：
   *   "添加 mod 的按钮应该直接跳转下载页的 mod 页，并默认选择该跳转版本"）。
   *
   *   从「Mod 管理 → 添加 Mod」进来时，用户心里想的是**手上这个版本**，
   *   而下载页默认挑的是"最近玩过的那个" —— 很可能不是它，
   *   于是他会把 Mod 装到另一个版本上（而且一眼看不出来）。
   *   事件里带着实例 id，这里收到就切过去。
   */
  useEffect(() => {
    const onPick = (e: Event) => {
      const id = (e as CustomEvent<{ instanceId?: string }>).detail?.instanceId;
      if (id) setTargetId(id);
    };
    window.addEventListener('ieml:download-target', onPick);
    return () => window.removeEventListener('ieml:download-target', onPick);
  }, []);
  const target = useMemo(() => {
    if (state.instances.length === 0) return null;
    const picked = state.instances.find((i) => i.id === targetId);
    if (picked) return picked;
    const byTime = [...state.instances].sort((a, b) =>
      (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? ''),
    );
    return byTime[0] ?? null;
  }, [state.instances, targetId]);

  const tabs: Array<{ key: DownloadTab; label: string; icon: React.ReactNode }> = [
    { key: 'game', label: '安装游戏', icon: <IconDownload /> },
    { key: 'modpack', label: '整合包', icon: <IconPackage /> },
    { key: 'mod', label: 'Mod', icon: <IconPuzzle /> },
    { key: 'resourcepack', label: '资源包', icon: <IconImage /> },
    { key: 'shader', label: '光影', icon: <IconLayers /> },
    { key: 'datapack', label: '数据包', icon: <IconGrid /> },
  ];

  const resourceTab = RESOURCE_TABS.find((r) => r.tab === tab) ?? null;

  return (
    <div className="page-fill">
      <div className="page-head">
        <div>
          <h1 className="page-title">下载</h1>
          <p className="page-desc">游戏 · 整合包 · Mod · 资源包 · 光影 · 数据包</p>
        </div>
        {!isDesktop ? <Chip tone="warning">浏览器演示模式 —— 真实下载要桌面版</Chip> : null}
      </div>

      <div className="tabs" role="tablist" aria-label="下载内容">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab${tab === t.key ? ' on' : ''}`}
            onClick={() => setDownloadTab(t.key)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === 'game' ? (
        <InstallComposer
          variant="page"
          onInstalled={(inst) => {
            toast('info', '已加入版本列表', '去「版本列表」双击它就能进设置或启动。');
            go('versions');
            void inst;
          }}
        />
      ) : tab === 'modpack' ? (
        <ModpackTab go={go} toast={toast} isDesktop={isDesktop} />
      ) : resourceTab ? (
        <>
          {/*
            装到哪个版本：下载页没有"当前版本"，所以这里显式选一个。
            ★ 没有版本时**不让装**，也不假装能装 —— 直接说清先做什么。
          */}
          {state.instances.length === 0 ? (
            <EmptyState
              title="还没有任何版本"
              desc="资源要装进某个版本的目录里，所以先在「安装游戏」里装一个版本。"
              actions={
                <Button variant="primary" onClick={() => setDownloadTab('game')}>
                  去安装游戏
                </Button>
              }
            />
          ) : (
            <>
              {/*
                ★ 「装到哪个版本」这一行（用户要求："选择游戏版本的那个栏可以再大一点，
                尤其是版本那里，很费眼，太小了"）。

                ★★ 同时去掉两样东西（用户："下载页上下重复，还有这里的『管理这个版本的资源』
                也去掉，这是无意义的"）：
                  · 「管理这个版本的资源」—— 它只把人送回版本列表，而**上面那排页签
                    已经能做同一件事**（选版本就在这一行），是个绕路按钮；
                  · 内层的 Mod / 资源包 / 光影 / 数据包 四个页签 —— 与最外层那排**完全重复**。
                    所以给 ResourceCenterBody 传 `hideKindTabs`，只留来源切换（Modrinth/CurseForge）。
              */}
              <div className="res-target">
                <span className="res-target-k">装到</span>
                <CustomSelect
                  value={target?.id ?? ''}
                  onChange={setTargetId}
                  ariaLabel="装到哪个版本"
                  options={state.instances.map((i) => ({
                    value: i.id,
                    label: `${i.config.name}（${i.mcVersion}${i.loader ? ` + ${i.loader.kind}` : ' · 原版'}）`,
                  }))}
                />
              </div>
              <ResourceCenterBody
                kind={resourceTab.kind}
                onKindChange={(k) => {
                  const next = RESOURCE_TABS.find((r) => r.kind === k);
                  if (next) setDownloadTab(next.tab);
                }}
                instance={target}
                toast={toast}
                compactHead
                hideKindTabs
              />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

/* ====================== 页签二：整合包 ====================== */

interface PackCard {
  id: string;
  name: string;
  author: string;
  summary: string;
  mc: string;
  loader: string;
  downloads: string;
  weight: 'light' | 'medium' | 'heavy';
  /**
   * ★ 封面图 URL（2026-09-15 补）。
   *
   *   用户报："整合包还没有封面"。实测：Modrinth 的搜索结果里**本来就有**
   *   `icon_url`，而这里只画了一个按 `weight` 变色的方块（`pack-cover`）——
   *   数据一直是有的，是这一页没接。现在有图用图、没图退回那个色块。
   */
  icon: string | null;
}

function ModpackTab({
  go,
  toast,
  isDesktop,
}: {
  go: (p: 'launch' | 'versions' | 'download' | 'settings') => void;
  toast: (k: 'ok' | 'err' | 'info' | 'warning', t: string, d?: string) => void;
  isDesktop: boolean;
}) {
  const { api } = useRealApi();
  // ★ 整合包安装完要真的建实例 —— 以前这里没有 createInstance，装上也没人登记
  const { createInstance } = useApp();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'hot' | 'new' | 'downloads'>('hot');
  const [packs, setPacks] = useState<PackCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PackCard | null>(null);
  const [name, setName] = useState('');
  const [installing, setInstalling] = useState(false);
  /** 页码与总数（0 基）—— 翻页靠它俩，不再写死前 20 个 */
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);

  /** 从 Modrinth 拉真实整合包（project_type=modpack） */
  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      /*
       * ★ 翻页（2026-09-15）：用户报"整合包还没有翻页"。
       *   实测确认：这里写死 `limit: 20` 且**没有 offset** ——
       *   于是整合包永远只有前 20 个，翻不动。现在按页取，总数用上游的
       *   `total_hits`（自己数出来的总数没有意义，也不是"全部"）。
       */
      const r = await api.modrinth.search({
        query: query || '',
        projectType: 'modpack',
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setTotal(r.total_hits ?? 0);
      setPacks(
        r.hits.map((h) => ({
          id: h.slug || h.project_id,
          name: h.title,
          author: h.author || '未知作者',
          summary: h.description,
          mc: h.versions.slice(-1)[0] ?? '—',
          loader: h.categories.find((c) => ['fabric', 'forge', 'neoforge', 'quilt'].includes(c)) ?? '—',
          downloads: h.downloads > 1000 ? `${Math.round(h.downloads / 1000)}k` : String(h.downloads),
          weight: 'medium' as const,
          icon: h.icon_url ?? null,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, query, page]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ★ 搜索词变了要回到第 1 页（不然会停在一个"搜出来只有 3 个"的第 7 页上） */
  useEffect(() => {
    setPage(0);
  }, [query]);

  const sorted = useMemo(() => {
    const list = [...packs];
    if (sort === 'downloads') {
      return list.sort(
        (a, b) => parseFloat(b.downloads.replace('k', '')) - parseFloat(a.downloads.replace('k', '')),
      );
    }
    if (sort === 'new') return list.reverse();
    return list;
  }, [packs, sort]);

  async function install() {
    if (!selected) return;
    if (!api) {
      toast('warning', '演示模式', '浏览器里无法真实安装整合包');
      return;
    }
    setInstalling(true);
    try {
      const versions = await api.modrinth.versions(selected.id);
      const first = versions[0];
      const file = first?.files.find((f) => f.primary) ?? first?.files[0];
      if (!file) throw new Error('这个整合包没有可下载的文件');

      // 先读清单，把"要装什么"如实告诉用户，再动手
      const info = await api.modpack.inspect(file.url);
      if (!info.mc_version) {
        throw new Error('这个整合包的清单里没写游戏版本，无法安装');
      }
      const packName = name.trim() || info.name || selected.name;
      const slug = `pack-${Date.now().toString(36).slice(-6)}`;

      // ★ 建任务：任务中心里能看到真实阶段与文件计数（不是假的进度条）
      const taskId = `modpack-${Date.now().toString(36)}`;
      window.dispatchEvent(
        new CustomEvent('ieml:task-add', {
          detail: {
            id: taskId,
            kind: 'install',
            title: `整合包 ${packName}`,
            detail: `${info.mc_version}${
              info.loader_kind ? ` + ${info.loader_kind} ${info.loader_version ?? ''}` : ''
            } · ${info.client_file_count} 个文件`,
            status: 'running',
            percent: 0,
            finishedFiles: 0,
            bytesPerSecond: 0,
            currentFile: '',
            etaSeconds: 0,
          },
        }),
      );
      const patch = (p: Record<string, unknown>) =>
        window.dispatchEvent(
          new CustomEvent('ieml:task-patch', { detail: { id: taskId, patch: p } }),
        );

      /*
       * ★ 注册重放函数：整合包安装不在 `flows/install` 的 pendingJobs 里，
       *   于是任务中心的「继续」「重试」对它静默失效（审计发现）。
       *   注册之后这两个按钮对整合包也真的能用（断点续传靠 .part）。
       */
      const doInstall = () =>
        api.modpack.install(
          {
            url: file.url,
            name: info.name,
            slug,
            taskId,
            instanceName: packName,
            source: 'bmclapi',
          },
          (e) => {
            patch({
              detail: e.stage,
              percent: e.percent,
              finishedFiles: e.finishedFiles,
              currentFile: e.currentFile,
            });
          },
        );
      registerTaskReplay(taskId, () => {
        void doInstall().catch((err) => {
          patch({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
        });
      });

      const result = await doInstall();

      /*
       * ★★ **被暂停就不算装完**（P0-3）：不许建实例、不许说"安装完成"。
       *
       *   老行为是：暂停之后照样往下跑、照样建实例、提示"整合包装好了"，
       *   而 `instances.json` 里多出一个**起不来**的空壳。
       *   现在如实标记「已暂停」，任务中心的「继续」用同一套参数接着下。
       */
      if (result.paused) {
        patch({
          status: 'paused',
          detail:
            result.remaining_files > 0
              ? `已暂停 · 还剩 ${result.remaining_files} 个文件`
              : '已暂停',
        });
        toast(
          'info',
          '已暂停',
          `${packName} 还剩 ${result.remaining_files} 个文件没下，点「继续」接着装`,
        );
        return; // `finally` 会把 installing 放回 false
      }

      // ★ 装完才建实例（失败不会在列表里留下一个起不来的空壳）
      const inst: Instance = {
        id: `inst-${Date.now().toString(36)}`,
        mcVersion: result.mc_version,
        loader: result.loader_kind
          ? {
              kind: result.loader_kind as 'forge' | 'neoforge' | 'fabric' | 'quilt',
              version: result.loader_version ?? '',
              mcVersion: result.mc_version,
            }
          : null,
        addons: [],
        config: {
          name: packName,
          slug,
          // ★ 整合包必须隔离：作者的 config 不能被别的实例污染
          isolation: 'on',
          memoryMb: Math.round(
            autoMemory(
              0,
              result.loader_kind === 'forge' || result.loader_kind === 'neoforge'
                ? 'modded'
                : 'vanilla',
              16,
              8,
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

      patch({ status: 'done', percent: 100, detail: '安装完成' });
      toast(
        'ok',
        '整合包装好了',
        `${packName} · ${result.mc_version}${
          result.loader_kind ? ` + ${result.loader_kind}` : ''
        } · ${result.mod_files} 个文件 + ${result.override_files} 个配置`,
      );
      setSelected(null);
      go('versions');
    } catch (e) {
      toast('err', '安装失败', e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <div className="row row-wrap" style={{ marginBottom: 'var(--space-3)' }}>
        <div style={{ flex: 1, maxWidth: 320 }}>
          <SearchBox
            label="搜索整合包"
            placeholder="搜索整合包名称 / 作者 / 标签"
            value={query}
            onChange={setQuery}
          />
        </div>
        <Segmented
          label="排序"
          size="sm"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'hot', label: '推荐' },
            { value: 'new', label: '最新' },
            { value: 'downloads', label: '最多下载' },
          ]}
        />
        <div style={{ flex: 1 }} />
        <span className="dim">数据来自 Modrinth</span>
      </div>

      {error ? (
        <Note
          tone="danger"
          icon={<IconAlert />}
          title="拉取整合包列表失败"
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
        ★ 骨架要**长成卡片的样子**（与资源中心同一条规矩）：
          原来这里是 `<Skeleton rows={4} height={110}/>` —— 四条通栏长条，
          加载完却是一格一格的卡片，用户看到的就是"大长条"。
      */}
      {loading ? (
        <div className="grid-cards" aria-busy="true" aria-label="正在加载">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="pack-card pack-card-sk">
              <span className="sk sk-cover-lg" />
              <div className="pack-body">
                <span className="sk sk-line w70" />
                <span className="sk sk-line w45" />
                <span className="sk sk-line w95" />
                <span className="sk sk-line w35" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {!loading && sorted.length === 0 && !error ? (
        <EmptyState
          title={api ? '没有找到整合包' : '桌面版才能浏览真实整合包'}
          desc={api ? '换个关键词试试。' : '浏览器演示模式下没有在线数据。'}
        />
      ) : null}

      <div className="grid-cards">
        {sorted.map((p) => (
          <button
            key={p.id}
            type="button"
            className="pack-card"
            onClick={() => {
              setSelected(p);
              setName(p.name);
            }}
          >
            {/* ★ 有封面就用真封面；没有才退回按"分量"变色的方块（不再假装有图） */}
            <div className="pack-cover" data-weight={p.weight}>
              {p.icon ? (
                <img
                  src={p.icon}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : null}
            </div>
            <div className="pack-body">
              <div className="pack-name truncate">{p.name}</div>
              <div className="pack-author">by {p.author}</div>
              <div className="pack-tags">
                <Chip tone="accent">{p.mc}</Chip>
                <Chip tone="neutral">{p.loader}</Chip>
              </div>
              <div className="pack-meta">{p.downloads} 次下载</div>
            </div>
          </button>
        ))}
      </div>

      {/* ★ 翻页（原来写死前 20 个，翻不动） */}
      {!loading && total > PAGE_SIZE ? (
        <div className="pager">
          <Button
            size="sm"
            variant="secondary"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            上一页
          </Button>
          <span className="pager-info">
            第 {page + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页 · 共 {total} 个
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={(page + 1) * PAGE_SIZE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      ) : null}

      {/* 配置面板（内联展开，不用弹窗 —— 弹窗会遮住刚选的包） */}
      {selected ? (
        <div className="setup-panel">
          <div className="setup-head">
            <span className="si">
              <IconBox />
            </span>
            <div>
              <div className="setup-t">安装「{selected.name}」</div>
              <div className="setup-s">{selected.summary}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
              取消
            </Button>
          </div>

          <div className="setup-body">
            <div className="setup-block">
              <div className="setup-label">实例名称</div>
              <div className="setup-field">
                <input
                  className="input"
                  value={name}
                  aria-label="实例名称"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>

            <div className="setup-foot">
              <span className="dim">版本、加载器、Mod 清单都由包里的 modrinth.index.json 定死</span>
              <div className="spacer" />
              <Button variant="ghost" onClick={() => setSelected(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                loading={installing}
                disabled={!isDesktop}
                onClick={() => void install()}
              >
                确认并开始安装
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

