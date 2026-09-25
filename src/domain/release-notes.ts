/**
 * 「更新说明」——**实时从更新通道读回来的那一份**的解析与合并。
 * ------------------------------------------------------------------
 * ★★ 2026-09-26 用户：「**这个版本更新列表可以改成实时获取吗，点进去就刷新**」。
 *
 *   `docs/CHANGELOG.md` 里那一节是 Markdown（`## 版本` / `### 段落` / `* 条目`），
 *   发布脚本把它原样放进清单的 `notes`。这个文件负责把它变成界面能渲染的东西，
 *   以及回答"**这份说明是哪一版的、要不要顶掉包里那份**"。
 *
 * ★ 为什么放 `domain/`：`.tsx` 进不了 `node --test`，而"哪一份说明该显示"
 *   恰恰是**错了不会报错、只会显示过时内容**的那类判断 —— 必须有判据钉着
 *   （`tests/release-notes.test.mjs`）。
 */

/** 说明里的一段（`### 新增了` 这种；没有段标题的条目落在 `''` 这一段） */
export interface NoteSection {
  title: string;
  items: string[];
}

/** 从清单 `notes` 里解析出来的说明 */
export interface ParsedNotes {
  /** 标题行里的版本号（`## 0.1.0-rc.9 — …` → `0.1.0-rc.9`）；读不到就是空串 */
  version: string;
  /** 标题行剩下的部分（`—` 之后那句话）；没有就是空串 */
  headline: string;
  /** 正文分段 */
  sections: NoteSection[];
  /** 正文里的条目总数（判断"这份说明是不是空的"用） */
  itemCount: number;
}

/** 标题行里版本号的样子：`## 0.1.0-rc.9 — 2026-09-26（…）` */
const VERSION_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/;

/**
 * 把 Markdown 的 `notes` 读成结构。
 *
 * ★ 只认三种行（发布脚本产出的就是这三种，`tools/check-release-notes.mjs`
 *   还额外守着"五段名、顺序、类别词"这些规矩）：
 *   · `## ` → 标题行（取版本号与那句话）
 *   · `### ` → 段标题
 *   · `* ` / `- ` → 条目（**续行会被接到上一条**，因为长条目会折行）
 * ★ `>`（引用）与 `---`（分隔线）会被跳过：它们是给仓库里那份 CHANGELOG 排版的，
 *   不是给用户看的正文。
 */
export function parseReleaseNotes(md: string): ParsedNotes {
  const out: ParsedNotes = { version: '', headline: '', sections: [], itemCount: 0 };
  let section: NoteSection | null = null;
  /*
   * ★★ 只在**第一个 `## ` 那一节**里读。
   *
   *   清单里的 `notes` 本来就只有一节，但解析器**不能靠这个前提活着** ——
   *   第一版没停，于是在一份"两节拼起来"的文本上把下一版的条目也读了进来
   *   （测试当场抓到：条目数 3 → 4、段标题里多出一个 `修复了`）。
   *   症状会是"这一版的更新日志里混着上一版的话"，而这**一声不响**。
   */
  let started = false;

  const pushSection = () => {
    // ★ 没有标题又没有条目的段不产出（空卡片等于没有内容）
    if (section && section.items.length > 0) out.sections.push(section);
  };

  for (const raw of String(md ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('---')) continue;

    // 引用块：去掉记号当作正文读它（"桥接说明"那种整段引用就是这么进来的）
    const body = line.startsWith('>') ? line.replace(/^>\s?/, '').trim() : line;
    if (!body) continue;

    if (body.startsWith('## ')) {
      if (started) break; // ★ 到了下一版 ⇒ 本版读完
      started = true;
      const title = body.slice(3).trim();
      const m = VERSION_RE.exec(title);
      out.version = m?.[1] ?? '';
      // 标题里 `—` 之后那句话就是头条
      const rest = title.split(/—|--/).slice(1).join('—').trim();
      out.headline = rest;
      continue;
    }
    if (!started) continue; // 标题之前的内容不属于任何一版（清单里不会有，但别乱读）
    if (body.startsWith('### ')) {
      pushSection();
      section = { title: body.slice(4).trim(), items: [] };
      continue;
    }
    if (body.startsWith('* ') || body.startsWith('- ')) {
      const text = body.slice(2).trim();
      if (!section) section = { title: '', items: [] };
      section.items.push(text);
      out.itemCount += 1;
      continue;
    }
    /*
     * 其它行 = **上一条的续行**（长条目在 Markdown 里会折行）。
     * ★ 没有上一条时（说明开头就是一段散文）当作一条独立条目，不要丢内容 ——
     *   "读不出来就当没有"是这个仓库最贵的一类 bug。
     */
    if (section && section.items.length > 0) {
      section.items[section.items.length - 1] += ` ${body}`;
    } else {
      if (!section) section = { title: '', items: [] };
      section.items.push(body);
      out.itemCount += 1;
    }
  }
  pushSection();
  return out;
}

/**
 * 界面正文里那些**只给开发者看**的记号要摘掉。
 *
 * ★ 具体是行内代码的反引号：用户在更新说明里看到 `` `publish-cnb.mjs` ``
 *   是一串带撇号的怪东西（`RichText` 只认 `**加粗**`，不认反引号）。
 *   摘掉撇号、内容原样留着 —— 那句话对玩家照样读得通。
 */
export function stripInlineCode(s: string): string {
  return String(s ?? '').replace(/`([^`]+)`/g, '$1');
}

/** 实时那一份要不要顶掉包里那份？ */
export type NotesChoice =
  /** 用实时的（清单版本 == 当前版本，说明是最新的权威文本） */
  | 'live'
  /** 用包里的（实时那份拿不到，或不是同一版） */
  | 'builtin'
  /** 实时的那一版**比当前版本新**：另外挂一条"有新版本" */
  | 'live-newer'
  /** 两边都没有（内置数据里没有当前版本这一条） */
  | 'none';

/**
 * 决定显示哪一份说明。
 *
 * 判据（顺序即优先级）：
 *   · 实时那份的版本 **==** 当前版本 → `live` —— 它是这一版说明的权威文本
 *     （发布后改过说明时，界面不会还挂着包里那份旧的）；
 *   · 实时那份的版本 **>** 当前版本 → `live-newer` —— 说明是**新版本**的，
 *     不能冒充"本版说明"，页面要另说一句"有新版本"；
 *   · 其余（拿不到 / 版本认不出 / 比当前还旧）→ `builtin`。
 *
 * ★ 为什么不"有就用"：清单指向的永远是**最新那一版**，而用户可能落后好几版 ——
 *   把新版说明当成本版说明显示，就是一句**具体的假话**。
 */
export function chooseNotes(opts: {
  currentVersion: string;
  builtinHasCurrent: boolean;
  liveVersion?: string;
  liveItemCount?: number;
}): NotesChoice {
  const live = (opts.liveVersion ?? '').trim();
  const cur = (opts.currentVersion ?? '').trim();
  if (live && cur) {
    if (live === cur) return 'live';
    if (compareVersions(live, cur) > 0) return 'live-newer';
  }
  return opts.builtinHasCurrent ? 'builtin' : 'none';
}

/**
 * 比版本号（**只用来判"谁更新"**，与 `publish-cnb.mjs` 里那个同口径）：
 * 预发布比同号正式版小，数字段按数值比（`rc.10 > rc.9`，不是字符串序）。
 */
export function compareVersions(a: string, b: string): number {
  const [aCore = '', aPre] = String(a).split('-');
  const [bCore = '', bPre] = String(b).split('-');
  const seg = (s: string) => s.split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const ac = seg(aCore);
  const bc = seg(bCore);
  for (let i = 0; i < 3; i++) {
    const d = Number(ac[i] ?? 0) - Number(bc[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return 1; // 正式版 > 预发布
  if (bPre === undefined) return -1;
  const ap = aPre.split('.');
  const bp = bPre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const an = /^\d+$/.test(x);
    const bn = /^\d+$/.test(y);
    if (an && bn) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
      continue;
    }
    if (an !== bn) return an ? -1 : 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
