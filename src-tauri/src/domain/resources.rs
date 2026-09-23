//! ★★ **社区资源子系统**：Mod / 资源包 / 光影 / 数据包，**同一套抽象**。
//!
//! ## 照 PCL 的 `Modules/Resource/*` 做的
//!
//! PCL 那一套是六个文件、约 2300 行：
//!
//! | 文件 | 行数 | 职责 |
//! |---|---|---|
//! | `ResourceProject.vb` | 711 | **统一的"资源项目"抽象** |
//! | `ResourceSearcher.vb` | 521 | 搜索 / 筛选 |
//! | `ResourceVersion.vb` | 426 | 版本与适配 |
//! | `LocalResourceLoaders.vb` | 349 | 本地已装资源的加载器 |
//! | `LocalResourceFile.vb` | 277 | 本地文件 |
//!
//! 配上它那一整套界面：`PageDownloadMod` / `PageDownloadPack` /
//! `PageDownloadResourcePack` / `PageDownloadShader` / `PageDownloadDataPack`。
//!
//! **它们不是五个功能，是同一套抽象的五种实例。**
//! 我们这边原来只有 Mod 一种（而且是平铺的搜索列表），
//! `resourcepack` / `datapack` / `shader` 在源码里**一处都没有**。
//!
//! ## 这个模块的全部内容就是"那张表"
//!
//! [`ResourceKind::ALL`] 里每一种资源只描述**四件事**：
//!   ① 到 Modrinth 上怎么查（项目类型 + 额外的分类 facet）；
//!   ② 装到实例的哪个子目录；
//!   ③ 认哪些扩展名；
//!   ④ 相不相信"必须搭配某个加载器"（资源包/光影与加载器无关，
//!      数据包**由游戏本体或加载器读**，Mod 才需要加载器）。
//!
//! 于是搜索、筛选、安装、扫描本地已装这四件事都只写一遍 ——
//! 加一种新资源只需要在 `ALL` 里加一行。
//!
//! ## 实测纠正过一个想当然的地方（数据包 ≠ 项目类型）
//!
//! 我一开始以为 Modrinth 的 `project_type` 有 `datapack` 这一档，
//! 真机打过去发现**返回的是 mod**：
//!
//! ```text
//! --- datapack: 3 条 ---
//!     [mod] VeinMiner (82553959 次下载)
//!     [mod] Terralith (22718424 次下载)
//! ```
//!
//! 正确的做法是用**分类** facet：`categories:datapack`
//! （`categories:datapacks` 是 0 条 —— 单数才对）。
//! 所以 [`ResourceKind::Datapack`] 的项目类型仍是 `mod`，
//! 但额外带一个 `datapack` 分类。**证据推翻了推测**，
//! 这一条写在类型定义上，免得以后有人"顺手改回去"。

use serde::Serialize;

/// 一种社区资源。**这是唯一一份描述**，四个消费方都读它。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    /// 模组（需要加载器；装到 `mods/`）
    Mod,
    /// 资源包（材质 / 音效；装到 `resourcepacks/`）
    ResourcePack,
    /// 光影包（需要 Iris / OptiFine 之类才能用；装到 `shaderpacks/`）
    Shader,
    /// 数据包（改配方 / 结构 / 进度；装到存档或世界的 `datapacks/`）
    Datapack,
    /*
     * ★★ 2026-09-23（用户：「**PCL 的整合包可以用 curseforge 啊**」）：
     *   整合包也是一种"可搜索的资源"，但它与上面四种有**根本差别** ——
     *   上面四种的安装是"把一个文件放进某个目录"，
     *   整合包的安装是"**建一个实例**"（读清单 → 装加载器 → 拉 Mod）。
     *   所以它进得了**搜索**，但进不了**装文件那条路**（见 `install_dir`）。
     */
    Modpack,
}

impl ResourceKind {
    /// 界面上按这个顺序列选项卡（先 Mod —— 最常用）
    pub const ALL: [ResourceKind; 5] = [
        ResourceKind::Mod,
        ResourceKind::ResourcePack,
        ResourceKind::Shader,
        ResourceKind::Datapack,
        ResourceKind::Modpack,
    ];

    /// 内部键名（与前端 `ResourceKind` 一一对应）
    pub fn key(self) -> &'static str {
        match self {
            ResourceKind::Mod => "mod",
            ResourceKind::ResourcePack => "resourcepack",
            ResourceKind::Shader => "shader",
            ResourceKind::Datapack => "datapack",
            ResourceKind::Modpack => "modpack",
        }
    }

    /// 面向用户的名字
    pub fn display(self) -> &'static str {
        match self {
            ResourceKind::Mod => "Mod",
            ResourceKind::ResourcePack => "资源包",
            ResourceKind::Shader => "光影",
            ResourceKind::Datapack => "数据包",
            ResourceKind::Modpack => "整合包",
        }
    }

    /// 传给 Modrinth `project_type` 的值。
    ///
    /// ★ 数据包在这里是 **`mod`** —— 见模块头部的实测说明。
    pub fn modrinth_project_type(self) -> &'static str {
        match self {
            ResourceKind::Mod | ResourceKind::Datapack => "mod",
            ResourceKind::ResourcePack => "resourcepack",
            ResourceKind::Shader => "shader",
            // ★ Modrinth 本来就有 `modpack` 这个 project_type
            ResourceKind::Modpack => "modpack",
        }
    }

    /// 额外要加的**分类** facet（数据包靠它区分）。
    ///
    /// ★ 单数 `datapack`（复数那个是 0 条 —— 实测）。
    pub fn extra_category(self) -> Option<&'static str> {
        match self {
            ResourceKind::Datapack => Some("datapack"),
            // ★ 整合包在 Modrinth 有自己的 project_type，不需要额外分类 facet
            _ => None,
        }
    }

    /// 装到实例目录下的哪个子目录（**相对实例根**）。
    pub fn install_dir(self) -> &'static str {
        match self {
            ResourceKind::Mod => "mods",
            ResourceKind::ResourcePack => "resourcepacks",
            ResourceKind::Shader => "shaderpacks",
            // ★ 数据包要放进**某个世界**的 datapacks/ 才会生效；
            //   放在实例根下是"给用户自己拖进世界"的暂存位。
            //   这一点必须对用户说清（界面上有提示），不能假装装完就生效。
            ResourceKind::Datapack => "datapacks",
            /*
             * ★★ 整合包**没有**"装进哪个目录"这回事 —— 它的安装是**建实例**。
             *   这里返回空串，让"装文件"那条路**明确拒绝**它，
             *   而不是往一个不存在的目录里塞东西（那会是一个安静的错）。
             */
            ResourceKind::Modpack => "",
        }
    }

    /// 认哪些扩展名（用于扫本地已装 + 安装时校验文件名）
    ///
    /// ★ 光影包历史上两种都有：`.zip`（大多数）与 `.jar`（少数还带代码）。
    ///   数据包同理（`.zip` 为主，个别用 `.jar`）。两张都要认。
    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            ResourceKind::Mod => &[".jar"],
            // ★ 资源包也可能是 `.jar`（老版本/特殊用途），少但要认
            ResourceKind::ResourcePack => &[".zip", ".jar"],
            ResourceKind::Shader => &[".zip", ".jar"],
            ResourceKind::Datapack => &[".zip", ".jar"],
            // 整合包是 .mrpack（Modrinth）/ .zip（CurseForge）
            ResourceKind::Modpack => &[".mrpack", ".zip"],
        }
    }

    /// 这一类资源**要不要挑加载器**。
    ///
    /// * Mod：要（Fabric 的 Mod 装进 Forge 的实例没用）；
    /// * 资源包 / 光影：**不要**（原版就能用资源包；光影只要有 Iris/OptiFine）；
    /// * 数据包：**不要**（游戏本体自己读）。
    ///
    /// ★ 这条决定了搜索时带不带 `categories:<loader>` facet。
    ///   带错了会让结果集偏窄甚至为空 —— 而用户会以为"没有这个资源"。
    ///   （这个仓库已经因为"把查不到说成没有"栽过一次，见 `LoaderList.status`。）
    pub fn needs_loader_filter(self) -> bool {
        // ★ 整合包也要挑加载器（Fabric 的包装进 Forge 的实例没意义）
        matches!(self, ResourceKind::Mod | ResourceKind::Modpack)
    }

    /// 这一类资源**装完要不要提示用户**（有额外动作才能生效）。
    ///
    /// 目前只有数据包：它必须放进**某个世界**的 `datapacks/`。
    pub fn install_note(self) -> Option<&'static str> {
        match self {
            ResourceKind::Datapack => Some(
                "数据包要放进**某个世界**的 datapacks/ 目录才会生效 —— \
                 已经放在实例的 datapacks/ 里了，进游戏后把它拖进目标世界即可。",
            ),
            ResourceKind::Shader => Some(
                "光影包需要 Iris 或 OptiFine 才能生效 —— 原版游戏里看不到它。",
            ),
            ResourceKind::Modpack => Some(
                "整合包装完会**新建一个版本**（不是塞进当前版本）—— 版本、加载器、Mod 清单\
                 都由包里的清单文件定死，装完到「版本列表」里就能看到它。",
            ),
            _ => None,
        }
    }
}

/// 把外部的键名解回类型（前端传 `resource_kind` 时用）
pub fn parse_kind(s: &str) -> Option<ResourceKind> {
    let t = s.trim().to_ascii_lowercase();
    ResourceKind::ALL.into_iter().find(|k| {
        k.key() == t
            // 容忍前端/hand-typed 的几种写法（都不改变语义）
            || (k == &ResourceKind::ResourcePack && t == "resourcepacks")
            || (k == &ResourceKind::Shader && (t == "shaders" || t == "shaderpack"))
            || (k == &ResourceKind::Datapack && t == "datapacks")
            || (k == &ResourceKind::Mod && (t == "mods" || t == "modpack"))
    })
}

/// 一种资源的完整描述（给界面用：一次问清全部四种）
#[derive(Debug, Clone, Serialize)]
pub struct ResourceKindInfo {
    pub key: String,
    pub display: String,
    /// 装到实例的哪个子目录（相对实例根）
    pub install_dir: String,
    pub extensions: Vec<String>,
    /// 要不要挑加载器（决定界面显不显示加载器筛选）
    pub needs_loader_filter: bool,
    /// 装完要额外说的话（数据包/光影）
    pub install_note: Option<String>,
}

/// 四种资源的描述（界面一次取走，不要在两边各写一份）
pub fn all_kinds() -> Vec<ResourceKindInfo> {
    ResourceKind::ALL
        .into_iter()
        .map(|k| ResourceKindInfo {
            key: k.key().to_string(),
            display: k.display().to_string(),
            install_dir: k.install_dir().to_string(),
            extensions: k.extensions().iter().map(|s| s.to_string()).collect(),
            needs_loader_filter: k.needs_loader_filter(),
            install_note: k.install_note().map(|s| s.to_string()),
        })
        .collect()
}

/// 这个文件名是不是这一类资源（按扩展名判）。
///
/// ★ 只看扩展名，**不看目录** —— 目录由调用方决定（同一个文件可能
///   既在实例的 `resourcepacks/` 也在别处）。判据只有这一份。
pub fn filename_matches(kind: ResourceKind, filename: &str) -> bool {
    let lower = filename.to_ascii_lowercase();
    // 临时/禁用文件不算（`.disabled` 是 Mod 的禁用后缀，别的资源也可能这么用）
    if lower.ends_with(".disabled") || lower.ends_with(".part") {
        return false;
    }
    kind.extensions().iter().any(|e| lower.ends_with(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★★ 数据包**不是**一个 Modrinth 项目类型 —— 实测：查 `datapack`
    ///    返回的是 mod。所以它走 `mod` + `categories:datapack`。
    ///
    ///    这条测试存在的意义：防止有人"顺手改回去"，
    ///    那样数据包页会变成**又一个 Mod 列表**（而且看起来还挺像）。
    #[test]
    fn datapack_uses_mod_project_type_plus_a_category() {
        assert_eq!(
            ResourceKind::Datapack.modrinth_project_type(),
            "mod",
            "★ 数据包在 Modrinth 上的 project_type 就是 mod（实测）"
        );
        assert_eq!(
            ResourceKind::Datapack.extra_category(),
            Some("datapack"),
            "★ 靠 categories:datapack 把它和普通 Mod 分开（单数，复数那个是 0 条）"
        );
        // 其它三种靠 project_type 就够，不该额外加分类
        assert_eq!(ResourceKind::Mod.extra_category(), None);
        assert_eq!(ResourceKind::ResourcePack.extra_category(), None);
        assert_eq!(ResourceKind::Shader.extra_category(), None);
        assert_eq!(ResourceKind::ResourcePack.modrinth_project_type(), "resourcepack");
        assert_eq!(ResourceKind::Shader.modrinth_project_type(), "shader");
    }

    /// 每种资源的安装目录 + 扩展名
    #[test]
    fn install_dirs_and_extensions() {
        assert_eq!(ResourceKind::Mod.install_dir(), "mods");
        assert_eq!(ResourceKind::ResourcePack.install_dir(), "resourcepacks");
        assert_eq!(ResourceKind::Shader.install_dir(), "shaderpacks");
        assert_eq!(ResourceKind::Datapack.install_dir(), "datapacks");

        // 资源包 / 光影 / 数据包都可能是 .zip **或** .jar（实测形态）
        for k in [
            ResourceKind::ResourcePack,
            ResourceKind::Shader,
            ResourceKind::Datapack,
        ] {
            assert!(k.extensions().contains(&".zip"), "{} 要认 .zip", k.key());
            assert!(k.extensions().contains(&".jar"), "{} 也要认 .jar", k.key());
        }
        // Mod 只认 .jar
        assert_eq!(ResourceKind::Mod.extensions(), &[".jar"]);
    }

    /// ★ 只有 Mod 需要挑加载器 —— 资源包/光影/数据包带上加载器 facet
    ///   会把结果集砍到几乎没有，而用户会以为"没有这个资源"。
    #[test]
    fn only_mods_filter_by_loader() {
        assert!(ResourceKind::Mod.needs_loader_filter());
        assert!(!ResourceKind::ResourcePack.needs_loader_filter());
        assert!(!ResourceKind::Shader.needs_loader_filter());
        assert!(!ResourceKind::Datapack.needs_loader_filter());
    }

    /// 文件名判据：认扩展名，但不认临时文件与禁用文件
    #[test]
    fn filename_matching() {
        assert!(filename_matches(ResourceKind::Mod, "sodium.jar"));
        assert!(filename_matches(ResourceKind::Mod, "Sodium.JAR"), "大小写不敏感");
        assert!(!filename_matches(ResourceKind::Mod, "sodium.zip"));
        assert!(!filename_matches(ResourceKind::Mod, "sodium.jar.disabled"), "禁用的不算启用");
        assert!(!filename_matches(ResourceKind::Mod, "sodium.jar.part"), "半成品不算");
        assert!(filename_matches(ResourceKind::ResourcePack, "FreshAnimations.zip"));
        assert!(filename_matches(ResourceKind::Shader, "ComplementaryReimagined.zip"));
        assert!(filename_matches(ResourceKind::Datapack, "terralith.zip"));
    }

    /// 键名解析要容忍几种自然写法（但不改变语义）
    #[test]
    fn kind_parsing_tolerates_natural_spellings() {
        assert_eq!(parse_kind("mod"), Some(ResourceKind::Mod));
        assert_eq!(parse_kind("mods"), Some(ResourceKind::Mod));
        assert_eq!(parse_kind("resourcepack"), Some(ResourceKind::ResourcePack));
        assert_eq!(parse_kind("resourcepacks"), Some(ResourceKind::ResourcePack));
        assert_eq!(parse_kind("shader"), Some(ResourceKind::Shader));
        assert_eq!(parse_kind("shaders"), Some(ResourceKind::Shader));
        assert_eq!(parse_kind("datapack"), Some(ResourceKind::Datapack));
        assert_eq!(parse_kind("Datapacks"), Some(ResourceKind::Datapack));
        // 不认识 → None（**不猜**，由调用方报错）
        assert_eq!(parse_kind("whatever"), None);
        assert_eq!(parse_kind(""), None);
    }

    /// 五种资源都要在 `all_kinds()` 里（界面的选项卡就是它）
    #[test]
    fn all_kinds_covers_everything() {
        let list = all_kinds();
        // ★ 2026-09-23：加了整合包 → 4 变 5（判据跟着需求变）
        assert_eq!(list.len(), 5);
        let keys: Vec<&str> = list.iter().map(|k| k.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["mod", "resourcepack", "shader", "datapack", "modpack"]
        );
        // 数据包 / 光影 / 整合包有"装完还要做什么"的提示，Mod/资源包没有
        let by_key = |k: &str| list.iter().find(|x| x.key == k).unwrap();
        assert!(by_key("datapack").install_note.is_some());
        assert!(by_key("shader").install_note.is_some());
        assert!(by_key("mod").install_note.is_none());
        /*
         * ★★ 整合包的判据（2026-09-23）：
         *   · 有自己的 project_type（Modrinth）与 classId（CurseForge 4471）；
         *   · **install_dir 是空串** —— 它不装进目录，而是"建一个实例"。
         *     这一条是**故意**的：让"装文件"那条路明确拒绝它，
         *     而不是往一个不存在的目录里塞东西。
         */
        assert!(by_key("modpack").install_note.is_some());
        assert_eq!(
            ResourceKind::Modpack.install_dir(),
            "",
            "整合包不装进目录（它的安装是建实例）"
        );
        assert_eq!(ResourceKind::Modpack.modrinth_project_type(), "modpack");
        assert_eq!(crate::net::curseforge::class_id(ResourceKind::Modpack), 4471);
    }
}
