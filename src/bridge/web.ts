/**
 * 网页版后端实现
 * ------------------------------------------------------------------
 * 本机缺 MSVC 生成工具 → Rust 链接不了 exe → Tauri 暂不可用。
 * 所以先用这个实现把**全部功能跑通**：真实的规则引擎 + 真实的状态机 +
 * 持久化到 localStorage + 模拟但结构真实的下载引擎（可暂停/取消/重试/续传）。
 *
 * 接上 Tauri 后，只需要新增 tauri.ts 实现同一个 Backend 接口，
 * UI 与领域层一行都不用改。
 */
import type { Instance, JavaRuntime, LoaderSelection } from '../domain';
import { buildInstallPlan, validateCombination } from '../domain';
import type { Backend, BackendInfo, LaunchResult } from './types.ts';
/* ★ 2026-09-24：`analyzeCrashLog`/`redactReport` 的 import 随 `analyzeCrash` 一起删 */
import { APP_VERSION } from '../domain/version-info.ts';

const LS_KEY = 'ieml.state.v1';

/* ====================== 持久化 ====================== */

interface Persisted {
  instances: Instance[];
  activeId: string | null;
  prefs?: Record<string, unknown>;
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { instances: [], activeId: null };
    const parsed = JSON.parse(raw) as Persisted;
    return {
      instances: Array.isArray(parsed.instances) ? parsed.instances : [],
      activeId: parsed.activeId ?? null,
      prefs: parsed.prefs,
    };
  } catch {
    return { instances: [], activeId: null };
  }
}

function savePersisted(p: Persisted): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* 配额满了也不该崩 */
  }
}

/* ====================== 演示实例 ====================== */

function demoInstances(): Instance[] {
  const now = new Date();
  const iso = (dayOffset: number) =>
    new Date(now.getTime() - dayOffset * 86400000).toISOString();

  return [
    {
      id: 'inst-star',
      mcVersion: '1.20.4',
      loader: { kind: 'fabric', version: '0.15.7', mcVersion: '1.20.4' },
      addons: [{ kind: 'optifine', version: 'HD U I6', bridge: { kind: 'optifabric', version: '0.15.1' } }],
      config: {
        name: '星河整合包',
        slug: 'star-pack',
        isolation: 'on',
        memoryMb: 6144,
        memorySource: 'auto',
        javaMode: 'auto',
      },
      createdAt: iso(40),
      lastPlayedAt: iso(0),
      totalPlaySeconds: 47 * 60 + 128 * 3600,
    },
    {
      id: 'inst-vanilla',
      mcVersion: '1.21.1',
      loader: null,
      addons: [],
      config: {
        name: '原版生存',
        slug: 'vanilla-1211',
        isolation: 'auto',
        memoryMb: 4096,
        memorySource: 'global',
        javaMode: 'auto',
      },
      createdAt: iso(30),
      lastPlayedAt: iso(3),
      totalPlaySeconds: 92 * 3600,
    },
    {
      id: 'inst-tech',
      mcVersion: '1.21.1',
      loader: { kind: 'neoforge', version: '21.1.72', mcVersion: '1.21.1' },
      addons: [],
      config: {
        name: '工匠科技',
        slug: 'craft-tech',
        isolation: 'on',
        memoryMb: 12288,
        memorySource: 'custom',
        javaMode: 'auto',
      },
      createdAt: iso(21),
      lastPlayedAt: iso(7),
      totalPlaySeconds: 210 * 3600,
    },
    {
      id: 'inst-nostalgia',
      mcVersion: '1.7.10',
      loader: { kind: 'forge', version: '10.13.4.1614', mcVersion: '1.7.10' },
      addons: [{ kind: 'optifine', version: 'HD U E7' }],
      config: {
        name: '怀旧 1.7.10',
        slug: 'nostalgia-1710',
        isolation: 'auto',
        memoryMb: 3072,
        memorySource: 'auto',
        javaMode: 'range',
        javaRange: { min: 8, max: 9, minInclusive: true, maxInclusive: false },
      },
      createdAt: iso(60),
      lastPlayedAt: iso(14),
      totalPlaySeconds: 36 * 3600,
    },
  ];
}

/* ====================== 演示 Mod 目录 ====================== */

const DEMO_MODS: Array<{ fileName: string; bytes: number }> = [
  { fileName: 'sodium-fabric-0.5.11.jar', bytes: 1_258_291 },
  { fileName: 'lithium-fabric-0.12.1.jar', bytes: 862_208 },
  { fileName: 'fabric-api-0.92.2+1.20.4.jar', bytes: 2_202_010 },
  { fileName: 'iris-1.7.0.jar', bytes: 2_411_725 },
  { fileName: 'bettercombat-fabric-1.8.6.jar', bytes: 1_048_576 },
  { fileName: 'jei-1.20.4-fabric-17.3.0.49.jar', bytes: 1_677_722 },
  { fileName: 'modmenu-9.0.0.jar', bytes: 1_153_434 },
  { fileName: 'cloth-config-13.0.121.jar', bytes: 1_048_576 },
  { fileName: 'player-animator-0.4.2.jar', bytes: 524_288 },
  { fileName: 'appleskin-fabric-2.5.1.jar', bytes: 104_858 },
  { fileName: 'wi-zoom-2.0.jar', bytes: 62_914 },
  { fileName: 'xaeros-minimap-24.2.0.jar', bytes: 3_145_728 },
  { fileName: 'xaeros-world-map-1.38.0.jar', bytes: 4_194_304 },
  { fileName: 'ferritecore-6.0.1-fabric.jar', bytes: 209_715 },
  { fileName: 'krypton-0.2.3.jar', bytes: 157_286 },
  { fileName: 'no-telemetry-1.0.0.jar', bytes: 41_943 },
  { fileName: 'memoryleakfix-fabric-1.1.5.jar', bytes: 83_886 },
  { fileName: 'moreculling-1.0.4.jar', bytes: 314_573 },
  { fileName: 'entityculling-fabric-1.6.6.jar', bytes: 419_430 },
  { fileName: 'dashloader-5.1.0.jar', bytes: 734_003 },
  { fileName: 'cull-less-leaves-1.2.4.jar', bytes: 52_429 },
  { fileName: 'starlight-1.1.2.jar', bytes: 524_288 },
  { fileName: 'indium-1.0.30.jar', bytes: 262_144 },
  // 两个禁用态（验证扩展名判定）
  { fileName: 'optifine-old.jar.disabled', bytes: 6_291_456 },
  { fileName: 'sodium-extra-0.5.4.jar.disabled', bytes: 1_572_864 },
];

/* ====================== 实现 ====================== */

export function createWebBackend(): Backend {
  const persisted = loadPersisted();
  /*
   * ★ 首次启动返回**空列表**，不塞演示数据。
   *
   * 为什么：如果预置几个"看起来能玩"的实例，用户点「启动游戏」就会失败
   * （磁盘上根本没有那些版本），而失败原因还很难解释。空状态 + 明确的
   * 「去下载游戏」引导才是诚实的做法。
   *
   * 想看演示数据的话，用 `?demo=1` 打开。
   */
  const wantDemo =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('demo') === '1';
  const instances =
    persisted.instances.length > 0
      ? persisted.instances
      : wantDemo
        ? demoInstances()
        : [];
  let activeId = persisted.activeId ?? instances[0]?.id ?? null;

  // 任务控制表：支持暂停/取消/重试/续传
  const taskControl = new Map<string, { paused: boolean; cancelled: boolean }>();
  const installedVersions = new Set<string>(['1.20.4', '1.21.1', '1.7.10']);

  return {
    async info(): Promise<BackendInfo> {
      // 浏览器演示模式没有 Rust 后端，版本号用前端常量（与 Rust 侧由
      // `tools/set-version.mjs --check` 保证一致）
      return {
        kind: 'web',
        dataDir: '浏览器演示模式（数据存在本地）',
        version: APP_VERSION,
      };
    },

    async machineInfo() {
      // 浏览器拿不到真实内存，给一组稳定可信的演示值；
      // Tauri 版会读真实 sysinfo。
      const nav = navigator as Navigator & { deviceMemory?: number };
      const total = nav.deviceMemory ?? 16;
      return {
        totalMemoryGb: total,
        availableMemoryGb: Math.round(total * 0.42 * 10) / 10,
        cpuCount: navigator.hardwareConcurrency ?? 8,
        os: navigator.userAgent.includes('Windows')
          ? 'Windows'
          : navigator.userAgent.includes('Mac')
            ? 'macOS'
            : 'Linux',
        arch: 'x64',
        dataDir: '演示模式 · 未接真实文件系统',
      };
    },

    async scanJava(): Promise<JavaRuntime[]> {
      return [
        { path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-8.0.402\\bin\\javaw.exe', major: 8, version: '8.0.402', vendor: 'Zulu', arch: 'x64', source: 'system', bytes: 186 * 1024 * 1024 },
        { path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.10\\bin\\javaw.exe', major: 17, version: '17.0.10', vendor: 'Temurin', arch: 'x64', source: 'system', bytes: 194 * 1024 * 1024 },
        { path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.2\\bin\\javaw.exe', major: 21, version: '21.0.2', vendor: 'Temurin', arch: 'x64', source: 'downloaded', bytes: 192 * 1024 * 1024 },
      ];
    },

    async downloadJava(major, onProgress) {
      const total = 190 * 1024 * 1024;
      const steps = 30;
      for (let i = 1; i <= steps; i++) {
        await sleep(80);
        onProgress(Math.round((i / steps) * 100), Math.round((i / steps) * total), total);
      }
      return {
        path: `C:\\Users\\Administrator\\AppData\\Roaming\\IEML\\java\\${major}\\bin\\javaw.exe`,
        major,
        version: major === 21 ? '21.0.2' : major === 17 ? '17.0.10' : `${major}.0.1`,
        vendor: 'Temurin',
        arch: 'x64',
        source: 'downloaded',
        bytes: total,
      };
    },

    async removeJava(path, permanent) {
      await sleep(120);
      void path;
      void permanent;
    },

    async loadInstances() {
      return { instances, activeId };
    },

    async saveInstances(next, nextActive) {
      savePersisted({ instances: next, activeId: nextActive });
    },

    /** 浏览器演示：没有真实文件系统，删不了目录 */
    async deleteInstanceFiles(slug, permanent) {
      void slug;
      void permanent;
      await sleep(80);
      return 0;
    },

    /** 浏览器演示：没有真实文件系统，复制不了目录 */
    async copyInstanceFiles(fromSlug, toSlug, copyGameDir) {
      void fromSlug;
      void toSlug;
      void copyGameDir;
      await sleep(80);
      return 0;
    },

    /** 浏览器演示：偏好放 localStorage（桌面版走 Rust 的 prefs.json） */
    async loadPrefs() {
      try {
        const raw = localStorage.getItem('ieml.demo.prefs');
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    },

    async savePrefs(prefs) {
      try {
        localStorage.setItem('ieml.demo.prefs', JSON.stringify(prefs));
      } catch {
        /* 配额满了不影响演示 */
      }
    },

    async install(planId, planRaw, onProgress) {
      const ctl = { paused: false, cancelled: false };
      taskControl.set(planId, ctl);

      const plan = planRaw as { summary?: { fileCount?: number; downloadBytes?: number }; steps?: Array<{ phase: string; label: string }> };
      const totalFiles = plan.summary?.fileCount ?? 100;
      const totalBytes = plan.summary?.downloadBytes ?? 100 * 1024 * 1024;
      const steps = plan.steps ?? [{ phase: 'download-installer', label: '下载安装器' }];

      let done = 0;
      const speed = 12.4 * 1024 * 1024; // 12.4 MB/s，与设计稿里的数字一致

      for (const step of steps) {
        if (ctl.cancelled) return { ok: false, error: '已取消' };
        // 暂停时轮询等待，而不是丢弃进度 —— 这就是"可暂停"的实现
        while (ctl.paused && !ctl.cancelled) {
          await sleep(120);
        }
        if (ctl.cancelled) return { ok: false, error: '已取消' };

        const stepFiles = Math.max(1, Math.round(totalFiles / steps.length));
        for (let i = 0; i < stepFiles; i++) {
          while (ctl.paused && !ctl.cancelled) await sleep(120);
          if (ctl.cancelled) return { ok: false, error: '已取消' };

          await sleep(35);
          done++;
          const pct = Math.min(100, Math.round((done / totalFiles) * 100));
          const remainingBytes = Math.max(0, totalBytes * (1 - done / totalFiles));
          onProgress({
            percent: pct,
            finishedFiles: done,
            totalFiles,
            bytesPerSecond: speed,
            currentFile: `${step.phase}/${String(i).padStart(3, '0')}`,
            etaSeconds: Math.max(1, Math.round(remainingBytes / speed)),
            phase: step.label,
          });
        }
      }

      // 标记版本已安装
      void installedVersions;
      taskControl.delete(planId);
      return { ok: true };
    },

    async pauseTask(taskId) {
      const ctl = taskControl.get(taskId);
      if (ctl) ctl.paused = true;
    },

    async resumeTask(taskId) {
      const ctl = taskControl.get(taskId);
      if (ctl) ctl.paused = false;
    },

    async cancelTask(taskId) {
      const ctl = taskControl.get(taskId);
      if (ctl) ctl.cancelled = true;
      taskControl.delete(taskId);
    },

    async launch(instanceId): Promise<LaunchResult> {
      await sleep(600);
      const inst = instances.find((i) => i.id === instanceId);
      const mc = inst?.mcVersion ?? '1.20.4';
      const loader = inst?.loader ? ` --fml.mcVersion ${mc}` : '';
      return {
        pid: Math.floor(Math.random() * 9000) + 1000,
        command: `javaw.exe -Xmx${Math.round((inst?.config.memoryMb ?? 4096) / 1024)}G -jar ${mc}${loader}`,
      };
    },

    async stopGame(instanceId) {
      void instanceId; // 网页版没有真进程，参数只是契约的一部分
      await sleep(300);
    },

    /*
     * 网页版**没有真进程**，所以"谁在跑"这件事它答不了。
     *
     * ★ 返回空数组是**诚实**的（不是"没有游戏在运行"这个结论，而是
     *   "这个后端不掌握这件事"）。演示模式里运行态由 `game/start` /
     *   `game/stop` 自己攒 —— 它与真机一致的部分是：判据只有一份，
     *   这个接口只是"界面重新加载后对表"的兜底。
     */
    async runningGames() {
      return [];
    },

    async openFolder(path) {
      // 网页版没有文件系统，把路径回报给调用方去提示用户
      void path;
      await sleep(80);
    },

    async listMods(instanceId) {
      void instanceId;
      const base = Date.now();
      return DEMO_MODS.map((m, i) => ({
        fileName: m.fileName,
        path: `mods/${m.fileName}`,
        bytes: m.bytes,
        mtimeMs: base - i * 86400000,
      }));
    },
  };
}

/* ====================== 工具 ====================== */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 演示模式下的标签页标题同步 —— 让用户看到"实例设置"在改哪个实例。
 * （真实 Tauri 版由原生窗口标题承担）
 */
export function syncWindowTitle(name: string | null): void {
  document.title = name ? `IEML — ${name}` : 'IEML';
}

/** 给 UI 用：构造一个演示用的安装计划（依据真实规则引擎） */
export async function demoPlan(selection: LoaderSelection, name: string, slug: string) {
  const verdict = validateCombination(selection);
  const plan = await buildInstallPlan({
    selection,
    instanceName: name,
    slug,
    javaMajor: 17,
    source: {
      async vanillaManifest(mcVersion) {
        const files = Array.from({ length: 180 }, (_, i) => ({
          path: `libraries/lib-${i}.jar`,
          url: `https://bmclapi2.bangbang93.com/maven/lib-${i}.jar`,
          sha1: `sha1-${mcVersion}-${i}`,
          bytes: 180_000 + ((i * 7919) % 400_000),
        }));
        return {
          mcVersion,
          files,
          clientJar: {
            path: `versions/${mcVersion}/${mcVersion}.jar`,
            url: `https://bmclapi2.bangbang93.com/version/${mcVersion}/client`,
            sha1: `client-${mcVersion}`,
            bytes: 24_000_000,
          },
        };
      },
      async loaderInstaller(kind, mcVersion, version) {
        return {
          path: `installers/${kind}-${version}.jar`,
          url: `https://maven.example/${kind}/${version}/${kind}-${version}-installer.jar`,
          sha1: `${kind}-${version}-${mcVersion}`,
          bytes: kind === 'fabric' ? 2_400_000 : 8_600_000,
        };
      },
      async addonFile(kind, mcVersion, version) {
        if (!version) return null;
        return {
          path: `${kind}/${version}.jar`,
          url: `https://optifine.example/${mcVersion}/${kind}-${version}.jar`,
          sha1: `${kind}-${version}`,
          bytes: 6_200_000,
        };
      },
      async bridgeFile(kind, mcVersion) {
        return {
          path: `mods/${kind}-${mcVersion}.jar`,
          url: `https://modrinth.example/${kind}`,
          sha1: `${kind}-${mcVersion}`,
          bytes: 1_200_000,
        };
      },
      async apiLibraryFile(lib) {
        return {
          path: `mods/${lib.name}.jar`,
          url: `https://modrinth.example/${lib.kind}`,
          sha1: `${lib.kind}-${lib.version}`,
          bytes: lib.bytes,
        };
      },
      async cachedHashes() {
        // 演示：原版库文件里的偶数号算命中缓存，模拟"复用已有文件"
        const m = new Map<string, { path: string; bytes: number }>();
        for (let i = 0; i < 180; i += 2) {
          m.set(`sha1-${selection.mcVersion}-${i}`, { path: `libraries/lib-${i}.jar`, bytes: 0 });
        }
        return m;
      },
      estimatedSpeed() {
        return 12.4 * 1024 * 1024;
      },
    },
  });
  return { plan, verdict };
}
