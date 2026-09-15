/**
 * 实例设置页（作用域表达 + 内存 + Java + 隔离）
 * ------------------------------------------------------------------
 * ★ 与原设计稿最大的差别：**这一页现在真的知道自己在改哪个实例**。
 *   原稿硬编码"当前实例：星河整合包"，页面上没有任何控件能换，
 *   用户会以为在改刚看的那个实例 —— 这是会破坏真实数据的误解。
 *   现在顶栏有常驻切换器，页头也明确写出当前实例。
 *
 * ★ 配置来源可见性（DESIGN_SYSTEM 7.18 / 7.20）：
 *   每个可继承项都带「跟随全局 / 已覆盖」标签，且切到"跟随全局"时
 *   **显示当前生效值**，而不是像原稿那样把输入框清空（那等于把
 *   "空值=继承"这个隐藏约定又请回来了）。
 */
import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { formatBytes } from '../domain';
// ★ Java 要求：`declaredJava` 是后端取回来的「Mojang 声明的版本」
import { useDeclaredJava } from '../hooks/useJavaRequirement.ts';
// ★ 字段映射只有一份（`toEngineInput`），带上加载器版本 —— 见它的说明
import { toEngineInput } from '../domain/java-requirement.ts';
import {
  deleteIntent,
  describeDelete,
  trashUnavailablePrompt,
} from '../domain/delete.ts';
import {
  parseServerAddress,
  serverAddressHint,
  toHalfWidth,
} from '../domain/server-address.ts';
import {
  Button,
  Card,
  CardTitle,
  Chip,
  EmptyState,
  Note,
  Segmented,
  Select,
  TextInput,
} from '../ui';
import {
  IconAlert,
  IconGear,
  IconGrid,
  IconInfo,
  IconJava,
  IconRam,
  IconShield,
  IconTerminal,
} from '../ui/Icons';
import {
  autoMemory,
  gbToGear,
  gearToGb,
  maxGear,
  memoryBar,
  memoryReasoning,
  resolveIsolation,
  resolveJavaRequirement,
  validateJavaRangeText,
  formatJavaRange,
} from '../domain';

export function InstanceSetup() {
  const {
    open: active,
    state,
    backend,
    updateConfig,
    go,
    toast,
    renameInstance,
    removeInstance,
    duplicateInstance,
    refreshJava,
  } = useApp();

  if (!active) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">实例设置</h1>
          </div>
        </div>
        <EmptyState
          title="还没有任何实例"
          desc="先创建一个实例，才能在这里调整它的 Java、内存与版本隔离。"
          actions={
            <>
              <Button
                variant="primary"
                onClick={() => window.dispatchEvent(new CustomEvent('ieml:create'))}
              >
                创建实例
              </Button>
              <Button variant="secondary" onClick={() => go('download')}>
                从整合包导入
              </Button>
            </>
          }
        />
      </>
    );
  }

  const machine = state.machine;
  const totalGb = machine?.totalMemoryGb ?? 16;
  const availableGb = machine?.availableMemoryGb ?? 8;
  const memoryGb = active.config.memoryMb / 1024;
  const bar = memoryBar(memoryGb, totalGb, availableGb);

  // ★ 同样要带上"Mojang 在版本 JSON 里声明的那个数"（26.2 写的是 25）
  const declaredJava = useDeclaredJava(active.mcVersion);
  const javaReq = useMemo(
    () =>
      resolveJavaRequirement(
        /*
         * ★ 加载器的种类**与版本**都交给规则引擎（P0-7）：Forge 的补丁号段
         *   与 Fabric Loader 的版本都会改变要求，而这里显示的是
         *   "这个实例需要 Java 几" —— 它必须与启动时判定的那个一致。
         */
        toEngineInput(
          {
            mcVersion: active.mcVersion,
            loaderKind: active.loader?.kind ?? null,
            loaderVersion: active.loader?.version ?? null,
            modCount: modCountFor(
              active.id,
              state.openInstanceId ?? active.id,
              state.mods.entries.length,
            ),
            hasOptifine: active.addons.some((a) => a.kind === 'optifine'),
          },
          declaredJava,
        ),
      ),
    [active, state.mods.entries.length, declaredJava, state.openInstanceId],
  );

  const matchedRuntime = useMemo(
    () => state.java.runtimes.find((r) => r.major === javaReq.major) ?? null,
    [state.java.runtimes, javaReq.major],
  );

  const isolation = useMemo(
    () =>
      resolveIsolation({
        mode: active.config.isolation,
        // ★ 审计发现这里硬编码了演示实例 id `'inst-star'`（来自 bridge/web.ts 的
        //   演示数据）混进真实逻辑。真判据只有"这个实例有没有自己的内容"：
        //   Mod / 附加组件 / 存档 —— 用 addons 与 Mod 数来判断，不认实例 id。
        hasContent: active.addons.length > 0 || state.mods.entries.length > 0,
        globalDefault: state.prefs.globalIsolation,
      }),
    [active, state.prefs.globalIsolation, state.mods.entries.length],
  );

  /* 内存自动值：显示真实算出来的值，并解释依据 */
  const autoSuggestion = useMemo(
    () =>
      autoMemory(
        state.mods.entries.length,
        active.addons.some((a) => a.kind === 'optifine') ? 'optifine' : 'vanilla',
        totalGb,
        availableGb,
      ),
    [state.mods.entries.length, active.addons, totalGb, availableGb],
  );

  const [javaRangeText, setJavaRangeText] = useState(
    active.config.javaRange ? formatJavaRange(active.config.javaRange) : '[17, 22)',
  );
  /** Java 自动下载：进度与忙碌态（以前是空回调，190 MB 下载全程无反馈） */
  const [javaDownloading, setJavaDownloading] = useState(false);
  const [javaProgress, setJavaProgress] = useState(0);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [rangeHint, setRangeHint] = useState<string | null>(null);

  const gear = gbToGear(memoryGb, totalGb);
  const gearMax = maxGear(totalGb);

  /** 摘要条用的两个值（**仅显示**：真正参与判定的是 `javaReq` / `matchedRuntime`） */
  const neededJava = javaReq;
  const javaReady = matchedRuntime !== null;

  /**
   * 跳到某一行并高亮一秒。
   *
   * ★ 为什么不是锚点 `<a href="#id">`：那样会改 URL 的 hash，而这是一个
   *   桌面应用（没有浏览器历史可言），hash 变化会在 Tauri 的 webview 里
   *   留下无意义的记录；而且我们要的是"滚过去 + 闪一下"，
   *   `scrollIntoView` + 一个临时 class 正好，不产生任何状态。
   */
  function jumpTo(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('row-flash');
    window.setTimeout(() => el.classList.remove('row-flash'), 1200);
  }

  return (
    <>
      {/* ==================== 页头 ==================== */}
      <div className="page-head">
        <div>
          <h1 className="page-title">实例设置</h1>
          <p className="page-desc">
            正在编辑 <b>{active.config.name}</b> · {active.mcVersion}
            {active.loader ? ` · ${loaderName(active.loader.kind)} ${active.loader.version}` : ' · 原版'}
          </p>
        </div>
        <div className="page-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              // ★ 真的复制目录（以前只克隆记录，副本是个空壳）
              void duplicateInstance(active.id)
                .then((bytes) =>
                  toast(
                    'ok',
                    '已创建副本',
                    bytes > 0
                      ? `存档 / Mod / 配置都复制过去了（${formatBytes(bytes)}）`
                      : '已创建副本（这个实例还没有磁盘文件）',
                  ),
                )
                .catch((e) =>
                  toast('err', '创建副本失败', e instanceof Error ? e.message : String(e)),
                );
            }}
          >
            创建副本
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const next = prompt('新的实例名称', active.config.name);
              if (next === null) return; // 取消
              /*
               * ★ 校验在 `renameInstance` 里做（判据只有一处）——
               *   这里只负责把结果告诉用户。
               */
              const why = renameInstance(active.id, next);
              if (why) {
                toast('warning', '这个名字不能用', why);
                return;
              }
              toast('ok', '已重命名', '目录名不变，只改显示名');
            }}
          >
            重命名
          </Button>
          <Button
            variant="danger"
            size="sm"
            title="默认移入系统回收站；按住 Shift 点击则永久删除"
            onClick={(e) => {
              const copy = describeDelete({
                what: `「${active.config.name}」`,
                items: [
                  `实例目录 instances/${active.config.slug}/ —— 存档、Mod、配置都在里面`,
                ],
                note: '共享的游戏文件不会被删除，其他版本还能用。',
                intent: deleteIntent(e),
              });
              if (!confirm(copy.message)) return;
              // ★ 审计发现：以前只删记录不删磁盘，确认框却写着会删存档。现在真的删。
              const report = (bytes: number, verb: string) => {
                toast(
                  'warning',
                  verb,
                  bytes > 0
                    ? `${active.config.name} 已从列表移除，磁盘上处理了 ${formatBytes(bytes)}`
                    : `${active.config.name} 已从列表移除（磁盘上本来就没有这个目录）`,
                );
                go('versions');
              };
              void removeInstance(active.id, copy.permanent)
                .then((bytes) => report(bytes, copy.doneVerb))
                .catch((err) => {
                  // ★ 回收站不可用时不静默降级，先问用户
                  if (!copy.permanent && confirm(trashUnavailablePrompt(err))) {
                    void removeInstance(active.id, true)
                      .then((bytes) => report(bytes, '已永久删除'))
                      .catch((e2) =>
                        toast('err', '磁盘目录没删掉', e2 instanceof Error ? e2.message : String(e2)),
                      );
                    return;
                  }
                  toast('err', '磁盘目录没删掉', err instanceof Error ? err.message : String(err));
                });
            }}
          >
            删除
          </Button>
        </div>
      </div>

      <div className="stack">
        {/* ==================== 作用域提示条 ====================
            ★ 一行说完（0.1.0-beta.1）：这句话的作用是让用户知道"改这里不会
              动到别的版本"，三个标签的含义本来就写在各自那一行的右端。
            ==================================================== */}
        <p className="scope-line">
          只作用于「{active.config.name}」，不影响其他实例 ——
          「跟随全局」的项会随全局变动，「已覆盖」的项已单独设定。
        </p>

        {/*
          ==================== 一眼摘要（0.1.0-beta.2 补）====================

          用户对旧的这一页的评价是「和 PCL 太像了，虽然确实很简便，适度调整」。

          PCL 的版本设置是一条**从头读到尾的长清单**：十几行长得一模一样，
          想改内存得先滚过隔离、标题、服务器、Java……而我们这一页比 PCL 多一个
          PCL 没有的概念：**每一项可以"跟随全局"或"已覆盖"**。

          所以这一条摘要做两件 PCL 没有的事：
            ① 把"这个版本实际会怎么启动"摆在一行里（内存 / Java / 隔离 / 标题）；
            ② 每一项都能点，点了**滚到那一行并高亮一下** —— 长清单里找一行
               本来要靠眼睛扫，现在是"从这里跳过去"。

          ★ 这里全部是**只读**的显示值（ADR-001 铁律①：一个值只能有一个地方能改），
            点击只滚动、不修改。
          ============================================================== */}
        <div className="setup-summary">
          <button
            type="button"
            className="ss-item"
            onClick={() => jumpTo('row-memory')}
            title="跳到内存分配"
          >
            <IconRam />
            <span className="ss-k">内存</span>
            <span className="ss-v mono">{memoryGb} GB</span>
            <span className="ss-src">
              {active.config.memorySource === 'global'
                ? '跟随全局'
                : active.config.memorySource === 'auto'
                  ? '自动'
                  : '自定义'}
            </span>
          </button>
          <button
            type="button"
            className="ss-item"
            onClick={() => jumpTo('row-java')}
            title="跳到 Java 运行时"
          >
            <IconJava />
            <span className="ss-k">Java</span>
            <span className="ss-v mono">{neededJava.major}</span>
            <span className={`ss-src${javaReady ? '' : ' warn'}`}>
              {javaReady ? '已就绪' : '未找到'}
            </span>
          </button>
          <button
            type="button"
            className="ss-item"
            onClick={() => jumpTo('row-isolation')}
            title="跳到版本隔离"
          >
            <IconGrid />
            <span className="ss-k">隔离</span>
            <span className="ss-v">
              {active.config.isolation === 'auto'
                ? '自动判定'
                : active.config.isolation === 'on'
                  ? '强制隔离'
                  : '已关闭'}
            </span>
            <span className="ss-src">{isolation.isolated ? '独立目录' : '共享目录'}</span>
          </button>
          <button
            type="button"
            className="ss-item"
            onClick={() => jumpTo('row-window')}
            title="跳到窗口标题"
          >
            <IconTerminal />
            <span className="ss-k">窗口标题</span>
            <span className="ss-v truncate">
              {active.config.windowTitle?.trim() ? active.config.windowTitle : '跟随全局'}
            </span>
          </button>
        </div>



        {/* ==================== 内存（常用，排最前） ====================
            ★ 顺序本身就是信息：打开"版本设置"的人，十次有八次是为了改
              内存或 Java。这两项在上面，其余按"改动频率"往下排。
            ============================================================ */}
        <Card id="row-memory">
          <CardTitle
            icon={<IconRam />}
            hint={`${state.mods.entries.length} 个 Mod · ${active.addons.length} 个附加组件`}
          >
            内存分配
          </CardTitle>

          <Segmented
            label="内存的来源"
            value={active.config.memorySource}
            onChange={(v) => updateConfig(active.id, { memorySource: v })}
            options={[
              { value: 'global', label: '跟随全局' },
              { value: 'auto', label: '自动配置' },
              { value: 'custom', label: '自定义' },
            ]}
          />

          <div className="ram-head">
            <span>
              已用 <b className="mono">{bar.usedGb}</b> / 共 <b className="mono">{bar.totalGb}</b> GB
            </span>
            <span className="dot" />
            <span>
              分给游戏 <b className="mono">{bar.gameGb}</b> GB
            </span>
            <span className="dot" />
            <span>
              空闲 <b className="mono">{bar.freeGb}</b> GB
            </span>
            {bar.overAvailable ? (
              <Chip tone="warning">超过当前可用 {availableGb} GB，会按可用值启动</Chip>
            ) : null}
          </div>

          <div className="ram-bar" aria-hidden="true">
            <i className="used" style={{ width: `${(bar.usedGb / bar.totalGb) * 100}%` }} />
            <i className="game" style={{ width: `${(bar.gameGb / bar.totalGb) * 100}%` }} />
          </div>

          <div className="ram-control">
            <input
              type="range"
              className="range"
              min={0}
              max={gearMax}
              value={gear}
              aria-label="内存分配档位"
              disabled={active.config.memorySource !== 'custom'}
              onChange={(e) => {
                const gb = gearToGb(Number(e.target.value));
                updateConfig(active.id, { memoryMb: Math.round(gb * 1024), memorySource: 'custom' });
              }}
            />
            <span className="ram-value mono">{memoryGb} GB</span>
          </div>

          {/* ★ 依据行用真实算出来的数值，不写死（原稿写死"向 2.7 GB 递进"是错的） */}
          <div className="ram-basis">
            <IconInfo />
            <span>
              {active.config.memorySource === 'auto'
                ? memoryReasoning(state.mods.entries.length, autoSuggestion)
                : active.config.memorySource === 'global'
                  ? `当前跟随全局设置（${Math.round(state.prefs.globalMemoryMb / 1024)} GB），改动全局会同步影响本实例。`
                  : `自定义值。本实例的自动配置建议为 ${autoSuggestion.gb} GB（共 ${state.mods.entries.length} 个 Mod）。`}
            </span>
          </div>
        </Card>

        {/* ==================== Java ==================== */}
        <Card id="row-java">
          <CardTitle
            icon={<IconJava />}
            hint={`当前规则：${javaReq.rule}`}
          >
            Java 运行时
          </CardTitle>

          <Note tone={matchedRuntime ? 'success' : 'warning'} icon={<IconInfo />} title={javaReq.reason}>
            {matchedRuntime ? (
              <>
                已匹配到 <span className="mono">{matchedRuntime.vendor} {matchedRuntime.version}</span>
                （{matchedRuntime.path}）
              </>
            ) : (
              <>
                本机没有 Java {javaReq.major}。可以
                <Button
                  size="sm"
                  variant="secondary"
                  style={{ margin: '0 6px' }}
                  loading={javaDownloading}
                  onClick={async () => {
                    /*
                     * ★ 审计发现两处问题：
                     *   ① 没有 try/catch —— 下载失败是一次**未处理的 Promise 拒绝**，
                     *      界面上只有那句"正在获取 Java"，然后就永远没有下文；
                     *   ② 进度回调是空函数 —— 一个 ~190 MB 的下载**完全不显示进度**。
                     *   现在：真进度 + 失败可见。
                     */
                    setJavaDownloading(true);
                    setJavaProgress(0);
                    try {
                      const rt = await backend.downloadJava(
                        javaReq.major,
                        (pct) => setJavaProgress(pct),
                      );
                      refreshJava([...state.java.runtimes, rt]);
                      toast('ok', `Java ${rt.major} 已就绪`, rt.path);
                    } catch (e) {
                      toast(
                        'err',
                        'Java 下载失败',
                        e instanceof Error ? e.message : String(e),
                      );
                    } finally {
                      setJavaDownloading(false);
                    }
                  }}
                >
                  {javaDownloading ? `下载中 ${javaProgress}%` : '自动下载'}
                </Button>
                或手动指定。
              </>
            )}
          </Note>

          <Select
            label="选择方式"
            value={active.config.javaMode}
            onChange={(e) =>
              updateConfig(active.id, {
                javaMode: e.target.value as 'auto' | 'range' | 'instance-folder' | 'path',
              })
            }
          >
            <option value="auto">自动选择</option>
            <option value="range">按版本区间选择</option>
            <option value="instance-folder">使用实例文件夹中的 Java</option>
            <option value="path">使用指定的 Java</option>
          </Select>

          {active.config.javaMode === 'range' ? (
            <div className="field-row">
              <label className="field-label" htmlFor="jr">
                允许的版本区间
                <span className="field-hint">方括号含该值、圆括号不含</span>
              </label>
              <div className="field-control">
                <input
                  id="jr"
                  className="input mono"
                  value={javaRangeText}
                  onChange={(e) => {
                    setJavaRangeText(e.target.value);
                    const r = validateJavaRangeText(e.target.value);
                    if (r.ok) {
                      setRangeError(null);
                      setRangeHint(r.hint ?? null);
                      updateConfig(active.id, { javaRange: r.range });
                    } else {
                      setRangeError(r.error);
                      setRangeHint(null);
                    }
                  }}
                />
              </div>
              <span />
            </div>
          ) : null}

          {rangeError ? (
            <Note tone="danger" icon={<IconAlert />}>
              {rangeError}
            </Note>
          ) : rangeHint ? (
            <Note tone="info" icon={<IconInfo />}>
              {rangeHint}
            </Note>
          ) : null}

          {active.config.javaMode === 'path' ? (
            <Select
              label="指定 Java"
              value={active.config.javaPath ?? ''}
              onChange={(e) => updateConfig(active.id, { javaPath: e.target.value })}
            >
              <option value="">请选择…</option>
              {state.java.runtimes.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.vendor} {r.version}（{r.arch}）{r.disabledByDefault ? ' · 官方 Java，默认禁用' : ''}
                </option>
              ))}
            </Select>
          ) : null}
        </Card>

        {/* ==================== 启动选项 ==================== */}
        <Card>
          <CardTitle icon={<IconGear />}>启动选项</CardTitle>

          <div className="field-row" id="row-isolation">
            <label className="field-label" htmlFor="iso">
              版本隔离
              <span className="field-hint">存档 / Mod / 配置是否与其他实例共用</span>
            </label>
            <div className="field-control">
              <select
                id="iso"
                className="input"
                value={active.config.isolation}
                onChange={(e) =>
                  updateConfig(active.id, {
                    isolation: e.target.value as 'auto' | 'on' | 'off',
                  })
                }
              >
                <option value="auto">自动判定（推荐）</option>
                <option value="on">强制隔离</option>
                <option value="off">不隔离（共享）</option>
              </select>
            </div>
            <Chip tone={active.config.isolation === 'auto' ? 'neutral' : 'accent'}>
              {active.config.isolation === 'auto' ? '自动' : '已覆盖'}
            </Chip>
          </div>

          {/* 判定结果与依据 —— 用户选"自动"时必须告诉他启动器会怎么判 */}
          <div className={`iso-verdict${isolation.isolated ? '' : ' danger'}`}>
            <IconInfo />
            <span>
              {/*
                ★ 审计发现：这个下拉框**完全不影响启动** ——
                  Rust 侧启动永远用 `instances/{slug}/game`，
                  `resolve_isolation` 这个命令前端从来没调过。
                  所以"不隔离（共享）"是一项**做不到的承诺**：
                  存档与 Mod 永远不会被共用。这里如实说明，
                  而不是继续显示"将与其他实例共用目录"这句假话。
              */}
              {active.config.isolation === 'off' ? (
                <>
                  <b>共享模式目前还没接上</b> —— 启动器现在总是用每个实例自己的
                  目录（存档 / Mod / 配置都在 <span className="mono">instances/{active.config.slug}/game</span>）。
                  这个选择会被记住，但要等共享目录真正实现后才会生效；
                  在此之前不会发生任何共用。
                </>
              ) : (
                <>
                  <b>{isolation.isolated ? '将启用隔离' : '将启用隔离（自动判定建议隔离）'}</b> ——{' '}
                  {isolation.reason}
                  <br />
                  每个实例的存档与 Mod 互相独立（这是当前唯一实现的行为）。
                </>
              )}
            </span>
          </div>

          {isolation.warning ? (
            <Note tone="warning" icon={<IconAlert />}>
              {isolation.warning}
            </Note>
          ) : null}

          <TextInput
            rowId="row-window"
            label="游戏窗口标题"
            hint="留空则跟随全局"
            value={active.config.windowTitle ?? ''}
            placeholder={
              state.instances.find((i) => i.id === active.id)
                ? `跟随全局（当前：${active.config.name}）`
                : ''
            }
            source={active.config.windowTitle ? 'over' : 'inherit'}
            onToggleSource={() => {
              if (active.config.windowTitle) {
                updateConfig(active.id, { windowTitle: undefined });
                toast('info', '已恢复跟随全局');
              } else {
                updateConfig(active.id, { windowTitle: active.config.name });
                toast('info', '已单独设定', '现在这一项不再随全局设置变动');
              }
            }}
            onChange={(e) => updateConfig(active.id, { windowTitle: e.target.value })}
          />

          {/*
            ★ 启动后自动进入服务器（PCL2 的实例设置里有这一项）。

              两个细节：
              ① **全角标点即时换成半角**（源码研读第 13.4 节）：
                 中文输入法下 `mc.example.com：25565` 是极自然的手误，
                 游戏只认半角，报错里两个地址看起来一模一样 ——
                 不处理就是"我明明输对了却连不上"。
              ② 提示行说清"真正会连到哪里"，**不偷偷改地址**：
                 端口写坏时只丢端口、不替用户换目标（宁可连默认端口，
                 也不要悄悄连到别的服务器上）。
          */}
          <ServerAddressField
            value={active.config.joinServer ?? ''}
            onChange={(v) => updateConfig(active.id, { joinServer: v })}
          />
        </Card>

        {/* ==================== 危险操作 ==================== */}
        <Card>
          <CardTitle icon={<IconShield />} hint="这些操作会改动真实文件">
            其他
          </CardTitle>
          <div className="field-row">
            <span className="field-label">
              重置为全局设置
              <span className="field-hint">把本实例所有「已覆盖」的项恢复为跟随全局</span>
            </span>
            <div className="field-control">
              <Button
                variant="secondary"
                onClick={() => {
                  const covered: string[] = [];
                  if (active.config.isolation !== 'auto') covered.push('版本隔离');
                  if (active.config.memorySource !== 'global') covered.push('内存分配');
                  if (active.config.javaMode !== 'auto') covered.push('Java 选择');
                  if (active.config.windowTitle) covered.push('窗口标题');
                  if (active.config.joinServer) covered.push('自动进入服务器');
                  const msg =
                    covered.length === 0
                      ? '本实例没有单独设定过的项，重置不会改变任何东西。'
                      : `以下 ${covered.length} 项将被重置为跟随全局：\n\n· ${covered.join('\n· ')}\n\n` +
                        `★ 重置后这些值就找不回来了（当前还没有"设置备份"功能）。确定继续？`;
                  if (!confirm(msg)) return;
                  /*
                   * ★ 审计发现：这句话以前写着「重置前会自动备份当前设置」——
                   *   而整个项目**没有任何备份实现**。用户信了这句话就点了确定，
                   *   被覆盖的每实例设置再也回不来。现在如实警告。
                   */
                  updateConfig(active.id, {
                    isolation: 'auto',
                    memorySource: 'global',
                    javaMode: 'auto',
                    windowTitle: undefined,
                    joinServer: undefined,
                    customInfo: undefined,
                    jvmArgs: undefined,
                    gameArgs: undefined,
                  });
                  toast('ok', '已重置', `恢复了 ${covered.length} 项为跟随全局`);
                }}
              >
                重置
              </Button>
            </div>
            <span />
          </div>
        </Card>
      </div>
    </>
  );
}

/**
 * 服务器地址输入框（含**全角→半角**即时纠正）。
 *
 * ## 为什么要有这一条
 *
 * 源码事实（研读第 13.4 节）：PCL2 在服务器地址输入框的 `TextChanged` 里
 * 自动把全角标点换成半角。原因是中文输入法下打 `mc.example.com：25565`
 * 极其自然（冒号被输入法换成全角 `：`），而游戏只认半角 ——
 * 报错信息里两个地址看起来**一模一样**，用户完全不知道为什么连不上。
 *
 * ## 为什么"改了要说"
 *
 * 悄悄改输入框里的内容是一种欺骗：用户下次看自己的配置会发现
 * "我明明写的是全角冒号，怎么变了"。所以这里两件事都做：
 *   ① 真的替换（省掉他手动去改）；
 *   ② 在下面明确写一行「已自动把全角字符换成半角」+ 最终地址。
 *
 * 端口写坏时**只丢端口、不换目标**：宁可让游戏连默认端口，
 * 也不要悄悄连到另一个服务器上（那才是真的灾难）。
 */
function ServerAddressField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const hint = serverAddressHint(value);
  const parsed = parseServerAddress(value);
  const tone = hint?.tone ?? 'ok';
  return (
    <div className="field-block">
      <TextInput
        label="启动后自动进入服务器"
        hint="留空则停在主菜单 · 全角标点会自动改半角"
        value={value}
        placeholder="mc.example.com:25565"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          // ★ 边输边纠正：粘贴进来的全角冒号也会被立刻换掉
          onChange(toHalfWidth(e.target.value));
        }}
      />
      {hint ? (
        <div className={`srv-hint srv-${tone}`}>
          {tone === 'warn' ? <IconAlert /> : <IconInfo />}
          <span>{hint.text}</span>
          {parsed.error ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                // ★ 给一条出路，而不只是报错（设计系统 13 章：给理由，也给路）
                onChange(parsed.host);
              }}
            >
              只用主机名 {parsed.host}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
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

/** Mod 数量：只有「当前打开的版本」才有真实值，其它情况给 0（避免张冠李戴） */
function modCountFor(instanceId: string, currentId: string, fallback: number): number {
  return instanceId === currentId ? fallback : 0;
}
