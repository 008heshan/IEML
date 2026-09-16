/**
 * 内存分配算法（ADR-029）
 * ------------------------------------------------------------------
 * 核心思想：**先按"游戏需要多少"定锚，再按"机器还剩多少"打折**。
 * 比"物理内存的一半"准得多，天然适配整合包（300 Mod 时 T1 就已经 4.8 GB）。
 *
 * 算法来自 PCL2 `PageInstanceSetup` 的源码研读（源码研读 13.3），
 * 但修掉了原稿实现里的一个 bug：原稿在"可用内存不足 T1"时仍给足 T1，
 * 导致分配值可能超过可用内存。这里改为**任何阶段都不得超发**。
 */

export type InstanceMemoryType = 'modded' | 'optifine' | 'vanilla';

export interface MemoryTargets {
  /** 最低可玩值 */
  min: number;
  /** 一/二/三阶段的上界 */
  t1: number;
  t2: number;
  t3: number;
}

/** 按 Mod 数量与实例类型算四个目标值（GB） */
export function memoryTargets(modCount: number, type: InstanceMemoryType): MemoryTargets {
  switch (type) {
    case 'modded':
      return {
        min: 0.5 + modCount / 150,
        t1: 1.5 + modCount / 90,
        t2: 2.7 + modCount / 50,
        t3: 4.5 + modCount / 25,
      };
    case 'optifine':
      return { min: 0.5, t1: 1.5, t2: 3, t3: 5 };
    case 'vanilla':
    default:
      return { min: 0.5, t1: 1.5, t2: 2.5, t3: 4 };
  }
}

export interface AutoMemoryResult {
  /** 建议分配的 GB —— **整数**（用户："给也是直接给整数内存"） */
  gb: number;
  /** 依据说明里要用的中间值 */
  detail: {
    modCount: number;
    availableGb: number;
    startGb: number;
    /** 递进目标 */
    escalateGb: number;
    /** 被可用内存封顶 */
    cappedByAvailable: boolean;
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * MB → **整数** GB（只用于显示）。
 *
 * ★ 用户原话（截图里那一行显示 `内存 3.599609375 GB`）：
 *   「内存取整数即可，给也是直接给整数内存」。
 *
 * 为什么必须有个专门的函数，而不是随手写 `Math.round(mb / 1024)`：
 *   ① 存储单位是 MB（`Instance.config.memoryMb`），引擎也算 MB —— 这里**不改语义**，
 *      只把"给人看的那一眼"收敛成整数；
 *   ② `3.599609375` 的直接来源就是 `3686 / 1024`：自动算法给出 3.6 GB 后按
 *      `Math.round(3.6 * 1024)` 存成 3686 MB，再除回来就不再是 3.6 了。
 *      1024 不是 10 的幂，**任何"非整 GB 的 MB 值"除回来都会带一长串小数**，
 *      所以显示层必须取整，否则换个数字还会再犯。
 */
export function wholeGbFromMb(memoryMb: number): number {
  return Math.round(memoryMb / 1024);
}

/**
 * GB → **整数** GB：用户可设置的值（滑块 / 档位）也一律是整数。
 * 同样是用户那句「给也是直接给整数内存」的落点。
 *
 * ★ 这里用 `Math.floor` 而不是 `Math.round`：`autoMemory` 的结果带有
 *   "**绝不超发**"这条硬约束（见下方四阶段说明与它的回归测试），
 *   四舍五入会把 3.6 变成 4，凭空多要 0.4 GB —— 向下取整才守得住这条约束。
 */
export function wholeGb(gb: number): number {
  return Math.floor(gb);
}

/**
 * 四阶段递减比例分配。
 * 阶段一 0→T1 取 100%；阶段二 T1→T2 取 70%；阶段三 T2→T3 取 40%；阶段四 T3→2·T3 取 15%。
 * 任一阶段后可用 < 0.1 GB 就停；最后 max(值, 最低值)。
 *
 * ★ 修正：每个阶段实际给出的量是 `min(本阶段可用额度, 阶段跨度)`，
 *   且**绝不超过剩余可用内存**。
 */
export function autoMemory(
  modCount: number,
  type: InstanceMemoryType,
  totalGb: number,
  availableGb: number,
): AutoMemoryResult {
  const T = memoryTargets(modCount, type);
  let avail = Math.max(availableGb, 0);
  let give = 0;

  // 阶段一：0 → T1，全给
  const s1 = Math.min(avail, T.t1);
  give += s1;
  avail -= s1;
  const capped = s1 < T.t1 - 1e-9;

  if (!capped && avail >= 0.1) {
    // 阶段二：T1 → T2，按 70% 折算
    const s2 = Math.min(avail * 0.7, T.t2 - T.t1);
    give += s2;
    avail -= s2;
  }
  const reachedT2 = give >= T.t2 - 1e-9;
  if (reachedT2 && avail >= 0.1) {
    // 阶段三：T2 → T3，按 40% 折算
    const s3 = Math.min(avail * 0.4, T.t3 - T.t2);
    give += s3;
    avail -= s3;
  }
  const reachedT3 = give >= T.t3 - 1e-9;
  if (reachedT3 && avail >= 0.1) {
    // 阶段四：T3 → 2·T3，按 15% 折算
    const s4 = Math.min(avail * 0.15, T.t3);
    give += s4;
    avail -= s4;
  }

  /*
   * ★ 2026-09-16 用户（截图 `内存 3.599609375 GB`）：
   *   「内存取整数即可，给也是直接给整数内存」。
   *
   *   这里在**算法出口**就取整，而不是只让界面显示整数 —— 两处都要，缺一不可：
   *     · 只改显示：`3.6` 存成 3686 MB、界面写 4 GB，说的和存的不是一回事，
   *       下次再有人从 MB 反推显示，长小数又回来了；
   *     · 只改这里：老实例库里已经有 3686 MB 这类值，界面照样漏出长小数。
   *   所以出口取整（保证新值）＋显示取整（兜住老值，见 `wholeGbFromMb`）。
   *
   *   用 `wholeGb`（向下取整）不是 `Math.round`：上面的四阶段分配有一条
   *   "任何阶段都不得超发"的硬约束（`autoMemory(24,'modded',8,1.5)` 不许超过 1.5），
   *   而 `Math.round(1.5) = 2` 正好会把它破掉。
   *   算法本身一个数都没动，取整只作用在它已经算完的输出上。
   */
  const gb = wholeGb(Math.min(Math.max(give, T.min), Math.max(totalGb, 0.5)));

  return {
    gb,
    detail: {
      modCount,
      availableGb: round1(availableGb),
      startGb: round1(1.5 + modCount / 90),
      escalateGb: round1(2.7 + modCount / 50),
      cappedByAvailable: capped || give < T.t2 - 1e-9,
    },
  };
}

/**
 * 生成"依据"文案。
 * ★ 这里刻意用真实计算出的数值，不写死 —— 原设计稿写死了"向 2.7 GB 递进"，
 *   而实际算出的是 3.24，说明文字与结果对不上。
 */
export function memoryReasoning(modCount: number, r: AutoMemoryResult): string {
  const { startGb, escalateGb, availableGb, cappedByAvailable } = r.detail;
  if (cappedByAvailable) {
    return `检测到 ${modCount} 个 Mod，按「1.5 + ${modCount}/90 ≈ ${startGb} GB」起步；` +
      `受当前可用内存 ${availableGb} GB 限制，分配 ${r.gb} GB。`;
  }
  return `检测到 ${modCount} 个 Mod，按「1.5 + ${modCount}/90 ≈ ${startGb} GB」起步，` +
    `可用内存充裕时向 ${escalateGb} GB 递进；本次分配 ${r.gb} GB（可用 ${availableGb} GB）。`;
}

/* ====================== 滑块档位映射 ====================== */

/**
 * 档位 → GB 的分段映射（与原版一致，已数值验证）
 *   0..12  → 0.1v + 0.3      (0.3 ~ 1.5)
 *   13..25 → 0.5(v-12) + 1.5 (2.0 ~ 8.0)
 *   26..33 → (v-25) + 8      (9 ~ 16)
 *   34..   → 2(v-33) + 16    (18+)
 */
export function gearToGb(v: number): number {
  if (v <= 12) return round1(v * 0.1 + 0.3);
  if (v <= 25) return round1((v - 12) * 0.5 + 1.5);
  if (v <= 33) return round1(v - 25 + 8);
  return round1((v - 33) * 2 + 16);
}

/** 档位上限随物理内存动态变化（避免滑到超过本机内存的值） */
export function maxGear(totalGb: number): number {
  if (totalGb <= 1.5) return Math.max(Math.floor((totalGb - 0.3) / 0.1), 1);
  if (totalGb <= 8) return Math.floor((totalGb - 1.5) / 0.5) + 12;
  if (totalGb <= 16) return Math.floor((totalGb - 8) / 1) + 25;
  return Math.floor((totalGb - 16) / 2) + 33;
}

/**
 * GB → 最接近的档位（滑块定位用）
 * ★ 修掉了原稿的"档位与显示值不一致"：原稿先把滑块设到某档，再显示自动值，
 *   于是手柄位置（1.7 GB）和数字（2.5 GB）对不上。这里取**最接近**的档位，
 *   并把该档对应的 GB 作为唯一真值返回，保证手柄与数字永远一致。
 */
export function gbToGear(gb: number, totalGb: number): number {
  const max = maxGear(totalGb);
  let best = 0;
  let bestDiff = Infinity;
  for (let v = 0; v <= max; v++) {
    const diff = Math.abs(gearToGb(v) - gb);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = v;
    }
  }
  return best;
}

/**
 * 把任意内存值吸附到滑块能表达的最近档位，返回吸附后的值。
 * UI 应使用这个函数，而不是直接用自动算法的原始值。
 */
export function snapToGear(gb: number, totalGb: number): number {
  return gearToGb(gbToGear(gb, totalGb));
}

/** 内存占用三分段的展示数据 */
export interface MemoryBar {
  usedGb: number;
  gameGb: number;
  freeGb: number;
  totalGb: number;
  /** 请求值是否超过可用内存 */
  overAvailable: boolean;
}

export function memoryBar(
  requestedGb: number,
  totalGb: number,
  availableGb: number,
): MemoryBar {
  const used = Math.max(totalGb - availableGb, 0);
  const game = Math.min(requestedGb, availableGb);
  const free = Math.max(totalGb - used - game, 0);
  return {
    usedGb: round1(used),
    gameGb: round1(game),
    freeGb: round1(free),
    totalGb: round1(totalGb),
    overAvailable: requestedGb > availableGb + 1e-9,
  };
}
