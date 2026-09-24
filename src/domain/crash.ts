/**
 * 崩溃日志分析（ADR-011）
 * ------------------------------------------------------------------
 * 源码事实（源码研读第 12 章）：PCL2 的崩溃分析是
 * **9 大类约 70 条日志特征规则 + 堆栈启发式兜底**，而不是简单的关键字匹配。
 * 原设计稿把这一块完全没做（全稿"崩溃"只出现 2 次，且都是 toast 文案）。
 *
 * 铁律（DESIGN_SYSTEM 7.14）：
 *   **首屏必须是「原因 + 建议动作」，绝不能是堆栈。**
 *   用户要的是"我该怎么办"，不是"Exception in thread main"。
 */

export interface CrashRule {
  id: string;
  category: CrashCategory;
  /** 匹配的日志特征（正则） */
  pattern: RegExp;
  /** 给用户看的原因（人话，禁止技术黑话） */
  conclusion: string;
  /** 一键修复动作 */
  fix?: { label: string; kind: FixKind };
  /** 补充说明，可折叠 */
  detail?: string;
}

export type CrashCategory =
  | 'java'
  | 'memory'
  | 'mod'
  | 'loader'
  | 'graphics'
  | 'account'
  | 'file'
  | 'environment'
  | 'unknown';

export type FixKind =
  | 'switch-java'
  | 'raise-memory'
  | 'lower-memory'
  | 'disable-mod'
  | 'remove-mod'
  | 'reinstall-loader'
  | 'verify-files'
  | 'disable-optifine'
  | 'reinstall-game'
  | 'open-folder'
  | 'relogin'
  | 'none';

export const CATEGORY_LABEL: Record<CrashCategory, string> = {
  java: 'Java 运行环境',
  memory: '内存',
  mod: 'Mod',
  loader: '加载器',
  graphics: '图形驱动',
  account: '账号',
  file: '文件完整性',
  environment: '环境',
  unknown: '未能确定',
};

/* ====================== 规则库（按类别） ====================== */

export const CRASH_RULES: CrashRule[] = [
  /* ---------- 1. Java ---------- */
  {
    id: 'java-version-mismatch',
    category: 'java',
    pattern: /UnsupportedClassVersionError|class file version (\d+)/i,
    conclusion: 'Mod 或游戏需要的 Java 版本比当前用的更高',
    fix: { label: '换用合适的 Java', kind: 'switch-java' },
    detail: '日志里的 "class file version 61" 表示它需要 Java 17，"65" 表示需要 Java 21。',
  },
  {
    id: 'java-too-new',
    category: 'java',
    pattern: /java\.lang\.NoSuchMethodError:.*java\.base|Unsupported class file major version 6[5-9]/i,
    conclusion: '当前 Java 版本过高，老版本 Forge 或 OptiFine 无法在此版本上运行',
    fix: { label: '改用 Java 8', kind: 'switch-java' },
    detail: '1.16.5 及更早的游戏版本通常只能用 Java 8。',
  },
  {
    id: 'java-not-found',
    category: 'java',
    pattern: /Could not find or load main class|Error: Could not find or load/i,
    conclusion: '找不到要启动的主程序，通常是 Java 选错了或游戏文件缺失',
    fix: { label: '校验游戏文件', kind: 'verify-files' },
  },
  {
    id: 'java-arch-mismatch',
    category: 'java',
    pattern: /Can't load this \.dll|%1 is not a valid Win32 application|wrong ELF class/i,
    conclusion: 'Java 的位数与系统或 Mod 不匹配',
    fix: { label: '换用 64 位 Java', kind: 'switch-java' },
  },
  {
    id: 'java-unsafe',
    category: 'java',
    pattern: /sun\.misc\.Unsafe|LWJGL.*Unsafe/i,
    conclusion: '新版 Java 移除了 LWJGL 依赖的 Unsafe 接口',
    fix: { label: '关闭 LWJGL Unsafe 检查', kind: 'switch-java' },
    detail: '在实例设置 → 高级选项里可以关闭这项检查。',
  },

  /* ---------- 2. 内存 ---------- */
  {
    id: 'out-of-memory-heap',
    category: 'memory',
    pattern: /java\.lang\.OutOfMemoryError: Java heap space/i,
    conclusion: '内存不够用了',
    fix: { label: '把内存调大', kind: 'raise-memory' },
    detail: 'Mod 越多需要的内存越多。整合包建议先按自动配置的建议值，再往上加 1–2 GB。',
  },
  {
    id: 'out-of-memory-metaspace',
    category: 'memory',
    pattern: /OutOfMemoryError: Metaspace/i,
    conclusion: 'Mod 数量太多，类元数据区占满了',
    fix: { label: '把内存调大', kind: 'raise-memory' },
  },
  {
    id: 'gc-overhead',
    category: 'memory',
    pattern: /GC overhead limit exceeded/i,
    conclusion: '内存几乎全部被占用，垃圾回收陷入空转',
    fix: { label: '把内存调大', kind: 'raise-memory' },
  },
  {
    id: 'memory-too-large',
    category: 'memory',
    pattern: /Could not reserve enough space|Invalid maximum heap size|The specified size exceeds/i,
    conclusion: '分配的内存超过了本机可用内存',
    fix: { label: '把内存调小', kind: 'lower-memory' },
    detail: '如果你填的数值比物理内存还大，Java 会直接拒绝启动。',
  },
  {
    id: 'native-oom',
    category: 'memory',
    pattern: /OutOfMemoryError.*native|Cannot allocate memory|failed to allocate/i,
    conclusion: '系统层面的内存不足（不是游戏堆内存）',
    fix: { label: '关掉其他占内存的程序', kind: 'lower-memory' },
  },

  /* ---------- 3. Mod ---------- */
  {
    id: 'missing-dependency',
    category: 'mod',
    pattern: /requires?\s+([\w-]+)(?:,\s*which is missing)?|Missing or unsupported mandatory dependencies|Mod .* requires .* which is missing/i,
    conclusion: '有 Mod 缺少前置包',
    fix: { label: '自动补装前置包', kind: 'disable-mod' },
    detail: '最常见的是缺 Fabric API。装上它就能解决大部分这类问题。',
  },
  {
    id: 'mod-mc-mismatch',
    category: 'mod',
    pattern: /Incompatible mod set|Mod .* is not compatible with|requires Minecraft (?:version )?[\d.]+/i,
    conclusion: '有 Mod 与当前游戏版本不匹配',
    fix: { label: '查看是哪个 Mod', kind: 'disable-mod' },
  },
  {
    id: 'mod-duplicate',
    category: 'mod',
    pattern: /Duplicate mods|DuplicateModsFoundException|found a duplicate mod/i,
    conclusion: '装了两个同名或同 ID 的 Mod',
    fix: { label: '清理重复 Mod', kind: 'remove-mod' },
  },
  {
    id: 'mod-crash-mixin',
    category: 'mod',
    pattern: /Mixin apply failed|MixinTransformerError|org\.spongepowered\.asm/i,
    conclusion: '某个 Mod 的注入代码与其他 Mod 冲突',
    fix: { label: '二分法排查 Mod', kind: 'disable-mod' },
    detail: '日志里 Mixin apply failed 上方的 "xxx.mixins.json" 就是出问题的那个 Mod。',
  },
  {
    id: 'mod-conflict',
    category: 'mod',
    pattern: /Conflicting mods|Mod resolution encountered an incompatible mod set/i,
    conclusion: '两个 Mod 互相冲突，无法同时加载',
    fix: { label: '查看冲突的两个 Mod', kind: 'disable-mod' },
  },
  {
    id: 'mod-classnotfound',
    category: 'mod',
    pattern: /NoClassDefFoundError: (?!java)([\w/$]+)/i,
    conclusion: '某个 Mod 缺少依赖的类，通常是前置包没装全',
    fix: { label: '补装前置包', kind: 'disable-mod' },
  },
  {
    id: 'fabric-api-missing',
    category: 'mod',
    pattern: /fabric-api|fabricloader.*Fabric API|requires fabric/i,
    conclusion: '缺 Fabric API',
    fix: { label: '自动补装 Fabric API', kind: 'disable-mod' },
  },
  {
    id: 'optifine-conflict',
    category: 'mod',
    pattern: /optifine.*(?:conflict|incompatible)|OptiFine.*not compatible|ClassNotFoundException: optifine/i,
    conclusion: 'OptiFine 与当前加载器组合冲突',
    fix: { label: '关掉 OptiFine', kind: 'disable-optifine' },
    detail: 'NeoForge 与 OptiFine 不兼容；Fabric 1.20.5 及以上也不行。',
  },

  /* ---------- 4. 加载器 ---------- */
  {
    id: 'forge-install-corrupt',
    category: 'loader',
    pattern: /Failed to find (?:the )?main class|net\.minecraftforge.*ClassNotFound|Could not find.*forge/i,
    conclusion: 'Forge 没有装完整',
    fix: { label: '重新安装加载器', kind: 'reinstall-loader' },
  },
  {
    id: 'loader-version-mismatch',
    category: 'loader',
    pattern: /LoaderException|incompatible loader version|FabricLoader.*requires/i,
    conclusion: '加载器版本与 Mod 要求的不一致',
    fix: { label: '重新安装加载器', kind: 'reinstall-loader' },
  },
  {
    id: 'mixin-loader',
    category: 'loader',
    pattern: /MixinBootstrap|mixin.*loader.*failed/i,
    conclusion: 'Mixin 框架加载失败，通常是加载器装得不完整',
    fix: { label: '重新安装加载器', kind: 'reinstall-loader' },
  },

  /* ---------- 5. 图形 ---------- */
  {
    id: 'gpu-driver',
    category: 'graphics',
    /*
     * ★★ 2026-09-24（C-8 的判据表逼出来的真缺陷）：原来写的是
     *   `EXCEPTION_ACCESS_VIOLATION.*(?:nvoglv|atio|ig\d)` —— 而 `.` 在 JS 正则里
     *   **不跨行**，真实的 JVM 崩溃日志却一定是这个形状：
     *       # EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=…, pid=…, tid=…
     *       C  [nvoglv64.dll+0x…]
     *   驱动名在**下一行** ⇒ 这条规则在真机上**永远不会命中**（写了等于没写）。
     *   现在用 `[\s\S]{0,400}?` 跨行且限定距离（避免把整篇日志的两个无关片段凑成一条）——
     *   Rust 侧的 `regex` 同样支持 `[\s\S]`，两边写法保持一致（见 tests/crash-rules.cases.json）。
     */
    pattern: /EXCEPTION_ACCESS_VIOLATION[\s\S]{0,400}?(?:nvoglv|atio|ig\d)/i,
    conclusion: '显卡驱动崩溃了',
    fix: { label: '更新显卡驱动', kind: 'none' },
    detail: '日志里出现 nvoglv64.dll / atio6axx.dll / igdumdim64.dll 就是显卡驱动的名字。',
  },
  {
    id: 'glfw-error',
    category: 'graphics',
    pattern: /GLFW error \d+|Failed to create (?:window|GL context)|Pixel format not accelerated/i,
    conclusion: '无法创建图形窗口，通常是显卡驱动过旧或缺少 OpenGL 支持',
    fix: { label: '更新显卡驱动', kind: 'none' },
  },
  {
    id: 'shader-compile',
    category: 'graphics',
    pattern: /Shader compilation failed|error: 0:\d+|Iris.*shader.*error/i,
    conclusion: '光影包编译失败',
    fix: { label: '换个光影包或关掉光影', kind: 'none' },
  },
  {
    id: 'context-lost',
    category: 'graphics',
    pattern: /GL context lost|Graphics device lost|DXGI_ERROR_DEVICE/i,
    conclusion: '显卡上下文丢失（常见于显卡驱动重启或显存不足）',
    fix: { label: '降低游戏内画质设置', kind: 'none' },
  },

  /* ---------- 6. 账号 ---------- */
  {
    id: 'auth-failed',
    category: 'account',
    pattern: /InvalidCredentialsException|401 Unauthorized|Failed to (?:refresh|authenticate)|AuthenticationException/i,
    conclusion: '登录状态已失效',
    fix: { label: '重新登录', kind: 'relogin' },
  },
  {
    id: 'auth-offline',
    category: 'account',
    pattern: /Failed to verify username|UserNotAuthenticated|Invalid session/i,
    conclusion: '服务器拒绝了你的登录会话',
    fix: { label: '重新登录后再进服务器', kind: 'relogin' },
  },

  /* ---------- 7. 文件 ---------- */
  {
    id: 'file-corrupt',
    category: 'file',
    pattern: /ZipException|invalid LOC header|zip END header not found|corrupt/i,
    conclusion: '有文件损坏（多半是下载没完成）',
    fix: { label: '校验并修复文件', kind: 'verify-files' },
  },
  {
    id: 'missing-file',
    category: 'file',
    pattern: /FileNotFoundException|NoSuchFileException|The system cannot find the file/i,
    conclusion: '缺少必需的文件',
    fix: { label: '校验并补全文件', kind: 'verify-files' },
  },
  {
    id: 'permission-denied',
    category: 'file',
    pattern: /AccessDeniedException|Permission denied|拒绝访问/i,
    conclusion: '没有权限读写游戏目录',
    fix: { label: '把游戏目录换到有权限的位置', kind: 'open-folder' },
    detail: '放在 C:\\Program Files 或需要管理员权限的目录下常见这个问题。',
  },
  {
    id: 'path-too-long',
    category: 'file',
    pattern: /The filename or extension is too long|path too long|文件名或扩展名太长/i,
    conclusion: '文件路径过长，Windows 默认限制 260 字符',
    fix: { label: '把游戏目录移到更浅的位置', kind: 'open-folder' },
  },
  {
    id: 'disk-full',
    category: 'file',
    pattern: /There is not enough space on the disk|No space left on device/i,
    conclusion: '磁盘空间不足',
    fix: { label: '清理磁盘空间', kind: 'none' },
  },

  /* ---------- 8. 环境 ---------- */
  {
    id: 'chinese-path',
    category: 'environment',
    pattern: /java\.lang\.IllegalArgumentException: URI has an authority component|MalformedInputException/i,
    conclusion: '游戏路径里有中文或特殊字符，Java 启动包装器处理不了',
    fix: { label: '把游戏目录改成纯英文路径', kind: 'open-folder' },
    detail: '这是 Java Launch Wrapper 的已知限制。IEML 在启动前会提示，但已有的中文路径需要你手动改。',
  },
  {
    id: 'antivirus',
    category: 'environment',
    pattern: /The process cannot access the file because it is being used by another process/i,
    conclusion: '文件被其他程序占用（多半是杀毒软件正在扫描）',
    fix: { label: '把游戏目录加入杀毒白名单', kind: 'open-folder' },
  },
  {
    id: 'firewall',
    category: 'environment',
    pattern: /Connection refused|ConnectException|UnknownHostException/i,
    conclusion: '网络连接被拒绝或域名解析失败',
    fix: { label: '检查网络与代理设置', kind: 'none' },
  },
  {
    id: 'locale',
    category: 'environment',
    pattern: /UnsupportedEncodingException|MalformedInputException.*UTF/i,
    conclusion: '系统编码不是 UTF-8，导致文件读取失败',
    fix: { label: '把游戏目录改成纯英文路径', kind: 'open-folder' },
  },
];

/* ====================== 分析器 ====================== */

export interface CrashAnalysis {
  /** 面向用户的原因（首屏第一条） */
  reason: string;
  category: CrashCategory;
  /** 命中的全部规则（按类别分组展示） */
  matches: Array<{ rule: CrashRule; excerpt: string }>;
  /**
   * ★★ 本环境下**必然出现、与崩溃无关**的命中（P0-6）。
   *
   * 目前只有一类：离线启动时的 `401 Unauthorized` / `Failed to verify username`
   * —— 那是**我们自己**用离线身份启动造成的，把它们当"崩溃原因"就是假报告。
   * 照实列出来（用户滑日志会看到那几行），但**不参与**原因评选。
   */
  benignMatches: Array<{ rule: CrashRule; excerpt: string; why: string }>;
  /** 建议动作（去重后的） */
  actions: Array<{ label: string; kind: FixKind }>;
  /** 原始日志，默认折叠 */
  raw: string;
  /** 是否用了启发式兜底（诚实告诉用户"我不确定"） */
  heuristic: boolean;
}

/** 分析时的环境事实（与 Rust 侧 `crash::AnalyzeOptions` 同名同义） */
export interface AnalyzeOptions {
  /** 这次启动是不是**离线身份**（决定 401 一类记录算不算噪声） */
  offline?: boolean;
}

/**
 * 这条命中是不是"**离线身份下必然出现**"的噪声。
 *
 * 与 Rust 侧 `crash::is_offline_noise` 同一张表（改一处必须改两处，有测试钉着）。
 */
export function isOfflineNoise(ruleId: string): boolean {
  return ruleId === 'auth-failed' || ruleId === 'auth-offline';
}

/** 离线时那两条命中的解释（界面要能回答"这行为什么不算原因"） */
const OFFLINE_NOISE_WHY =
  '这次是离线身份启动，客户端连不上正版验证服务 —— 这一条是必然出现的，不是崩溃原因';

/**
 * 分析崩溃日志。
 * 顺序：先按类别优先级匹配规则，全部没命中时用堆栈启发式兜底。
 *
 * ★ `opts.offline` 为真时，上面那两条账号规则会被挪进 `benignMatches`
 *   （照实展示、不参与结论）—— 见 P0-6 的说明。
 */
export function analyzeCrashLog(raw: string, opts: AnalyzeOptions = {}): CrashAnalysis {
  const text = raw ?? '';
  const all: Array<{ rule: CrashRule; excerpt: string }> = [];

  for (const rule of CRASH_RULES) {
    const m = rule.pattern.exec(text);
    if (!m) continue;
    // 取命中位置前后各 80 字符作为证据摘录
    const start = Math.max(0, (m.index ?? 0) - 80);
    const excerpt = text.slice(start, Math.min(text.length, (m.index ?? 0) + m[0].length + 80)).trim();
    all.push({ rule, excerpt });
  }

  /* 类别优先级：内存/Java 这类"必然结论"排在 Mod 冲突这类"可能结论"之前 */
  const priority: CrashCategory[] = [
    'java',
    'memory',
    'loader',
    'mod',
    'file',
    'graphics',
    'account',
    'environment',
  ];
  all.sort((a, b) => priority.indexOf(a.rule.category) - priority.indexOf(b.rule.category));

  const benignMatches = opts.offline
    ? all.filter((m) => isOfflineNoise(m.rule.id)).map((m) => ({ ...m, why: OFFLINE_NOISE_WHY }))
    : [];
  const matches = opts.offline ? all.filter((m) => !isOfflineNoise(m.rule.id)) : all;

  const actions: Array<{ label: string; kind: FixKind }> = [];
  for (const { rule } of matches) {
    if (rule.fix && !actions.some((a) => a.kind === rule.fix!.kind)) actions.push(rule.fix);
  }

  if (matches.length > 0) {
    const top = matches[0]!;
    return {
      reason: top.rule.conclusion,
      category: top.rule.category,
      matches,
      benignMatches,
      actions,
      raw: text,
      heuristic: false,
    };
  }

  /* ---------- 兜底：从堆栈里找线索 ---------- */
  const heuristic = heuristicGuess(text);
  return {
    reason: heuristic.reason,
    category: heuristic.category,
    matches: [],
    benignMatches,
    actions: heuristic.actions,
    raw: text,
    heuristic: true,
  };
}

function heuristicGuess(text: string): {
  reason: string;
  category: CrashCategory;
  actions: Array<{ label: string; kind: FixKind }>;
} {
  // 从堆栈里找非 Minecraft / 非 Java 的包名，那通常是肇事的 Mod
  const culprit = /at\s+([a-z][\w.]*)\.[\w$]+\(/gi;
  const known = /^(java|javax|jdk|sun|com\.mojang|net\.minecraft|org\.lwjgl|it\.unimi|org\.spongepowered|cpw\.mods|net\.minecraftforge|org\.apache|com\.google)/i;
  const found = new Set<string>();
  for (const m of text.matchAll(culprit)) {
    const pkg = m[1];
    if (!pkg || known.test(pkg)) continue;
    const root = pkg.split('.').slice(0, 2).join('.');
    found.add(root);
    if (found.size >= 3) break;
  }

  if (found.size > 0) {
    const names = [...found].join('、');
    return {
      reason: `未能匹配到已知问题，但从堆栈看可能与 ${names} 有关`,
      category: 'mod',
      actions: [
        { label: '二分法排查 Mod', kind: 'disable-mod' },
        { label: '打开日志所在目录', kind: 'open-folder' },
      ],
    };
  }

  if (/Exception|Error|Caused by/i.test(text)) {
    return {
      reason: '游戏异常退出，但日志里没有 IEML 能识别的特征',
      category: 'unknown',
      actions: [
        { label: '校验并修复文件', kind: 'verify-files' },
        { label: '打开日志所在目录', kind: 'open-folder' },
      ],
    };
  }

  return {
    reason: '游戏进程结束但没有留下错误信息（可能是被强制结束或正常退出）',
    category: 'unknown',
    actions: [{ label: '打开日志所在目录', kind: 'open-folder' }],
  };
}

/* ====================== 脱敏导出（ADR-012） ====================== */

export interface RedactionResult {
  text: string;
  /** 处理了哪些东西 —— 必须主动告诉用户（DESIGN_SYSTEM 7.14 铁律） */
  redacted: Array<{ what: string; count: number }>;
}

/**
 * 导出崩溃报告前的脱敏。
 * ★ 日志里出现自己的正版账号名或 token，用户会介意。
 *   在导出前主动告诉他处理了什么，比事后被质疑要好。
 */
export function redactReport(raw: string): RedactionResult {
  const counts = new Map<string, number>();
  let text = raw;

  const rules: Array<{ name: string; re: RegExp; replace: string }> = [
    { name: '微软登录令牌', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, replace: '<已隐藏的登录令牌>' },
    { name: '访问令牌', re: /(access_token|accessToken|refresh_token)(["'\s:=]+)([A-Za-z0-9._-]{8,})/gi, replace: '$1$2<已隐藏>' },
    { name: '玩家 UUID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replace: '<已隐藏的账号 ID>' },
    { name: '会话密钥', re: /(session|secret|password)(["'\s:=]+)(\S{6,})/gi, replace: '$1$2<已隐藏>' },
    { name: '本机用户名', re: /[A-Za-z]:\\Users\\[^\\\s]+/g, replace: 'C:\\Users\\<用户名>' },
    { name: 'IP 地址', re: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, replace: '<已隐藏的地址>' },
  ];

  /*
   * 注意：String.replace 的替换串里 `$` 有特殊含义，而替换文本本身含
   * 中文尖括号，直接用会踩坑；这里用回调返回字面量，并手工展开 $1/$2。
   */
  for (const r of rules) {
    text = text.replace(r.re, (...args) => {
      counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
      const groups = args.slice(1, -2) as Array<string | undefined>;
      return r.replace.replace(/\$(\d)/g, (_m, d: string) => groups[Number(d) - 1] ?? '');
    });
  }

  return {
    text,
    redacted: [...counts.entries()].map(([what, count]) => ({ what, count })),
  };
}

/** 日志特征库的规模，用于在 UI 上说明"我们查了多少条规则" */
export const RULE_STATS = {
  total: CRASH_RULES.length,
  byCategory: CRASH_RULES.reduce<Record<string, number>>((acc, r) => {
    acc[r.category] = (acc[r.category] ?? 0) + 1;
    return acc;
  }, {}),
};
