/**
 * 加载器可用性目录（后台**真实**查询，按 MC 版本缓存）
 * ------------------------------------------------------------------
 * ## 为什么需要它
 *
 * 用户的要求是「所有 MC 版本都要检测，能装就是能装，不能装就是不能装」。
 * 但真实清单有 900+ 个版本，而每个版本的加载器清单要打 5 个接口 ——
 * 900 × 5 = 4500 个请求，任何后端都受不了，用户也等不起。
 *
 * 所以这里的立场是：
 *   ① **内置表彻底退出"能不能装"的判定**（它连 26.2 都没有，还跟不上新版本）。
 *      没有在线数据时一律 `confirmed: false` —— 宁可暂时不能选，也不猜。
 *   ② 目录**只装真实查到的结果**，按 MC 版本缓存（默认 1 小时）。
 *   ③ 后台**按优先级**把真实数据拉回来：已装版本 → 列表当前可见的版本 →
 *      常用版本 → 其余。并发受控（默认 3），不会一次打爆。
 *   ④ 用户点开某个版本时，前端用同一份目录 —— 单次查询与后台预热共用缓存。
 *
 * ## 与 ADR-037 的关系
 *
 * 目录里**只记录成功的查询**。"查过但没有"与"没查过"必须可区分：
 * `versions: []` + 有 `fetchedAt` = 确认没有；没有条目 = 还没查到。
 */

/** 一个 MC 版本的真实加载器清单结果 */
export interface VersionLoaderRecord {
  /** kind → 该加载器可安装的版本号（空数组 = 确认这个版本没有它） */
  bases: Record<string, string[]>;
  /** kind → 查询失败的原因（没查到的那些） */
  errors: Record<string, string>;
  /**
   * 附加组件（OptiFine）的**完整信息**。
   *
   * ★ 不能再把它压成字符串数组：OptiFine 的每一条都带
   *   `filename` / `preview`（预览版）/ `required_forge`（兼容的 Forge 要求），
   *   界面要靠这些告诉用户"装的是不是正式版""需要哪个 Forge"。
   *   压成字符串会把这三条信息全丢掉（曾经真的这么写过，界面于是显示
   *   "最新：undefined"）。
   */
  addons?: Record<string, unknown[]>;
  /** 拉取时间（毫秒）；TTL 判定用 */
  fetchedAt: number;
}

/**
 * 缓存的 localStorage 键。
 *
 * ★★ **版本号必须跟着解析规则的修改一起升**（v1 → v2，2026-09-13）。
 *
 * 为什么：缓存里存的是"**结论**"（比如"26.1 没有 NeoForge"），
 * 而不只是原始数据。当修复的是**解析规则**时，旧结论会带着 bug 继续生效 ——
 * 用户升级了启动器，看到的还是"没有 NeoForge"，而且会持续到 TTL 到期。
 *
 * 这次就是把 v1 升到 v2 的原因：NeoForge 的旧逻辑会把 `-beta` 全部过滤掉，
 * 于是 `26.1`（18 条全是 beta）被当成"**确认没有** NeoForge"并持久化。
 * 那种记录连"失败"都不算 —— 它是**自信的错误结论**，比失败更糟。
 *
 * 规则：**凡是改了"从接口数据得出什么结论"的代码，就升这个版本号。**
 */
const KEY = 'ieml.loaderCatalog.v2';
/** 缓存多久算新鲜（1 小时）。加载器是活的，但也没必要每次进页面全网重拉 */
export const CATALOG_TTL_MS = 60 * 60 * 1000;

type Listener = () => void;

class LoaderCatalog {
  private map = new Map<string, VersionLoaderRecord>();
  private inflight = new Map<string, Promise<VersionLoaderRecord>>();
  private listeners = new Set<Listener>();
  /** 正在查的版本（UI 显示"正在查…"用） */
  private pending = new Set<string>();

  constructor() {
    this.load();
  }

  /* ---------- 读 ---------- */

  /**
   * 取一个版本的记录；`null` = **还没查到**（不是"没有"）
   */
  get(mcVersion: string): VersionLoaderRecord | null {
    return this.map.get(mcVersion) ?? null;
  }

  /** 这条记录里有没有**没查到的**加载器（有就说明它不完整） */
  hasErrors(rec: VersionLoaderRecord | null): boolean {
    return !!rec && Object.keys(rec.errors ?? {}).length > 0;
  }

  /**
   * 记录是否够新**且可用**。
   *
   * ★★ 这里修的是一个真实的 bug（用户报"该有 Forge 的版本还是没有 Forge"）：
   *
   *   以前只判 `Date.now() - fetchedAt < TTL` —— 于是一条**部分失败**的记录
   *   （例如 Forge 超时、Fabric 成功）会被当成"新鲜且有效"用整整 1 小时，
   *   而且它还被写进了 localStorage 存活 24 小时。
   *   结果：只要某一次 Forge 查询赶上瞬时失败，这个版本在这一整天里
   *   都会告诉用户"Forge 没查到"—— 而 Forge 一直都在。
   *
   *   现在的规则：**带 errors 的记录一律不算新鲜**，下次一定重查。
   *   （"确认没有"不含 errors，仍然是新鲜的有效结论，不会被反复重查。）
   */
  isFresh(mcVersion: string): boolean {
    const r = this.map.get(mcVersion);
    if (!r) return false;
    if (Date.now() - r.fetchedAt >= CATALOG_TTL_MS) return false;
    return !this.hasErrors(r);
  }

  isPending(mcVersion: string): boolean {
    return this.pending.has(mcVersion);
  }

  /** 已缓存的版本数（诊断/展示用） */
  get size(): number {
    return this.map.size;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /* ---------- 写 ---------- */

  /** 写入一条真实结果（只有成功的查询才该进这里） */
  put(mcVersion: string, rec: Omit<VersionLoaderRecord, 'fetchedAt'>): void {
    this.map.set(mcVersion, { ...rec, fetchedAt: Date.now() });
    this.persist();
    this.emit();
  }

  /**
   * 确保某个版本的清单已就绪（有新鲜缓存就直接用；否则真去查）。
   *
   * ★ 同一版本的并发调用会合并成一次请求（`inflight`）——
   *   用户连点几个版本、后台又在预热时，不会重复打同一个接口。
   */
  async ensure(
    mcVersion: string,
    fetcher: (mc: string) => Promise<{ base: LoaderLike[]; addons: LoaderLike[] }>,
    opts: { force?: boolean } = {},
  ): Promise<VersionLoaderRecord> {
    const cached = this.map.get(mcVersion);
    if (cached && !opts.force && this.isFresh(mcVersion)) return cached;

    const running = this.inflight.get(mcVersion);
    if (running && !opts.force) return running;

    this.pending.add(mcVersion);
    this.emit();

    const job = (async () => {
      try {
        const res = await fetcher(mcVersion);
        const bases: Record<string, string[]> = {};
        const errors: Record<string, string> = {};
        const addons: Record<string, unknown[]> = {};
        for (const l of [...res.base, ...res.addons]) {
          if (l.error) {
            errors[l.kind] = l.error;
            continue;
          }
          if (l.kind === 'optifine') {
            // 附加组件保留完整信息（preview / required_forge / filename）
            addons[l.kind] = (l.optifine ?? []) as unknown[];
            // 版本号视图也留一份，方便只想看"有哪些版本"的地方
            bases[l.kind] = l.versions;
            continue;
          }
          bases[l.kind] = l.versions;
        }
        const rec: VersionLoaderRecord = { bases, errors, addons, fetchedAt: Date.now() };
        this.map.set(mcVersion, rec);
        /*
         * ★ 只有**全部查到**的记录才写进 localStorage。
         *
         *   带 errors 的记录留在内存里（本次会话能立刻看到"没查到，可重试"），
         *   但**不落盘** —— 否则一次瞬时失败会被持久化，重启后依然显示
         *   "没查到"，而用户根本没有重试的机会（见 `isFresh` 的说明）。
         */
        if (Object.keys(errors).length === 0) {
          this.persist();
        } else {
          console.warn(
            `[IEML] ${mcVersion} 的加载器清单有 ${Object.keys(errors).length} 项没查到，不写入缓存：`,
            errors,
          );
        }
        return rec;
      } finally {
        this.pending.delete(mcVersion);
        this.inflight.delete(mcVersion);
        this.emit();
      }
    })();

    this.inflight.set(mcVersion, job);
    return job;
  }

  /* ---------- 真正的"所有版本"：后台按优先级批量预热 ---------- */

  /**
   * 按给定顺序把版本清单拉回来（并发受控）。
   *
   * `shouldStop` 每轮问一次，用来在页面离开时收手。
   * 返回实际完成的版本数。
   */
  async prime(
    mcVersions: string[],
    fetcher: (mc: string) => Promise<{ base: LoaderLike[]; addons: LoaderLike[] }>,
    opts: { concurrency?: number; limit?: number; shouldStop?: () => boolean; force?: boolean } = {},
  ): Promise<number> {
    const todo = mcVersions.filter(
      (v) => (opts.force || !this.isFresh(v)) && !this.inflight.has(v),
    );
    const limit = opts.limit ?? todo.length;
    const queue = todo.slice(0, limit);
    const concurrency = Math.max(1, opts.concurrency ?? 3);
    let done = 0;
    let idx = 0;

    const worker = async () => {
      for (;;) {
        if (opts.shouldStop?.()) return;
        const i = idx++;
        if (i >= queue.length) return;
        try {
          await this.ensure(queue[i]!, fetcher, opts.force ? { force: true } : {});
          done += 1;
        } catch {
          // 后台预热失败不打扰用户：那一条留在"没查到"，用户点开时自然会重试
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return done;
  }

  /**
   * 清掉过期的、以及**带 errors 的**条目（启动时调一次）。
   *
   * ★ 带 errors 的也要清（不只是不新鲜）：
   *   修好缓存规则之前，用户 localStorage 里可能已经存着
   *   「Forge 没查到」这种**被错误持久化**的记录。只把它们标成不新鲜
   *   还不够 —— 界面上仍会显示上次那份失败结果，用户看到的就是
   *   "该有 Forge 的版本还是没有 Forge"。启动时直接丢掉，让它重查。
   *
   *   顺带也避免 localStorage 无限膨胀。
   */
  dropStale(): void {
    const now = Date.now();
    let changed = false;
    for (const [k, v] of this.map) {
      // 留 24 小时：过期的还能当"上次查到的结果"用，只是标成不新鲜
      const tooOld = now - v.fetchedAt > 24 * 60 * 60 * 1000;
      if (tooOld || this.hasErrors(v)) {
        this.map.delete(k);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /* ---------- 持久化 ---------- */

  /**
   * 从 localStorage 载入。
   *
   * ★ **带 errors 的记录在读入时就丢掉**：修好缓存规则之前，用户的
   *   localStorage 里可能存着「Forge 没查到」这种被错误持久化的记录。
   *   读进来就等于把上次的瞬时失败当成结论——界面会说
   *   "该有 Forge 的版本还是没有 Forge"。丢掉，让它重查。
   */
  private load() {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, VersionLoaderRecord>;
      let dropped = 0;
      for (const [k, v] of Object.entries(obj)) {
        if (!v || typeof v.fetchedAt !== 'number' || !v.bases) continue;
        if (this.hasErrors(v)) {
          dropped += 1;
          continue;
        }
        this.map.set(k, v);
      }
      if (dropped > 0) {
        console.warn(
          `[IEML] 丢掉了 ${dropped} 个不完整的加载器缓存（上次没查到的那几项），会重新查询`,
        );
        this.persist();
      }
    } catch {
      /* 存储坏了就当没有 —— 不值得为一个缓存报错 */
    }
  }

  private persist() {
    try {
      if (typeof localStorage === 'undefined') return;
      const obj: Record<string, VersionLoaderRecord> = {};
      for (const [k, v] of this.map) obj[k] = v;
      localStorage.setItem(KEY, JSON.stringify(obj));
    } catch {
      /* 配额满了也不影响功能（内存里还有） */
    }
  }
}

/** 目录用到的加载器结构（与 `bridge/tauri.ts` 的 `LoaderVersions` 对齐） */
interface LoaderLike {
  kind: string;
  versions: string[];
  error: string | null;
  /** 仅 OptiFine：每条的完整信息（preview / required_forge / filename） */
  optifine?: unknown[];
}

/** 全局单例：整个应用共用一份，避免每个组件各拉一遍 */
export const loaderCatalog = new LoaderCatalog();
