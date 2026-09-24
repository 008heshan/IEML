/**
 * C5：资源的**独立安装页**（用户：「给这些资源点击安装时单独建页面，具体看 PCL 做法」）。
 *
 * 结构照 PCL 的详情页（图二）：
 *   ① 顶部**资源信息卡**：图标 / 名称 / 英文名 / 简介 / 作者·标签·下载量·来源
 *      + 三个直达动作（转到 Modrinth / 转到 MC 百科 / 复制名称）；
 *   ② 下面**版本列表**：MC 版本 chips + 按大版本分组折叠 ——
 *      直接复用列表页那个 VersionPicker（**同一份实现**，不写第二套）。
 *
 * ★ 为什么要有这一页：内联展开时"资源信息"和"几十个版本"挤在同一张卡里，
 *   越往下越乱；而挑版本这件事本身要专注。PCL 就是这么分的，用户点名照它做。
 */
import { useEffect, useState } from 'react';
import { Button, Chip, EmptyState, Note, Spinner } from '../ui';
import { IconChevronRight } from '../ui/Icons';
import { VersionPicker } from '../components/ResourceBrowser';
import { useRealApi } from '../hooks/useRealApi';
import { useApp } from '../state/AppContext';
import { installResourceVersion } from '../flows/resource-install';
import type { ModrinthHit, ModrinthVersion, ResourceKindInfo, ResourceKindName, ResourceSourceName } from '../bridge/tauri';

export function ResourceInstallPage() {
  const { state, closeResource, toast } = useApp();
  const { api } = useRealApi();
  /** store 里存的是 unknown（那一层不解析 Modrinth 字段），到这里收窄 */
  const hit = (state.resourceTarget?.hit ?? null) as ModrinthHit | null;
  const kind = (state.resourceTarget?.kind ?? '') as ResourceKindName;

  const [versions, setVersions] = useState<ModrinthVersion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  /*
   * ★★ 2026-09-24（C-17 修复）：这一页原来把 `installNote` **写死成 null** ——
   *   而"装完还有一步"的整条通路（flows 里的 `note` → 这里 `toast('info','还有一步')`）
   *   于是永远不会触发：数据包装完不告诉你要放进世界、光影装完不说要 Iris。
   *   说明文字**后端早就有**（`ResourceKind::install_note`，随 `resource_kinds` 下发），
   *   所以正确做法是**取它**，而不是在前端再写一张表。
   */
  const [installNote, setInstallNote] = useState<string | null>(null);
  /*
   * ★★ 2026-09-24（C-18 修复）：来源如实显示 —— 这一页原来写死「来自 Modrinth」，
   *   从 CurseForge 那一栏点进来的包也会这么写。
   * ★ C-1：这个来源同时要**传给后端**（版本列表按来源走），所以收成 ResourceSourceName。
   */
  const source: ResourceSourceName =
    state.resourceTarget?.source === 'curseforge' ? 'curseforge' : 'modrinth';
  const sourceLabel = source === 'curseforge' ? 'CurseForge' : 'Modrinth';

  useEffect(() => {
    if (!api || !kind) return;
    let alive = true;
    void api.modrinth
      .resourceKinds()
      .then((list: ResourceKindInfo[]) => {
        if (alive) setInstallNote(list.find((k) => k.key === kind)?.install_note ?? null);
      })
      .catch(() => {
        /* 取不到就不提示 —— 少一句提示，好过编一句 */
      });
    return () => {
      alive = false;
    };
  }, [api, kind]);

  /** 装到哪个实例：沿用下载页那一套（downloadTargetId → 否则最近玩过的） */
  const target =
    state.instances.find((i) => i.id === state.downloadTargetId) ??
    [...state.instances][0] ??
    null;

  const load = () => {
    if (!api || !hit) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    /*
     * ★★ 2026-09-24（C-1 修复）：这里原来调的是 `api.modrinth.versions(hit.project_id)` ——
     *   **只有 Modrinth 那一条路**。而 CF 命中的 `project_id` 是**数字 id**，
     *   拿它去问 Modrinth 只会得到 404 或空列表 ——
     *   真机上的表现就是报告里那句「这个整合包没有可下载的版本 / 上游没有给它发布任何文件」，
     *   而那个包在 CurseForge 上明明有几十个文件。
     *
     *   后端**早就有** source-aware 的 `resource_versions`（`commands_real.rs:803`：
     *   CF → `curseforge::files`，Modrinth → `project_versions`），
     *   `ResourceBrowser` 展开卡片时用的就是它 —— 只有这一页漏了。
     *   现在两边一致：**来源只作为参数传下去，界面不写 `if (source === …)`**。
     */
    void api.modrinth
      .resourceVersions({ kind, projectId: hit.project_id, source })
      .then(setVersions)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [hit?.project_id, kind, source]);

  const install = async (v: ModrinthVersion) => {
    if (!api || !hit) return;
    setInstalling(v.id);
    try {
      const outcome = await installResourceVersion({
        api,
        kind,
        hit,
        version: v,
        instanceSlug: target?.config.slug ?? null,
        display: target ? target.config.name : '',
        installNote,
      });
      if (!outcome.ok) {
        const r = outcome.refusal;
        if (r.kind === 'forbidden') {
          toast(
            'warning',
            '作者不允许第三方下载',
            hit.title +
              ' 在 CurseForge 上关掉了「允许第三方分发」，任何启动器都下不到它。' +
              (r.pageUrl ? ' 去项目页自己下：' + r.pageUrl : ''),
          );
        } else if (r.kind === 'no-file') {
          toast('warning', '这个版本没有文件', hit.title);
        } else if (r.kind === 'no-url') {
          toast('warning', '这个文件下不了', '多半是作者关掉了「允许第三方分发」。去项目页自己下再放进去。');
        } else {
          toast('warning', '先选一个版本', '不知道要装到哪个实例里 —— 回下载页选一个再试。');
        }
        return;
      }
      toast('ok', '已装好', hit.title + ' ' + outcome.versionLabel + ' → ' + outcome.path);
      if (outcome.note) toast('info', '还有一步', outcome.note);
    } catch (e) {
      toast('err', '下载失败', e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  };

;

;

  if (!hit) {
    return (
      <EmptyState
        title="没有要安装的资源"
        desc="从「下载」页点一个资源的「安装」再进来。"
        actions={
          <Button variant="primary" onClick={closeResource}>
            回到下载页
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
          <Button size="sm" variant="ghost" onClick={closeResource}>
            <IconChevronRight style={{ transform: 'rotate(180deg)' }} /> 返回
          </Button>
          <h1 className="page-title">安装资源</h1>
        </div>
      </div>

      <div className="stack">
        {/* ---------- ① 资源信息卡 ---------- */}
        <div className="res-detail">
          <div className="res-detail-head">
            {hit.icon_url ? (
              <img className="res-detail-icon" src={hit.icon_url} alt="" />
            ) : (
              <span className="res-detail-icon res-detail-icon-ph" aria-hidden="true" />
            )}
            <div className="res-detail-main">
              <div className="res-detail-title">
                <span className="res-detail-name">{hit.title}</span>
                {hit.slug && hit.slug !== hit.title ? (
                  <span className="dim mono">{hit.slug}</span>
                ) : null}
              </div>
              <div className="res-detail-desc">{hit.description}</div>
              <div className="res-detail-meta">
                <span className="dim">{hit.author}</span>
                {(hit.categories ?? []).slice(0, 4).map((c) => (
                  <Chip key={c} tone="neutral">
                    {c}
                  </Chip>
                ))}
                <span className="dim">{formatCount(hit.downloads)} 次下载</span>
                {/* ★ C-18：来源跟着实际搜索的那一栏走，不写死 */}
                <span className="dim">来自 {sourceLabel}</span>
                {/* ★ 装到哪个实例必须一直看得见 —— 否则装完不知道进了哪儿 */}
                <span className="dim">装到：{target ? target.config.name : '（还没选版本）'}</span>
              </div>
            </div>
          </div>

          {/*
            ★★ 2026-09-23 用户（截图）：「资源单开的那一页的**这个不要**，这个太像 PCL 了」——
              原来这里有三个动作：转到 Modrinth / 转到 MC 百科 / 复制名称。
              **整排删掉**：这一页的职责就是"挑版本、装它"，不是当外链中转站；
              而且照抄 PCL 的按钮组也不是我们想要的观感。
              ★ 一并删掉它们用到的 `copyName` / `openExternal` 两个函数与
                `IconSearch` 导入 —— 留着就是死代码。
          */}
        </div>

        {/* ---------- ② 版本列表（与列表页同一份实现） ---------- */}
        {error ? (
          <Note
            tone="danger"
            title="取版本列表失败"
            actions={
              <Button size="sm" variant="secondary" onClick={load}>
                重试
              </Button>
            }
          >
            {error}
          </Note>
        ) : null}
        {loading && !versions ? <Spinner label="正在取版本列表…" /> : null}
        {versions ? (
          <VersionPicker
            hit={hit}
            versions={versions}
            loading={false}
            error={null}
            installing={installing}
            onPick={(v) => void install(v)}
            onRetry={load}
          />
        ) : null}
      </div>
    </>
  );
}

function formatCount(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(n);
}
