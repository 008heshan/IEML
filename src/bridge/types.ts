/**
 * 平台后端抽象层
 * ------------------------------------------------------------------
 * ★ 这是"网页版 → Tauri 桌面版"的唯一接缝。
 *   现在跑在浏览器里（localStorage + 模拟下载），接上 Tauri 之后
 *   只要换一个实现（invoke 到 Rust 命令），UI 一行都不用改。
 *
 *   之所以这么设计：本机缺 MSVC 生成工具，Rust 链接不了 exe，
 *   先用浏览器把功能跑通，工具链到位后无缝切换。
 */
import type { Instance, JavaRuntime } from '../domain';
import type { RunningGameInfo } from './tauri.ts';
export type { RunningGameInfo };

export interface BackendInfo {
  kind: 'web' | 'tauri';
  /** 数据落盘位置（Tauri 下是真实路径） */
  dataDir: string;
  /**
   * 后端版本号（`app_info` 的 `version`，Rust 侧是编译期的
   * `env!("CARGO_PKG_VERSION")`）。
   *
   * ★ 为什么要把它接出来：`src/domain/version-info.ts` 里的 `APP_VERSION`
   *   一直由 `tools/set-version.mjs` 同步维护、`pnpm verify` 也把它算进
   *   "四处一致"，但**前端从来没有 import 过它** —— 也就是说版本号
   *   维护得很认真，界面上却一个地方都不显示。
   *   规则（docs/VERSIONING.md）说这是给"关于"页用的，那就得真显示出来。
   *   桌面版以后端为准；浏览器演示模式用前端常量。
   */
  version: string;
}

export interface InstallRequest {
  /** 要装的一组东西 */
  plan: unknown;
}

export interface LaunchResult {
  pid: number | null;
  /** 给用户看的启动摘要 */
  command: string;
}

export interface CrashReport {
  /** 面向用户的原因（不是堆栈） */
  reason: string;
  /** 建议动作 */
  actions: Array<{ label: string; kind: string }>;
  /** 原始日志（默认折叠） */
  raw: string;
  /** 匹配到的日志特征 */
  matches: Array<{ pattern: string; conclusion: string }>;
}

/**
 * 后端接口。所有方法在网页版与 Tauri 版都必须实现。
 */
export interface Backend {
  info(): Promise<BackendInfo>;

  /* --- 机器与运行时 --- */
  machineInfo(): Promise<{
    totalMemoryGb: number;
    availableMemoryGb: number;
    cpuCount: number;
    os: string;
    arch: string;
    dataDir: string;
  }>;
  scanJava(): Promise<JavaRuntime[]>;
  /** 从网络获取 Java（Adoptium） */
  downloadJava(major: number, onProgress: (pct: number, bytes: number, total: number) => void): Promise<JavaRuntime>;
  /**
   * ★ 删除 IEML 自己下载的 Java。
   *
   * 默认进**系统回收站**（可捞回）；`permanent = true` 才是真删
   * （界面上按住 Shift 点删除的语义）。
   */
  removeJava(path: string, permanent?: boolean): Promise<void>;

  /* --- 实例 --- */
  loadInstances(): Promise<{ instances: Instance[]; activeId: string | null }>;
  saveInstances(instances: Instance[], activeId: string | null): Promise<void>;
  /**
   * ★ 删除一个实例的**磁盘目录**（存档 / Mod / 配置 / natives）。
   *
   * 审计发现：以前只从内存列表里删记录，而确认框写着"存档与配置会一起删除" ——
   * 磁盘上什么都没删。返回删掉的字节数，好让前端如实报告。
   *
   * 默认进**系统回收站**（存档能捞回来）；`permanent = true` 才是真删。
   */
  deleteInstanceFiles(slug: string, permanent?: boolean): Promise<number>;
  /** ★ 复制实例的磁盘目录，返回复制的字节数 */
  copyInstanceFiles(
    fromSlug: string,
    toSlug: string,
    copyGameDir: boolean,
  ): Promise<number>;

  /* --- 全局偏好 --- */
  /**
   * ★ 读全局偏好（主题 / 下载源 / 并发 / 窗口尺寸 / 离线名 / 账号 uuid）。
   *
   * 审计发现：偏好只存在内存里，**重启全丢** —— 连正版登录的 accountUuid
   * 都没了，用户第二天启动变成离线 "Player"。
   */
  loadPrefs(): Promise<Record<string, unknown>>;
  savePrefs(prefs: Record<string, unknown>): Promise<void>;

  /* --- 安装 --- */
  /** 真正执行安装，通过回调上报进度（前端会节流聚合） */
  install(
    planId: string,
    planRaw: unknown,
    onProgress: (p: {
      percent: number;
      finishedFiles: number;
      totalFiles: number;
      bytesPerSecond: number;
      currentFile: string;
      etaSeconds: number;
      phase: string;
    }) => void,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  pauseTask(taskId: string): Promise<void>;
  resumeTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;

  /* --- 启动 --- */
  launch(instanceId: string): Promise<LaunchResult>;
  /** ★ 停**这一个**实例（多开时同时可能有好几个在跑，不许含糊） */
  stopGame(instanceId: string): Promise<void>;
  /**
   * ★ 现在有哪些实例在跑。
   *
   * 存在的理由是"界面可能被重新加载"：那一刻本地状态是空的、而后端的
   * 子进程还活着。不问后端，界面就会说"没有游戏在运行"，用户再点一次启动，
   * 同一个存档被两个进程写。
   */
  runningGames(): Promise<RunningGameInfo[]>;

  /* --- 目录 --- */
  openFolder(path: string): Promise<void>;
  /** 读某个实例的 mods 目录 */
  listMods(
    instanceId: string,
  ): Promise<Array<{ fileName: string; path: string; bytes: number; mtimeMs: number }>>;

  /* --- 崩溃分析 --- */
  analyzeCrash(instanceId: string): Promise<CrashReport | null>;
}
