/**
 * 改「版本隔离」之后要做的事（ADR-005）
 * ------------------------------------------------------------------
 * 这一小段流程是从设置页里抽出来的，因为它有**四步**，而其中两步很容易漏：
 *
 * ```text
 *   ① 存设置          → 账本里的 config.isolation
 *   ② **回读判定**    → 判定由后端算（ADR-006），前端不许自己推一个结论出来
 *   ③ 问一句要不要搬   → 隔离一改，游戏看的目录就换了；旧目录里的存档/Mod
 *                       不会自己跑过去（用户会以为"东西丢了"）
 *   ④ 搬之前先备份     → ADR-014 的后悔药
 * ```
 *
 * ## 为什么"搬"这件事必须由用户点头
 *
 *   切换隔离是**一个下拉框的动作**，而它的后果是"游戏从此读另一个目录"。
 *   自动搬的话，用户会在不知情的情况下多出一份 copies（占盘），
 *   或者更糟 —— 以为我们在删他的东西。所以：**先给计划（会搬什么、从哪到哪、
 *   不搬会怎样），再让他选**。
 *
 * ## 为什么永不覆盖、永不删除
 *
 *   迁移只做 `copy`，目标里已有同名文件就跳过并报出来（`overwrite: false`）。
 *   源目录里的东西一个字节都不动 —— 这样这件事**永远可逆**，
 *   万一用户其实不想换，或者换回去，什么都没丢。
 */
import type { RealApi } from '../bridge';
import type { IsolationInfo } from '../bridge/tauri';

export interface IsolationChangeDeps {
  /** 当前保存用的后端（前端 store 的 updateConfig 已经写账本，这里只用来刷新与迁移） */
  api: RealApi | null;
  /** 重新拉一遍全部判定（写进 state） */
  refresh: () => Promise<void>;
  /**
   * ★★ **改之前**那一份判定（调用方从 state 里取，改设置之前的值）。
   *
   *   判断"结论有没有翻面"必须拿**前后两份**比 —— 只有新结论时无法判断：
   *   曾经写成"新结论与目标不同才算翻面"，那正好把该问的那一次跳过
   *   （探针抓到的：界面拨到「强制隔离」后弹窗不出现）。
   */
  before?: IsolationInfo | null;
  /** 问用户"要不要把内容搬过去"；返回 false = 只切不搬 */
  ask: (plan: {
    from: string;
    to: string;
    items: Array<{ name: string; files: number; bytes: number }>;
    consequence: string;
  }) => Promise<{ move: boolean; backupFirst: boolean } | null>;
  toast: (kind: 'ok' | 'warning' | 'err' | 'info', title: string, desc?: string) => void;
  /** 把字节数写成人话（复用界面的 formatBytes） */
  formatBytes: (n: number) => string;
}

export interface IsolationChangeResult {
  /** 改完之后后端算出的结论（拿不到时为 null） */
  verdict: IsolationInfo | null;
  /** 迁移动了几个文件（没搬时为 0） */
  movedFiles: number;
}

/**
 * 等账本落盘之后**再读判定**。
 *
 * ★★ 为什么必须等：实例配置是 `AppContext` 里那个 **250ms 去抖** 的 effect 写盘的
 *   （`save_instances`），而判定要读的是 `instances.json` 里的 `config.isolation`。
 *   改完设置立刻读 ⇒ 读到的是**旧模式**算出来的结论 ⇒ 结论"看起来没翻面" ⇒
 *   该问的迁移一句都不问（用户以为启动器忘了）。
 *   （这条竞态是探针抓出来的：界面拨到「不隔离」后弹窗没出现。）
 *
 * 判据不是"睡够 250ms"（那是在赌机器快慢），而是**等到后端算出来的结论
 * 与新模式一致**为止；等不到就如实说"没读到新模式"，绝不假装已经切好了。
 */
async function readVerdictAfterSave(
  api: RealApi,
  slug: string,
  toMode: 'auto' | 'on' | 'off',
): Promise<IsolationInfo | null> {
  const want = toMode === 'auto' ? null : { isolated: toMode === 'on', source: 'user' };
  const deadline = Date.now() + 3000;
  let v: IsolationInfo | null = null;
  for (;;) {
    try {
      v = await api.isolation.of(slug);
    } catch {
      return null;
    }
    if (!want) {
      // auto：没有"目标结论"可比，给它一拍让账本落盘就够
      if (Date.now() + 2700 > deadline) return v;
    } else if (v.isolated === want.isolated && v.source === want.source) {
      return v;
    }
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * 把模式改成 `toMode` 之后跑完那四步。
 *
 * ★ 迁移的方向由**结论**决定，不由用户选的那一档决定：
 *   「自动」也可能把结论判到共享那一侧（全局默认是共享、目录还是空的），
 *   那时要搬的方向就是"搬出去"。所以先回读结论，再按结论定方向。
 */
export async function runIsolationChange(
  slug: string,
  toMode: 'auto' | 'on' | 'off',
  deps: IsolationChangeDeps,
): Promise<IsolationChangeResult> {
  if (!deps.api) {
    // 演示模式：没有后端，也就没有判定与迁移 —— 如实说，不假装
    await deps.refresh();
    return { verdict: null, movedFiles: 0 };
  }

  // ② 回读判定（设置已经由调用方写进账本了 —— 但要等它真的落盘）
  const verdict = await readVerdictAfterSave(deps.api, slug, toMode);
  await deps.refresh();
  if (!verdict) {
    deps.toast('warning', '读不到隔离判定', '设置已经保存，但这次没能确认切换后的结果。');
    return { verdict: null, movedFiles: 0 };
  }

  /*
   * ③ 只有**结论真的翻了面**才谈迁移：用户把 auto 改成 on（本来就在隔离）
   *    也要问一句"要不要搬"，那是纯打扰。
   *
   * ★ 判据是"改之前那份判定 vs 现在这份" —— 不是"新结论 vs 目标模式"。
   *   后者听起来等价，其实相反：切到「强制隔离」之后新结论就是 isolated，
   *   而目标也是 isolated，于是"不同才算翻面"永远不成立、永远不问。
   */
  const flipped = deps.before ? deps.before.isolated !== verdict.isolated : true;
  if (!flipped) return { verdict, movedFiles: 0 };

  // 方向由**新结论**决定：要隔离就把共享目录里的搬进来，要共享就把实例的搬出去
  const target: 'on' | 'off' = verdict.isolated ? 'on' : 'off';

  let plan;
  try {
    plan = await deps.api.isolation.planMigration(slug, target);
  } catch (e) {
    /*
     * ★ 计划都算不出来（例如实例不在账本里）不该拦住设置本身：
     *   如实说一句，然后继续 —— 用户已经表达了他的选择。
     */
    deps.toast('warning', '没法自动搬内容', e instanceof Error ? e.message : String(e));
    return { verdict, movedFiles: 0 };
  }
  if (plan.items.length === 0) return { verdict, movedFiles: 0 };

  const answer = await deps.ask({
    from: plan.from,
    to: plan.to,
    items: plan.items,
    consequence: plan.consequence,
  });
  if (!answer || !answer.move) return { verdict, movedFiles: 0 };

  try {
    const r = await deps.api.isolation.applyMigration(slug, target, answer.backupFirst);
    const files = r.copied.reduce((n, c) => n + c.files, 0);
    const bytes = r.copied.reduce((n, c) => n + c.bytes, 0);
    const extra: string[] = [];
    if (r.backup_id) extra.push(`已先备份一份（${r.backup_id}）`);
    if (r.skipped_existing.length > 0) {
      extra.push(
        `${r.skipped_existing.length} 个同名文件没有覆盖（${r.skipped_existing
          .slice(0, 3)
          .join('、')}${r.skipped_existing.length > 3 ? '…' : ''}）`,
      );
    }
    if (r.failed.length > 0) extra.push(`${r.failed.length} 个复制失败（${r.failed[0]}）`);
    deps.toast(
      r.failed.length > 0 ? 'warning' : 'ok',
      files > 0 ? `已复制 ${files} 个文件（${deps.formatBytes(bytes)}）` : '没有需要复制的内容',
      ['原目录里的东西**没有删**，确认没问题后你可以自己清理。', ...extra].join('\n'),
    );
    return { verdict, movedFiles: files };
  } catch (e) {
    deps.toast('err', '复制失败', e instanceof Error ? e.message : String(e));
    return { verdict, movedFiles: 0 };
  }
}
