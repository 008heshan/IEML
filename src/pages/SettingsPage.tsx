/**
 * 设置（一级页 · 全局）
 * ------------------------------------------------------------------
 * 这里是**全局**设置。单个版本的 Java / 内存 / 隔离在「版本列表 → 双击 →
 * 设置」里改 —— 两处的分工在顶部一句话说清（ADR-028）。
 *
 * 相对原设计稿的减法：
 *   * 去掉"界面缩放 / 毛玻璃 / 粒子效果"等无实际作用的装饰项
 *   * Java 环境改成**可看到路径与占用、可删除**（ADR-013 的硬要求）
 *   * 账号区压实：一个头像行 + 两个按钮
 */
import { useEffect, useState } from 'react';
import { useApp } from '../state/AppContext';
import { Button, Card, CardTitle, Chip, CustomSelect, Field, Note, Segmented, Switch } from '../ui';
import {
  IconAlert,
  IconGear,
  IconInfo,
  IconJava,
  IconRefresh,
  IconShield,
  IconTrash,
} from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import { humanBytes } from '../hooks/useRealApi';
import { useLauncherUpdate } from '../hooks/useLauncherUpdate';
import {
  deleteIntent,
  describeDelete,
  trashUnavailablePrompt,
} from '../domain/delete.ts';
import type { DownloadSourcesPayload } from '../bridge/tauri';
import { APP_VERSION, STAGE_LABEL, versionStage } from '../domain/version-info.ts';
// ★ 账号面板**只在顶栏**（用户："设置这里的账号一栏可以删除了"）。
//   一份实现仍然只有那一处（`components/AccountPanel.tsx`），这里不再重复摆一遍。


/**
 * 版本号里的阶段 → 中文名。
 *
 * ★ 直接用 `domain/version-info.ts` 的 `STAGE_LABEL` / `versionStage`，
 *   不在页面里再写一份映射 —— 那种"文案表各写一份"的分叉，这个仓库
 *   已经踩过好几次（服务器地址规则表、加载器能力表都是）。
 */
function stageLabelOf(version: string): string {
  if (!version) return '版本未知';
  return STAGE_LABEL[versionStage(version)];
}

export function SettingsPage() {
  const { state, rescanJava, toast, backend, refreshJava, prefsSaveFailed } = useApp();
  const { api } = useRealApi();
  /** 启动器自身的更新（不是 Mod 更新，见 useLauncherUpdate 顶部说明） */
  const upd = useLauncherUpdate();

  const [downloaded, setDownloaded] = useState<Array<{ major: number; path: string; bytes: number; usable: boolean }>>([]);
  const [busy, setBusy] = useState(false);
  /** 清理缓存的两段式流程（先算再删）的忙碌态 —— 两条清理已合并，所以只有一个状态 */
  const [cleaning, setCleaning] = useState(false);
  /** 下载源健康报告的按需快照（null = 还没查过） */
  const [sources, setSources] = useState<DownloadSourcesPayload | null>(null);

  /** 读失败时不能显示成"一个都没下过" —— 那是两句完全不同的话 */
  const [javaListError, setJavaListError] = useState<string | null>(null);
  /** 低性能损耗模式（本机偏好，存 localStorage；见 main.tsx 的说明） */
  const [lowPerf, setLowPerf] = useState(() => localStorage.getItem('ieml.lowPerf') === '1');

  async function loadDownloadedJava() {
    if (!api) return;
    try {
      setDownloaded(await api.java.listDownloaded());
      setJavaListError(null);
    } catch (e) {
      // ★ 审计发现这里以前 `catch { /* 忽略 */ }` ——
      //   读失败与"没下过 Java"在界面上长得一模一样，用户会以为记录丢了。
      setJavaListError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * ★ 进页面就载入一次。
   *
   *   审计发现：`loadDownloadedJava` 只在"下载完 Java / 删完 Java"之后被调用，
   *   **从来没有在进入设置页时调用** —— 于是每次启动都显示
   *   「还没有通过 IEML 下载过 Java。」，哪怕已经下过；
   *   而那一栏的"删除 / 释放空间"按钮永远见不到。
   */
  useEffect(() => {
    void loadDownloadedJava();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          {/* ★ 2026-09-16 用户（截图）：删掉副标题"全局设置 · 单个版本的内存 / Java / 隔离在版本列表里双击它改" */}
        </div>
      </div>

      <div className="stack">
        {/*
          ★ 偏好写盘失败要**说出来**（原来这里是空 catch，用户只会觉得
            "设置改完重启就没了"，而日志里一个字都没有）。
            这与"读失败 ≠ 一个都没下过"是同一条原则：坏了就说坏了。
        */}
        {prefsSaveFailed ? (
          <Note tone="danger" icon={<IconAlert />} title="设置存不进磁盘">
            这一页的改动<b>这次会话有效，重启就会丢</b>。原因：{prefsSaveFailed}
            <br />
            数据目录可能没有写权限（被杀毒软件保护、或是只读盘）。可以试试点上面的
            「打开数据目录」看能不能写文件。
          </Note>
        ) : null}

        {/* ★ 外观与存储并排（用户要求："把存储移到外观的右侧"） */}
        <div className="set-cols">
        {/* ==================== 外观 ====================
            ★ 与「存储」并排（用户："把存储移到外观的右侧"），所以这一卡只放
              "看得见"的偏好：主题 + 减少动效。
            ★ 「窗口尺寸」**已经搬回「新版本的默认值」**（用户要求）。
              它上一次被我挪进来，理由是"窗口多大算外观"——用户不认这个理由，
              而且它确实更像"新开一个游戏窗口用多大"，搬回去。
            ============================================== */}
        <Card>
          <CardTitle icon={<IconGear />}>外观</CardTitle>

          {/* ★★ 2026-09-16 用户要求"删除白色模式"：主题选择整行删掉。
              只有深色，没有可选项 —— 摆一个只有一个选项的选择器是假控件。 */}

          {/*
            ★★ 低性能损耗模式（用户 2026-09-16："在外观选项里加一个低性能损耗模式"）。
            关掉的是**装饰**：卡片的磨砂（整屏几十层 backdrop-filter 是实打实的 GPU 开销）、
            页面标题区的磨砂、以及背景那三团氛围光晕。功能与布局一点不动。
            存 localStorage（本机偏好），见 main.tsx 里的说明。
          */}
          <div className="field-row">
            <span className="field-label">
              低性能损耗模式
              {/* ★ 2026-09-16 用户（截图）：删掉"关掉磨砂与氛围光晕，弱机更流畅" */}
            </span>
            <div className="field-control">
              <Switch
                label="低性能损耗模式"
                checked={lowPerf}
                onChange={(v) => {
                  setLowPerf(v);
                  localStorage.setItem('ieml.lowPerf', v ? '1' : '0');
                  document.documentElement.classList.toggle('low-perf', v);
                  toast('ok', v ? '已开启低性能损耗模式' : '已关闭低性能损耗模式');
                }}
              />
            </div>
            <span />
          </div>

          <div className="field-row">
            <span className="field-label">
              减少动效
              <span className="field-hint">关闭过渡动画</span>
            </span>
            <div className="field-control">
              <Switch
                label="减少动效"
                checked={state.prefs.reducedMotion}
                onChange={(v) => {
                  window.dispatchEvent(
                    new CustomEvent('ieml:prefs', { detail: { reducedMotion: v } }),
                  );
                  document.documentElement.classList.toggle('reduce-motion', v);
                  toast('ok', v ? '已开启减少动效' : '已关闭减少动效');
                }}
              />
            </div>
            <span />
          </div>
        </Card>

        {/* ==================== 存储 ==================== */}
        <Card>
          <CardTitle icon={<IconAlert />}>存储</CardTitle>
          <div className="field-row">
            <span className="field-label">
              数据目录
              <span
                className="field-hint mono truncate"
                title={state.machine?.dataDir ?? '未知'}
                style={{ maxWidth: 280 }}
              >
                {shortPath(state.machine?.dataDir ?? '未知')}
              </span>
            </span>
            <div className="field-control">
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  /*
                   * ★ 走 Rust 命令，**不要**在前端调 @tauri-apps/plugin-opener 的
                   *   `openPath`。那个命令会先过 opener 插件的 scope 白名单，而
                   *   `opener:allow-open-path` 只授权"可以调用这个命令"、不含任何
                   *   路径；于是 `openPath(数据目录)` 必然返回 `forbidden path`，
                   *   老代码的 `catch {}` 把它吞掉，用户看到的就是"点了没反应"。
                   *   `open_data_dir` 在 Rust 侧直接调 `app.opener().open_path(...)`，
                   *   不经过插件命令的 scope，所以一定打得开。
                   */
                  if (!api) {
                    toast('info', '数据目录', state.machine?.dataDir ?? '未知');
                    return;
                  }
                  try {
                    const dir = await api.launcher.openDir('data');
                    toast('ok', '已打开数据目录', dir);
                  } catch (e) {
                    toast('err', '打不开目录', e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                打开
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const dir = state.machine?.dataDir ?? '';
                  try {
                    await navigator.clipboard.writeText(dir);
                    toast('ok', '已复制路径', dir);
                  } catch {
                    toast('info', '数据目录', dir);
                  }
                }}
              >
                复制路径
              </Button>
              {/*
                ★★ 2026-09-17 用户：「应该可以让玩家新建游戏根目录路径」，
                  并明确语义是「单独建一个根目录，源目录不删」。

                ★ 为什么这里**不叫「迁移」也不叫「移动」**：这个动作不搬任何文件。
                  新目录是空的，游戏要重新装；旧的版本 / 存档 / Mod
                  原封不动留在原处，随时能把记录改回去。
                  文案必须让用户看完就知道"我的东西还在"，否则他不会敢点。
              */}
              <Button
                size="sm"
                variant="ghost"
                disabled={!api}
                onClick={async () => {
                  if (!api) {
                    toast('info', '演示模式', '浏览器里不能改数据目录');
                    return;
                  }
                  let picked: string | null = null;
                  try {
                    /*
                     * 动态 import：`@tauri-apps/plugin-dialog` 只在桌面版有意义，
                     * 静态引入会把它拖进浏览器演示模式的包里。
                     */
                    const { open } = await import('@tauri-apps/plugin-dialog');
                    picked = await open({
                      directory: true,
                      multiple: false,
                      title: '选一个新的游戏根目录（旧的不会被动）',
                    });
                  } catch (e) {
                    toast('err', '打不开文件夹选择框', e instanceof Error ? e.message : String(e));
                    return;
                  }
                  if (!picked) return; // 用户取消 —— 不是错误，什么都不说

                  try {
                    const r = await api.launcher.setDataRoot(picked);
                    // ★ 后端已经把该拒的都拒了（嵌套、只读、和当前相同），
                    //   走到这里就是真的记下了。下面把三件事一次说清：
                    //   装在哪、旧的怎么样、什么时候生效。
                    const extra = [
                      r.hasExistingData ? '这个目录里已经有游戏数据，会直接用那一份' : null,
                      r.onSystemDrive ? '★ 它在系统盘上，游戏多了会把系统盘写满' : null,
                    ]
                      .filter(Boolean)
                      .join('；');
                    toast(
                      r.onSystemDrive ? 'warning' : 'ok',
                      '已记录新的游戏根目录（重启后生效）',
                      `新的：${r.path}　旧的：${r.previous} —— 旧目录里的东西一个都没动，` +
                        `想换回来重新选它就行。${extra}${extra ? '。' : ''}`,
                    );
                  } catch (e) {
                    toast('err', '换不了这个目录', e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                新建/切换…
              </Button>
            </div>
            <span />
          </div>
          {/*
            ★★ 两条清理合并成一条（用户 2026-09-15：
              "清理未使用的缓存 和 清理缓存与旧日志 功能重复，可以合并"）。

            确实是同一件事（"把可再生的东西删掉换空间"），只是后端两个命令：
              · `clean_unused`  —— 没有版本引用的共享库/资源文件
              · `clean_caches`  —— 安装器、元数据缓存、旧日志
            合并成**一次 dry run → 一次确认 → 一次执行**：两条命令各算各的，
            把数字合起来给用户看；确认后一起删。

            ★ 合并时**没有**丢掉各自的说明：确认框里逐类列出来（分别是多少、
              哪些绝对不动）—— 合并的是"入口"，不是"信息"。
          */}
          <div className="field-row">
            <span className="field-label">
              清理缓存
              <span className="field-hint">没有版本引用的共享文件 + 安装器 / 清单缓存 / 旧日志</span>
            </span>
            <div className="field-control">
              <Button
                size="sm"
                variant="secondary"
                loading={cleaning}
                onClick={async () => {
                  if (!api) {
                    toast('info', '演示模式', '桌面版才能清理缓存');
                    return;
                  }
                  setCleaning(true);
                  try {
                    /*
                     * 两段式：先算（dry run）再删。
                     * 清理是不可逆的破坏性操作，**先让用户看到"能释放多少"**
                     * 再让他确认 —— 直接开删是不负责任的。
                     */
                    const [unused, caches] = await Promise.all([
                      api.installer.cleanUnused(true),
                      api.installer.cleanCaches(true),
                    ]);
                    const bytes = unused.total_bytes + caches.total_bytes;
                    if (unused.candidates === 0 && caches.installer_files + caches.metadata_files + caches.log_files === 0) {
                      toast(
                        'ok',
                        '没有可清理的东西',
                        `扫了 ${unused.version_jsons_scanned} 份版本描述，每个库和资源文件都还有版本在用。`,
                      );
                      return;
                    }
                    const ok = confirm(
                      `可以释放约 ${humanBytes(bytes)}：\n\n` +
                        `· 没有版本引用的共享文件 ${unused.candidates} 个` +
                        `（保留 ${unused.kept_libraries} 个库、${unused.kept_assets} 个资源文件）\n` +
                        `· 缓存的安装器 ${caches.installer_files} 个（Forge / OptiFine，要用时会重新下载）\n` +
                        `· 元数据缓存 ${caches.metadata_files} 个（版本清单 / 加载器列表，联网即可重建）\n` +
                        `· 旧启动日志 ${caches.log_files} 份（保留最近 ${caches.logs_kept} 份，崩溃分析不受影响）\n\n` +
                        `不动：断点续传的 .part 临时文件；游戏文件（libraries / assets / 已装版本）一个都不动。\n` +
                        `注意：这些是缓存，会直接永久删除（不进回收站 —— 几百上千个碎文件进回收站反而会把回收站塞爆）。\n\n` +
                        `确定清理？`,
                    );
                    if (!ok) return;
                    const [doneUnused, doneCaches] = await Promise.all([
                      api.installer.cleanUnused(false),
                      api.installer.cleanCaches(false),
                    ]);
                    toast(
                      'ok',
                      '已清理',
                      `释放 ${humanBytes(doneUnused.total_bytes + doneCaches.removed_bytes)}` +
                        `（共享文件 ${doneUnused.removed} 个 / 缓存 ${doneCaches.installer_files + doneCaches.metadata_files + doneCaches.log_files} 个）`,
                    );
                  } catch (e) {
                    toast('err', '清理失败', e instanceof Error ? e.message : String(e));
                  } finally {
                    setCleaning(false);
                  }
                }}
              >
                立即清理
              </Button>
            </div>
            <span />
          </div>

        </Card>
        </div>

        {/* ==================== Java ==================== */}
        <Card>
          <CardTitle
            icon={<IconJava />}
            hint={`扫描到 ${state.java.runtimes.length} 个 · 系统装的不会被 IEML 改动`}
            actions={
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={state.java.scanning}
                  onClick={() => void rescanJava()}
                >
                  <IconRefresh /> 重新扫描
                </Button>
                {/*
                  ★「下载 Java」是这张卡最主要的动作，所以放在标题行右端 ——
                    以前它在卡片最底部，前面还压着一长句"1.20.5+ 需要 Java 21…"。
                */}
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy}
                  disabled={!api}
                  title={
                    api ? 'IEML 会把它下到数据目录的 java/ 下' : '桌面版才能下载 Java'
                  }
                  onClick={async () => {
                    if (!api) {
                      toast('warning', '演示模式', '桌面版才能下载 Java');
                      return;
                    }
                    setBusy(true);
                    try {
                      const path = await api.java.install(21, `java-21-${Date.now()}`);
                      toast('ok', 'Java 21 已就绪', path);
                      void loadDownloadedJava();
                      refreshJava(await backend.scanJava());
                    } catch (e) {
                      toast('err', '下载失败', e instanceof Error ? e.message : String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  下载 Java 21
                </Button>
              </>
            }
          >
            Java 运行环境
          </CardTitle>

          {/* IEML 下载的 Java（可删） */}
          {downloaded.length > 0 ? (
            <div className="java-list">
              {downloaded.map((j) => (
                <div key={j.path} className="java-item">
                  <div className="java-main">
                    <div className="java-title">
                      <span className="mono">Java {j.major}</span>
                      <Chip tone="accent">IEML 下载</Chip>
                      {!j.usable ? <Chip tone="danger">无法运行</Chip> : null}
                    </div>
                    {/*
                      ★ 只显示路径**尾部**（含文件名），完整路径在 title 里。
                        以前整条绝对路径铺满一行（`C:\Users\…\Programs\…\bin\javaw.exe`），
                        一行就被路径吃掉，真正要看的"是哪个 Java、多大"反而看不到。
                    */}
                    <div className="java-meta mono truncate" title={j.path}>
                      {shortPath(j.path)} · {j.bytes > 0 ? humanBytes(j.bytes) : '体积未知'}
                    </div>
                  </div>
                  <div className="java-act">
                    <Button
                      size="sm"
                      variant="ghost"
                      title="默认移入系统回收站；按住 Shift 点击则永久删除"
                      onClick={(e) => {
                        const copy = describeDelete({
                          what: '这个 Java',
                          items: [j.path],
                          bytes: j.bytes,
                          note: '如果还有版本在用它，启动时会提示重新指定。',
                          intent: deleteIntent(e),
                        });
                        if (!confirm(copy.message)) return;
                        /*
                         * ★ 审计发现：这里没有 `.catch` —— 文件被占用或没权限时
                         *   删除会静默失败，用户点了几次都"没反应"。
                         */
                        const attempt = (permanent: boolean) =>
                          backend
                            .removeJava(j.path, permanent)
                            .then(() => {
                              void loadDownloadedJava();
                              toast(
                                'ok',
                                permanent ? '已永久删除' : '已移到回收站',
                                j.bytes > 0 ? `释放了 ${humanBytes(j.bytes)}` : j.path,
                              );
                            })
                            .catch((err) => {
                              // ★ 回收站不可用时不静默降级成永久删，先问用户
                              if (!permanent && confirm(trashUnavailablePrompt(err))) {
                                void attempt(true);
                                return;
                              }
                              toast(
                                'err',
                                '删除失败',
                                `文件可能正被别的程序占用：${
                                  err instanceof Error ? err.message : String(err)
                                }`,
                              );
                            });
                        void attempt(copy.permanent);
                      }}
                    >
                      <IconTrash />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : javaListError ? (
            /* 读失败 ≠ 没下过 —— 必须分开说 */
            <Note
              tone="warning"
              icon={<IconAlert />}
              title="读不出已下载的 Java 列表"
              actions={
                <Button size="sm" variant="secondary" onClick={() => void loadDownloadedJava()}>
                  <IconRefresh /> 重试
                </Button>
              }
            >
              {javaListError}。这不代表你没下过 Java —— 只是这次没读到。
            </Note>
          ) : null}
          {/* ★ 2026-09-16 用户（截图）：这里原来还有一句（没出错时显示的）
              "IEML 自己下载的 Java 会列在这里，可随时删除" —— 删掉：
              下面那张表自己就标着来源（「IEML 下载」的 Chip）。 */}

          {/* 系统扫描到的 Java（★ 2026-09-16 用户要求删掉这里那行版本对照：
              "1.20.5+ → 21 · 1.18~1.20.4 → 17 · 1.16.5 及更早 → 8"） */}
          <div className="section-head">
            <h3 className="section-title" style={{ fontSize: 'var(--text-base)' }}>
              系统里探测到的 Java
            </h3>
          </div>

          {state.java.runtimes.length === 0 ? (
            <span className="field-hint">
              一个都没探测到 —— 启动游戏前需要一个 Java 运行时，用右上角「下载 Java 21」。
            </span>
          ) : (
            <div className="java-list">
              {state.java.runtimes.map((r) => (
                <div key={r.path} className="java-item">
                  <div className="java-main">
                    <div className="java-title">
                      <span className="mono">
                        {r.vendor} {r.version}
                      </span>
                      <Chip tone="neutral">
                        {r.source === 'downloaded'
                          ? 'IEML 下载'
                          : r.source === 'instance'
                            ? '版本自带'
                            : '系统安装'}
                      </Chip>
                      {r.disabledByDefault ? <Chip tone="warning">默认禁用</Chip> : null}
                    </div>
                    <div className="java-meta mono truncate" title={r.path}>
                      Java {r.major} · {r.arch} · {shortPath(r.path)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ==================== 新版本默认值 ==================== */}
        <Card>
          {/* ★ 2026-09-16 用户（截图）：删掉这块的 hint"只影响之后新建的版本" */}
          <CardTitle icon={<IconShield />}>
            新版本的默认值
          </CardTitle>

          <div className="field-row">
            <span className="field-label">
              默认版本隔离
              <span className="field-hint">单个版本可单独覆盖</span>
            </span>
            <div className="field-control">
              <Segmented
                label="默认版本隔离"
                value={state.prefs.globalIsolation}
                onChange={(v) =>
                  window.dispatchEvent(new CustomEvent('ieml:prefs', { detail: { globalIsolation: v } }))
                }
                options={[
                  { value: 'isolated', label: '默认隔离' },
                  { value: 'shared', label: '默认共用' },
                ]}
              />
            </div>
            <span />
          </div>

          <div className="field-row">
            <span className="field-label">
              窗口尺寸
              <span className="field-hint">启动游戏时的初始窗口大小</span>
            </span>
            <div className="field-control">
              <input
                className="input mono"
                style={{ width: 76 }}
                value={state.prefs.windowWidth}
                aria-label="窗口宽度"
                onChange={(e) =>
                  window.dispatchEvent(
                    new CustomEvent('ieml:prefs', {
                      detail: { windowWidth: Number(e.target.value) || 1280 },
                    }),
                  )
                }
              />
              <span className="dim">×</span>
              <input
                className="input mono"
                style={{ width: 76 }}
                value={state.prefs.windowHeight}
                aria-label="窗口高度"
                onChange={(e) =>
                  window.dispatchEvent(
                    new CustomEvent('ieml:prefs', {
                      detail: { windowHeight: Number(e.target.value) || 720 },
                    }),
                  )
                }
              />
            </div>
            <span />
          </div>

          <div className="field-row">
            <span className="field-label">
              离线玩家名
              <span className="field-hint">没有正版账号时用这个名字进游戏</span>
            </span>
            <div className="field-control">
              <input
                className="input"
                value={state.prefs.offlineUsername}
                aria-label="离线玩家名"
                onChange={(e) =>
                  window.dispatchEvent(
                    new CustomEvent('ieml:prefs', { detail: { offlineUsername: e.target.value } }),
                  )
                }
              />
            </div>
            <span />
          </div>
        </Card>

        {/* ==================== 下载 ==================== */}
        <Card>
          <CardTitle icon={<IconRefresh />}>下载</CardTitle>

          {/*
            ★ 2026-09-16 用户（发来展开状态的两张图）："这里的下拉栏也要像图二这样"。
              原来这里是 `Select`（原生 <select>）—— 展开的菜单是**浏览器画的**，
              灰底、选项挤在一起，在深色玻璃界面里非常突兀。
              换成启动页「要启动的版本」同款的 `CustomSelect`（`.cs-*`）。
              ★ 行为不变：值仍然走同一条 `ieml:prefs` 事件，只是换了控件。
          */}
          <Field label="下载源" hint="国内建议用 BMCLAPI">
            <CustomSelect
              value={state.prefs.downloadSource}
              onChange={(v) =>
                window.dispatchEvent(
                  new CustomEvent('ieml:prefs', { detail: { downloadSource: v } }),
                )
              }
              ariaLabel="下载源"
              options={[
                { value: 'bmclapi', label: 'BMCLAPI 镜像（推荐）' },
                { value: 'mojang', label: 'Mojang 官方源' },
              ]}
            />
          </Field>

          <div className="field-row">
            <span className="field-label">
              并发下载数
              <span className="field-hint">同时下载的文件数</span>
            </span>
            <div className="field-control">
              <input
                type="range"
                className="range"
                min={8}
                max={128}
                step={4}
                value={state.prefs.concurrentDownloads}
                aria-label="并发下载数"
                onChange={(e) =>
                  window.dispatchEvent(
                    new CustomEvent('ieml:prefs', {
                      detail: { concurrentDownloads: Number(e.target.value) },
                    }),
                  )
                }
              />
              <span className="mono" style={{ minWidth: 30 }}>
                {state.prefs.concurrentDownloads}
              </span>
            </div>
            <span />
          </div>

          {/*
            ★ 源健康面板：回答"为什么这次这么慢"。
              后端会按源的成功率/限流/实测速度动态挑源，被 429 限流还会自动
              降并发并冷却 —— 这些判断如果不暴露出来，用户只能看到"进度条不动"。
          */}
          <div className="field-row">
            <span className="field-label">
              下载源状态
              <span className="field-hint">本次运行的成败 / 限流 / 实测速度</span>
            </span>
            <div className="field-control">
              {!api ? (
                <span className="field-hint">桌面版才能查看（演示模式没有真实下载）</span>
              ) : sources ? (
                <div className="src-report">
                  {sources.sources.map((s) => (
                    <div key={s.source} className="src-row">
                      <Chip tone={s.coolingSeconds > 0 ? 'warning' : 'neutral'}>
                        {s.source === 'bmclapi' ? 'BMCLAPI' : 'Mojang'}
                      </Chip>
                      <span className="mono">
                        {s.successes}/{s.attempts} 成功
                        {s.rateLimited > 0 ? ` · 限流 ${s.rateLimited} 次` : ''}
                        {s.bytesPerSecond > 0 ? ` · ${humanBytes(s.bytesPerSecond)}/s` : ''}
                        {s.coolingSeconds > 0 ? ` · 冷却 ${s.coolingSeconds}s` : ''}
                      </span>
                    </div>
                  ))}
                  <span className="field-hint">
                    当前优先：{sources.preferred === 'bmclapi' ? 'BMCLAPI 镜像' : 'Mojang 官方源'}
                    （按上面的实测结果自动决定） · 并发上限 {sources.concurrencyHint}
                  </span>
                </div>
              ) : (
                <Button
                  size="sm"
                  onClick={() => {
                    void api.installer
                      .sources()
                      .then(setSources)
                      .catch((e: unknown) =>
                        toast('err', '查询失败', e instanceof Error ? e.message : String(e)),
                      );
                  }}
                >
                  查看
                </Button>
              )}
            </div>
            <span />
          </div>

        </Card>


        {/*
          ==================== 关于 ====================

          ★ 为什么值得单独一块：
            版本号一直由 `tools/set-version.mjs` 认真维护在**四个**文件里
            （`package.json` / `Cargo.toml` / `tauri.conf.json` /
            `domain/version-info.ts`），`pnpm verify` 里还有一条
            "四处必须一致" 的检查 —— 但**界面上一个地方都不显示它**。
            版本号规则（docs/VERSIONING.md）明说这个值是给"关于"用的。

            用户在报 bug 时第一个会问的就是"我这是哪个版本"。
            显示出来，也让"改了版本号没重新构建"这件事一眼可见：
            桌面版显示的是**后端**（编译期 `env!("CARGO_PKG_VERSION")`），
            浏览器演示模式显示的是前端常量。
        */}
        <Card>
          <CardTitle icon={<IconInfo />} hint="报 bug 时请带上这个版本号">
            关于
          </CardTitle>
          <div className="field-row">
            <span className="field-label">
              IEML 启动器
              <span className="field-hint">极简 Minecraft 启动器 · {stageLabelOf(state.backendVersion)}</span>
            </span>
            <div className="field-control">
              <span className="mono" style={{ fontSize: 'var(--text-base)' }}>
                {state.backendVersion || '（未知）'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const v = state.backendVersion;
                  try {
                    await navigator.clipboard.writeText(v);
                    toast('ok', '已复制版本号', v);
                  } catch {
                    toast('info', '版本号', v);
                  }
                }}
              >
                复制
              </Button>
            </div>
            {/*
              ★ 这一格以前重复写着"数据目录：…"（存储卡里已经有，还带「打开」按钮），
                而它是 `.field-row` 的**第三列**，宽度只剩几十像素，
                于是被折成"数据目 / 录：…"两行 —— 比不写还难读。删掉。
            */}
            <span />
          </div>
          <div className="field-row">
            <span className="field-label">
              前端版本
              <span className="field-hint">不一致 = 改了版本号没重新构建</span>
            </span>
            <div className="field-control">
              <span className="mono" style={{ fontSize: 'var(--text-base)' }}>
                {APP_VERSION}
              </span>
              {state.backendVersion && state.backendVersion !== APP_VERSION ? (
                <span className="field-hint" style={{ color: 'var(--warn, #d9a441)' }}>
                  ⚠ 与后端不一致
                </span>
              ) : null}
            </div>
            <span />
          </div>
          {/*
            ★ 2026-09-17：更新检查放在"关于"卡里、紧挨版本号。
              用户看到版本号，下一个问题必然是"那有没有新的" —— 两者分开就是让人找。
              按钮文案特意写成「检查启动器更新」（而不是 ModsPanel 那种「检查更新」），
              因为这个程序里同时存在两种更新，同名会点错。
          */}
          <div className="field-row">
            <span className="field-label">
              启动器更新
              <span className="field-hint">
                {upd.state.phase === 'unsupported'
                  ? '浏览器演示模式下没有更新能力'
                  : '更新的是启动器自己，装完需要重启'}
              </span>
            </span>
            <div className="field-control">
              {upd.state.phase === 'available' ? (
                <span
                  className="field-hint"
                  style={{ color: 'var(--ok, #6cc06c)' }}
                  title={upd.state.notes || undefined}
                >
                  发现新版本 {upd.state.version}
                </span>
              ) : upd.state.phase === 'downloading' ? (
                <span className="field-hint">
                  正在下载 {humanBytes(upd.state.downloaded ?? 0)}
                  {upd.state.total ? ` / ${humanBytes(upd.state.total)}` : ''}
                </span>
              ) : upd.state.phase === 'installing' ? (
                <span className="field-hint" style={{ color: 'var(--ok, #6cc06c)' }}>
                  已开始安装，启动器马上退出；装完会自动打开（没打开就手动开一次）
                </span>
              ) : upd.state.phase === 'uptodate' ? (
                <span className="field-hint">已是最新版本</span>
              ) : upd.state.phase === 'checking' ? (
                <span className="field-hint">正在检查…</span>
              ) : upd.state.phase === 'error' ? (
                <span className="field-hint" style={{ color: 'var(--warn, #d9a441)' }}>
                  {upd.state.error}
                </span>
              ) : null}
              <Button
                size="sm"
                variant={upd.state.phase === 'available' ? 'primary' : 'ghost'}
                loading={upd.state.phase === 'checking' || upd.state.phase === 'downloading'}
                disabled={upd.state.phase === 'unsupported' || upd.state.phase === 'installing'}
                onClick={() => void (upd.state.phase === 'available' ? upd.install() : upd.checkNow())}
              >
                {upd.state.phase !== 'checking' && upd.state.phase !== 'downloading' ? <IconRefresh /> : null}
                {upd.state.phase === 'available' ? '下载并安装' : '检查启动器更新'}
              </Button>
            </div>
            <span />
          </div>
          <div className="field-row">
            <span className="field-label">
              第三方组件
              <span className="field-hint">都随程序附带（或由系统提供）</span>
            </span>
            <div className="field-control">
              <span className="field-hint">
                Tauri 2 · React 18 · Vite 5
              </span>
              {/* ★ 2026-09-16 用户（截图）：后面那半句
                  "· 字体由系统提供 —— 启动器本体不含任何 Minecraft 游戏资源文件" 删掉 */}
            </div>
            <span />
          </div>
        </Card>
      </div>
    </>
  );
}

/**
 * 把绝对路径压成"尾部三段"（`…\java\java-21-xxx`）。
 *
 * ★ 只用于**显示**：完整路径一律挂在 `title` 上，鼠标停一下就全看得到。
 *   判据、传参、删除用的都还是调用方手里那份完整路径 —— 这里不产生新事实。
 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…\\${parts.slice(-3).join('\\')}`;
}
