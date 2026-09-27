//! 领域层入口
//!
//! 与前端 `src/domain/` 一一对应。规则只在这两处之一实现、另一处镜像，
//! 并有测试守住（`tests/domain.test.js` 与 `cargo test`）。

pub mod bridge_range;
pub mod combination;
pub mod crash;
/// ★ 拖进来的文件**是什么**（按内容判，ADR-015 的判定顺序）—— 纯判定，不碰盘、不知道实例在哪
pub mod dropped;
pub mod java;
/// ★★ 版本隔离（ADR-005 三段判定）—— **规则只在这一份**，平台层与界面都读它的结论
pub mod isolation;
pub mod loader_caps;
pub mod loader_trace;
pub mod memory;
pub mod mods;
pub mod resources;
pub mod types;
pub mod validate;
pub mod version;
