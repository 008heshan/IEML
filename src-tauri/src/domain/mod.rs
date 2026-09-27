//! 领域层入口
//!
//! 与前端 `src/domain/` 一一对应。规则只在这两处之一实现、另一处镜像，
//! 并有测试守住（`tests/domain.test.js` 与 `cargo test`）。

/// ★ 中文搜 Mod 的别名表（ADR-016）—— 静态词表 + 纯查表，不碰网络
pub mod alias;
pub mod bridge_range;
pub mod combination;
pub mod crash;
/// ★ 拖进来的文件**是什么**（按内容判，ADR-015 的判定顺序）—— 纯判定，不碰盘、不知道实例在哪
pub mod dropped;
/// ★ 别人的目录是**谁的**（官方 / PCL / HMCL / Prism…）—— 只认形状，不碰盘（导入见命令层）
pub mod external;
pub mod java;
/// ★★ 版本隔离（ADR-005 三段判定）—— **规则只在这一份**，平台层与界面都读它的结论
pub mod isolation;
pub mod loader_caps;
pub mod loader_trace;
pub mod memory;
/// ★ 导出整合包时**哪些文件绝不能带上**（ADR-024：两张黑名单 + 登录凭据红线）
pub mod modpack_export;
pub mod mods;
pub mod resources;
pub mod types;
pub mod validate;
pub mod version;
