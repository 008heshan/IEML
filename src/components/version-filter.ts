/**
 * 资源版本列表：**按当前实例筛掉不兼容的版本**（纯函数，好测）。
 * ------------------------------------------------------------------
 * ★★★★ 2026-10-08（用户：「**少世代分组的大版本**」）。
 *
 * ## 为什么要有这个函数（这条判据很容易被"顺手统一"掉）
 *
 *   整合包与其余资源**不能用同一条规则**：
 *
 *   | 种类 | 按当前实例的 MC 版本筛？ | 为什么 |
 *   |---|---|---|
 *   | 整合包 | **不筛** | 它的"版本"本来就是**跨世代的一条谱系**（同一个包在 1.16 / 1.18 / 1.20 / 1.21 上各有一串）；按当前实例一筛，整个谱系只剩一组 —— 用户看到的就是「37 个版本」却只有一个分组。而且装上 1.21 那版等于**建一个新实例**，不是升级当前这个 |
 *   | 其余 | **筛** | 用户就是要把东西装进这个实例里；不兼容的版本列出来只会让人点错（也是 2026-09-30 那条性能优化的同一个理由） |
 *
 *   ★ 真正的教训：这条判据原来**藏在接口请求参数里**（`...{ mcVersion }`），
 *     于是"整合包为什么不筛"这件事在代码里根本看不出来，
 *     下一个人只会觉得那个 spread 多余而删掉它。
 *     提取成具名函数 + 测试，才能让意图活下来。
 *
 * ## 行为
 *
 *   · 没有目标实例 ⇒ 原样返回（那时"有哪些版本"本身就是要给用户看的信息）；
 *   · 整合包 ⇒ 原样返回；
 *   · 其余 ⇒ 留下 `game_versions` 含目标 MC 版本的；
 *   · **筛完一个不剩 ⇒ 退回全量**（见下）。
 */

/** 这个函数需要知道的那点形状（不依赖完整类型，方便测） */
export interface FilterableVersion {
  game_versions?: string[];
}

export function filterVersionsForInstance<T extends FilterableVersion>(
  versions: T[],
  opts: {
    /** 这个资源自己的种类（`hit.project_type`） */
    projectType?: string | null;
    /** 装到哪个实例；`null`/`undefined` = 没选实例 */
    target?: { mcVersion: string } | null;
  },
): T[] {
  const kept = strictlyCompatibleVersions(versions, opts);

  /*
   * ★ **筛完一个都不剩 ⇒ 退回全量**，而不是显示"无"。
   *
   *   真机会遇到：实例是 `1.20.1`，而这个项目只标了 `1.20`
   *   （前缀不同、实际能跑）。显示"无"会让用户以为"这个装不了"，
   *   而它其实能装。
   *   ⇒ 宁可多列几条让他自己判断，也不要凭空说没有。
   *     （这与这个仓库一贯的"读不到 ≠ 没有"是同一条规矩。）
   */
  return kept.length > 0 ? kept : versions;
}

/**
 * **严格**筛：只留下当前实例真的能装的（**不做**"筛完不剩就退回全量"那一步）。
 *
 * ★★ 2026-10-17：取版本那条路要用它 —— "这一份到底有没有能装到当前实例的版本"
 *   决定**要不要回退去问另一个来源**（`domain/version-sources.ts`）。
 *   它与 `filterVersionsForInstance` **共用同一段筛选实现**，
 *   只差最后那一步"退回全量"：判据仍然只有一份，不会出现两套筛选规则。
 */
export function strictlyCompatibleVersions<T extends FilterableVersion>(
  versions: T[],
  opts: {
    projectType?: string | null;
    target?: { mcVersion: string } | null;
  },
): T[] {
  if (!opts.target?.mcVersion) return versions;
  // 整合包是跨世代谱系 —— 不筛（见文件头那张表）
  if (opts.projectType === 'modpack') return versions;

  const want = opts.target.mcVersion;
  return versions.filter((v) => (v.game_versions ?? []).includes(want));
}

/**
 * 这一批里**有没有能装到当前实例的**（取版本时"这一份算不算数"的判据）。
 *
 * ★ 非空是必要条件：一批里一个都没有时谈不上"有兼容版本"。
 */
export function hasCompatibleVersion<T extends FilterableVersion>(
  versions: T[],
  opts: {
    projectType?: string | null;
    target?: { mcVersion: string } | null;
  },
): boolean {
  return versions.length > 0 && strictlyCompatibleVersions(versions, opts).length > 0;
}
