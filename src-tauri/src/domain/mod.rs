//! 领域层入口
//!
//! 与前端 `src/domain/` 一一对应。规则只在这两处之一实现、另一处镜像，
//! 并有测试守住（`tests/domain.test.js` 与 `cargo test`）。

/// ★ 中文搜 Mod 的别名表（ADR-016）—— 静态词表 + 纯查表，不碰网络
pub mod alias;
/// ★★ **压缩包落盘闸门**（Zip Slip / 绝对路径 / ADS / 保留设备名）+ 按类别的体积上限
///    —— 全仓库**唯一**一份判据：清单路径与解压条目共用（见 `net::installer`
///    与 `net::adoptium`）。零 `crate::` 依赖，能用 rustc 单独编译跑断言。
pub mod archive_guard;
pub mod bridge_range;
pub mod combination;
pub mod crash;
/// ★ 拖进来的文件**是什么**（按内容判，ADR-015 的判定顺序）—— 纯判定，不碰盘、不知道实例在哪
pub mod dropped;
/// ★ 别人的目录是**谁的**（官方 / PCL / HMCL / Prism…）—— 只认形状，不碰盘（导入见命令层）
pub mod external;
/// ★★ **"这次失败该怎么办"**（2026-10 审计结论：下载路径的重试**完全不分类**）——
///    纯判定：给 HTTP 状态码与 errno，得出 Fatal / Retryable / Busy。
///    退避、换源、落盘都在 `net/`，这一份只管判据（于是能被 rustc 单编验证）
pub mod failure;
pub mod java;
/// ★★ 版本隔离（ADR-005 三段判定）—— **规则只在这一份**，平台层与界面都读它的结论
pub mod isolation;
pub mod loader_caps;
pub mod loader_trace;
pub mod memory;
/// ★ 导出整合包时**哪些文件绝不能带上**（ADR-024：两张黑名单 + 登录凭据红线）
pub mod modpack_export;
pub mod mods;
/// ★★ **一个版本在磁盘上叫什么名字**（ADR-055 决定八）—— 规范只在这一份，
///    安装器 / 迁移 / 账本 / 前端镜像都必须调它，不许各自拼字符串
pub mod naming;
/// ★★ **整合包这一次该装哪些文件、哪些没装上**（2026-10-16 事故：漏下 5 个 mod
///    却报安装完成）—— 纯判定，不碰网络；落盘成 `<实例>/.ieml/pack-files.json`
pub mod pack_plan;
/// ★ 整合包安装记录与"装全了没有"（ADR-025 的 Completion 阶段）—— 纯判定，不做下载
pub mod pack_record;
/// ★ 整合包**有没有新版本**、新清单会让盘上换掉哪些文件（ADR-025 第 4 条）—— 纯判定，不碰网络
pub mod pack_update;
pub mod resources;
pub mod types;
pub mod validate;
pub mod version;
