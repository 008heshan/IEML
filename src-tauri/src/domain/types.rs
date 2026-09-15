//! 领域类型（与前端 `src/domain/types.ts` 一一对应）
//!
//! 三个实体严格分离，这是原设计稿含混不清、导致「已装版本」与「实例」
//! 互相打架的根本原因：
//!   * `GameVersion`   —— 磁盘上的一份原版游戏（共享，可被多个实例复用）
//!   * `LoaderInstall` —— 叠加在某个 GameVersion 上的加载器
//!   * `Instance`      —— 用户看到的"一套独立游戏环境"，引用上面两者 + 自己的配置
//!
//! ★ **线格式统一用 camelCase**（`#[serde(rename_all = "camelCase")]`）。
//!
//!   前端 `src/domain/types.ts` 里全是 camelCase（`memoryMb` / `mcVersion` /
//!   `unavailableReason`），而 Rust 惯例是 snake_case。两边不一致的后果实测过：
//!   ```
//!   invalid args `store` for command `save_instances`: missing field `memory_mb`
//!   ```
//!   —— 实例列表**一个字节都存不下去**，用户看到的是"安装失败"。
//!   这类"字段名对不上"的 bug 编译器抓不到（跨 IPC 边界），
//!   只能靠两侧对齐约定 + 往返序列化的单元测试守着（见文件末尾 `wire_format` 测试）。

use serde::{Deserialize, Serialize};

/// 基础加载器：严格互斥，四选一（不含"纯原版"—— 那是"没有加载器"）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BaseLoaderKind {
    Forge,
    NeoForge,
    Fabric,
    Quilt,
}

impl BaseLoaderKind {
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Forge => "Forge",
            Self::NeoForge => "NeoForge",
            Self::Fabric => "Fabric",
            Self::Quilt => "Quilt",
        }
    }

    pub fn all() -> [Self; 4] {
        [Self::Forge, Self::NeoForge, Self::Fabric, Self::Quilt]
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Forge => "forge",
            Self::NeoForge => "neoforge",
            Self::Fabric => "fabric",
            Self::Quilt => "quilt",
        }
    }
}

/// 附加组件：可叠加，但受基础加载器约束
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddonKind {
    OptiFine,
    LiteLoader,
}

impl AddonKind {
    pub fn display_name(self) -> &'static str {
        match self {
            Self::OptiFine => "OptiFine",
            Self::LiteLoader => "LiteLoader",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OptiFine => "optifine",
            Self::LiteLoader => "liteloader",
        }
    }

    pub fn all() -> [Self; 2] {
        [Self::OptiFine, Self::LiteLoader]
    }
}

/// 桥接包
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeKind {
    OptiFabric,
    OptiFabricOrigins,
}

impl BridgeKind {
    pub fn display_name(self) -> &'static str {
        match self {
            Self::OptiFabric => "OptiFabric",
            Self::OptiFabricOrigins => "OptiFabric Origins",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OptiFabric => "optifabric",
            Self::OptiFabricOrigins => "optifabric-origins",
        }
    }
}

/// 版本隔离策略（ADR-005 三段判定）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum IsolationMode {
    #[default]
    Auto,
    On,
    Off,
}

/// 隔离判定的依据来源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IsolationSource {
    User,
    Content,
    Global,
}

/// 用户选出来的一套组合（提交校验的输入）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderSelection {
    pub mc_version: String,
    /// None = 纯原版
    #[serde(default)]
    pub base: Option<BaseLoaderKind>,
    #[serde(default)]
    pub addons: Vec<AddonKind>,
    #[serde(default)]
    pub base_version: Option<String>,
}

/// 被移除的组件及原因
#[derive(Debug, Clone, Serialize)]
pub struct RemovedAddon {
    pub kind: AddonKind,
    pub name: String,
    pub reason: String,
}

/// 将自动安装的桥接包
#[derive(Debug, Clone, Serialize)]
pub struct AutoBridge {
    pub kind: BridgeKind,
    pub name: String,
    /// 排在哪个附加组件之后（顺序铁律）
    pub after: AddonKind,
}

/// API 前置包
#[derive(Debug, Clone, Serialize)]
pub struct ApiLibrary {
    pub kind: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub bytes: u64,
    pub required: bool,
}

/// 组合校验结果：valid + 被移除的 + 自动补的 + 警告
#[derive(Debug, Clone, Serialize)]
pub struct CombinationVerdict {
    pub valid: bool,
    pub removed: Vec<RemovedAddon>,
    pub auto_bridges: Vec<AutoBridge>,
    pub auto_apis: Vec<ApiLibrary>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

/// 加载器能力（由 Rust 侧提供，前端不自己算）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderCapabilities {
    pub mc_version: String,
    pub base_loaders: Vec<LoaderOption>,
    pub addons: Vec<AddonOption>,
    pub api_libraries: Vec<ApiLibrary>,
    pub java_major: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderOption {
    pub kind: BaseLoaderKind,
    pub name: String,
    pub versions: Vec<String>,
    pub available: bool,
    /// 不可用时**必须**给出具体理由（禁止"不支持"三个字）
    pub unavailable_reason: Option<String>,
    /// 这个结论是**确认**出来的，还是**推断/未知**？
    ///
    /// ★ 存在的理由（用户报的 bug）：「什么叫 Forge 没发布 26.2 版本，PCL 是有的」——
    ///   内置表只有 10 个版本、没有 26.2；在线清单没拿到时代码把"我不知道"
    ///   写成了"尚未发布"。有了这个字段，UI 与 `combination.rs` 就能区分
    ///   「确认没有」（可以置灰并说"未发布"）与「没查到」（只能说"没查到，可重试"）。
    ///   见 ADR-037。
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonOption {
    pub kind: AddonKind,
    pub name: String,
    pub versions: Vec<String>,
    /// **最终结论**：这个组件在这个版本上、并且**我们装得了**吗？
    /// 等价于 `exists && implemented` —— 界面直接看它决定能不能点。
    pub available: bool,
    /// ★ 它**存在**吗（上游有没有发布这个 MC 版本的版本）？
    ///
    /// 与 `implemented` 分开的理由（用户原话「能装就是能装，不能装就是不能装」）：
    /// 把"上游没有"和"我们没做"混成一件事，界面就只能说一句含糊的
    /// "不可用"，而用户真正需要知道的是**该怪谁** ——
    /// 是等这个组件发布，还是换个启动器装。
    pub exists: bool,
    /// ★ **IEML 自己实现安装了吗**？
    ///
    /// 现有实现：OptiFine 有（走 Patcher / BMCLAPI），LiteLoader **没有** ——
    /// 只有磁盘检测。见 `addon_install_implemented`。
    pub implemented: bool,
    /// 不可用时**必须**给出具体理由（禁止"不支持"三个字）
    pub unavailable_reason: Option<String>,
    pub note: Option<String>,
}

/// 实例运行时配置
///
/// ★ 字段名必须与前端 `InstanceConfig`（`src/domain/types.ts`）一致 ——
///   前端多带的那些字段（`javaRange` / `windowTitle` / `jvmArgs` …）这里
///   收不到也无所谓：**反序列化时多余字段会被忽略**，
///   但**缺失字段会直接报错**（就是 `missing field memory_mb` 那个 bug）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceConfig {
    pub name: String,
    pub slug: String,
    #[serde(default)]
    pub isolation: IsolationMode,
    pub memory_mb: u64,
    pub memory_source: String,
    pub java_mode: String,
}

/// 一个实例
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub mc_version: String,
    #[serde(default)]
    pub loader: Option<LoaderRecord>,
    #[serde(default)]
    pub addons: Vec<AddonRecord>,
    pub config: InstanceConfig,
    /// 下面三个前端会写、后端目前不读 —— 给默认值，别让它们变成"必填"
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub last_played_at: Option<String>,
    #[serde(default)]
    pub total_play_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderRecord {
    pub kind: BaseLoaderKind,
    pub version: String,
    pub mc_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonRecord {
    pub kind: AddonKind,
    pub version: String,
    #[serde(default)]
    pub bridge: Option<BridgeRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRecord {
    pub kind: BridgeKind,
    pub version: String,
}

#[cfg(test)]
mod wire_format {
    //! 线格式回归测试：**跨 IPC 边界的字段名对不上，编译器抓不到**。
    //!
    //! 实测踩过：前端发 camelCase（`memoryMb`），Rust 收 snake_case（`memory_mb`），
    //! 结果 `save_instances` 直接失败：
    //! `invalid args store: missing field memory_mb` —— 实例一个都存不下来，
    //! 用户看到的是"安装失败"。
    //!
    //! 所以这里用**前端的真实载荷形状**（照抄 `src/domain/types.ts`）做往返测试。

    use super::*;

    /// 前端 `InstanceConfig` 的最小载荷（字段名照抄 TS 定义）
    const CONFIG: &str = r#"{
        "name": "测试实例",
        "slug": "test",
        "isolation": "auto",
        "memoryMb": 4096,
        "memorySource": "global",
        "javaMode": "auto"
    }"#;

    #[test]
    fn instance_config_deserializes_from_frontend_camel_case() {
        let c: InstanceConfig =
            serde_json::from_str(CONFIG).expect("前端发来的 camelCase 必须能收下");
        assert_eq!(c.memory_mb, 4096, "memoryMb → memory_mb");
        assert_eq!(c.memory_source, "global");
        assert_eq!(c.java_mode, "auto");
        assert_eq!(c.isolation, IsolationMode::Auto);

        // 再序列化回去，前端读到的必须是 camelCase
        let back = serde_json::to_value(&c).unwrap();
        assert!(back.get("memoryMb").is_some(), "回给前端必须还是 camelCase");
        assert!(back.get("memory_mb").is_none(), "不能混进 snake_case");
    }

    #[test]
    fn instance_deserializes_from_frontend_shape() {
        let raw = format!(
            r#"{{
                "id": "i1",
                "mcVersion": "1.20.1",
                "loader": {{ "kind": "fabric", "version": "0.15.0", "mcVersion": "1.20.1" }},
                "addons": [],
                "config": {CONFIG},
                "createdAt": "2026-09-12T17:00:00Z",
                "lastPlayedAt": null,
                "totalPlaySeconds": 123
            }}"#
        );
        let inst: Instance = serde_json::from_str(&raw).expect("完整实例载荷必须能收下");
        assert_eq!(inst.mc_version, "1.20.1");
        assert_eq!(inst.config.memory_mb, 4096);
        assert_eq!(inst.loader.as_ref().unwrap().kind, BaseLoaderKind::Fabric);
        assert_eq!(inst.total_play_seconds, 123);

        // 序列化回去后，前端的字段名都要在
        let back = serde_json::to_value(&inst).unwrap();
        for k in ["mcVersion", "loader", "createdAt", "lastPlayedAt", "totalPlaySeconds"] {
            assert!(back.get(k).is_some(), "缺少前端要读的字段 {k}：{back}");
        }
    }

    /// 纯原版实例：`loader` 为 null，且前端没给那几个时间字段 —— 必须也能收下
    #[test]
    fn vanilla_instance_without_optional_fields() {
        let raw = format!(
            r#"{{ "id": "i2", "mcVersion": "26.2", "loader": null, "addons": [], "config": {CONFIG} }}"#
        );
        let inst: Instance = serde_json::from_str(&raw).expect("缺可选字段不该失败");
        assert!(inst.loader.is_none());
        assert_eq!(inst.total_play_seconds, 0);
    }

    /// 加载器能力：前端读 `mcVersion` / `baseLoaders` / `apiLibraries` / `javaMajor`
    #[test]
    fn loader_capabilities_are_camel_case_on_the_wire() {
        let caps = LoaderCapabilities {
            mc_version: "1.20.1".into(),
            base_loaders: vec![LoaderOption {
                kind: BaseLoaderKind::Forge,
                name: "Forge".into(),
                versions: vec!["47.2.0".into()],
                available: true,
                unavailable_reason: None,
                confirmed: true,
            }],
            addons: vec![],
            api_libraries: vec![],
            java_major: 17,
        };
        let v = serde_json::to_value(&caps).unwrap();
        for k in ["mcVersion", "baseLoaders", "apiLibraries", "javaMajor"] {
            assert!(v.get(k).is_some(), "前端要读 {k}，实际给了 {v}");
        }
    }
}
