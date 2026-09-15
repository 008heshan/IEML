/**
 * 输入校验：**可组合的规则**（Rust 侧 `domain/validate.rs` 的镜像）
 * ------------------------------------------------------------------
 * ## 为什么两边都要有
 *
 * Rust 侧那份（`src-tauri/src/domain/validate.rs`）是**真源**：
 * 它带 PCL `ModValidate.vb` 的三态语义与全部测试。
 *
 * 前端要这份，是因为**校验必须在按键时就发生** —— 让用户填完、点确定、
 * 收到一句"不能为空"，比在输入框下面直接说清差得远。
 * 但这不构成"判据有两份"的问题：这里的规则与 Rust 侧**逐条同名同参数**，
 * 并由 `tests/validate-rules.test.js` 钉住两边一致（就像服务器地址那张表）。
 *
 * ## PCL 的三态语义（照抄，别简化）
 *
 * 一条规则对输入的结论有三种，不是两种：
 *   · `'skip'`  —— **中断检查并直接通过**（PCL 返回 `Nothing`）
 *   · `null`    —— 这条通过，继续下一条（PCL 返回 `""`）
 *   · `'原因'`  —— 不通过，这就是最终结论（PCL 返回非空串）
 *
 * `'skip'` 的存在是为了 `optional`："这个字段可以不填，不填的话
 * **后面所有规则都不适用**"。
 *
 * ## 第一条不通过的规则决定结论
 *
 * 不攒错误：用户一次只该看到**一个**要改的地方。
 */

export type RuleResult = 'skip' | string | null;

export type Rule =
  | { rule: 'optional' }
  | { rule: 'not_empty'; message?: string }
  | { rule: 'not_blank'; message?: string }
  | { rule: 'matches'; pattern: RegExp; message: string }
  | { rule: 'int_range'; min?: number; max?: number; label?: string }
  | { rule: 'len_range'; min?: number; max?: number; label?: string }
  | { rule: 'safe_name'; label?: string }
  | { rule: 'custom'; name: string; label?: string };

const DEFAULT_EMPTY = '这一项不能为空';

/* ====================== 自定义谓词（与 Rust 侧同名） ====================== */

/** 返回错误原因，或 `null` 表示通过 —— 与 Rust 的 `CustomFn` 同形 */
type CustomFn = (s: string) => string | null;

const CUSTOM_RULES: Record<string, CustomFn> = {
  no_newline: (s) => (/[\n\r\t]/.test(s) ? '不能包含换行或制表符' : null),
  no_spaces: (s) => (s.includes(' ') ? '不能包含空格' : null),
};

/* ====================== 单条规则 ====================== */

function checkRule(rule: Rule, text: string | null | undefined): RuleResult {
  switch (rule.rule) {
    case 'optional':
      /*
       * ★★ 空 / 缺失 → `'skip'`（中断并直接通过）；有内容 → `null`（继续）。
       *
       *   我第一版在 Rust 那边把这两个写反了，结果是**两个方向都错**：
       *   没填时继续跑后面的规则（把"没填"判成错），
       *   填了反而直接通过（把非法值放行）。
       */
      return text === null || text === undefined || text === '' ? 'skip' : null;

    case 'not_empty':
      return text === null || text === undefined || text === ''
        ? (rule.message ?? DEFAULT_EMPTY)
        : null;

    case 'not_blank':
      return text === null || text === undefined || text.trim() === ''
        ? (rule.message ?? DEFAULT_EMPTY)
        : null;

    case 'matches': {
      if (text === null || text === undefined) return rule.message;
      return rule.pattern.test(text) ? null : rule.message;
    }

    case 'int_range': {
      const label = rule.label || '这一项';
      if (text === null || text === undefined || text.trim() === '') {
        return `${label}要填一个整数`;
      }
      const t = text.trim();
      // 与 Rust 侧同一条早期判断（PCL 130 行：太长就不是正常输入）
      if (t.replace(/^[-+]/, '').length > 18) {
        return `${label}要填一个大小合理的数字`;
      }
      if (!/^[-+]?\d+$/.test(t)) return `${label}要填一个整数`;
      const v = Number(t);
      if (rule.max !== undefined && v > rule.max) return `${label}不能超过 ${rule.max}`;
      if (rule.min !== undefined && v < rule.min) return `${label}不能低于 ${rule.min}`;
      return null;
    }

    case 'len_range': {
      const label = rule.label || '这一项';
      if (text === null || text === undefined) return `${label}不能为空`;
      // ★ 按**字符**数（`[...text].length`），不是 `text.length`（UTF-16 码元）
      const n = [...text].length;
      if (rule.min !== undefined && n < rule.min) {
        return `${label}不能少于 ${rule.min} 个字符（现在是 ${n} 个）`;
      }
      if (rule.max !== undefined && n > rule.max) {
        return `${label}不能超过 ${rule.max} 个字符（现在是 ${n} 个）`;
      }
      return null;
    }

    case 'safe_name':
      return text === null || text === undefined
        ? `${rule.label || '名称'}不能为空`
        : safeNameError(text, rule.label || '名称');

    case 'custom': {
      if (text === null || text === undefined) return null;
      const f = CUSTOM_RULES[rule.name];
      if (!f) {
        // ★ 没注册的名字 → 报错，不静默通过（与 Rust 侧一致）
        return `（校验规则「${rule.name}」没有注册，${
          rule.label || '这一项'
        }没法检查）`;
      }
      return f(text);
    }
  }
}

/**
 * Windows 上"这个名字能不能当文件夹/文件名"。
 *
 * 逐条对照 PCL 的 `ValidateFolderName`（259-315 行）与 Rust 侧同一函数。
 */
function safeNameError(s: string, label: string): string | null {
  if (s === '') return `${label}不能为空`;
  if (s.startsWith(' ')) return `${label}不能以空格开头`;
  if (s.endsWith(' ')) return `${label}不能以空格结尾`;
  if (s.endsWith('.')) return `${label}不能以小数点结尾`;
  if (/\.\.~\d/.test(s)) return `${label}不能包含「..~数字」这种特殊格式`;

  const bad = [...s].find((c) => '<>:"/\\|?*'.includes(c) || c.charCodeAt(0) < 0x20);
  if (bad) return `${label}不能包含 ${bad} 这个字符`;

  const stem = (s.split('.')[0] ?? s).toUpperCase();
  const RESERVED = [
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ];
  if (RESERVED.includes(stem)) return `${label}不能是系统保留名（${stem}）`;

  if ([...s].every((c) => c === '.' || c === ' ')) {
    return `${label}不能只由点和空格组成`;
  }
  return null;
}

/* ====================== 引擎 ====================== */

/**
 * ★★ **按顺序跑一遍规则，返回第一条不通过的原因**（`null` = 全部通过）。
 *
 * 与 Rust 的 `validate` / PCL 的 `Validate`（8-16 行）语义一致。
 */
export function validate(
  text: string | null | undefined,
  rules: Rule[],
): string | null {
  for (const r of rules) {
    const res = checkRule(r, text);
    if (res === 'skip') return null; // 中断并直接通过
    if (res !== null) return res; // 第一条不通过就是结论
  }
  return null;
}

/** 便于调用点：`true` = 通过 */
export function isValid(text: string | null | undefined, rules: Rule[]): boolean {
  return validate(text, rules) === null;
}

/* ====================== 项目里在用的那几套（与 Rust 侧逐条一致） ====================== */

/** 实例「显示名」—— 可以写中文，但挡换行/制表符与超长 */
export function instanceNameRules(): Rule[] {
  return [
    { rule: 'not_blank', message: '版本名不能为空，也不能只有空格' },
    { rule: 'custom', name: 'no_newline', label: '版本名' },
    { rule: 'len_range', min: 1, max: 64, label: '版本名' },
  ];
}

/** 实例 `slug`（磁盘目录名）—— 它就是文件夹名 */
export function slugRules(): Rule[] {
  return [
    { rule: 'not_blank', message: '目录名不能为空' },
    { rule: 'safe_name', label: '目录名' },
    { rule: 'len_range', min: 1, max: 48, label: '目录名' },
  ];
}

/** 离线玩家名（会被写进 `--username`） */
export function offlineUsernameRules(): Rule[] {
  return [
    { rule: 'not_blank', message: '玩家名不能为空' },
    {
      rule: 'matches',
      pattern: /^[A-Za-z0-9_]{1,16}$/,
      message: '玩家名只能用英文字母、数字、下划线，且不超过 16 个字符',
    },
  ];
}

/** 服务器地址的**端口**部分（主机名由 `parseServerAddress` 管） */
export function portRules(): Rule[] {
  return [
    { rule: 'optional' },
    { rule: 'int_range', min: 1, max: 65535, label: '端口' },
  ];
}
