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
import { VersionPicker } from '../components/ResourceBrowser';
import { useRealApi } from '../hooks/useRealApi';
import { useApp } from '../state/AppContext';
import { useBackTarget } from '../state/back-nav';
import { installResourceVersion } from '../flows/resource-install';
/*
 * ★★★★ 2026-10-17（用户）：「在 modr 的左边加一个全部，并且默认为全部，
 *   这样即使有资源里不允许第三方下载，也可以得到互补了」。
 *
 *   来源必须写在**这一页**（用户明确说：卡片上不放来源徽章，来源信息放详情页）：
 *     · 「来自 Modrinth + CurseForge（两个来源都有）」
 *     · 有一份下不了 ⇒ 说清用的是哪一份
 *     · 两份都下不了 ⇒ 如实说「两个来源都不能直接下载」
 *   三句话的判据在 `domain/resource-merge.ts::describeSource`（纯函数、有测试），
 *   这一页只负责把它渲染出来，**不在这里拼措辞**。
 */
import { describeSource } from '../domain/resource-merge';
/*
 * ★★★★ 2026-10-17（取版本互补 —— `resource-merge` 留下的那个缺口）：
 *   合并后取版本原来只走 `preferred`（能下载的那一份）；那一份
 *   **没有能装到当前实例的版本**（或干脆问不到）时界面显示「无」，
 *   而另一个来源明明有 —— 这正是「全部」要解决的互补问题。
 *   判据在 `domain/version-sources.ts`（纯函数、可注入假 fetch 真跑）。
 */
import { lookupVersionsFrom, versionSourcesToTry, versionSourceNote } from '../domain/version-sources';
/*
 * ★ 「这一份到底有没有能装到这个实例的版本」—— 与版本列表的筛选**共用同一段实现**
 *   （`strictlyCompatibleVersions`），所以不会出现两套筛选口径。
 */
import { hasCompatibleVersion } from '../components/version-filter';
import type { ModrinthHit, ModrinthVersion, ResourceKindInfo, ResourceKindName, ResourceSourceName } from '../bridge/tauri';

export function ResourceInstallPage() {
  const { state, closeResource, toast } = useApp();
  const { api } = useRealApi();
  /** store 里存的是 unknown（那一层不解析 Modrinth 字段），到这里收窄 */
  const hit = (state.resourceTarget?.hit ?? null) as ModrinthHit | null;
  const kind = (state.resourceTarget?.kind ?? '') as ResourceKindName;

  /*
   * ★ 2026-10-09：返回按钮全站只有顶栏那一个（用户：「所有页面的返回按钮做一个固定位置」）
   *   ⇒ 这一页只是**登记**"我能回下载页"，按钮由外壳画在固定位置。
   *   原来这里自己在页头画了一个（右箭头转 180°），已删除。
   */
  useBackTarget({ to: '下载页', onClick: closeResource });

  const [versions, setVersions] = useState<ModrinthVersion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  /**
   * ★★ 「这一批版本来自哪一份、为什么换了源」—— `versionSourceNote` 算好的那一句
   *   （回退时必须说出来，见下面 `load` 的说明）；`null` = 不用多说。
   */
  const [versionsNote, setVersionsNote] = useState<string | null>(null);
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
   *
   * ★★★★ 2026-10-17：来源改成**读数据里的**（`hit.provenance`）——
   *   「全部」模式下两个源的结果合成了一张表，**切换器上那一格叫 `all`**，
   *   它既不是一个能问接口的来源，也说不清"这条到底来自哪一边"。
   *   合并层算好的那个 `preferred` 才是唯一答案（"优先用能下载的那一份"）。
   *   ★ 没有 provenance（老路径）时退回原来的判据（切换器上那个源），
   *     这样老行为一字不变。
   */
  const source: ResourceSourceName =
    hit?.provenance?.preferred ??
    (state.resourceTarget?.source === 'curseforge' ? 'curseforge' : 'modrinth');
  /** 来源那一行 + 需要额外说清的事（判据在 `domain/resource-merge.ts`） */
  const sourceSaid = describeSource(hit?.provenance, source);

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
     *
     * ★★★★ 2026-10-17：**再往前一步 —— 一份问不出来就换另一份**。
     *
     *   「全部」下这条资源可能被两个源同时收录（`provenance.sources` 两条），
     *   而合并层只把 `preferred`（能下载的那一份）交给了安装。那一份
     *   **没有能装到当前实例的版本**（或问不到）时，旧行为是显示「无」——
     *   而另一个来源明明有。所以这里按 `versionSourcesToTry` 给的顺序问下去，
     *   第一个给出"有能装到这个实例的版本"的源就是答案。
     *
     *   ★ 三条不许含糊的：
     *     ① **换源要换身份**：每个目标带它**自己那一份**的 `project_id`
     *        （拿 Modrinth 的 id 去问 CF = 把"拿错了标识"说成"上游没有"，C-1 栽过）；
     *     ② **两源的版本不混在一张表里**：所以是"换一批"，不是"拼起来"——
     *        换成功了要在这一页说清这一批来自哪个来源（`versionSourceNote`）；
     *     ③ **两个源都问了才叫真的没有**；只要有一份非空就列出来让人自己判断
     *        （"筛完不剩就退回全量"是同一条规矩，见 `version-filter.ts`）。
     */
    const targets = versionSourcesToTry(hit.provenance, { source, projectId: hit.project_id });
    void lookupVersionsFrom<ModrinthVersion>({
      targets,
      fetch: (t) =>
        api.modrinth.resourceVersions({
          kind,
          projectId: t.projectId,
          source: t.source,
        }),
      /*
       * ★ "这一份算不算数" = **有没有能装到当前实例的版本**（与列表筛选同一份判据）。
       *   没有目标实例时不筛（那时"有哪些版本"本身就是要给用户看的）。
       */
      usable: (list) => hasCompatibleVersion(list, { projectType: hit.project_type, target }),
    })
      .then((got) => {
        setVersions(got.versions);
        /*
         * ★ 回退 / 都没给出来时**必须说一句**（见 `versionSourceNote` 的三种情形）。
         *   全都没成时 `source` 是 null —— 那时列表为空的「无」是"都问了、都没有"，
         *   不是"我们只问了其中一个源"。
         */
        setVersionsNote(versionSourceNote(hit.provenance, got));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  /*
   * ★ 依赖里带 `target?.mcVersion`：上面那个 `usable` 判据就是按它算的
   *   （"这一份有没有能装到这个实例的版本"）。换了实例却不重取，
   *   就会出现"列表按新实例筛、来源却还是按旧实例挑的那一份"。
   */
  useEffect(load, [hit?.project_id, kind, source, target?.mcVersion]);

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
          /*
           * ★★ 两个源都下不了时说"在 CurseForge 上关掉了"就不对了
           *   （Modrinth 那一份也下不了）。判据读合并层的结论，
           *   措辞用详情页那一句（同一句话只有一处）。
           */
          const both = hit.provenance && hit.provenance.sources.length > 1;
          toast(
            'warning',
            hit.provenance && !hit.provenance.downloadable
              ? both
                ? '两个来源都不能直接下载'
                : '这个来源不能直接下载'
              : '作者不允许第三方下载',
            hit.provenance && !hit.provenance.downloadable
              ? sourceSaid.warning ?? hit.title
              : hit.title +
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
        {/* ★ 返回按钮不在这里画（全站只有顶栏那一个，见上面 `useBackTarget`）——
            页头只留标题，这样它的位置在所有页面上都一样。 */}
        <div>
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
                {/*
                  ★★ 来源（C-18 起跟着实际来源走；2026-10-17 起连"两个来源都有"
                     与"用的是哪一份"一起说）—— 这句话是**详情页**的，不在卡片上。
                */}
                <span className="dim">{sourceSaid.text}</span>
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
        {/*
          ★★ 「两个来源都不能直接下载」/「有一份下不了、用的是哪一份」——
            这两句只在这里（详情页）说，卡片上不放来源徽章（用户要求保持干净）。
            ★ 措辞来自 `describeSource`，不在这一页拼字符串（同一句话只准有一处）。
        */}
        {sourceSaid.warning ? (
          <Note tone="warning" title="来源说明">
            {sourceSaid.warning}
          </Note>
        ) : null}
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
            /*
             * ★ 把「装到哪个实例」传下去：这一页既然写明了"装到：X"，
             *   版本列表就该按 X 筛（整合包不筛、其余筛 —— 判据在
             *   `version-filter.ts`，与列表页那几处同一份实现）。
             *   ★ 这也是"回退"判据的另一半：`usable` 判的是"这一份里有没有
             *     能装到 X 的版本"，两边必须同一个 target，否则会出现
             *     "换了源却还是列不出能装的"。
             */
            target={target}
            sourceNote={versionsNote}
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
