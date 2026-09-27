/**
 * 版本隔离判定（ADR-005 三段判定）
 * ------------------------------------------------------------------
 * 原设计稿把隔离做成一个"开/关"开关，甚至全局开关 + 实例开关两处并存，
 * 语义完全冲突。真实模型是**三段判定**：
 *
 *   用户显式设置  >  该实例目录下有无 mods/saves  >  全局默认（auto）
 *
 * 并且**必须把判定依据说出来** —— 用户选"自动"时并不知道启动器会怎么判。
 */
import type { IsolationMode, IsolationSource } from './types.ts';

export interface IsolationInput {
  mode: IsolationMode;
  /** 该实例目录下是否已经出现 mods/ 或 saves/ */
  hasContent: boolean;
  /** 全局默认策略（设置页里的那个开关） */
  globalDefault: 'isolated' | 'shared';
  /** 该实例是不是整合包导入的（整合包一律隔离） */
  fromModpack?: boolean;
}

export interface IsolationVerdict {
  /** 最终是否隔离 */
  isolated: boolean;
  /** 判定来源，UI 用它显示「已强制」「已自动判定」「跟随全局」 */
  source: IsolationSource;
  /** 一句话依据，必须具体到"检测到了什么" */
  reason: string;
  /** 关闭隔离时的后果警告（危险操作必须说清后果） */
  warning?: string;
}

export function resolveIsolation(input: IsolationInput): IsolationVerdict {
  /* ---- ① 整合包实例一律隔离，这是包作者的前提假设 ---- */
  if (input.fromModpack && input.mode !== 'off') {
    return {
      isolated: true,
      source: 'content',
      reason: '这是整合包导入的实例，包内的 Mod 与配置必须独占，因此启用隔离',
    };
  }

  /* ---- ② 用户显式指定，优先级最高 ---- */
  if (input.mode === 'on') {
    return {
      isolated: true,
      source: 'user',
      reason: '你已强制启用隔离，该实例的 mods / saves / config 独立存放',
    };
  }
  if (input.mode === 'off') {
    return {
      isolated: false,
      source: 'user',
      reason: '你已强制关闭隔离，将与其他实例共用 mods / saves / config',
      warning:
        '多个版本的 Mod 会互相污染 —— 1.20.1 的 Mod 放进 1.21.1 的实例会直接导致游戏无法启动。仅建议纯原版实例这样做。',
    };
  }
  /* ---- ③ 自动：按目录内容判定 ---- */
  if (input.hasContent) {
    return {
      isolated: true,
      source: 'content',
      reason: '已检测到该实例目录下的 mods/ 与 saves/，自动启用隔离以避免多版本互相污染',
    };
  }

  /* ---- ④ 内容为空：跟随全局默认 ---- */
  const isolated = input.globalDefault === 'isolated';
  return {
    isolated,
    source: 'global',
    reason: isolated
      ? '实例目录还是空的，按全局默认启用隔离'
      : '实例目录还是空的，按全局默认与其他实例共用目录',
  };
}

/**
 * ★★ 2026-09-27（清理）：这里原来还有 `IsolationMigrationPlan` 与
 *   `describeMigration()` —— 一整套"关闭隔离后这些内容会被其他实例看到、
 *   要不要先自动备份再搬"的迁移方案（PCL2 的原文只说要手动迁移，那份设计
 *   想给用户一条自动路径）。
 *
 *   ★ 它**全仓库一个调用方都没有**（判据：`grep -rn describeMigration src` 只有它自己），
 *     而它里面写着 `canAutoBackup: true` 这种"承诺"—— 没有任何调用方会兑现。
 *     "共享模式"本身也没接上（见 `InstanceSetup.tsx` 那段说明）。
 *   ⇒ 删掉：一份没人会执行的迁移方案，比没有方案更容易让人误以为功能已存在。
 *     真要做共享模式时，连同调用方与判据一起写。
 */
