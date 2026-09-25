/** 领域层统一出口 —— UI 只从这里导入，保证规则来源单一 */
export * from './types.ts';
export * from './version.ts';
export * from './loader-caps.ts';
export * from './combination.ts';
export * from './memory.ts';
export * from './java.ts';
export * from './isolation.ts';
export * from './mods.ts';
export * from './install-plan.ts';
export * from './crash.ts';
export * from './delete.ts';
export * from './server-address.ts';
/* ★ 2026-09-25：「当前文件夹里的版本」与「账本里的实例」怎么对上（PCL 的文件夹逻辑） */
export * from './folder-versions.ts';
