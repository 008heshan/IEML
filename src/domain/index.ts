/** 领域层统一出口 —— UI 只从这里导入，保证规则来源单一 */
export * from './types.ts';
export * from './version.ts';
export * from './loader-caps.ts';
export * from './combination.ts';
export * from './memory.ts';
export * from './java.ts';
/*
 * ★★ 2026-09-27：这里原来还有 `export * from './isolation.ts'` ——
 *   那是**前端自己算的一份隔离判定**，与后端那份措辞不同，而真正决定游戏目录的
 *   那一行（`prepare_spec`）两份都不看 —— 于是「不隔离」选了等于没选。
 *   规则现在只有一份：`src-tauri/src/domain/isolation.rs`（ADR-005 / ADR-006），
 *   界面显示的是后端算好的结论（`isolation_verdicts`）。
 */
export * from './mods.ts';
export * from './install-plan.ts';
export * from './crash.ts';
export * from './delete.ts';
export * from './server-address.ts';
/* ★ 2026-09-25：「当前文件夹里的版本」与「账本里的实例」怎么对上（PCL 的文件夹逻辑） */
export * from './folder-versions.ts';
