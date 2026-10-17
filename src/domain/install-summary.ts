/**
 * 整合包安装收尾**那三句话的唯一一份判据**。
 * ------------------------------------------------------------------
 * ★★★★ 2026-10-17（用户：「装完了但缺 N 个文件」）。
 *
 * ## 由来：一次"把缺了东西说成完成了"
 *
 *   后端的收尾结论原来是**两档**：`outcome.failed` 空 ⇒ 成功，非空 ⇒ `Err`。
 *   于是"有几个文件没下来"和"这个包根本起不来"被混成一件事。
 *   现在它分三档（判据在 `src-tauri/src/domain/pack_outcome.rs::classify_install`，
 *   一路带到 `ModpackInstallResult.tier`）：
 *
 *   | 档位 | 事实 | 结果 |
 *   |---|---|---|
 *   | `complete` | 清单里的文件全到手 | 成功（照旧） |
 *   | `partial`  | **≥1 个没到手，但骨架齐全**（包体 + 客户端 jar + 加载器） | **仍然算成功**：实例照建 |
 *   | `null`     | **这一次没有档位结论** —— 暂停 / 提前返回走这一档 | 先看 `paused` |
 *
 *   界面这边的旧形状只认 `missing_files` 有没有内容，而且主路径先写死一句
 *   「安装完成」（任务卡片），再补一句缺件提示 —— partial 时那句"完成"
 *   就是**假话**：用户最忌讳的"把缺了东西说成完成了"。
 *
 * ## 为什么提成纯函数（而不是在页面里各写各的）
 *
 *   这三句话要出现在三个地方：
 *     ① **任务卡片**（标题 / 状态角标 / 副标题）；
 *     ② **toast**（标题 + 正文）；
 *     ③ **页面提示**（留在安装页那一块）。
 *   写在三处 ⇒ 分叉只是时间问题，而分叉的后果正是同一句假话从另一处冒出来。
 *   所以：**同一个输入只算一次**，三处都从它取（本文件 + `tests/install-summary.test.mjs`）。
 *
 * ## 两条判据顺序（别调换）
 *
 *   ① **先看 `paused`**：暂停不属于三档（后端在暂停时给的 `tier` 就是 `null`）。
 *      暂停的文件还在 `.part` 里等着续传，说成"缺件"会把用户引到
 *      「重新下载缺失的」那条**错的**路上（正确出口是「继续」）。
 *   ② **`tier` 说 full/partial，但数据说缺了** ⇒ 按缺的说。
 *      `missing_count > 0` 是**数据**、不需要档位替它背书：`tier` 缺失
 *      （老后端、演示模式）时也得如实说"缺 N 个"，而不是退回"完成"。
 *      ★ 反过来不成立：数据说没缺、`tier` 也不是 partial ⇒ 才敢说装好了。
 *
 * ## 「安装完成」这四个字
 *
 *   它只允许出现在 `complete` 那一档（后端真的核对过"清单里的文件全到手"）。
 *   `partial` / `paused` / `unknown` 一律不许 —— 这条由测试直接钉住。
 */
import { REPAIR_ENTRY_LABEL, missingSummary } from './pack-missing.ts';
import type { MissingFile } from './pack-missing.ts';

/**
 * 后端 `ModpackInstallResult.tier` 的取值。
 *
 * ★ `null`（或字段缺失）= **没有档位结论**，不是"完整"也不是"缺件"：
 *   暂停 / 提前返回那条路给的就是它（`paused_pack_result` 里写着理由）。
 */
export type InstallTier = 'complete' | 'partial' | null;

/** 收尾时要看的那些事实（后端 `ModpackInstallResult` 上的字段，一个都不加工） */
export interface InstallOutcomeInput {
  /** 档位结论（后端 `tier`） */
  tier?: InstallTier;
  /** 是不是被暂停停下（★ **先看它**，见文件头第①条） */
  paused?: boolean;
  /** 暂停时还没下的文件数（`remaining_files`） */
  remainingFiles?: number;
  /** 暂停发生在哪一步（`paused_stage`）——说了才能回答"停在哪了" */
  pausedStage?: string | null;
  /** 没到手的**总数**（`missing_count` = 下载失败 + 没解析出地址） */
  missingCount?: number;
  /** 其中**下载失败**的条数（`failed_count`）—— 只用于把两类分开说 */
  failedCount?: number;
  /** 明细（`missing_files`）：有它就能**点名**，而不是只给一个数 */
  missing?: ReadonlyArray<MissingFile>;
}

/** 三处文案 + 两个动作判据（都在这里算好，调用方只负责渲染） */
export interface InstallSummary {
  /** 落在哪一档（`unknown` = 没有档位结论，且数据也说没缺） */
  kind: 'complete' | 'partial' | 'paused' | 'unknown';
  /**
   * ★ 三处**共用**的那一句。
   *   partial 时它就是"装好了，但缺 N 个文件" —— 任务卡片标题、toast 标题、
   *   页面提示的小标题都取这一句，所以三处不可能各说各的。
   */
  title: string;
  /** 更细的一句（toast 正文 / 卡片副标题 / 页面提示正文） */
  detail: string;
  /** 要不要提醒（partial = true；完成 / 暂停 / 无结论 = false） */
  warn: boolean;
  /** 「重新下载缺失的」的文案；`null` = 不给这个入口。★ 措辞只有一份（见常量） */
  action: string | null;
  /** 要不要**留在这一屏**（partial：跳走等于把"缺哪几个"从屏幕上抹掉） */
  stay: boolean;
}

/** 计数归一：只认有限正数，其余一律 0（脏数据不许变成负数或 NaN 传到文案里） */
function countOf(v: number | undefined | null): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return n > 0 ? n : 0;
}

/**
 * 收尾的三句话（**唯一实现**）。
 *
 * 幂等、不动输入、不抛 —— 它就是一张判据表。
 */
export function installSummary(input: InstallOutcomeInput): InstallSummary {
  const remaining = countOf(input.remainingFiles);

  /*
   * ① 暂停**先看**（后端在暂停时共享同一个 `tier: null`，而"暂停"与"缺件"
   *    是两件完全不同的事：前者的文件还在盘上等着续传）。
   */
  if (input.paused) {
    const bits: string[] = [];
    if (remaining > 0) bits.push(`还剩 ${remaining} 个文件没下`);
    const stage = String(input.pausedStage ?? '').trim();
    /*
     * ★ 文件下完了但某一步没做（例如加载器安装器还没跑）时**要点名那一步** ——
     *   只说一句"已暂停"会让人以为已经装好了（`markPausedConfirmed` 同一条）。
     */
    if (stage) bits.push(`「${stage}」这一步还没做完`);
    return {
      kind: 'paused',
      title: '已暂停',
      detail: bits.length > 0 ? `${bits.join(' · ')}，点「继续」接着装。` : '点「继续」接着装。',
      warn: false,
      action: null,
      stay: false,
    };
  }

  const listed = countOf(input.missing?.length);
  const declared = input.missingCount === undefined ? null : countOf(input.missingCount);
  /*
   * 总数以 `missing_count` 为准（后端算好的那一个数）；它没给时才退回
   * 明细条数 / 下载失败数。★ **不取三者的最大值**：`failed_count` 比
   * `missing_count` 大是脏数据，取最大值会编出一个"超过总数"的分配
   * （detail 里会出现 −N 那种算出来的数）。
   */
  const total = Math.max(declared ?? 0, listed, declared === null ? countOf(input.failedCount) : 0);
  const failed = Math.min(countOf(input.failedCount), total);
  const unresolved = Math.max(total - failed, 0);

  /* ② 缺件：`tier === 'partial'` 是后端说的，`total > 0` 是数据说的 —— 两者任一个都算 */
  if (input.tier === 'partial' || total > 0) {
    /*
     * ★ 有明细就**点名**（"缺哪几个"才是用户要的），措辞直接用
     *   `pack-missing.ts::missingSummary` —— 那一句已经有一份（含它自己的测试），
     *   这里不再拼第二套。
     */
    const named = listed > 0 ? missingSummary(input.missing ?? []) : '';
    const parts: string[] = [];
    if (failed > 0) parts.push(`${failed} 个是下载失败`);
    if (unresolved > 0) parts.push(`${unresolved} 个是没解析出下载地址`);
    const split = parts.length > 0 ? `（${parts.join('，')}）` : '';
    return {
      kind: 'partial',
      title: total > 0 ? `装好了，但缺 ${total} 个文件` : '装好了，但没装全',
      /*
       * ★ 一件说清楚的事：**缺的这几个不影响已经装好的部分** ——
       *   不计入这条，用户会以为整个包装坏了（partial 的定义正是"骨架齐全"）。
       */
      detail:
        named.length > 0
          ? `${named} 已经装好的部分不受影响。`
          : total > 0
            ? `还有 ${total} 个文件没到手上${split}。已经装好的部分不受影响，可以点「${REPAIR_ENTRY_LABEL}」再试一次。`
            : `有文件没到手上，但这一次没拿到条数 —— 名字和原因见下面那张清单。已经装好的部分不受影响。`,
      warn: true,
      action: REPAIR_ENTRY_LABEL,
      stay: true,
    };
  }

  /* ③ 后端确认"清单里的文件全到手" —— 只有这一档可以说装完了 */
  if (input.tier === 'complete') {
    return {
      kind: 'complete',
      title: '整合包装好了',
      detail: '清单里的文件都到位了，可以启动。',
      warn: false,
      action: null,
      stay: false,
    };
  }

  /*
   * ④ 没有档位结论（`tier` 是 `null` / 字段缺失）。
   *   ★ **不许替后端下结论**：这一档说明"这一次没人核对过装全了没有"，
   *     所以既不提"缺"，也不说"完成" —— 只说安装已经结束，并给出复核的入口。
   */
  return {
    kind: 'unknown',
    title: '整合包装好了',
    detail: '安装已经结束；这一次没拿到"装全了没有"的结论，可以在实例页点「检查完整性」复核。',
    warn: false,
    action: null,
    stay: false,
  };
}
