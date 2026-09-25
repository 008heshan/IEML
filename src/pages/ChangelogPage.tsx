/**
 * 更新日志页（用户：「左侧栏的数据目录改成更新日志…**更新日志要去 AI 味，说人话**」）。
 *
 * 内容来自 `data/release-notes.ts`（面向用户的那一份），不是仓库里的 CHANGELOG.md ——
 * 为什么另写一份，那份文件开头写清楚了。
 *
 * ★★ 2026-09-26 用户：「**这个版本更新列表可以改成实时获取吗，点进去就刷新**」。
 *
 *   改之前这一页是**纯静态**的：它只读构建时打进包里的那份，所以
 *   ① 发布之后又改了说明，界面还是旧的；
 *   ② 而**已经装了这一版的人**根本看不到这一版的说明 ——
 *      Tauri 的 updater 插件在"版本相同"时连 `body` 都不返回（见 `useLauncherUpdate`），
 *      于是"我装的是最新版，那这一版改了什么"在客户端里**拿不到**。
 *
 *   现在两条路并用：
 *     · **进页面就实时拉一次**（`refreshNotes`，直接读更新通道的清单）；
 *     · 拉到的版本 == 当前版本 ⇒ 用它顶掉包里那份（它是权威文本）；
 *       拉到的版本 **比当前新** ⇒ **不冒充本版说明**，另外挂一条「有新版本」；
 *       拉不到 ⇒ 用包里那份，**不报错**（说明文字拿不到不该弹红条）。
 *   判据在 `domain/release-notes.ts`（`chooseNotes` / `parseReleaseNotes`），有单测钉着。
 */
import { useEffect } from 'react';
import { Button, Card, CardTitle, Chip, Note } from '../ui';
import { RichText } from '../ui/RichText';
import { IconLayers, IconRefresh } from '../ui/Icons';
import { CHANGELOG_NOTE, RELEASE_NOTES } from '../data/release-notes';
import { chooseNotes, parseReleaseNotes, stripInlineCode } from '../domain/release-notes';
import { APP_VERSION } from '../domain/version-info';
import { useApp } from '../state/AppContext';

/** 说明正文（条目里的行内代码记号摘掉，其余交给 `RichText` 处理加粗） */
function NotesBody({ sections }: { sections: Array<{ title: string; items: string[] }> }) {
  return (
    <>
      {sections.map((g, i) => (
        <div className="rel-group" key={`${g.title}-${i}`}>
          {g.title ? <div className="rel-group-t">{g.title}</div> : null}
          <ul className="rel-list">
            {g.items.map((it, j) => (
              <li key={j}>
                <RichText text={stripInlineCode(it)} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

export function ChangelogPage() {
  const { update } = useApp();
  const { liveNotes, notesPhase } = update.state;

  /* ★ 进页面就拉一次（"点进去就刷新"）。拉不到就用包里那份，不打扰。 */
  useEffect(() => {
    void update.refreshNotes();
    // 只在进页面时拉：refreshNotes 的依赖是桥，桥不会每次渲染都变
  }, [update.refreshNotes]);

  const live = liveNotes ? parseReleaseNotes(liveNotes.notes) : null;
  const builtinHasCurrent = RELEASE_NOTES.some((r) => r.version === APP_VERSION);
  const choice = chooseNotes({
    currentVersion: APP_VERSION,
    builtinHasCurrent,
    liveVersion: liveNotes?.version,
    liveItemCount: live?.itemCount,
  });

  /* 实时那份就是当前版本、而且真的解析出了条目 ⇒ 用它顶掉包里那条 */
  const useLive = choice === 'live' && live !== null && live.itemCount > 0;
  const rows = RELEASE_NOTES.map((r) =>
    useLive && r.version === APP_VERSION
      ? { ...r, headline: live!.headline || r.headline, sections: live!.sections }
      : { ...r, sections: r.groups as Array<{ title: string; items: string[] }> },
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">更新日志</h1>
          <div className="page-desc">按版本倒序。每一条都是"你遇到的那件事现在怎么样了"。</div>
        </div>
        {/*
          ★ 手动刷新入口：进页面已经自动拉过一次，但"看完想再看一眼有没有更新"
            是常态。它只重拉说明，**不触发下载**（那是"检查更新"的事）。
        */}
        <div className="page-actions">
          <Button
            size="sm"
            variant="secondary"
            loading={notesPhase === 'loading'}
            onClick={() => void update.refreshNotes()}
            title="重新读取更新说明（只读说明，不会下载任何东西）"
          >
            <IconRefresh /> 刷新
          </Button>
        </div>
      </div>

      <div className="stack">
        {/*
          ★★ 实时那份是**新版本**的说明时，不冒充"本版说明"，单独挂一条。
             判据 `chooseNotes` 返回 `live-newer`（见 `domain/release-notes.ts`）。
        */}
        {choice === 'live-newer' && live ? (
          <Note tone="info" icon={<IconRefresh />} title={`有新版本 ${liveNotes?.version}`}>
            <div className="rel-headline">{live.headline || '这一版有新内容。'}</div>
            <NotesBody sections={live.sections} />
            <div className="dim">
              以上是 <b>{liveNotes?.version}</b> 的说明（你现在跑的是 {APP_VERSION}）。
              去「设置 → 关于」可以检查更新。
            </div>
          </Note>
        ) : null}

        {rows.map((r, idx) => (
          <Card key={r.version}>
            <CardTitle
              icon={<IconLayers />}
              actions={
                <>
                  <span className="dim mono">{r.date}</span>
                  {idx === 0 ? <Chip tone="success">最新</Chip> : null}
                  {/* 这一条是刚从线上读回来的（不是包里那份）*/}
                  {useLive && r.version === APP_VERSION ? <Chip tone="accent">已刷新</Chip> : null}
                </>
              }
            >
              {r.version}
            </CardTitle>

            {r.headline ? <div className="rel-headline">{r.headline}</div> : null}

            {/* ★ 条目也走 `<RichText>`：文案里写 `**…**` 会真的加粗，而不是把星号显示给用户 */}
            <NotesBody sections={r.sections} />
          </Card>
        ))}

        {/*
          ★ 拉不到时说一句**为什么不新鲜**，但不当成错误 ——
            说明文字拿不到，界面照旧有东西可看（包里那份）。
        */}
        {notesPhase === 'failed' ? (
          <div className="dim">
            这次没能从更新通道读到最新说明（网络或上游的问题），上面显示的是随启动器一起发布的版本。
          </div>
        ) : null}

        <Note tone="info" icon={<IconLayers />} title="更早的版本">
          {CHANGELOG_NOTE}
        </Note>
      </div>
    </>
  );
}
