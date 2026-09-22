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
import { IconChevronRight, IconSearch } from '../ui/Icons';
import { VersionPicker } from '../components/ResourceBrowser';
import { useRealApi } from '../hooks/useRealApi';
import { useApp } from '../state/AppContext';
import { installResourceVersion } from '../flows/resource-install';
import type { ModrinthHit, ModrinthVersion, ResourceKindName } from '../bridge/tauri';

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
    void api.modrinth
      .versions(hit.project_id)
      .then(setVersions)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [hit?.project_id]);

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
        installNote: null,
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

  /*
   * ★ 复制名称 / 转到外部页面：PCL 详情页那两个动作的等价物 ——
   *   用户求助时最常要贴的就是资源名与链接。
   */
  const copyName = async () => {
    if (!hit) return;
    try {
      await navigator.clipboard.writeText(hit.title);
      toast('ok', '已复制名称', hit.title);
    } catch {
      toast('info', '名称', hit.title);
    }
  };

  const openExternal = async (url: string, label: string) => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch {
      toast('info', label, url);
    }
  };

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
                <span className="dim">来自 Modrinth</span>
                {/* ★ 装到哪个实例必须一直看得见 —— 否则装完不知道进了哪儿 */}
                <span className="dim">装到：{target ? target.config.name : '（还没选版本）'}</span>
              </div>
            </div>
          </div>

          <div className="res-detail-actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void openExternal(
                  'https://modrinth.com/project/' + (hit.slug || hit.project_id),
                  'Modrinth 页面',
                )
              }
            >
              <IconSearch /> 转到 Modrinth
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void openExternal(
                  'https://search.mcmod.cn/s?key=' + encodeURIComponent(hit.title),
                  'MC 百科',
                )
              }
            >
              转到 MC 百科
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void copyName()}>
              复制名称
            </Button>
          </div>
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
