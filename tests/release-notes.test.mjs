/**
 * 「更新说明」的判据（2026-09-26，用户：「版本更新列表可以改成实时获取吗，点进去就刷新」）。
 *
 * 这里守两件事，都是**错了不会报错、只会显示过时或错版本内容**的那类：
 *   ① 从清单的 Markdown `notes` 里能不能正确读出条目（读丢了就是"这一版没写日志"）；
 *   ② 该显示**哪一份**说明（把新版本的说明当成本版说明显示，就是一句具体的假话）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseNotes,
  compareVersions,
  parseReleaseNotes,
  stripInlineCode,
} from '../src/domain/release-notes.ts';
import { RELEASE_NOTES } from '../src/data/release-notes.ts';
import { APP_VERSION } from '../src/domain/version-info.ts';

/* ---------- ① 解析真实形态的 notes ---------- */

// 线上清单里 notes 的真实形状（rc.9 那一段的节选，含 `### ` 段与 `* ` 条目）
const REAL = `## 0.1.0-rc.9 — 2026-09-26（第七十八轮：代码仓与发布仓合并 + 公开化收尾）

用户：「**仓库强推送**」。

### 修改了

* 修改了更新端点：\`IEML-releases\` → **代码仓** ——
  两仓合并后，release 直接发在代码仓上。
* 修改了 CurseForge 的路由。

### 删除了

* 删除了仓库里的运行期产物。

> ★ **桥接说明**：老客户端只会去问旧发布仓。

---

## 0.1.0-rc.8 — 2026-09-25（第七十七轮）

### 修复了

* 修复了版本列表读不到当前文件夹。
`;

test('★ 标题行读出**版本号**（界面据此判断"这是哪一版"）', () => {
  assert.equal(parseReleaseNotes(REAL).version, '0.1.0-rc.9');
});

test('★ 折行的条目**接回上一条**，不是丢掉或者变成独立条目', () => {
  const p = parseReleaseNotes(REAL);
  const all = p.sections.flatMap((s) => s.items);
  const first = all.find((i) => i.includes('修改了更新端点')) ?? '';
  assert.ok(first, `没读到"修改了更新端点"那条：${JSON.stringify(all)}`);
  assert.ok(
    first.includes('两仓合并后，release 直接发在代码仓上'),
    `续行没接上去：${first}`,
  );
  assert.ok(!first.includes('\n'), '条目里不该留原始换行');
  assert.equal(
    all.filter((i) => i.includes('修改了更新端点')).length,
    1,
    '续行不该变成独立条目',
  );
});

test('★ 只解析**第一个** `## ` 那一节（清单里只有一节，但解析器不该把后面的也吞进来）', () => {
  const p = parseReleaseNotes(REAL);
  /*
   * 条目 = 开头的引子 + 五个正文条目。那个引子**按设计保留**：
   * 这个仓库的更新说明一贯以「用户：『…』」开头（那是这一轮的由来），
   * 而 `RichText` 会把 `**…**` 渲染成加粗 —— 它不是开发者噪音。
   */
  assert.equal(p.itemCount, 4, `条目数：${JSON.stringify(p.sections)}`);
  assert.ok(
    !p.sections.some((s) => s.items.some((i) => i.includes('读不到当前文件夹'))),
    '不能把下一版的条目也读进来',
  );
});

test('段标题与顺序原样保留（新增了 / 修复了 / … 是用户定的五段）', () => {
  const p = parseReleaseNotes(REAL);
  assert.deepEqual(
    p.sections.map((s) => s.title),
    // 第一段没有 `### ` 标题 = 标题之前那段引子，它自成一个无名段
    ['', '修改了', '删除了'],
  );
});

test('★ 引用块（`> `）当正文读、分隔线（`---`）跳过 —— 两者都是给仓库那份 CHANGELOG 排版的', () => {
  const p = parseReleaseNotes(REAL);
  const all = p.sections.flatMap((s) => s.items).join('\n');
  assert.ok(!all.includes('---'), '分隔线不该变成条目');
  assert.ok(!all.trimStart().startsWith('>'), '引用记号要被摘掉');
});

test('说明是空的时候不炸，也不编内容', () => {
  const p = parseReleaseNotes('');
  assert.equal(p.version, '');
  assert.equal(p.itemCount, 0);
  assert.deepEqual(p.sections, []);
});

test('没有段标题的条目也能读出来（不算丢内容）', () => {
  const p = parseReleaseNotes('## 0.1.0 — 2026-01-01\n\n* 一件没有段标题的事。');
  assert.equal(p.itemCount, 1);
  assert.equal(p.sections[0]?.items[0], '一件没有段标题的事。');
});

test('★ 行内代码记号摘掉（否则用户看到的是带反引号的怪东西）', () => {
  assert.equal(stripInlineCode('读了 `latest.json` 里的说明'), '读了 latest.json 里的说明');
  assert.equal(stripInlineCode('没有记号就原样'), '没有记号就原样');
});

/* ---------- ② 该显示哪一份 ---------- */

test('★★ 实时那份与当前版本相同 ⇒ 用它（它是这一版说明的权威文本）', () => {
  assert.equal(
    chooseNotes({ currentVersion: '0.1.0-rc.9', builtinHasCurrent: true, liveVersion: '0.1.0-rc.9' }),
    'live',
  );
});

test('★★ 实时那份比当前版本新 ⇒ **不许冒充本版说明**，另挂"有新版本"', () => {
  assert.equal(
    chooseNotes({ currentVersion: '0.1.0-rc.8', builtinHasCurrent: true, liveVersion: '0.1.0-rc.9' }),
    'live-newer',
  );
});

test('实时那份比当前还旧（清单没更新）⇒ 用包里那份，不拿旧的冒充新的', () => {
  assert.equal(
    chooseNotes({ currentVersion: '0.1.0-rc.9', builtinHasCurrent: true, liveVersion: '0.1.0-rc.7' }),
    'builtin',
  );
});

test('拿不到实时那份（断网 / 上游挂了）⇒ 退回包里那份，不是空白页', () => {
  assert.equal(
    chooseNotes({ currentVersion: '0.1.0-rc.9', builtinHasCurrent: true, liveVersion: undefined }),
    'builtin',
  );
});

test('两边都没有当前版本这一条 ⇒ 如实说"没有"（不是编一条出来）', () => {
  assert.equal(
    chooseNotes({ currentVersion: '0.1.0-rc.99', builtinHasCurrent: false, liveVersion: undefined }),
    'none',
  );
});

test('实时那份版本号读不出来时不许当成"相同"', () => {
  assert.equal(
    chooseNotes({ currentVersion: '0.1.0-rc.9', builtinHasCurrent: true, liveVersion: '' }),
    'builtin',
  );
});

/* ---------- ③ 跨阶段比较（rc.10 > rc.9 这种） ---------- */

test('★ 版本比较：预发布小于同号正式版，数字段按数值比', () => {
  assert.equal(compareVersions('0.1.0-rc.10', '0.1.0-rc.9'), 1, 'rc.10 比 rc.9 新（不是字符串序）');
  assert.equal(compareVersions('0.1.0', '0.1.0-rc.9'), 1, '正式版 > 预发布');
  assert.equal(compareVersions('0.1.0-beta.57', '0.1.0-rc.1'), -1, 'beta < rc');
  assert.equal(compareVersions('0.1.0-rc.9', '0.1.0-rc.9'), 0);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
});

/* ---------- ④ 包里那份**必须有当前版本这一条** ---------- */

test('★★ 包里那份横竖得能回答"我现在这版改了什么"', () => {
  /*
   * 这是这次真正踩到的坑：rc.9 发布之后，`data/release-notes.ts` 里**没有 rc.9 那一条**，
   * 于是启动器里的「更新日志」页第一张卡还是 rc.8 —— 用户的原话是
   * 「启动器没写 rc9 更新日志」。
   * ★ 实时拉取能兜住（清单里有），但断网时就没有兜底了 ⇒ 这条判据要求**包里必须有**。
   */
  assert.ok(
    RELEASE_NOTES.some((r) => r.version === APP_VERSION),
    `包里那份说明里没有当前版本 ${APP_VERSION} —— 发布新版本时必须同时补一条`,
  );
});

test('包里那份按版本倒序、且每条都有内容（空卡片等于没有）', () => {
  for (const r of RELEASE_NOTES) {
    const items = r.groups.reduce((n, g) => n + g.items.length, 0);
    assert.ok(items > 0, `${r.version} 一条内容都没有`);
  }
  for (let i = 1; i < RELEASE_NOTES.length; i++) {
    assert.ok(
      compareVersions(RELEASE_NOTES[i - 1].version, RELEASE_NOTES[i].version) > 0,
      `${RELEASE_NOTES[i - 1].version} 应排在 ${RELEASE_NOTES[i].version} 前面（按版本倒序）`,
    );
  }
});
