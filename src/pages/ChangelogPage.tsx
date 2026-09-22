/**
 * 更新日志页（用户：「左侧栏的数据目录改成更新日志…**更新日志要去 AI 味，说人话**」）。
 *
 * 内容来自 `data/release-notes.ts`（面向用户的那一份），不是仓库里的 CHANGELOG.md ——
 * 为什么另写一份，那份文件开头写清楚了。
 */
import { Card, CardTitle, Chip, Note } from '../ui';
import { RichText } from '../ui/RichText';
import { IconLayers } from '../ui/Icons';
import { CHANGELOG_NOTE, RELEASE_NOTES } from '../data/release-notes';

export function ChangelogPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">更新日志</h1>
          <div className="page-desc">按版本倒序。每一条都是"你遇到的那件事现在怎么样了"。</div>
        </div>
      </div>

      <div className="stack">
        {RELEASE_NOTES.map((r, idx) => (
          <Card key={r.version}>
            <CardTitle
              icon={<IconLayers />}
              actions={
                <>
                  <span className="dim mono">{r.date}</span>
                  {idx === 0 ? <Chip tone="success">最新</Chip> : null}
                </>
              }
            >
              {r.version}
            </CardTitle>

            {r.headline ? <div className="rel-headline">{r.headline}</div> : null}

            {r.groups.map((g) => (
              <div className="rel-group" key={g.title}>
                <div className="rel-group-t">{g.title}</div>
                <ul className="rel-list">
                  {g.items.map((it) => (
                    /*
                     * ★ 2026-09-23：条目也走 `<RichText>` ——
                     *   这样文案里写 `**…**` 会**真的加粗**，而不是把星号显示给用户
                     *   （关于页就是因为这个被用户截图指出来的）。
                     *   现在没有记号时它是个空操作，但以后加条目不会再踩。
                     */
                    <li key={it}>
                      <RichText text={it} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        ))}

        <Note tone="info" icon={<IconLayers />} title="更早的版本">
          {CHANGELOG_NOTE}
        </Note>
      </div>
    </>
  );
}
