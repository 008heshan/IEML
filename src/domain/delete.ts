/**
 * 删除语义（ADR-042）
 * ------------------------------------------------------------------
 * ★ 源码事实（源码研读第 13 章）：PCL2 删实例/删 Mod 都走系统回收站，
 *   只有用户**按住 Shift 点删除**才是真删。回收站不可用时，
 *   它会明确告诉用户"移入回收站失败"，而不是偷偷改成永久删除。
 *
 * 本项目的规则（与 Rust 侧 `delete_path` 一一对应）：
 *   1. 默认 → 系统回收站，文案里**不许写"不可撤销"**（那是假话）；
 *   2. Shift → 永久删除，文案必须写明"不进回收站、无法恢复"；
 *   3. 回收站失败 → 不静默降级，把后端错误原样抛出，由界面问用户；
 *   4. 确认框里的清单来自真实数据（几个 Mod / 多少字节），不写空话。
 *
 * 这条规则的来源是一次真实的界面谎言：三个删除确认框都写着
 * "存档与配置会一起删除，不可撤销"，而后端当时**一个字节都没删**。
 * 所以：**文案必须等于代码行为** —— 这里把它收敛成唯一一处规则。
 */

export interface DeleteIntent {
  /** 用户点删除时有没有按住 Shift（表达"我知道我在干什么"） */
  shift: boolean;
}

export interface DeleteCopy {
  /** 进回收站还是永久删 */
  permanent: boolean;
  /** 确认框正文（第一行是问句，最后一行是后果） */
  message: string;
  /** 成功后报告的动词，例如"已移到回收站" */
  doneVerb: string;
}

/** 从一次点击事件里读出意图（React 的 MouseEvent / 原生事件都能用） */
export function deleteIntent(e: { shiftKey?: boolean } | undefined | null): DeleteIntent {
  return { shift: Boolean(e?.shiftKey) };
}

/** 用户按住 Shift 想永久删时给的一次性二次确认文案 */
export const PERMANENT_WARNING =
  '你按住了 Shift —— 这会跳过回收站直接永久删除，删掉就找不回来了。\n\n确定吗？';

/** 回收站不可用时（网络盘 / 精简版 Windows）问用户要不要改成永久删 */
export function trashUnavailablePrompt(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `${detail}\n\n要改成【永久删除】吗？永久删除无法恢复。`;
}

interface DescribeArgs {
  /** 删什么，例如「3 个 Mod」「实例「1.20.1 Forge」」 */
  what: string;
  /** 将被删除的内容清单，每行一条（可为空） */
  items?: string[];
  /** 额外提醒（例如"共享的游戏文件不会被删除"） */
  note?: string;
  /** 总大小，有就写进去让用户有概念 */
  bytes?: number;
  /** 估算不出大小时为 true —— 那就**不写**大小，不编数字 */
  intent: DeleteIntent;
}

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * 生成删除确认框的完整文案。
 *
 * ★ 铁律：`permanent` 与 `message` 必须同时来自这里 ——
 *   界面文案和实际行为不允许由两处代码各自决定。
 */
export function describeDelete(args: DescribeArgs): DeleteCopy {
  const lines: string[] = [`确定删除${args.what}？`, ''];
  const items = (args.items ?? []).filter((s) => s.trim().length > 0);
  if (items.length > 0) {
    lines.push('将被删除的内容：');
    for (const it of items) lines.push(it.startsWith('·') ? it : `· ${it}`);
  }
  if (args.bytes !== undefined && args.bytes > 0) {
    lines.push(`· 磁盘上约 ${humanBytes(args.bytes)}`);
  }
  if (args.note) {
    lines.push('', args.note);
  }
  if (args.intent.shift) {
    lines.push('', '⚠ 你按住了 Shift：直接永久删除，不进回收站，删掉就找不回来了。');
    return { permanent: true, message: lines.join('\n'), doneVerb: '已永久删除' };
  }
  lines.push('', '会移入系统回收站，误删还能捞回来。');
  return { permanent: false, message: lines.join('\n'), doneVerb: '已移到回收站' };
}
