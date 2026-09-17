/**
 * 任务中心（顶栏常驻）
 * ------------------------------------------------------------------
 * ★ 原设计稿的下载队列有三个致命缺口：
 *   ① 只在「下载队列」页签里能看到，切走就不知道还在不在下
 *   ② 文案写着「可暂停」但**没有任何暂停按钮**
 *   ③ 同一个 Forge 进度在两个页面各有一份 DOM，文案都漂移了
 *
 *   这里：单一任务源 → 顶栏常驻入口 → 每个任务都有真实的暂停/继续/取消/重试。
 */
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext';
import { Button, Progress } from '../ui';
import { IconDownload, IconPause, IconPlay, IconRefresh, IconClose, IconAlert } from '../ui/Icons';
import { formatBytes, formatDuration } from '../domain';
import { markCancelled, markPaused, removeTask, resumeOrReplay } from '../flows/install';

export function TaskCenter() {
  const { state, backend, patchTask, toast } = useApp();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const active = state.tasks.filter(
    (t) => t.status === 'running' || t.status === 'paused' || t.status === 'pending',
  );
  const failed = state.tasks.filter((t) => t.status === 'failed');

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /*
   * ★★ 2026-09-17 用户：「下载完后下载展开栏自动收起」。
   *
   *   展开栏挡住了主界面，而"下完了"之后它还杵在那儿，得手动再点一下 ——
   *   那一下点的是纯粹的收尾动作，不该让用户来做。
   *
   * ## 只在"看着它下完"时才收
   *
   *   判据是**从有活跃任务变成没有**（`was > 0 && now === 0`），
   *   而不是"当前没有活跃任务" —— 后者会在用户主动打开面板查看
   *   历史任务时把它一把收掉（他正要读，你却关了）。
   *
   * ## 失败时坚决不收
   *
   *   有失败任务就保持展开：收起来等于把错误信息藏了，用户只会觉得
   *   "又没反应"。要收也得是**成功**之后收。
   */
  const prevActive = useRef(0);
  useEffect(() => {
    const was = prevActive.current;
    prevActive.current = active.length;
    if (!open) return;
    if (was > 0 && active.length === 0 && failed.length === 0) setOpen(false);
  }, [active.length, failed.length, open]);

  if (state.tasks.length === 0) return null;

  const count = active.length + failed.length;

  return (
    <div className="task-center" ref={wrapRef}>
      <Button
        variant="ghost"
        iconOnly
        aria-label={`任务中心，${count} 个任务`}
        title={`任务中心 · ${count} 个进行中`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconDownload />
        {count > 0 ? <span className="badge-dot">{count}</span> : null}
      </Button>

      {open ? (
        <div className="task-panel" role="region" aria-label="任务中心">
          <div className="task-panel-head">
            <strong>任务</strong>
            <span className="task-count">
              {active.length} 个进行中{failed.length > 0 ? ` · ${failed.length} 个失败` : ''}
            </span>
          </div>

          {state.tasks.length === 0 ? (
            <div className="task-empty">没有正在进行的任务</div>
          ) : (
            state.tasks.map((t) => (
              <div key={t.id} className={`task-item task-${t.status}`}>
                <div className="task-top">
                  <span className="task-title truncate">{t.title}</span>
                  <span className="task-pct mono">
                    {t.status === 'done'
                      ? '完成'
                      : t.status === 'failed'
                        ? '失败'
                        : t.status === 'cancelled'
                          ? '已取消'
                          : t.status === 'paused'
                            ? '已暂停'
                            : `${t.percent}%`}
                  </span>
                </div>

                {t.status === 'failed' && t.error ? (
                  <div className="task-error">
                    <IconAlert /> {t.error}
                  </div>
                ) : (
                  <>
                    <Progress percent={t.percent} label={`${t.title} 进度`} />
                    <div className="task-meta">
                      <span>
                        {t.phase} · {t.finishedFiles} / {t.totalFiles} 个文件
                      </span>
                      {t.status === 'running' && t.bytesPerSecond > 0 ? (
                        <span className="mono">
                          {formatBytes(t.bytesPerSecond)}/s · 剩余 {formatDuration(t.etaSeconds)}
                        </span>
                      ) : null}
                    </div>
                  </>
                )}

                <div className="task-actions">
                  {t.status === 'running' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        /*
                         * ★★ **真暂停**（不再伪装成取消）。
                         *
                         *   老实现这里是 `backend.cancelTask(t.id)` —— 注释还写着
                         *   "暂停 = 标记 + 停掉后端下载"。效果上勉强能用
                         *   （`.part` 保留、继续时续传），但对用户不是一回事：
                         *   取消是"不要了"，暂停是"等会儿接着下"。
                         *
                         *   引擎现在有 `PauseToken` 了：**不再开始新的下载、
                         *   让在跑的收尾**，并把"还剩哪些"记下来。
                         */
                        markPaused(t.id);
                        try {
                          await backend.pauseTask(t.id);
                          /*
                           * ★★ 这里**不再**立刻写「已暂停」。
                           *
                           *   按下令牌只是"请求"：引擎会在**下一个任务开始之前**
                           *   停下，手上正在传的几个还要收尾。真实结论由
                           *   `install_version` 返回的 `paused: true` 给出
                           *   （`flows/install.ts` 的 `markPausedConfirmed`）。
                           *   提前写「已暂停」= 界面说了一件后端还没做到的事 ——
                           *   那正是这个仓库反复修的那类假话。
                           */
                          patchTask(t.id, {
                            status: 'running',
                            phase: '正在暂停…（手上这几个下完就停）',
                          });
                          toast('info', '正在暂停', `${t.title} 会在当前文件下完后停下`);
                        } catch (e) {
                          /*
                           * ★ 审计发现：这里以前 `catch {}` 把失败吞了，
                           *   界面照样显示"已暂停"、下载却还在跑（白耗带宽和磁盘）。
                           *   现在如实报错，并把状态**改回 running** ——
                           *   界面显示的状态必须与实际相符。
                           */
                          patchTask(t.id, { status: 'running' });
                          toast(
                            'err',
                            '暂停失败',
                            `后端没能停掉这个任务，它还在继续下载：${
                              e instanceof Error ? e.message : String(e)
                            }`,
                          );
                        }
                      }}
                    >
                      <IconPause /> 暂停
                    </Button>
                  ) : null}

                  {t.status === 'paused' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        /*
                         * ★ 审计发现：以前无条件弹"已继续…正在续传"，
                         *   而 `resumeInstall` 对不在 pendingJobs 里的任务（整合包）
                         *   直接 return —— 提示是假的、任务永远停在"已暂停"。
                         *   现在按真实结果说话。
                         */
                        if (resumeOrReplay(t.id)) {
                          patchTask(t.id, { status: 'running' });
                          toast('info', '已继续', `${t.title} 正在从上次的位置续传`);
                        } else {
                          toast(
                            'warning',
                            '没法继续这个任务',
                            '这个任务没有留下重试所需的信息（可能是重启前创建的）。请重新发起一次安装 —— 已下载的文件会被跳过。',
                          );
                        }
                      }}
                    >
                      <IconPlay /> 继续
                    </Button>
                  ) : null}

                  {t.status === 'failed' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        /*
                         * ★ 审计发现：以前这里**只改本地状态**就弹"正在重试"，
                         *   后端什么都没做 —— 任务永远停在 running、进度不动。
                         *   现在真的重新发起（.part 断点续传）。
                         */
                        if (resumeOrReplay(t.id)) {
                          patchTask(t.id, { status: 'running', error: undefined });
                          toast('info', '正在重试', `已下载的 ${t.finishedFiles} 个文件会直接复用`);
                        } else {
                          toast(
                            'warning',
                            '没法自动重试',
                            '这个任务没有留下重试所需的信息。请重新发起一次安装 —— 已下载的文件会被跳过。',
                          );
                        }
                      }}
                    >
                      <IconRefresh /> 重试
                    </Button>
                  ) : null}

                  {t.status === 'running' || t.status === 'paused' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        markCancelled(t.id);
                        try {
                          await backend.cancelTask(t.id);
                        } catch {
                          /* 后端任务可能已结束，忽略 */
                        }
                        patchTask(t.id, { status: 'cancelled' });
                        toast('warning', '已取消', `${t.title} 已停止；已下载的文件保留，下次可以续传`);
                      }}
                    >
                      <IconClose /> 取消
                    </Button>
                  ) : null}

                  {t.status === 'done' || t.status === 'cancelled' || t.status === 'failed' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeTask(t.id)}
                      aria-label={`移除 ${t.title}`}
                    >
                      移除
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
