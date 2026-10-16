/**
 * 整合包"这一次缺了哪几个文件"的判定（与 Rust `src-tauri/src/domain/pack_plan.rs` **镜像**）
 * ------------------------------------------------------------------
 * ★★ 由来（2026-10-16 真机事故）：整合包 `Better MC [FABRIC] - BMC2` 装完之后
 *   进游戏弹出包**自带的**「Missing Mods」窗口，点名 Balm / FallingTree /
 *   FTB Teams / Fabrication / Paintings ++ —— 而启动器这边报了「安装完成」。
 *
 *   盘上：`mods/` 里有 333 个 jar，这 5 个确实不在；实例目录 `.ieml/` 里
 *   **什么都没有**，所以事后连"本来该装什么"都查不出来。
 *
 *   根因是 CurseForge 整合包的**解析地址**那一段：每个文件要先问一次接口，
 *   查不到的条目从计划里彻底消失（只剩一个计数），于是下载 333 个全成功、
 *   收尾校验说「都在」⇒ 界面说装完了。
 *
 * ## 这个文件负责什么
 *
 *   把"缺了哪些、哪些还能再试、哪些只能自己去网站下"这套**判定**做成纯函数：
 *   · 后端（Rust）在安装收尾时用同一套规则算出结论；
 *   · 界面用这里的函数决定**怎么说、给哪个按钮**。
 *
 *   ★ 两边**必须同一口径** —— 所以这里有 `node --test` 钉住边界，
 *     而 Rust 那侧的同名逻辑有自己的断言（`cargo test` / 独立 rustc 跑）。
 *
 * ## 判据只有一条：**没有下载地址 = 没弄到手**
 *
 *   为什么不按"盘上有没有这个文件"判：那是"检查完整性"的活（要读盘、算哈希）。
 *   这里判的是"我们当初有没有能力把它下下来" —— 下载**开始前**就该知道的事。
 */

/** 一条"该装、但没弄到手"的清单条目（与 Rust `MissingFile` 一一对应） */
export interface MissingFile {
  /** 相对游戏目录的路径（`mods/xxx.jar`） */
  path: string;
  /** 给用户看的名字（通常是 jar 文件名） */
  name: string;
  /** 为什么没弄到手 */
  reason: string;
  /** 还能再试吗（有 CurseForge 身份的能） */
  retryable: boolean;
}

/** 取一条条目的显示名：路径最后一段（反斜杠也认），空路径退回整条 */
export function missingLabel(path: string): string {
  const parts = String(path ?? '').split(/[/\\]/);
  const last = (parts[parts.length - 1] ?? '').trim();
  return last.length > 0 ? last : String(path ?? '').trim();
}

/**
 * 缺了哪些 —— **没有下载地址的就是缺的**。
 *
 * 输入是"这一次该装的全部条目"（后端 `pack-files.json` 的形状）。
 * ★ 空地址有三种来源，判定上不区分（都是"没弄到手"）：
 *   · CurseForge 接口查不到这个文件；
 *   · 作者禁止第三方分发（`downloadUrl` 是 null）；
 *   · 清单本身没给地址（`.mrpack` 的 `downloads` 是空数组）。
 */
export function planMissing(
  files: ReadonlyArray<{ path: string; url?: string; reason?: string; project_id?: number; file_id?: number }>,
): MissingFile[] {
  const out: MissingFile[] = [];
  for (const f of files ?? []) {
    if ((f.url ?? '').trim().length > 0) continue;
    const why = (f.reason ?? '').trim();
    out.push({
      path: f.path,
      name: missingLabel(f.path),
      reason:
        why.length > 0
          ? `没解析出下载地址（${why}）`
          : '没解析出下载地址（接口查不到这个文件，或作者不允许第三方下载）',
      retryable: (f.project_id ?? 0) !== 0 && (f.file_id ?? 0) !== 0,
    });
  }
  return out;
}

/**
 * 界面上那一句（后端 `missing_summary` 是同一套措辞的 Rust 版）。
 *
 * 最多点名 3 个 + "等 N 个"：用户要的是"缺的是哪些 mod"，不是一个数字。
 * ★ 空清单返回**空串** —— 界面据此决定"要不要显示这一条"，
 *   而不是显示一句"没有缺失"的空话。
 */
export function missingSummary(missing: ReadonlyArray<MissingFile>): string {
  const list = missing ?? [];
  if (list.length === 0) return '';
  const sample = list.slice(0, 3).map((m) => m.name);
  const more = list.length > sample.length ? ` 等 ${list.length} 个` : '';
  return `整合包有 ${list.length} 个文件没下下来：${sample.join('、')}${more}。可以点「重新下载缺失的」再试一次。`;
}

/**
 * 这一批缺失里**能自动再试的**与**只能人工下的**各几个。
 *
 * ★ 为什么必须分开说：把两者混成一句"点这里重试"会把用户引到一条
 *   **点了必然失败**的路上（作者禁止第三方下载的那些，我们再试一万次也下不到）。
 */
export function splitByRetryable(missing: ReadonlyArray<MissingFile>): {
  retryable: number;
  manual: number;
} {
  let retryable = 0;
  let manual = 0;
  for (const m of missing ?? []) {
    if (m.retryable) retryable += 1;
    else manual += 1;
  }
  return { retryable, manual };
}

/**
 * "重新下载缺失的"这个入口该不该给、该怎么说。
 *
 * 三种情况（第三种**没有**好的自动化出路，所以只给解释、不给按钮）：
 *   · 没有缺失            → 不给入口；
 *   · 有能重试的          → 给入口（`couldRetry`），文案说清还有几个要人工下；
 *   · 全都要人工下        → 不给入口（点了必然失败），只解释为什么。
 */
export function repairEntry(missing: ReadonlyArray<MissingFile>): {
  /** 要不要显示「重新下载缺失的」按钮 */
  show: boolean;
  /** 按钮上那句话 */
  label: string;
  /** 按下去之前/之后要说清的一句 */
  detail: string;
} {
  const list = missing ?? [];
  if (list.length === 0) {
    return { show: false, label: '', detail: '' };
  }
  const { retryable, manual } = splitByRetryable(list);
  if (retryable === 0) {
    return {
      show: false,
      label: '',
      detail: `这 ${manual} 个文件的作者不允许第三方下载，启动器再试也下不到 —— 请到整合包的下载页自己下好，放进 mods 文件夹。`,
    };
  }
  const tail =
    manual > 0 ? `（另有 ${manual} 个要你自己去整合包网站下）` : '';
  return {
    show: true,
    label: '重新下载缺失的',
    detail: `有 ${retryable} 个可以再试一次${tail}。`,
  };
}
