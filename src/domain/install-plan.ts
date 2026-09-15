/**
 * 安装计划生成器（ADR-002）
 * ------------------------------------------------------------------
 * ★ 铁律：InstallPlan 必须是**纯数据结构**，在下载前完全算出来。
 *   好处：可预览、可显示准确体积、可序列化续传、可单元测试。
 *
 * ★ 步骤间串行、步骤内并发（ARCHITECTURE 第 6 章）：
 *   加载器安装有严格顺序（原版 → 基础加载器 → 附加组件 → 桥接包 → API 包），
 *   但每一步内部有上百个文件可高并发。
 *
 * ★ 文件去重：多加载器/多实例共享大量 libraries，按 SHA1 去重能省 30%+ 流量。
 */
import { getLoaderCapabilities, resolveApiLibrary } from './loader-caps.ts';
import { validateCombination } from './combination.ts';
import type {
  ApiLibraryOption,
  DownloadItem,
  InstallPhase,
  InstallPlan,
  InstallStep,
  LoaderSelection,
  LocalAction,
} from './types.ts';

/** 面向用户的阶段文案（禁止内部术语，见文案规范第 13 章） */
export const PHASE_LABELS: Record<InstallPhase, string> = {
  resolve: '解析版本清单',
  'download-installer': '下载安装器',
  'run-installer': '释放库文件',
  'collect-libraries': '整理依赖',
  'apply-addons': '应用附加组件',
  'install-bridge': '安装桥接包',
  'install-apis': '安装 API 前置包',
  'write-manifest': '生成版本描述',
  verify: '校验文件',
};

/** 用户能看到的阶段顺序（进度条用），内部阶段合并展示 */
export const USER_PHASES: Array<{ id: InstallPhase; label: string }> = [
  { id: 'download-installer', label: '下载安装器' },
  { id: 'run-installer', label: '释放库文件' },
  { id: 'collect-libraries', label: '整理依赖' },
  { id: 'install-bridge', label: '安装附加组件' },
  { id: 'write-manifest', label: '生成版本描述' },
];

/* ====================== 数据源抽象 ====================== */

/**
 * 元数据源 —— 真实实现里由 Rust 侧实现（Mojang 清单 + BMCLAPI 镜像 + 各加载器 API）。
 * 前端只依赖这个接口，所以现在可以用本地实现跑通，将来换成 invoke() 不改调用方。
 */
export interface VersionManifest {
  mcVersion: string;
  /** 原版全部文件 */
  files: Array<{ path: string; url: string; sha1: string; bytes: number }>;
  /** 客户端 jar */
  clientJar: { path: string; url: string; sha1: string; bytes: number };
}

export interface MetadataSource {
  /** 取原版文件清单 */
  vanillaManifest(mcVersion: string): Promise<VersionManifest>;
  /** 取某个加载器的安装器信息 */
  loaderInstaller(
    kind: string,
    mcVersion: string,
    version: string,
  ): Promise<{ path: string; url: string; sha1: string; bytes: number } | null>;
  /** 取某个附加组件的文件 */
  addonFile(
    kind: string,
    mcVersion: string,
    version: string,
  ): Promise<{ path: string; url: string; sha1: string; bytes: number } | null>;
  /** 取桥接包 */
  bridgeFile(
    kind: string,
    mcVersion: string,
  ): Promise<{ path: string; url: string; sha1: string; bytes: number } | null>;
  /** 取 API 前置包的下载地址（版本必须与 MC 绑定，ADR-006） */
  apiLibraryFile(
    lib: ApiLibraryOption,
    mcVersion: string,
  ): Promise<{ path: string; url: string; sha1: string; bytes: number } | null>;
  /** 本地已有哪些文件的 SHA1（用于缓存复用与去重） */
  cachedHashes(): Promise<Map<string, { path: string; bytes: number }>>;
  /** 预估下载速度（字节/秒），用于算 ETA */
  estimatedSpeed(): number;
}

/* ====================== 生成计划 ====================== */

export interface BuildPlanInput {
  selection: LoaderSelection;
  instanceName: string;
  slug: string;
  /** 该实例已装的 Java 主版本，若为 null 说明要下载 Java */
  javaMajor: number | null;
  /** Java 需要下载时的字节数 */
  javaBytes?: number;
  source: MetadataSource;
}

/**
 * 生成完整安装计划。
 * 返回的 InstallPlan 可以被 JSON.stringify 后存盘，中断后按已完成的 path 续传。
 */
export async function buildInstallPlan(input: BuildPlanInput): Promise<InstallPlan> {
  const { selection, instanceName, slug, source } = input;
  const verdict = validateCombination(selection);
  const caps = getLoaderCapabilities(selection.mcVersion);

  const notes: string[] = [];
  for (const w of verdict.warnings) notes.push(w);
  for (const r of verdict.removed) {
    notes.push(`已移除 ${r.kind}：${r.reason}`);
  }

  /* ---------- 1. 原版文件 ---------- */
  const manifest = await source.vanillaManifest(selection.mcVersion);
  const vanillaDownloads: DownloadItem[] = [
    ...manifest.files.map((f) => toItem(f, 'shared', 'mojang')),
    toItem(manifest.clientJar, 'shared', 'mojang'),
  ];

  /* ---------- 2. 基础加载器 ---------- */
  const loaderDownloads: DownloadItem[] = [];
  const loaderActions: LocalAction[] = [];
  if (selection.base !== null && verdict.valid) {
    const version = selection.baseVersion ?? findDefaultVersion(caps, selection.base);
    if (version) {
      const installer = await source.loaderInstaller(selection.base, selection.mcVersion, version);
      if (installer) {
        loaderDownloads.push(toItem(installer, 'shared', sourceOf(selection.base)));
        loaderActions.push({
          kind: 'run-installer',
          jarPath: installer.path,
          args: ['--installClient'],
        });
      } else {
        notes.push(
          `未能获取 ${selection.base} ${version} 的安装器地址，安装时可能失败 —— 该来源暂时不可用`,
        );
      }
    }
  }

  /* ---------- 3. 附加组件（严格在基础加载器之后） ---------- */
  const addonDownloads: DownloadItem[] = [];
  const addonActions: LocalAction[] = [];
  const survivingAddons = selection.addons.filter(
    (a) => !verdict.removed.some((r) => r.kind === a),
  );
  for (const addon of survivingAddons) {
    const version = selection.addonVersions?.[addon] ?? '';
    const file = await source.addonFile(addon, selection.mcVersion, version);
    if (file) {
      addonDownloads.push(toItem(file, 'shared', 'optifine'));
      if (addon === 'optifine') {
        // ★ 关键：OptiFine 是**独立的 Patcher 程序**对原版 jar 做字节码补丁，
        //   不是"复制文件覆盖"。所以这里是一个 action，不是一堆下载项。
        addonActions.push({
          kind: 'apply-optifine-patch',
          inputJar: manifest.clientJar.path,
          outputDir: 'libraries/optifine',
        });
      }
    } else {
      notes.push(`${addon} ${version || '所选版本'} 的文件地址暂时不可用`);
    }
  }

  /* ---------- 4. 桥接包（必须在附加组件之后） ---------- */
  const bridgeDownloads: DownloadItem[] = [];
  for (const b of verdict.autoBridges) {
    /*
     * ★★ 这里**现在进不来了**，两段都留着是为了下次不再犯同样的错。
     *
     *   `validateCombination` 只把**能自动装**的桥接包放进 `autoBridges`；
     *   1.14 ~ 1.20.4 的 OptiFabric 是手动的（`manual: true`），
     *   走的是 `verdict.warnings` 里那条「要你自己下载 + 地址」。
     *
     *   为什么这段代码本来是**有害**的：它是全仓库**唯一**读桥接包的地方，
     *   而 `bridgeFile()` 只存在于 `src/bridge/web.ts`（浏览器演示模式），
     *   生产适配器根本没有这个方法 —— 所以"会自动装桥接包"这句承诺
     *   从 dev.9 起就写在界面上，却从来没有对应的代码。
     *   留着这两段是为了让后来的人看清：**承诺和实现差在哪里**。
     */
    if (b.kind === 'optifabric-origins') {
      notes.push(
        'OptiFabric Origins 没有自动下载方案，需要你手动下载后放进 mods/ 目录（安装完会提示路径）',
      );
      continue;
    }
    const file = await source.bridgeFile(b.kind, selection.mcVersion);
    if (file) bridgeDownloads.push(toItem(file, 'instance', 'modrinth'));
  }

  /* ---------- 5. API 前置包 ---------- */
  const apiDownloads: DownloadItem[] = [];
  const apis: ApiLibraryOption[] = [];
  const api = resolveApiLibrary(selection.base, selection.mcVersion);
  if (api) {
    apis.push(api);
    const file = await source.apiLibraryFile(api, selection.mcVersion);
    if (file) {
      apiDownloads.push(toItem(file, 'instance', 'modrinth'));
    } else {
      // 查询失败降级为警告，不阻断安装（ADR-006）
      notes.push(
        `${api.name} 的下载地址暂时查不到 —— 装完后请去 Mod 管理页手动补装，否则依赖它的 Mod 无法加载`,
      );
    }
  }

  /* ---------- 6. Java（整合包自带 Java 的情况见 ADR-030） ---------- */
  const javaDownloads: DownloadItem[] = [];
  if (input.javaMajor === null && input.javaBytes) {
    javaDownloads.push({
      path: `java/${caps.javaMajor}/runtime.zip`,
      url: `https://api.adoptium.net/v3/binary/latest/${caps.javaMajor}/ga/windows/x64/jre/hotspot/normal/eclipse`,
      sha1: '',
      bytes: input.javaBytes,
      target: 'java',
      source: 'adoptium',
    });
    notes.push(`本机没有 Java ${caps.javaMajor}，将自动从 Adoptium 获取（约 ${mb(input.javaBytes)} MB）`);
  }

  /* ---------- 组装步骤（顺序即铁律） ---------- */
  const steps: InstallStep[] = [
    step('download-installer', loaderDownloads, [], true),
    step('run-installer', [], loaderActions, true),
    step('collect-libraries', vanillaDownloads, [], false),
    step('apply-addons', [...addonDownloads, ...bridgeDownloads], addonActions, true),
    step('install-apis', apiDownloads, [], true),
    step(
      'write-manifest',
      [],
      [
        {
          kind: 'write-json',
          path: `versions/${slug}/${slug}.json`,
          content: JSON.stringify(
            {
              id: slug,
              inheritsFrom: selection.mcVersion,
              loader: selection.base,
              loaderVersion: selection.baseVersion,
              addons: survivingAddons,
              apiLibraries: apis.map((a) => a.name),
            },
            null,
            2,
          ),
        },
      ],
      true,
    ),
    step('verify', [], [{ kind: 'verify-hashes', paths: [] }], true),
  ];

  /* ---------- 去重 + 缓存命中 ---------- */
  const all = [
    ...javaDownloads,
    ...vanillaDownloads,
    ...loaderDownloads,
    ...addonDownloads,
    ...bridgeDownloads,
    ...apiDownloads,
  ];
  const cached = await source.cachedHashes();

  const seen = new Set<string>();
  const deduped: DownloadItem[] = [];
  let dedupedBytes = 0;
  for (const d of all) {
    // 同一个 sha1 只下一次（多实例/多加载器共享 libraries 的典型场景）
    if (d.sha1 && seen.has(d.sha1)) {
      dedupedBytes += d.bytes;
      continue;
    }
    if (d.sha1) seen.add(d.sha1);
    deduped.push(d);
  }

  let downloadBytes = 0;
  let reusedBytes = 0;
  for (const d of deduped) {
    const hit = d.sha1 ? cached.get(d.sha1) : undefined;
    if (hit) reusedBytes += d.bytes;
    else downloadBytes += d.bytes;
  }
  const installBytes = deduped.reduce((s, d) => s + d.bytes, 0);
  const speed = Math.max(source.estimatedSpeed(), 1);
  const estimatedSeconds = Math.max(
    5,
    Math.round(downloadBytes / speed + deduped.length * 0.02),
  );

  // 把下载项挂回各自的步骤，便于 UI 按阶段展示
  attachDownloads(steps, deduped);

  return {
    mcVersion: selection.mcVersion,
    instanceName,
    slug,
    loader:
      selection.base !== null && verdict.valid
        ? {
            kind: selection.base,
            version: selection.baseVersion ?? findDefaultVersion(caps, selection.base) ?? '',
            mcVersion: selection.mcVersion,
          }
        : null,
    addons: survivingAddons.map((kind) => ({
      kind,
      version: selection.addonVersions?.[kind] ?? '',
      ...(verdict.autoBridges.find((b) => b.after === kind)
        ? { bridge: { kind: verdict.autoBridges.find((b) => b.after === kind)!.kind, version: 'latest' } }
        : {}),
    })),
    apiLibraries: apis,
    javaMajor: caps.javaMajor,
    downloads: deduped,
    steps,
    summary: {
      downloadBytes,
      reusedBytes,
      installBytes,
      estimatedSeconds,
      fileCount: deduped.length,
      dedupedBytes,
    },
    notes,
  };
}

/* ====================== 内部工具 ====================== */

function toItem(
  f: { path: string; url: string; sha1: string; bytes: number },
  target: DownloadItem['target'],
  source: DownloadItem['source'],
): DownloadItem {
  return { path: f.path, url: f.url, sha1: f.sha1, bytes: f.bytes, target, source };
}

function sourceOf(kind: string): DownloadItem['source'] {
  switch (kind) {
    case 'forge':
      return 'forge';
    case 'neoforge':
      return 'neoforge';
    case 'fabric':
      return 'fabric';
    case 'quilt':
      return 'quilt';
    default:
      return 'mojang';
  }
}

function step(
  phase: InstallPhase,
  downloads: DownloadItem[],
  actions: LocalAction[],
  serial: boolean,
): InstallStep {
  return { phase, label: PHASE_LABELS[phase], downloads, actions, serial };
}

function attachDownloads(steps: InstallStep[], all: DownloadItem[]): void {
  // 已经按阶段分好组的不动；这里只把阶段外的零散项补进 collect-libraries
  const known = new Set(steps.flatMap((s) => s.downloads.map((d) => d.path)));
  const orphans = all.filter((d) => !known.has(d.path));
  if (orphans.length === 0) return;
  const target = steps.find((s) => s.phase === 'collect-libraries');
  if (target) {
    target.downloads.push(...orphans.filter((o) => o.target === 'shared'));
    const inst = steps.find((s) => s.phase === 'install-apis');
    if (inst) inst.downloads.push(...orphans.filter((o) => o.target !== 'shared'));
  }
}

function findDefaultVersion(
  caps: ReturnType<typeof getLoaderCapabilities>,
  kind: string,
): string | undefined {
  return caps.baseLoaders.find((b) => b.kind === kind)?.versions[0];
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

/* ====================== 计划的自检 ====================== */

export interface PlanCheckIssue {
  level: 'error' | 'warning';
  message: string;
}

/**
 * 计划自检：在真正开下之前跑一遍，把"算错了"的情况拦下来。
 * 这是"安装失败"最便宜的一种修复方式。
 */
export function checkPlan(plan: InstallPlan): PlanCheckIssue[] {
  const issues: PlanCheckIssue[] = [];

  if (plan.downloads.length === 0) {
    issues.push({ level: 'error', message: '计划里没有任何要下载的文件 —— 解析可能失败了' });
  }
  const noUrl = plan.downloads.filter((d) => !d.url);
  if (noUrl.length > 0) {
    issues.push({
      level: 'error',
      message: `${noUrl.length} 个文件缺少下载地址：${noUrl.slice(0, 3).map((d) => d.path).join('、')}`,
    });
  }
  const noHash = plan.downloads.filter((d) => !d.sha1 && d.source !== 'adoptium');
  if (noHash.length > 0) {
    issues.push({
      level: 'warning',
      message: `${noHash.length} 个文件没有校验值，无法验证完整性`,
    });
  }
  if (plan.summary.downloadBytes > 8 * 1024 * 1024 * 1024) {
    issues.push({
      level: 'warning',
      message: '计划要下载超过 8 GB，请确认选中的不是整合包级别的体量',
    });
  }
  // 顺序铁律检查：桥接包不能在附加组件之前
  const phaseOrder = plan.steps.map((s) => s.phase);
  const addonIdx = phaseOrder.indexOf('apply-addons');
  const bridgeIdx = phaseOrder.indexOf('install-bridge');
  if (bridgeIdx >= 0 && addonIdx >= 0 && bridgeIdx < addonIdx) {
    issues.push({
      level: 'error',
      message: '顺序错误：桥接包被排在了附加组件之前，OptiFabric 会装不上',
    });
  }
  return issues;
}

/** 人类可读的体积 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return Math.round(bytes / 1024 ** 2) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

/** 人类可读的时长 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}
