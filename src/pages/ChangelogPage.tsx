/**
 * 更新日志页（用户：「左侧栏的数据目录改成更新日志…**更新日志要去 AI 味，说人话**」）。
 *
 * 内容来自 `data/release-notes.ts`（面向用户的那一份），不是仓库里的 CHANGELOG.md ——
 * 为什么另写一份，那份文件开头写清楚了。
 */
import { Card, CardTitle, Chip, Note } from '../ui';
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
                    <li key={it}>{it}</li>
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
