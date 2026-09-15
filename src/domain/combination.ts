/**
 * 组合校验 —— 本项目最核心的一段规则（ADR-003 / ADR-004 / ADR-006）
 * ------------------------------------------------------------------
 * 架构铁律：**校验只实现一次**。前端 UI 的置灰、桥接提示、API 补全
 * 全部是本文件结论的**呈现**，前端不得自己维护一份规则（否则两侧必然漂移）。
 *
 * 因此本文件将来会一比一移植到 Rust 侧（`src-tauri/src/domain/combination.rs`），
 * 这里的每条规则都要能直接翻译，不依赖任何浏览器 API。
 */
import {
  ADDON_NAME,
  BASE_LOADER_NAME,
  COMPONENT_BYTES,
  OPTIFINE_FORGE_REQ,
  apiForBase,
  bridgeFor,
  getLoaderCapabilities,
  type OnlineLoaderVersions,
} from './loader-caps.ts';
import { bridgeDisplayName, bridgeUrl } from './bridge-range.ts';
import type {
  AddonKind,
  BaseLoaderKind,
  CombinationVerdict,
  LoaderSelection,
} from './types.ts';
import { compareVersion, forgeVersionSatisfies } from './version.ts';

/* ====================== 单点规则 ====================== */

/**
 * OptiFine 是否适配给定的 Forge 版本（五级判定，源码研读 13.2）
 * ① Inherit 段必须与 MC 版本一致
 * ② req 为 null → 该版本 OptiFine 不支持 Forge
 * ③ req 为空白串 → 无限制
 * ④ req 含 '.' → 精确比较
 * ⑤ 否则只比 revision
 */
export function optifineSuitsForge(
  mcVersion: string,
  forgeVersion: string,
): { ok: boolean; reason?: string } {
  const meta = OPTIFINE_FORGE_REQ[mcVersion];
  // 没有数据时不阻断，交给运行时判定（诚实原则：不掌握的信息不下结论）
  if (!meta) return { ok: true };

  if (meta.inherit !== mcVersion) {
    return {
      ok: false,
      reason: `该 OptiFine 版本适用于 ${meta.inherit}，与当前 ${mcVersion} 不一致`,
    };
  }
  if (meta.req === null) {
    return { ok: false, reason: `OptiFine 未针对 ${mcVersion} 的 Forge 提供兼容补丁` };
  }
  if (!forgeVersion) return { ok: true };
  if (!forgeVersionSatisfies(meta.req, forgeVersion)) {
    return {
      ok: false,
      reason: `该 OptiFine 版本要求 Forge ${meta.req}，当前选择的是 ${forgeVersion}`,
    };
  }
  return { ok: true };
}

/**
 * 单个附加组件与基础加载器的兼容性。
 * ★ base 必须可空 —— 纯原版下 OptiFine 是**合法且主流**的用法（ADR-003 的核心更正）。
 */
export function addonCompatibility(
  mcVersion: string,
  base: BaseLoaderKind | null,
  addon: AddonKind,
  opts: { baseVersion?: string; addonVersion?: string } = {},
  online?: OnlineLoaderVersions,
): { ok: boolean; reason?: string; note?: string; bridge?: ReturnType<typeof bridgeFor> } {
  const caps = getLoaderCapabilities(mcVersion, online);
  const addonOpt = caps.addons.find((a) => a.kind === addon);
  if (!addonOpt) return { ok: false, reason: `${ADDON_NAME[addon]} 不是可识别的组件` };
  /*
   * ★★ 这里必须**先判真实的组合不兼容，再判"我们有没有实现"**。
   *
   *   顺序反过来的话，一条精确的理由会被一条笼统的理由盖掉：
   *   `1.20.4 + NeoForge + OptiFine` 的正确结论是
   *   「NeoForge 与 OptiFine 不兼容」，而先判 implemented 会变成
   *   「我们还没做 OptiFine 的安装」—— 后者**换个加载器就能装**，
   *   前者**怎么都装不了**。用户按错误的那条去换加载器，只会白忙一场。
   *
   *   （2026-09-14：OptiFine 的 `implemented` 从 true 改成 false 之后，
   *    上面这个顺序问题立刻被 `tests/domain.test.js` 抓到。）
   */
  const notImplemented = (): { ok: false; reason: string } => ({
    ok: false,
    reason:
      addonOpt.unavailableReason ??
      `${ADDON_NAME[addon]} 在这个版本上存在，但 IEML 还没做它的安装`,
  });

  if (addon === 'optifine') {
    /*
     * --- 纯原版：合法，走 OptiFine 自带的 Patcher 对原版 jar 打补丁 ---
     *
     * ★★ dev.4：OptiFine 的安装**已经实装**（`net::optifine`，
     *    照 PCL 的 `McDownloadOptiFineInstall` 写的，有真机测试证明装完能进游戏），
     *    所以这里不再需要 `notImplemented()` 那道闸门 —— 直接放行。
     *
     *    历史（留着是为了不再犯）：曾经这里 `return { ok: true }` 并附一句
     *    "将对原版 jar 打补丁安装"，而**没有任何代码**去做这件事 ——
     *    用户勾上、点安装、看到成功，磁盘上什么都没变。
     */
    if (base === null) {
      return {
        ok: true,
        /*
         * ★ 用户 2026-09-15："关于安装高清修复的提示，也不需要"。
         *
         *   原来这里挂着一句 note：
         *     「将用 OptiFine 自带的 Patcher 在原版 jar 上打补丁
         *       （会在临时目录里跑，不会动你的原版）」
         *   它出现在「安装前请确认」那张黄条里。
         *
         *   为什么删：那是**实现细节**，不是用户需要"确认"的事 ——
         *   用户要的是"勾上 → 装 → 能玩"。而"会在临时目录里跑、不动原版"
         *   是我们自己该保证的事，写在确认框里反而像是在让他承担风险。
         *   真出问题时该解释的地方是**日志与崩溃报告**，不是安装前的黄条。
         */
        bridge: { usable: 'no-bridge' },
      };
    }

    /* --- Fabric / Quilt --- */
    if (base === 'fabric' || base === 'quilt') {
      /*
       * ★★ **Quilt 上根本不支持 OptiFine —— 直接不让选**（用户 2026-09-15：
       *   "Quilt 完全不兼容，所以选了这个也得不让选高清修复"）。
       *
       *   与 Fabric 不同：Fabric 在 1.20.4 及以前有 OptiFabric 桥接包
       *   （只是要用户自己下），而 **Quilt 没有对应的桥接包** ——
       *   上游从来没有过，不是"我们没做"。所以这里不查区间、不给"最新版"，
       *   直接返回不兼容：选 Quilt 时 OptiFine 那个选项会被禁用。
       */
      if (base === 'quilt') {
        return {
          ok: false,
          reason:
            'Quilt 与高清修复（OptiFine）不兼容：Quilt 没有可用的桥接包' +
            '（Fabric 那边有 OptiFabric，Quilt 没有对应的东西）。' +
            '想要高清修复请改用 Forge（官方支持），' +
            '或留在 Fabric 上用 Iris + Sodium。',
        };
      }
      /*
       * ★★ 这里**只有一条**规则：`bridgeFor`。
       *
       *   以前还有第二条 —— 开头写着
       *   `if (compareVersion(mcVersion, '1.20.4') > 0) return 不兼容`
       *   —— 而 `bridgeFor` 内部也判同一个上界。
       *   两条规则判同一件事的后果实测过：1.20.5 走的是**先返回**的那条，
       *   理由变成"渲染管线挂不上"，把"缺桥接包 OptiFabric"这条
       *   更有用的信息盖掉了（而且两条文案还有漂移的风险，
       *   `forgespi` 就是这么坏的）。
       *
       *   现在上界只有一份（`bridge-range.ts` 的 RANGE_HIGH = 1.20.4），
       *   由 `bridgeFor` 翻译成给用户看的话 —— 不管越界的是 1.13 还是 1.20.5。
       */
      const bridge = bridgeFor(mcVersion, base, 'optifine');
      /*
       * ★★ 桥接包的处置（dev.11 更正，dev.10 判错了这一整段）。
       *
       *   dev.10 我断言「1.16 ~ 1.20.4 没有任何桥接包」并把整段判成不兼容，
       *   **依据是 Modrinth 上 `optifabric` 返回 404**。那是错的：
       *   OptiFabric 一直在 **CurseForge 项目 322385** 发布
       *   （75 个文件 / 1005 万次下载），MC百科 class/1703 的支持表列到 1.20.4。
       *   它只是**没上 Modrinth** —— 我把"某个平台上没有"当成了"不存在"。
       *
       *   现在：
       *     · `unavailable` → 上游**真的**没有（1.20.5+、1.13-）→ 判不兼容；
       *     · `yes` + `manual` → 上游有，但**必须用户自己下**（因为
       *       `bridgeFile()` 只存在于浏览器演示模式，生产路径根本没有它）→
       *       放行，并把下载地址和该版本的坑一起告诉用户。
       *
       *   ★ 再也不要返回 `manual: false`：那会让界面写「会自动装」，
       *     而一行代码都不会去下它（`manual` 的依据见 `bridge-range.ts`）。
       */
      if (bridge.usable === 'unavailable') {
        return { ok: false, reason: bridge.reason };
      }
      if (bridge.usable === 'no-bridge') {
        // Fabric 上 OptiFine 一定需要桥接 —— 走到这里说明表写错了，如实报
        return {
          ok: false,
          reason: `Fabric ${mcVersion} 上装高清修复需要桥接包，而上游没有可用的桥接包`,
        };
      }
      {
        const name = bridgeDisplayName(bridge.kind);
        const url = bridgeUrl(bridge.kind);
        const extra = bridge.notes.length > 0 ? `\n· ${bridge.notes.join('\n· ')}` : '';
        return {
          ok: true,
          note:
            `需要桥接包 ${name} —— **要你自己下载**后放进 mods/ 目录：${url}` +
            `\n（桥接包必须在高清修复之后放进 mods；两样缺一个游戏都会崩）` +
            extra,
          bridge,
        };
      }
    }

    /* --- NeoForge：无条件不兼容 --- */
    if (base === 'neoforge') {
      return {
        ok: false,
        reason: 'NeoForge 与 OptiFine 不兼容 —— NeoForge 改写了渲染管线，OptiFine 的补丁没有挂载点',
      };
    }

    /* --- Forge：1.13 ~ 1.14.3 整段不兼容，其余走五级判定 --- */
    if (base === 'forge') {
      if (compareVersion(mcVersion, '1.13') >= 0 && compareVersion('1.14.3', mcVersion) >= 0) {
        return {
          ok: false,
          reason: `Forge ${mcVersion} 与 OptiFine 不兼容 —— 该版本段 Forge 尚未接入 OptiFine 的补丁机制`,
        };
      }
      const judged = optifineSuitsForge(mcVersion, opts.baseVersion ?? '');
      if (!judged.ok) return { ok: false, reason: judged.reason };
      return { ok: true, bridge: { usable: 'no-bridge' } };
    }
  }

  if (addon === 'liteloader') {
    /*
     * LiteLoader **必须**有 Forge 作基座，且仅限 1.7.10 ~ 1.12.2。
     *
     * ★ dev.4 第二轮的边界说明：
     *   我们的 `net::liteloader` 装出来的版本描述里
     *   `mainClass = net.minecraft.launchwrapper.Launch`，
     *   而**纯原版没有 launchwrapper** —— 所以即使技术上能拼出来，
     *   直接挂在原版上也不成立。这一条**不是"我们没做"**，
     *   而是真的兼容性约束（PCL 的 `LoadLiteLoaderGetError` 也是这么判的）。
     */
    if (base === null) {
      return { ok: false, reason: 'LiteLoader 需要 Forge 作为基座，无法独立安装在原版上' };
    }
    if (base !== 'forge') {
      return {
        ok: false,
        reason: `LiteLoader 需搭配 Forge 使用，不能装在 ${BASE_LOADER_NAME[base]} 上`,
      };
    }
    const inRange =
      compareVersion(mcVersion, '1.7.10') >= 0 && compareVersion('1.12.2', mcVersion) >= 0;
    if (!inRange) {
      return {
        ok: false,
        reason: `LiteLoader 已停止维护，仅支持 1.7.10 ~ 1.12.2，不含 ${mcVersion}`,
      };
    }
    /*
     * ★ 组合合法 —— 而且安装**已经实装**（`net::liteloader`，有真机测试
     *   证明装完能进游戏），所以直接放行。
     *   （以前这里是 `return notImplemented()` —— 当时是诚实的，
     *    现在实现有了，那道闸门就该撤掉。）
     */
    return { ok: true, bridge: { usable: 'no-bridge' } };
  }

  /*
   * ★★ 走到这里 = **组合本身没问题**，剩下的唯一障碍是"上游有、我们还没做"。
   *
   *   为什么这句必须在**最后**（而不是像原来那样放在开头）：
   *     · 放开头会把精确理由盖掉 —— `1.20.4 + NeoForge + OptiFine` 会从
   *       "NeoForge 不兼容"变成"我们没做 OptiFine"，用户于是去换加载器白忙；
   *     · 而且 LiteLoader 分支原来是 `return { ok: true }`，
   *       等于**绕过**了这句检查 —— 那条断言"没实现的组件不能被判成可以装"
   *       的测试立刻变红（2026-09-14 就是这么抓到的）。
   */
  if (!addonOpt.available) {
    return notImplemented();
  }
  return { ok: true, bridge: { usable: 'no-bridge' } };
}

/* ====================== 组合校验（对外主入口） ====================== */

/**
 * 校验一整套组合，返回 UI 需要的全部信息。
 * 结构固定为 valid / removed / autoBridges / autoApis / warnings / errors。
 */
export function validateCombination(
  sel: LoaderSelection,
  online?: OnlineLoaderVersions,
): CombinationVerdict {
  const caps = getLoaderCapabilities(sel.mcVersion, online);
  const errors: string[] = [];
  const warnings: string[] = [];
  const removed: CombinationVerdict['removed'] = [];
  const autoBridges: CombinationVerdict['autoBridges'] = [];

  /* --- 基础加载器本身是否可用 --- */
  if (sel.base !== null) {
    const opt = caps.baseLoaders.find((b) => b.kind === sel.base);
    if (!opt) {
      errors.push(`${BASE_LOADER_NAME[sel.base]} 不是可识别的加载器`);
    } else if (!opt.available) {
      /*
       * ★ 措辞必须跟着"确不确认"走（ADR-037，用户报的「什么叫 Forge 没发布
       *   26.2 版本，PCL 是有的」就是这里说错话）：
       *     · 确认没有 → 可以说"未发布 / 不支持"
       *     · 没查到   → 只能说"没查到，换个网络或重试"，绝不替加载器下结论
       */
      const name = BASE_LOADER_NAME[sel.base];
      errors.push(
        opt.confirmed === false
          ? `${name} 的版本清单这次没查到，**无法确认**它有没有 ${sel.mcVersion} 的版本 —— ` +
              `请重新查询在线清单后再试（这不是"没有发布"）`
          : (opt.unavailableReason ?? `${name} 不适用于 ${sel.mcVersion}`),
      );
    }
  }

  /* --- 逐个校验附加组件，不兼容的直接移出并记录原因 --- */
  const surviving: AddonKind[] = [];
  for (const addon of sel.addons) {
    const judged = addonCompatibility(
      sel.mcVersion,
      sel.base,
      addon,
      {
        baseVersion: sel.baseVersion,
        addonVersion: sel.addonVersions?.[addon],
      },
      online,
    );
    if (!judged.ok) {
      /*
       * ★★ **勾了就必须装上** —— 装不上是阻断性错误，不是"顺手帮你去掉"。
       *
       *   改之前这里只 push 到 `removed`，然后**继续往下走**：
       *   用户勾了高清修复、点安装、装完了 —— 而高清修复根本不在里面。
       *   界面列一句原因，看起来像"已经帮你处理好了"。
       *
       *   用户的预期是"我要它；它现在装不了；我得知道，而且该由我决定
       *   要不要去掉它"。所以这里同时进 `errors`（→ `valid = false`，
       *   安装按钮会被拦住），理由里带上**怎么改**。
       */
      const why = judged.reason ?? '不兼容';
      removed.push({ kind: addon, reason: why });
      errors.push(
        `${ADDON_NAME[addon]} 装不了：${why}\n` +
          `（取消勾选「${ADDON_NAME[addon]}」就能按现在的组合安装）`,
      );
      continue;
    }
    surviving.push(addon);
    /*
     * ★ 只有**我们能自动装**的桥接包才进 `autoBridges`。
     *
     *   `autoBridges` 的语义是"安装流程会自动补装这些东西"，
     *   而 1.14 ~ 1.20.4 的 OptiFabric **必须用户自己下**
     *   （`manual: true`，依据见 `bridge-range.ts`）。
     *   把它塞进来等于又写一次"会自动装"的假承诺 —— 界面上
     *   `InstallComposer` 会把 autoBridges 渲染成"将自动安装"。
     *
     *   手动的那种走 `judged.note`（下面 warnings.push），
     *   里面带着下载地址和注意事项。
     */
    if (judged.bridge && judged.bridge.usable === 'yes' && !judged.bridge.manual) {
      autoBridges.push({
        kind: judged.bridge.kind,
        name: bridgeDisplayName(judged.bridge.kind),
        // ★ 顺序铁律：桥接包必须在 OptiFine **之后**安装
        after: addon,
      });
    }
    if (judged.note) warnings.push(judged.note);
  }

  /* --- 自动补齐的 API 前置包 --- */
  const autoApis = apiForBase(sel.base, sel.mcVersion);

  /* --- 自动补齐必须明示（用户打开 mods 目录看到凭空多个包会困惑，ADR-004） --- */
  for (const lib of autoApis) {
    warnings.push(`将自动安装 ${lib.name} ${lib.version}（${lib.description}）`);
  }

  /* --- 版本号一致性提醒 --- */
  if (sel.base !== null && sel.baseVersion) {
    const opt = caps.baseLoaders.find((b) => b.kind === sel.base);
    if (opt?.available && opt.versions.length > 0 && !opt.versions.includes(sel.baseVersion)) {
      warnings.push(
        `所选的 ${BASE_LOADER_NAME[sel.base]} ${sel.baseVersion} 不在该版本的推荐列表中，仍可安装但可能不被 Mod 支持`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    removed,
    autoBridges,
    autoApis,
    warnings,
    errors,
  };
}

/* ====================== 安装顺序 ====================== */

/**
 * 安装顺序铁律（ARCHITECTURE 第 6 章）：
 *   原版 → 基础加载器 → 附加组件 → 桥接包 → API 包 → Java → 实例描述
 * 返回的是一个**扁平的顺序数组**，InstallPlan 的 steps 必须严格按它生成。
 */
export function installOrder(sel: LoaderSelection): string[] {
  const verdict = validateCombination(sel);
  const order: string[] = ['vanilla'];
  if (sel.base !== null && verdict.valid) order.push(sel.base);
  for (const a of sel.addons) {
    if (!verdict.removed.some((r) => r.kind === a)) order.push(a);
  }
  // 桥接包严格排在它依赖的附加组件之后
  for (const _b of verdict.autoBridges) {
    order.push(_b.kind);
  }
  if (verdict.autoApis.length > 0) order.push('api');
  order.push('manifest');
  return order;
}

/** 组合的落盘体积估算（不含原版），用于"将下载"摘要 */
export function componentBytes(sel: LoaderSelection): number {
  const verdict = validateCombination(sel);
  let bytes = 0;
  if (sel.base !== null && verdict.valid) bytes += COMPONENT_BYTES[sel.base] ?? 0;
  for (const a of sel.addons) {
    if (!verdict.removed.some((r) => r.kind === a)) bytes += COMPONENT_BYTES[a] ?? 0;
  }
  /*
   * ★ 桥接包体积**不计入**：`autoBridges` 里已经只剩能自动装的，
   *   而手动的那种（1.14 ~ 1.20.4 的 OptiFabric）是我们不下、用户自己下的，
   *   算进"将下载"就是虚报。
   */
  for (const _b of verdict.autoBridges) bytes += COMPONENT_BYTES.optifabric ?? 0;
  for (const lib of verdict.autoApis) bytes += lib.bytes;
  return bytes;
}
