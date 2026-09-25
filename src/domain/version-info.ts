/**
 * 版本号（前端显示用）
 * ------------------------------------------------------------------
 * ★★ **这个文件由 `tools/set-version.mjs` 自动写入，不要手改。**
 *
 *   为什么前端要有一份自己的：Rust 侧的 `app_info` 命令读的是
 *   `env!("CARGO_PKG_VERSION")`，那是**编译期**展开的 ——
 *   浏览器开发模式（`pnpm dev`）没有 Rust 进程，拿不到它。
 *   所以浏览器里显示的版本号必须来自前端自己。
 *
 *   两份值的一致性由 `tools/set-version.mjs --check` 保证
 *   （`pnpm verify` 会跑它）。
 *
 * 规则见 `docs/VERSIONING.md`。
 */

/** 当前版本号。形状：`<主>.<次>.<修订>[-<阶段>.<序号>]` */
export const APP_VERSION = '0.1.0-rc.10';

/**
 * 版本号里的阶段（没有后缀 = 正式版）。
 * 界面用它决定要不要显示"开发中"这类角标。
 */
export function versionStage(v: string = APP_VERSION): 'dev' | 'alpha' | 'beta' | 'rc' | 'stable' {
  const m = v.match(/-(dev|alpha|beta|rc)\./);
  if (m) return m[1] as 'dev' | 'alpha' | 'beta' | 'rc';
  return 'stable';
}

/** 阶段的中文名（界面文案只在这里写一次） */
export const STAGE_LABEL: Record<ReturnType<typeof versionStage>, string> = {
  dev: '内部开发版',
  alpha: '小范围测试版',
  beta: '公开测试版',
  rc: '发布候选版',
  stable: '正式版',
};
