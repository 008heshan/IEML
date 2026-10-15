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
import type { FolderVersion, RunningGameInfo, IsolationInfo } from './tauri.ts';
export type { RunningGameInfo, IsolationInfo };

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

/*
 * ★ 2026-09-24（死代码清理）：`CrashReport` 类型与 `Backend.analyzeCrash` 一起删掉了。
 *   理由：`analyzeCrash` 全仓库 **0 处调用**（崩溃弹窗走的是 `domain/crash.ts`
 *   的 `analyzeCrashLog`，同步、无需 IPC），而它拖着一条只会说谎的链路：
 *   Tauri 版去调 Rust 的 `analyze_crash`（那份规则表与 TS 那份漂移过，见 C-8）。
 *   规则现在只有 TS 一份（Rust 侧的 `judge_crash` 只用它自己那份做"崩没崩"的判断，
 *   由 tests/crash-rules.cases.json 钉着两边一致）。
 */

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
    /**
     * 当前游戏根目录里装了几个版本（`<root>/.minecraft/versions` 下的目录数）。
     *
     * ★★ 2026-09-25：给「版本列表」页用 —— 那一页列的是账本里的实例（与根目录无关），
     *   换到空目录之后要靠这个数把"你选的这个目录里什么都还没有"说出来。
     */
    versionCount: number;
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
   * ★★ 2026-09-25（用户：「你看PCL，就是像换了个文件夹去读游戏版本，可以无缝切换」）：
   *   **当前游戏文件夹里有哪几个版本**（真读盘扫 `versions/*`，不看账本、不看网络清单）。
   *
   *   它是「版本列表」与「启动页」的数据源：换文件夹 = 换一份游戏数据。
   *   放在这一层（而不是 `launcher.*`）是因为**全局只用这一份**：
   *   版本列表的行、启动页能启动的版本、侧栏角标、筛选里的"全部 N"都从它派生。
   */
  folderVersions(): Promise<FolderVersion[]>;
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
      /** 已下 / 总共多少字节（2026-10-07 加：单个大文件时唯一在动的量） */
      finishedBytes: number;
      totalBytes: number;
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

  /**
   * ★★ **每个实例的隔离判定**（ADR-005）。
   *
   * 判定的规则只写在 Rust 侧（`domain::isolation`，ADR-006）——这里只是把它搬回来。
   * 浏览器演示模式返回**空表**：演示版没有 Rust 后端，也就没有判定，
   * 界面据此显示"演示模式里没有判定"，而不是自己编一个结论。
   */
  listIsolation(): Promise<IsolationInfo[]>;

  /* --- 目录 --- */
  openFolder(path: string): Promise<void>;
  /**
   * 读某个实例的 mods 目录（**只读盘，不联网** —— 见 `ModsPanel` 的说明）。
   *
   * ★★ **必须传 `config.slug`（磁盘目录名），不是 `id`**（2026-09-30 真机 bug）。
   *
   *   `id`（`inst-mulcf1gv`）只在启动器内部用；磁盘上的目录名是 `slug`
   *   （`26.3-fabric-0.19.5`）。传错的话后端会去读
   *   `.minecraft/versions/inst-mulcf1gv/mods` ⇒ 不存在 ⇒ **列表 0 个**，
   *   而症状与"这个实例真的没有 Mod"**长得一模一样**。
   *
   *   ★ 参数名从 `instanceId` 改成 `slug` 就是为了让类型本身说清这件事 ——
   *     两个都是 `string`，编译器抓不到，只能靠名字 + 注释拦住下一个人。
   */
  listMods(
    slug: string,
  ): Promise<Array<{ fileName: string; path: string; bytes: number; mtimeMs: number }>>;
  /**
   * Mod 图标，`路径 → data:` URI`（**只含真的解出图标的那些**）。
   *
   * ★ 从 jar 里解（本地、按 mtime 缓存），不联网。
   *   没有图标的 Mod 用文件名首字母做占位块。
   * ★ 与 `listMods` 同理：**传 `config.slug`，不是 `id`**。
   */
  modIcons(slug: string): Promise<Record<string, string>>;
  /**
   * 整合包作者的图标，`版本 id → data:` URI`（**只含真的有图标的那些**）。
   *
   * ★ 装包时从包体里抽出来留下的（作者放在包根目录的那张图），不联网。
   *   作者没放图标的包不在结果里 —— 界面退回自绘的版本图标。
   */
  packIcons(): Promise<Record<string, string>>;
  /**
   * **按版本目录名删除**（不依赖账本记录）。默认进回收站。
   *
   * ★ 与 `deleteInstanceFiles` 的分工：那条连记录一起删；这条只处理目录，
   *   给"盘上有、账本里没有记录"的那些行用。
   */
  deleteVersionDir(slug: string, permanent?: boolean): Promise<number>;

  /**
   * ★★ **MC 新闻（游戏版本动态）**：把用户网站烘好的那份同步进数据目录，再读回来。
   *
   * 用户 2026-10-15：「网站更新了版本大图功能，启动器同步一下」
   *            + 「其实这些东西应该保存在启动器的数据文件夹里的」。
   *
   * 数据落在 `<数据目录>/news/`（`index.json` / `versions/*.json` / `img/*`），
   * 与游戏文件同级、用户自己看得见也删得掉。
   *
   * ★ **这一层不改数据的形状**：返回的是站点那几份 JSON 的**原文**，
   *   解析与校验只有一份实现（`src/domain/mc-news.ts`，有单测钉着）。
   *   图则转成 `data:` URI（与 Mod 图标同一套做法）——数据目录里当然也有那份图。
   *
   * ★★ **必须是两个扁平方法，不许收成一个 `news: { … }` 子对象**
   *   （2026-10-15 真机踩过）：`getBackend()` 在 Tauri 下是个懒加载 `Proxy`，
   *   它的 `get` **一律返回一个函数** —— 于是 `api.news` 拿到的是个函数、
   *   `api.news.load` 是 `undefined`，界面上显示「news.load is not a function」，
   *   而**类型检查完全看不出来**（`Backend` 说 `news` 是个对象，运行时不是）。
   *   ⇒ 这条规矩由 `tools/gates/check-backend-flat.mjs` 守着。
   */
  /** 读数据目录里那份（**不联网**）；没同步过时 `null` */
  newsLoad(): Promise<NewsCachePayload | null>;
  /** 从网站同步一次（失败时一个字节都不写），返回刚同步好的那份 */
  newsSync(): Promise<NewsCachePayload>;
}

/**
 * 同步下来的 MC 新闻缓存（Rust `news::NewsCache`，线格式 camelCase）。
 *
 * ★ `manifest` / `docs` 里装的是**站点 JSON 的原文**，不是解析好的对象 ——
 *   解析在 `domain/mc-news.ts` 里做（那里能在 `node --test` 下被喂坏样本）。
 */
export interface NewsCachePayload {
  /** 数据目录里那个 news 文件夹（界面显示它 + 一个「打开」按钮） */
  dir: string;
  /** 上一次同步的时刻（毫秒；0 = 没有记录） */
  syncedAtMs: number;
  /** 站点那份清单里的烘焙日期（`2026-10-15`）—— 界面据此说"数据旧了" */
  baked: string;
  /** `index.json` 原文 */
  manifest: string;
  /** 版本号 → 正文原文（键是**清单里的版本号**） */
  docs: Record<string, string>;
  /** 版本号 → 大图的 `data:` URI（只含真的同步到的那几个） */
  images: Record<string, string>;
}
