/**
 * 安装流程（跨页面复用的编排）
 * ------------------------------------------------------------------
 * ★ 为什么要有这一层：
 *   "点下载 → 建任务 → 调后端 → 更新进度 → 标记已安装" 这段编排
 *   在版本页签、加载器页签、整合包面板里都要用。
 *   写在组件里会抄三遍，抄完必然漂移（改一处忘一处）。
 *
 *   规则与 I/O 都不在这里 —— 规则在 `domain`，I/O 在 `bridge`。
 *   这里只负责"把两件事按顺序串起来并上报进度"。
 *
 * ★ 任务控制（取消 / 暂停 / 恢复 / 移除）也在这里：
 *
 *   ## 暂停**不再等于取消**（这一节以前写的是反的）
 *
 *   老注释写的是"后端只有「取消」一种原语，暂停 = 取消 + 记一个标记" ——
 *   在 `net::download::PauseToken` 落地之后这句话就**不成立了**，
 *   留着它会让下一个人照着错的模型改代码。现在是：
 *     · **暂停** = `backend.pauseTask(id)` 真的把后端的暂停令牌按下去，
 *       下载引擎在**下一个任务开始之前**停下（在跑的那几个收尾），
 *       `.part` 分片全部保留；
 *     · **继续** = `backend.resumeTask(id)` 抬起令牌 + 用记住的参数重新发起
 *       （已下好的文件走"校验通过 → 跳过"，没下完的接着下）；
 *     · **取消** = `backend.cancelTask(id)`，引擎返回 `Cancelled`。
 *   三张表（`cancelledTasks` / `pausedTasks` / `pendingJobs`）仍然有用，
 *   但它们记录的是**界面状态**，不是"假装出来的暂停"。
 */
import { getRealApi } from '../bridge';

export interface InstallProgress {
  stage: string;
  percent: number;
  finishedFiles: number;
  totalFiles: number;
  bytesPerSecond: number;
  currentFile: string;
}

/** 全局任务中心的事件名（AppContext 会监听并写进 store） */
const TASK_ADD = 'ieml:task-add';
const TASK_PATCH = 'ieml:task-patch';
const TASK_REMOVE = 'ieml:task-remove';
const TOAST = 'ieml:toast';

/**
 * ★★ 安装的**三种结局**（不是 boolean）。
 *
 * 为什么必须分开（P0-3）：暂停不是失败。老签名只有一个 boolean，
 * 于是调用方只能写 `if (!ok) toast('err', '安装没完成')` ——
 * 用户按了暂停，收到一句红色报错；而任务中心那边正好好地写着「已暂停」。
 * 同一个动作，两句话互相打架。
 */
export type InstallOutcome =
  /** 真的装完了 */
  | 'done'
  /** 用户按了暂停（后端确认过），可以继续 */
  | 'paused'
  /** 失败 / 被取消 */
  | 'failed';

/* ====================== 任务控制表 ====================== */

/** 用户主动取消的任务 */
const cancelledTasks = new Set<string>();
/** 用户主动暂停的任务 */
const pausedTasks = new Set<string>();

type InstallJob =
  | {
      kind: 'vanilla';
      mcVersion: string;
      source: 'auto' | 'bmclapi' | 'mojang';
      concurrency: number;
    }
  | {
      kind: 'loader';
      mcVersion: string;
      loaderKind: string;
      loaderVersion: string | null;
      source: 'auto' | 'bmclapi' | 'mojang';
      concurrency: number;
    }
  | {
      /** ★ 版本 + 加载器一次装好（单页组合安装走这条） */
      kind: 'game';
      mcVersion: string;
      loaderKind: string | null;
      loaderVersion: string | null;
      source: 'auto' | 'bmclapi' | 'mojang';
      concurrency: number;
      /** 用于失败重试时还原标题 */
      title: string;
    };

/** 记住每个任务的安装参数，恢复（续传）时重放 */
const pendingJobs = new Map<string, InstallJob>();

function addTask(task: {
  id: string;
  title: string;
  detail: string;
  phase: string;
  totalFiles: number;
}) {
  window.dispatchEvent(
    new CustomEvent(TASK_ADD, {
      detail: {
        ...task,
        percent: 0,
        finishedFiles: 0,
        bytesPerSecond: 0,
        currentFile: '',
        etaSeconds: 0,
        status: 'running' as const,
      },
    }),
  );
}

function patchTask(id: string, patch: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(TASK_PATCH, { detail: { id, patch } }));
}

/**
 * 把后端进度事件翻译成一句人能读的阶段文字。
 *
 * ★ 为什么要写"已切到 xxx 源"和"重试第 N 轮"：
 *   下载慢或者卡住时，用户最想知道的是"它在干嘛"。
 *   后端会根据源健康度自动换源、会在 429 之后降并发重试 ——
 *   这些动作如果不说出来，用户只会看到进度条突然变慢然后以为死机了。
 */
function describeProgress(p: {
  stage: string;
  source?: string;
  retryRound?: number;
}): string {
  const srcName = (s?: string) =>
    s === 'mojang' ? 'Mojang 官方源' : s === 'bmclapi' ? 'BMCLAPI 镜像' : '';
  const notes: string[] = [p.stage];
  if (p.retryRound && p.retryRound > 0) {
    notes.push(`失败重试第 ${p.retryRound} 轮 · 已降低并发`);
  }
  const s = srcName(p.source);
  if (s) notes.push(`源：${s}`);
  return notes.join(' · ');
}

/** 弹一个全局 toast（AppContext 监听 ieml:toast） */
function toast(kind: 'ok' | 'err' | 'info' | 'warning', title: string, desc?: string) {
  window.dispatchEvent(new CustomEvent(TOAST, { detail: { kind, title, desc } }));
}

/** 标记任务为「用户主动取消」，安装流程的 catch 据此不再把状态改成失败 */
export function markCancelled(id: string): void {
  cancelledTasks.add(id);
  pausedTasks.delete(id);
}

/** 标记任务为「用户主动暂停」，安装流程的 catch 据此把状态改成暂停 */
export function markPaused(id: string): void {
  pausedTasks.add(id);
  cancelledTasks.delete(id);
}

/**
 * ★★ **后端说"我停下了"** —— 按它的说法把任务标成「已暂停」。
 *
 * 为什么要有这个函数（P0-3）：暂停是**两次**通信 ——
 *   ① 界面按 `backend.pauseTask(id)`，令牌被按下；
 *   ② 后端在下一个任务边界停下，`install_version` 返回 `paused: true`。
 * 中间这段时间引擎还在把在跑的几个文件收尾，**任务仍然是"运行中"**。
 * 只有当 ② 真的回来了，界面才该写「已暂停」—— 否则又是一句提前说的假话。
 */
export function markPausedConfirmed(
  id: string,
  remainingFiles: number,
  stage: string | null,
): void {
  pausedTasks.add(id);
  cancelledTasks.delete(id);
  /*
   * 文案要能回答"停在哪了"：
   *   · 还剩文件 → "已暂停 · 还剩 N 个文件"
   *   · 文件下完了但某一步没做（例如加载器安装器还没跑）→ 点名那一步，
   *     **不能**写成"已暂停"就完事 —— 那会让人以为已经装好了。
   */
  const where = stage ? `${stage} 还没做完` : '';
  const what = remainingFiles > 0 ? `还剩 ${remainingFiles} 个文件` : '';
  const detail = [what, where].filter(Boolean).join(' · ');
  patchTask(id, { status: 'paused', phase: detail ? `已暂停 · ${detail}` : '已暂停' });
}

/** 从任务中心移除一条任务（完成后 / 取消后 / 失败后都可以清掉） */
export function removeTask(id: string): void {
  cancelledTasks.delete(id);
  pausedTasks.delete(id);
  pendingJobs.delete(id);
  window.dispatchEvent(new CustomEvent(TASK_REMOVE, { detail: id }));
}

/** 恢复一个暂停的任务：用记住的参数重新发起安装（.part 自动断点续传） */
export function resumeInstall(id: string): boolean {
  const job = pendingJobs.get(id);
  if (!job) return false;
  pausedTasks.delete(id);
  if (job.kind === 'vanilla') {
    void installVersionFromManifest(job.mcVersion, job.source, job.concurrency, id);
  } else if (job.kind === 'game') {
    void installGame({
      mcVersion: job.mcVersion,
      loaderKind: job.loaderKind,
      loaderVersion: job.loaderVersion,
      source: job.source,
      concurrency: job.concurrency,
      reuseTaskId: id,
    });
  } else {
    void installLoader(
      job.mcVersion,
      job.loaderKind,
      job.loaderVersion,
      job.source,
      job.concurrency,
      id,
    );
  }
  return true;
}

/**
 * ★ 重试一个**失败**的任务。
 *
 * 审计发现：任务中心的「重试」按钮以前只改了本地状态
 * （`patchTask({status:'running'})` + 一句"正在重试"），
 * 后端什么都没发生 —— 任务会永远停在 running、进度不动。
 * 现在它真的重新发起：有记住的参数就重跑，没有就明说重试不了。
 *
 * 返回"是否真的发起了重试"，调用方据此决定提示文案。
 */
export function retryInstall(id: string): boolean {
  const job = pendingJobs.get(id);
  if (!job) return false;
  // 重试 = 清掉暂停/取消标记 + 重新发起（.part 会断点续传）
  pausedTasks.delete(id);
  cancelledTasks.delete(id);
  return resumeInstall(id);
}

/**
 * ★ 注册一个"外部编排"的任务（整合包安装走这条）。
 *
 * 整合包安装由 `DownloadPage` 直接调 `modpack.install`，它不在 `pendingJobs` 里，
 * 于是任务中心的「继续」「重试」对它静默失效（审计发现）。
 * 把重放函数交给这里，两个按钮就能对整合包也生效。
 */
export function registerTaskReplay(id: string, replay: () => void): void {
  pendingJobs.set(id, { kind: 'replay', replay } as unknown as InstallJob);
  // resumeInstall 不认识 'replay'，所以这里直接接管：见下面的 resumeOrReplay
}

/** 内部：带重放函数的任务 */
interface ReplayJob {
  kind: 'replay';
  replay: () => void;
}

/** 恢复/重试的统一入口（任务中心用这个，整合包与普通安装都支持） */
export function resumeOrReplay(id: string): boolean {
  const job = pendingJobs.get(id) as unknown as ReplayJob | InstallJob | undefined;
  if (!job) return false;
  if ((job as ReplayJob).kind === 'replay') {
    pausedTasks.delete(id);
    cancelledTasks.delete(id);
    (job as ReplayJob).replay();
    return true;
  }
  return retryInstall(id);
}

/** 清掉一个任务的内部记录（安装成功/用户移除时调） */
export function forgetTask(id: string): void {
  pendingJobs.delete(id);
  pausedTasks.delete(id);
  cancelledTasks.delete(id);
}

/* ====================== 安装入口 ====================== */

/**
 * 装一个原版游戏版本。
 *
 * 返回三种结局之一（`done` / `paused` / `failed`）——
 * **暂停不是失败**，调用方据此决定提示什么（ADR-051）。
 */
export async function installVersionFromManifest(
  mcVersion: string,
  source: 'auto' | 'bmclapi' | 'mojang' = 'auto',
  concurrency = 64,
  reuseTaskId?: string,
): Promise<InstallOutcome> {
  const api = await getRealApi();
  if (!api) return 'failed';

  const taskId = reuseTaskId ?? `ver-${mcVersion}-${Date.now()}`;
  cancelledTasks.delete(taskId);
  pausedTasks.delete(taskId);
  pendingJobs.set(taskId, { kind: 'vanilla', mcVersion, source, concurrency });

  addTask({
    id: taskId,
    title: `Minecraft ${mcVersion}`,
    detail: `从 ${source === 'bmclapi' ? 'BMCLAPI 镜像' : 'Mojang 官方源'} 下载`,
    phase: '准备中',
    totalFiles: 0,
  });
  toast('info', '已开始下载', `Minecraft ${mcVersion}，进度看顶栏任务中心`);

  try {
    // 先算计划，把"要下多少"告诉用户（ADR-002：下载前可预览）
    const plan = await api.installer.plan({ mcVersion, source });
    patchTask(taskId, {
      detail: `${plan.libraries} 个库 · ${plan.total_files} 个文件`,
      totalFiles: plan.total_files,
    });

    const result = await api.installer.install(
      { mcVersion, source, taskId, downloadAssets: true, concurrency },
      (p) => {
        patchTask(taskId, {
          percent: p.percent,
          finishedFiles: p.finishedFiles,
          totalFiles: p.totalFiles,
          bytesPerSecond: p.bytesPerSecond,
          currentFile: p.currentFile,
          phase: describeProgress(p),
          status: 'running',
        });
      },
    );

    /*
     * ★★ **后端说暂停了，就不许写"完成"**（P0-3）。
     *
     *   保留 `pendingJobs` 里的参数，「继续」按钮才能用同一套参数重跑；
     *   返回 `'paused'` 是因为**这次没有装完** —— 调用方据此提示
     *   （而不是把它当成失败弹红色报错）。
     */
    if (result.paused) {
      markPausedConfirmed(taskId, result.remaining_files, result.paused_stage);
      toast('info', '已暂停', `${mcVersion} 还剩 ${result.remaining_files} 个文件，点「继续」接着下`);
      return 'paused';
    }

    patchTask(taskId, {
      status: 'done',
      percent: 100,
      detail: `${result.libraries} 个库 · ${result.assets} 个资源文件`,
    });
    pendingJobs.delete(taskId);
    return 'done';
  } catch (e) {
    // ★ 取消 / 暂停是用户主动操作，不能覆盖成「失败」
    if (cancelledTasks.has(taskId)) {
      patchTask(taskId, { status: 'cancelled', phase: '已取消' });
      pendingJobs.delete(taskId);
      return 'failed';
    }
    if (pausedTasks.has(taskId)) {
      patchTask(taskId, { status: 'paused', phase: '已暂停' });
      return 'paused';
    }
    patchTask(taskId, {
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    });
    return 'failed';
  }
}

/**
 * ★ 单页组合安装：**一个任务装好「游戏版本 + 加载器」**。
 *
 * 为什么不是"先装原版、再装加载器"两个任务：
 *   ① 两次任务会在任务中心留两条记录，用户要盯着两条进度条；
 *   ② 后端 `install_version` 本来就把 Forge/NeoForge 安装器接在同一次调用里
 *      （装完原版直接跑 installer），分成两次反而绕开了这条路径；
 *   ③ 原版与加载器共享大量 libraries，分开装会让"去重复用"跨不了任务边界。
 */
export async function installGame(opts: {
  mcVersion: string;
  loaderKind: string | null;
  loaderVersion: string | null;
  source?: 'auto' | 'bmclapi' | 'mojang';
  concurrency?: number;
  /** 触发时给用户看的加载器名（用于标题） */
  loaderName?: string;
  reuseTaskId?: string;
}): Promise<InstallOutcome> {
  const {
    mcVersion,
    loaderKind,
    loaderVersion,
    source = 'bmclapi',
    concurrency = 64,
    loaderName,
    reuseTaskId,
  } = opts;

  const api = await getRealApi();
  if (!api) return 'failed';

  const taskId = reuseTaskId ?? `game-${mcVersion}-${loaderKind ?? 'vanilla'}-${Date.now()}`;
  const title = loaderKind
    ? `Minecraft ${mcVersion} + ${loaderName ?? loaderKind} 加载器`
    : `Minecraft ${mcVersion}`;

  cancelledTasks.delete(taskId);
  pausedTasks.delete(taskId);
  pendingJobs.set(taskId, {
    kind: 'game',
    mcVersion,
    loaderKind,
    loaderVersion,
    source,
    concurrency,
    title,
  });

  addTask({
    id: taskId,
    title,
    detail: `从 ${source === 'bmclapi' ? 'BMCLAPI 镜像' : 'Mojang 官方源'} 下载`,
    phase: '准备中',
    totalFiles: 0,
  });
  toast('info', '已开始下载', `${title}，进度看顶栏任务中心`);

  try {
    const plan = await api.installer.plan({
      mcVersion,
      loaderKind,
      loaderVersion,
      source,
    });
    patchTask(taskId, {
      detail: `${plan.libraries} 个库 · ${plan.total_files} 个文件`,
      totalFiles: plan.total_files,
    });

    const result = await api.installer.install(
      {
        mcVersion,
        loaderKind,
        loaderVersion,
        source,
        taskId,
        downloadAssets: true,
        concurrency,
      },
      (p) => {
        patchTask(taskId, {
          percent: p.percent,
          finishedFiles: p.finishedFiles,
          totalFiles: p.totalFiles,
          bytesPerSecond: p.bytesPerSecond,
          currentFile: p.currentFile,
          phase: describeProgress(p),
          status: 'running',
        });
      },
    );

    // ★ 暂停 → 如实标记（见 `installVersionFromManifest` 同一处说明）
    if (result.paused) {
      markPausedConfirmed(taskId, result.remaining_files, result.paused_stage);
      toast('info', '已暂停', `${title} 还剩 ${result.remaining_files} 个文件，点「继续」接着下`);
      return 'paused';
    }

    patchTask(taskId, {
      status: 'done',
      percent: 100,
      detail: `${result.libraries} 个库 · ${result.assets} 个资源文件`,
    });
    pendingJobs.delete(taskId);
    return 'done';
  } catch (e) {
    if (cancelledTasks.has(taskId)) {
      patchTask(taskId, { status: 'cancelled', phase: '已取消' });
      pendingJobs.delete(taskId);
      return 'failed';
    }
    if (pausedTasks.has(taskId)) {
      patchTask(taskId, { status: 'paused', phase: '已暂停' });
      return 'paused';
    }
    patchTask(taskId, {
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    });
    return 'failed';
  }
}

/**
 * 装一个加载器（Fabric / Quilt 走 profile JSON 合并；Forge 系需要跑安装器）。
 */
export async function installLoader(
  mcVersion: string,
  loaderKind: string,
  loaderVersion: string | null,
  source: 'auto' | 'bmclapi' | 'mojang' = 'auto',
  concurrency = 64,
  reuseTaskId?: string,
): Promise<InstallOutcome> {
  const api = await getRealApi();
  if (!api) return 'failed';

  const taskId = reuseTaskId ?? `loader-${loaderKind}-${mcVersion}-${Date.now()}`;
  cancelledTasks.delete(taskId);
  pausedTasks.delete(taskId);
  pendingJobs.set(taskId, {
    kind: 'loader',
    mcVersion,
    loaderKind,
    loaderVersion,
    source,
    concurrency,
  });

  addTask({
    id: taskId,
    title: `${loaderKind} ${loaderVersion ?? ''} for ${mcVersion}`.trim(),
    detail: '叠加在原版之上，会复用已下载的库',
    phase: '准备中',
    totalFiles: 0,
  });
  toast('info', '已开始安装', `${loaderKind} ${loaderVersion ?? ''}，进度看顶栏任务中心`);

  try {
    const result = await api.installer.install(
      {
        mcVersion,
        loaderKind,
        loaderVersion,
        source,
        taskId,
        downloadAssets: false, // 原版资源已经下过了
        concurrency,
      },
      (p) => {
        patchTask(taskId, {
          percent: p.percent,
          finishedFiles: p.finishedFiles,
          totalFiles: p.totalFiles,
          bytesPerSecond: p.bytesPerSecond,
          currentFile: p.currentFile,
          phase: describeProgress(p),
          status: 'running',
        });
      },
    );
    // ★ 暂停 → 如实标记（见 `installVersionFromManifest` 同一处说明）
    if (result.paused) {
      markPausedConfirmed(taskId, result.remaining_files, result.paused_stage);
      toast(
        'info',
        '已暂停',
        `${loaderKind} ${loaderVersion ?? ''} 还剩 ${result.remaining_files} 个文件，点「继续」接着下`,
      );
      return 'paused';
    }
    patchTask(taskId, {
      status: 'done',
      percent: 100,
      detail: `${result.libraries} 个库`,
    });
    pendingJobs.delete(taskId);
    return 'done';
  } catch (e) {
    if (cancelledTasks.has(taskId)) {
      patchTask(taskId, { status: 'cancelled', phase: '已取消' });
      pendingJobs.delete(taskId);
      return 'failed';
    }
    if (pausedTasks.has(taskId)) {
      patchTask(taskId, { status: 'paused', phase: '已暂停' });
      return 'paused';
    }
    patchTask(taskId, {
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    });
    return 'failed';
  }
}

/**
 * 把日志交给崩溃分析并弹出结果。
 * （弹窗由 CrashModal 监听 `ieml:crash` 事件渲染）
 */
export function showCrashAnalysis(logText: string): void {
  window.dispatchEvent(new CustomEvent('ieml:crash', { detail: { raw: logText } }));
}
