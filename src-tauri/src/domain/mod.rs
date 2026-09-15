//! 领域层入口
//!
//! 与前端 `src/domain/` 一一对应。规则只在这两处之一实现、另一处镜像，
//! 并有测试守住（`tests/domain.test.js` 与 `cargo test`）。

pub mod bridge_range;
pub mod combination;
pub mod crash;
pub mod java;
pub mod loader_caps;
pub mod loader_trace;
pub mod memory;
pub mod mods;
pub mod resources;
pub mod types;
pub mod validate;
pub mod version;
