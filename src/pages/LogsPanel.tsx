/**
 * 日志（二级页）
 * ------------------------------------------------------------------
 * 这是原设计稿**完全缺失**的一部分（"装完之后那一半"）。
 *
 * 三件事：
 *   ① 一个按钮把日志交给崩溃分析（首屏给结论，不是堆栈）
 *   ② 原始日志可滚动查看（等宽字体、默认折叠关键段）
 *   ③ 导出报告前主动脱敏，并告诉用户处理了什么
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { Button, Chip, EmptyState, Note, Skeleton } from '../ui';
import {
  IconCheck,
  IconInfo,
  IconRefresh,
  IconShield,
  IconTerminal,
} from '../ui/Icons';
import { useRealApi } from '../hooks/useRealApi';
import { dispatchCrash } from './CrashModal';

export function LogsPanel() {
  const { open: inst, toast, state } = useApp();
  const { api } = useRealApi();
  const [log, setLog] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  /*
   * ★★ 这份日志是不是**离线身份**跑出来的（P0-6）。
   *
   *   判据用「当前有没有登录正版账号」——这是**我们能知道的事实**，
   *   而且它是"为什么日志里会有 401"的直接解释。不知道就传 `undefined`：
   *   分析器会按"不排除"处理，界面也不会假装知道。
   *   （启动时到底用了哪个身份，由后端记在会话上并随 `game-exit` 事件带出来；
   *    这里是"事后看一份旧日志"的场景，只能按当前账号状态推断。）
   */
  const offlineForLog = state.prefs.accountUuid ? undefined : true;

  const load = useCallback(async () => {
    if (!api || !inst) return;
    setLoading(true);
    try {
      setLog(await api.launcher.readLog(inst.config.slug));
    } catch (e) {
      toast('err', '读取日志失败', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, inst, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  /* 日志行数统计 + 关键行高亮 */
  const stats = useMemo(() => {
    if (!log) return { lines: 0, errors: 0, warns: 0, crashes: 0 };
    const arr = log.split('\n');
    return {
      lines: arr.length,
      errors: arr.filter((l) => /\bERROR\b/.test(l)).length,
      warns: arr.filter((l) => /\bWARN\b/.test(l)).length,
      crashes: arr.filter((l) => /Exception|Caused by|at net\.minecraft/.test(l)).length,
    };
  }, [log]);

  if (!inst) return <Note tone="warning">没有选中的版本。</Note>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">日志</h1>
          <p className="page-desc">
            {inst.config.name} · 上一次启动的完整输出
            {log ? ` · ${stats.lines} 行` : ''}
          </p>
        </div>
        <div className="page-actions">
          <Button variant="ghost" size="sm" loading={loading} onClick={() => void load()}>
            <IconRefresh /> 刷新
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!log}
            onClick={() => {
              if (!log) return;
              // ★ 带上实例上下文：崩溃弹窗里的修复动作要知道"修哪一个版本"
              // ★ 带上"是不是离线身份"：否则那行必然出现的 401 会被当成原因
              dispatchCrash(log, inst.config.slug, inst.config.name, offlineForLog);
            }}
          >
            <IconTerminal /> 分析崩溃原因
          </Button>
        </div>
      </div>

      {!api ? (
        <Note tone="warning">
          浏览器演示模式：日志要桌面版才能读真实文件（<code>pnpm desktop:dev</code>）
        </Note>
      ) : null}

      {loading ? <Skeleton rows={6} height={40} /> : null}

      {!loading && log === '' ? (
        <EmptyState
          icon={<IconTerminal />}
          title="还没有日志"
          desc="启动过一次游戏之后，这里会出现完整的游戏输出。启动失败时，日志是排查问题最重要的东西。"
        />
      ) : null}

      {!loading && log && log.length > 0 ? (
        <>
          {/* 统计卡：一眼看出有没有问题 */}
          <div className="log-stats">
            <div className="log-stat">
              <span className="ls-k">总行数</span>
              <span className="ls-v mono">{stats.lines}</span>
            </div>
            <div className="log-stat">
              <span className="ls-k">错误</span>
              <span className={`ls-v mono${stats.errors > 0 ? ' bad' : ' good'}`}>
                {stats.errors}
              </span>
            </div>
            <div className="log-stat">
              <span className="ls-k">警告</span>
              <span className={`ls-v mono${stats.warns > 0 ? ' warn' : ' good'}`}>
                {stats.warns}
              </span>
            </div>
            <div className="log-stat">
              <span className="ls-k">异常堆栈</span>
              <span className={`ls-v mono${stats.crashes > 0 ? ' bad' : ' good'}`}>
                {stats.crashes}
              </span>
            </div>
            <div className="log-stat wide">
              <span className="ls-k">判断</span>
              <span className="ls-v">
                {stats.crashes > 0 ? (
                  <Chip tone="danger">有异常，建议点「分析崩溃原因」</Chip>
                ) : stats.errors > 0 ? (
                  <Chip tone="warning">有错误，但未必致命</Chip>
                ) : (
                  <Chip tone="success">
                    <IconCheck /> 看起来正常
                  </Chip>
                )}
              </span>
            </div>
          </div>

          {/* 日志正文 */}
          <div className="log-toolbar">
            <Button size="sm" variant="ghost" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? '收起日志正文' : '展开日志正文'}
            </Button>
            <div className="spacer" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                // ★ 导出前主动脱敏，并告诉用户处理了什么（ADR-012）
                void (async () => {
                  const redact = await import('../domain/crash.ts');
                  const r = redact.redactReport(log);
                  const blob = new Blob([r.text], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${inst.config.slug}-log.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                  toast(
                    'ok',
                    '已导出（已脱敏）',
                    r.redacted.length > 0
                      ? `处理了：${r.redacted.map((x) => `${x.what} ${x.count} 处`).join('、')}`
                      : '日志里没有发现敏感内容',
                  );
                })();
              }}
            >
              <IconShield /> 导出（脱敏）
            </Button>
          </div>

          {showRaw ? (
            <pre className="crash-log tall" tabIndex={0} aria-label="完整日志">
              {log}
            </pre>
          ) : null}
        </>
      ) : null}

      {/*
        「怎么看日志」收进折叠块（0.1.0-beta.1）。

        ★ 它原来是常驻的三行 Note，占掉页面顶部一块 —— 而**它只在用户
          真正要看日志时才用得着**（正常进这一页是看统计与崩溃分析）。
          收进 <details> 之后：不知道怎么看的人点一下就有，知道的人
          一个像素都不被它占。内容一个字没删。
      */}
      <details className="logs-howto">
        <summary>
          <IconInfo /> 怎么看日志
        </summary>
        <ol>
          <li>
            <b>先看最后 30 行</b> —— 崩溃原因几乎总在末尾。
          </li>
          <li>
            <b>搜 "Caused by"</b> —— 它后面那句才是真正的原因，前面的往往只是包装。
          </li>
          <li>
            不想自己看就点上面的<b>「分析崩溃原因」</b>，会把日志特征翻译成人话并给出修复动作。
          </li>
        </ol>
      </details>
    </>
  );
}
