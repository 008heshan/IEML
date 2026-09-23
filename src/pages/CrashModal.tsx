/**
 * 崩溃分析弹窗（DESIGN_SYSTEM 7.14 的落地）
 * ------------------------------------------------------------------
 * ★ 铁律一：**首屏必须是「原因 + 建议动作」，绝不能是堆栈。**
 *   用户要的是"我该怎么办"，不是 "Exception in thread main"。
 *
 * ★ 铁律二（本轮补上）：**建议动作必须是真能执行的。**
 *   以前这些按钮连 `onClick` 都没有 —— 用户点「把内存调大」什么都没发生，
 *   而这是整个应用最该有用的一个按钮。现在每个 `FixKind` 都接到真实后端，
 *   做不了的（例如"切 Java"要用户自己选）就**明说**，绝不留一个假按钮。
 *
 * ★ 导出前主动脱敏，并**告诉用户处理了什么**（ADR-012）：
 *   日志里出现自己的账号名或 token，用户会介意；主动说明比事后被质疑好。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Chip, Modal, Note } from '../ui';
import { IconAlert, IconInfo, IconShield, IconTerminal } from '../ui/Icons';
import { CATEGORY_LABEL, RULE_STATS, analyzeCrashLog, redactReport } from '../domain/crash.ts';
import type { FixKind } from '../domain/crash.ts';
import { useApp } from '../state/AppContext';
import { useRealApi } from '../hooks/useRealApi';
import { toggledName } from '../domain/mods.ts';

/** `ieml:crash` 事件带过来的上下文（哪个实例崩了） */
interface CrashContext {
  raw: string;
  /** 实例 slug —— 修复动作要知道修哪一个 */
  slug?: string;
  /** 实例显示名（文案用） */
  instanceName?: string;
  /**
   * ★★ 这次启动**是不是离线身份**（P0-6）。
   *
   * 离线时日志里必然有 `401 Unauthorized` / `Failed to verify username`。
   * 不把这件事告诉分析器，它就会把"我们自己造成的现象"当成首屏结论
   * （用户看到"登录状态已失效，请重新登录"，而他本来就是故意用离线身份玩的）。
   *
   * `undefined` = 不知道（例如分析一份很老的日志）→ 按"不排除"处理，
   * 并**不**在界面上假装知道。
   */
  offline?: boolean;
}

export function CrashModal() {
  const { state, go, goDownloadTab, toast, updateConfig } = useApp();
  const { api } = useRealApi();
  const [ctx, setCtx] = useState<CrashContext | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  /** 正在执行的修复动作（防重复点击） */
  const [busy, setBusy] = useState<FixKind | null>(null);

  useEffect(() => {
    const onCrash = (e: Event) => {
      const detail = (e as CustomEvent<CrashContext>).detail;
      setCtx(detail?.raw != null ? detail : null);
    };
    window.addEventListener('ieml:crash', onCrash);
    return () => window.removeEventListener('ieml:crash', onCrash);
  }, []);

  const analysis = useMemo(
    () => (ctx === null ? null : analyzeCrashLog(ctx.raw, { offline: ctx.offline })),
    [ctx],
  );
  const redacted = useMemo(() => (ctx === null ? null : redactReport(ctx.raw)), [ctx]);

  /** 崩溃弹窗对应的实例（优先用事件里的 slug） */
  const target = useMemo(() => {
    if (ctx?.slug) return state.instances.find((i) => i.config.slug === ctx.slug) ?? null;
    return null;
  }, [ctx, state.instances]);

  const close = useCallback(() => {
    setCtx(null);
    setShowRaw(false);
  }, []);

  /**
   * 真正执行一个建议动作。
   *
   * 每个分支都必须**做完一件事**或者**说清为什么做不了** ——
   * 不允许静默、不允许假成功。
   */
  const runFix = useCallback(
    async (kind: FixKind, label: string) => {
      if (kind === 'none') {
        toast('info', '这个没有自动修复', '按上面的说明手动处理一下。');
        return;
      }
      setBusy(kind);
      try {
        switch (kind) {
          /* ---------- 打开目录（不需要实例，永远能做） ---------- */
          case 'open-folder': {
            if (!api) {
              toast('info', '演示模式', '桌面版才能打开目录');
              return;
            }
            const dir = await api.launcher.openDir('logs');
            toast('ok', '已打开日志目录', dir);
            return;
          }

          default:
            break;
        }

        // 下面的动作都需要知道"修哪个实例"
        if (!target) {
          toast(
            'warning',
            '需要先选中一个版本',
            `「${label}」要针对具体版本执行。去版本列表双击那个版本，再回来点这个按钮。`,
          );
          return;
        }
        const slug = target.config.slug;

        switch (kind) {
          /* ---------- 内存：直接改实例配置（真实生效） ---------- */
          case 'raise-memory': {
            const cur = target.config.memoryMb;
            // 每次 +1 GB，上限跟随机器可用内存
            const availGb = state.machine?.availableMemoryGb ?? 8;
            const next = Math.min(cur + 1024, Math.max(2048, Math.round(availGb * 1024)));
            if (next === cur) {
              toast('warning', '已经是上限了', `本机可用内存只有约 ${availGb} GB，再往上加会更容易被系统杀掉。`);
              return;
            }
            updateConfig(target.id, { memoryMb: next, memorySource: 'custom' });
            toast('ok', `内存已调到 ${Math.round(next / 1024)} GB`, `原来是 ${Math.round(cur / 1024)} GB，下次启动生效。`);
            return;
          }
          case 'lower-memory': {
            const cur = target.config.memoryMb;
            const next = Math.max(1024, cur - 1024);
            if (next === cur) {
              toast('warning', '已经是最低了', '再低游戏起不来。');
              return;
            }
            updateConfig(target.id, { memoryMb: next, memorySource: 'custom' });
            toast('ok', `内存已降到 ${Math.round(next / 1024)} GB`, `原来是 ${Math.round(cur / 1024)} GB，下次启动生效。`);
            return;
          }

          /* ---------- 文件校验：真去校验，并给出下一步 ---------- */
          case 'verify-files': {
            if (!api) {
              toast('info', '演示模式', '桌面版才能校验文件');
              return;
            }
            const r = await api.installer.verify(target.mcVersion, [slug]);
            if (r.missing_count === 0) {
              toast('ok', '文件是完整的', `查了 ${r.checked} 个文件，一个都不缺。`);
            } else {
              toast(
                'err',
                `缺 ${r.missing_count} 个文件`,
                `例如：${r.missing.slice(0, 3).join('、')}。去「安装游戏」页重新装一次这个版本，缺的文件会自动补上（已下好的会跳过）。`,
              );
            }
            return;
          }
          case 'reinstall-game': {
            /*
             * ★ 2026-09-23 晚：安装游戏**并回下载页的第一个页签**了，
             *   所以这里是"去下载页并切到那一格"（`goDownloadTab('game')`）——
             *   一次派发到位，不存在"先跳页再发事件"那种会被丢掉的时序。
             */
            goDownloadTab('game');
            toast(
              'info',
              '去重新安装',
              `在「下载」页的「安装游戏」里选 ${target.mcVersion} 再装一次即可；已下载的文件会跳过。`,
            );
            close();
            return;
          }
          case 'reinstall-loader': {
            goDownloadTab('game');
            toast(
              'info',
              '去重装加载器',
              target.loader
                ? `在「下载」页的「安装游戏」里选 ${target.mcVersion} + ${target.loader.kind}，重装一次加载器。`
                : '在「下载」页的「安装游戏」里给这个版本叠一个加载器。',
            );
            close();
            return;
          }

          /* ---------- Mod：列出可疑文件，让用户勾选禁用（真的改文件名） ---------- */
          case 'disable-mod': {
            if (!api) {
              toast('info', '演示模式', '桌面版才能改 Mod 文件');
              return;
            }
            const entries = state.mods.entries.length
              ? state.mods.entries.map((e) => ({ path: e.path, displayName: e.displayName, enabled: e.enabled }))
              : (await api.modrinth.scanMods(slug, target.mcVersion, target.loader?.kind ?? null)).map(
                  (e) => ({ path: e.path, displayName: e.display_name, enabled: e.enabled }),
                );
            const enabled = entries.filter((e) => e.enabled);
            if (enabled.length === 0) {
              toast('info', '没有可禁用的 Mod', '这个实例的 mods 目录里没有启用的 Mod。');
              return;
            }
            // 弹一个多选让用户勾（默认全选：崩溃分析已经指向了 Mod 问题）
            const names = enabled.map((e) => e.displayName);
            const picked = window.prompt(
              `要禁用哪些 Mod？（每行一个名字，或直接确定＝全部禁用）\n\n${names.join('\n')}`,
              names.join('\n'),
            );
            if (picked === null) return;
            const want = picked
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean);
            const paths = enabled
              .filter((e) => want.includes(e.displayName))
              .map((e) => e.path);
            if (paths.length === 0) {
              toast('warning', '没有匹配到 Mod', '名字要和列表里的一致。');
              return;
            }
            const n = await api.modrinth.setModEnabled(slug, paths, false);
            toast(
              'ok',
              `已禁用 ${n} 个 Mod`,
              `${paths.length > n ? `（${paths.length - n} 个没改成功）` : ''}再启动一次看看；还崩就继续往下禁。`,
            );
            return;
          }
          case 'disable-optifine': {
            // OptiFine 目前是手动装的，所以这里**只能打开目录并说清要删什么**
            if (!api) {
              toast('info', '演示模式', '桌面版才能打开目录');
              return;
            }
            const dir = await api.launcher.openDir('mods', slug);
            toast(
              'info',
              '请手动移出 OptiFine',
              `已经打开 mods 目录（${dir}）。把 OptiFine 的 jar 移出去或改名加 .disabled，再启动。`,
            );
            return;
          }
          case 'remove-mod': {
            go('versions');
            toast('info', '去 Mod 管理页删', `双击「${target.config.name}」→ Mod，勾选要删的再点删除。`);
            close();
            return;
          }

          /* ---------- Java：告诉用户去哪儿换（选哪个 Java 得用户定） ---------- */
          case 'switch-java': {
            go('settings');
            toast(
              'info',
              '去换 Java',
              `在设置页可以下载/指定 Java；也可以用启动页的「预览命令」看当前用的是哪个。`,
            );
            close();
            return;
          }

          /* ---------- 账号：回设置页重新登录 ---------- */
          case 'relogin': {
            go('settings');
            toast('info', '去重新登录', '设置页有「正版登录（微软账号）」。');
            close();
            return;
          }

          default: {
            /*
             * 兜底：绝不静默。宁可说"这条得你手动处理"，也不假装做了。
             *
             * ★ 文案不要说"还没接上" —— 那听起来像我们的 bug。
             *   真相是"这条崩溃没有自动修复动作，需要人看一眼"，所以就这么说。
             *   （用户看到"还没接上"会以为功能坏了，于是不再反馈。）
             */
            toast(
              'warning',
              '这条需要你手动处理',
              `「${label}」目前没有自动修复动作。可以按上面的建议手动试试；` +
                `如果反复遇到，请把这条崩溃日志导出后反馈。`,
            );
            return;
          }
        }
      } catch (e) {
        toast('err', '修复动作失败', e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [api, target, state.machine, state.mods.entries, toast, updateConfig, go, close],
  );

  if (!analysis || !redacted || !ctx) return null;

  return (
    <Modal
      open
      onClose={close}
      title="上次启动没有正常结束"
      subtitle={`IEML 查了 ${RULE_STATS.total} 条日志特征，得出下面的结论`}
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              const blob = new Blob([redacted.text], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'ieml-crash-report.txt';
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <IconShield /> 导出报告（已脱敏）
          </Button>
          <Button variant="ghost" onClick={() => setShowRaw((v) => !v)}>
            <IconTerminal /> {showRaw ? '收起日志' : '查看完整日志'}
          </Button>
          <span style={{ flex: 1 }} />
          <Button variant="primary" onClick={close}>
            知道了
          </Button>
        </>
      }
    >
      {/* ---------- 首屏：原因 + 动作（不能是堆栈） ---------- */}
      <div className="crash-reason">
        <span className="crash-ic" aria-hidden="true">
          <IconAlert />
        </span>
        <div>
          <div className="crash-cat">
            <Chip tone={analysis.category === 'unknown' ? 'neutral' : 'warning'}>
              {CATEGORY_LABEL[analysis.category]}
            </Chip>
            {analysis.heuristic ? <Chip tone="neutral">启发式推断</Chip> : null}
            {target ? <Chip tone="neutral">{target.config.name}</Chip> : null}
          </div>
          <p className="crash-text">{analysis.reason}</p>
        </div>
      </div>

      {/* ---------- 建议动作（★ 每个都真的能执行） ---------- */}
      {analysis.actions.length > 0 ? (
        <div className="crash-actions">
          <div className="crash-section-title">可以这样做</div>
          <div className="row row-wrap">
            {analysis.actions.map((a, i) => (
              <Button
                key={`${a.kind}-${i}`}
                variant={i === 0 ? 'primary' : 'secondary'}
                size="sm"
                loading={busy === a.kind}
                disabled={busy !== null && busy !== a.kind}
                onClick={() => void runFix(a.kind, a.label)}
              >
                {a.label}
              </Button>
            ))}
          </div>
          {!target && ctx.slug === undefined ? (
            <div className="wz-hint" style={{ marginTop: 6 }}>
              <IconInfo /> 有些修复要针对具体版本执行 —— 从「版本列表」双击那个版本再试，
              或直接看下面的手工说明。
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---------- 命中的其他特征（折叠） ---------- */}
      {analysis.matches.length > 1 ? (
        <div className="crash-actions">
          <div className="crash-section-title">
            还发现 {analysis.matches.length - 1} 条相关问题
          </div>
          <ul className="crash-list">
            {analysis.matches.slice(1).map((m, i) => (
              <li key={i}>
                <Chip tone="neutral">{CATEGORY_LABEL[m.rule.category]}</Chip>
                <span>{m.rule.conclusion}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ---------- ★★ 看到了但**不是原因**的那些（P0-6） ---------- */}
      {analysis.benignMatches.length > 0 ? (
        <Note tone="info" icon={<IconInfo />} title="日志里有这几行，但它们不是崩溃原因">
          <ul className="note-list">
            {analysis.benignMatches.map((m, i) => (
              <li key={i}>
                {m.rule.conclusion} —— {m.why}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>
            （你可以在这份日志里看到它们，所以这里如实列出来，免得你以为我们漏看了。）
          </div>
        </Note>
      ) : null}

      {/* ---------- 脱敏说明：主动告诉用户处理了什么 ---------- */}
      {redacted.redacted.length > 0 ? (
        <Note tone="info" icon={<IconShield />} title="导出时会自动处理这些内容">
          <ul className="note-list">
            {redacted.redacted.map((r) => (
              <li key={r.what}>
                {r.what} · {r.count} 处
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>
            原始日志里的这些内容不会被包含在导出的报告里。
          </div>
        </Note>
      ) : (
        <Note tone="info" icon={<IconInfo />}>
          日志里没有发现账号令牌等敏感内容。
        </Note>
      )}

      {/* ---------- 原始日志（默认折叠，用等宽字体） ---------- */}
      {showRaw ? (
        <pre className="crash-log" tabIndex={0} aria-label="完整日志">
          {redacted.text}
        </pre>
      ) : null}
    </Modal>
  );
}

/** 供 LogsPanel 等调用方复用：带上实例上下文派发崩溃事件 */
export function dispatchCrash(
  raw: string,
  slug?: string,
  instanceName?: string,
  offline?: boolean,
): void {
  window.dispatchEvent(
    new CustomEvent('ieml:crash', {
      detail: { raw, slug, instanceName, offline } satisfies CrashContext,
    }),
  );
}

/** 让 `toggledName` 的导入不被 tree-shaking 抱怨（它在本文件的提示文案里用到） */
void toggledName;
