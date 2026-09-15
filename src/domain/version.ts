/**
 * 版本号比较与版本区间（ADR-022 闭区间模型）
 * ------------------------------------------------------------------
 * 三件容易写错的事：
 *   ① MC 版本号不是三段式（"1.20" / "24w45a"），比较要能容错
 *   ② Forge 的 revision 比较：不含 '.' 的如 "36.2" 只比最后一段
 *   ③ 区间必须能表达 [17.0, 22.0) 这种半开区间，且左右含否要分别记录
 */

/** 把版本串拆成可比较的段；非数字段退化为 0，保证不会 NaN */
export function parseVersion(v: string): number[] {
  return String(v)
    .split('.')
    .map((seg) => {
      // 取段开头的数字，兼容 "0.16.9+build.1" / "r175" 这类
      const m = /^(\d+)/.exec(seg.trim());
      return m?.[1] ? parseInt(m[1], 10) : 0;
    });
}

/** -1 / 0 / 1 */
export function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Forge 版本匹配（源码事实：RequiredForgeVersion 的两种比较方式）
 *   - 需求串是**完整三段式**（如 "47.2.0"）→ 精确比较，要求完全一致
 *   - 需求串是**两段式**（如 "36.2"）→ 按段位前缀匹配，
 *     所以 36.2.39 / 36.2.34 都通过，36.1.0 不通过
 *   - 空串 → 无限制
 *
 * 这里踩过两次坑，记下来：
 *   ① 最初写成"只比末段"，导致 36.1.2 会被误判为通过
 *   ② 然后写成"含 '.' 就精确比较"，结果 36.2 这个两段式需求
 *      永远匹配不上 36.2.39（因为精确比较要求 36.2.0 == 36.2.39，为假）
 *   正确判据是**段数**，不是"含不含点"。
 */
export function forgeVersionSatisfies(required: string, actual: string): boolean {
  const req = required.trim();
  if (req === '') return true;

  const reqSegs = req.split('.');
  const actSegs = actual.split('.');

  // 三段及以上 = 完整版本号，必须精确一致
  if (reqSegs.length >= 3) return compareVersion(req, actual) === 0;

  // 两段式 = revision 前缀匹配
  if (actSegs.length < reqSegs.length) return false;
  for (let i = 0; i < reqSegs.length; i++) {
    const want = reqSegs[i] ?? '';
    const got = actSegs[i] ?? '';
    // 数值比较，避免 "02" 与 "2" 被当成不同
    if (parseInt(want, 10) !== parseInt(got, 10)) return false;
  }
  return true;
}

/**
 * 版本区间（ADR-022）
 * 表达 [min, max) —— 左含右不含是默认约定，"Java 21 到底算不算"这类歧义必须让用户能选中。
 */
export interface VersionRange {
  min: number | null;
  max: number | null;
  minInclusive: boolean;
  maxInclusive: boolean;
}

/** 解析形如 "[17.0, 22.0)" / "(,21]" / "[17,)" 的区间串 */
export function parseRange(text: string): { ok: true; range: VersionRange } | { ok: false; error: string } {
  const t = text.trim();
  const m = /^([[(])\s*([\d.]*)\s*,\s*([\d.]*)\s*([\])])$/.exec(t);
  if (!m) {
    return {
      ok: false,
      error: '区间格式形如 [17.0, 22.0) —— 方括号表示含该值，圆括号表示不含，留空一侧表示不限制',
    };
  }
  const [, left, minRaw, maxRaw, right] = m;
  const min = minRaw === '' ? null : Number(minRaw);
  const max = maxRaw === '' ? null : Number(maxRaw);

  if (min !== null && Number.isNaN(min)) return { ok: false, error: '下限不是合法数字' };
  if (max !== null && Number.isNaN(max)) return { ok: false, error: '上限不是合法数字' };
  if (min === null && max === null) return { ok: false, error: '两侧都不限制时，请直接选「自动选择」' };

  if (min !== null && max !== null) {
    if (min > max) return { ok: false, error: `下限 ${min} 大于上限 ${max}` };
    if (min === max && (left === '(' || right === ')')) {
      return {
        ok: false,
        error: `[${min}, ${max}${right} 是空区间（开区间两端相等什么都选不到）。如果只想允许 ${min}，请写 [${min}, ${min}]`,
      };
    }
  }

  return {
    ok: true,
    range: {
      min,
      max,
      minInclusive: left === '[',
      maxInclusive: right === ']',
    },
  };
}

/** 某个值是否落在区间内 */
export function inRange(value: number, r: VersionRange): boolean {
  if (r.min !== null) {
    if (r.minInclusive ? value < r.min : value <= r.min) return false;
  }
  if (r.max !== null) {
    if (r.maxInclusive ? value > r.max : value >= r.max) return false;
  }
  return true;
}

/**
 * 区间的"右侧闭区间歧义"提示（PCL2 的两种改法，ADR-022）
 * 当用户写了 [17, 21] 而 21 正好是某台机器的 Java 版本时，提示他怎么改成不含 21。
 */
export function rangeBoundaryHint(r: VersionRange, probe: number): string | null {
  if (r.max !== null && r.max === probe && r.maxInclusive) {
    return `如果不想允许 Java ${probe}，请改为 ${probe})；如果想允许，请改为 ${probe + 1})`;
  }
  if (r.min !== null && r.min === probe && !r.minInclusive) {
    return `如果不想允许 Java ${probe}，保持现状；如果想允许，请改为 [${probe}, ...)`;
  }
  return null;
}

export function formatRange(r: VersionRange): string {
  const l = r.minInclusive ? '[' : '(';
  const rt = r.maxInclusive ? ']' : ')';
  return `${l}${r.min ?? ''}, ${r.max ?? ''}${rt}`;
}
