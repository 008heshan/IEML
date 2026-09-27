//! **拖进来的东西是什么** —— 按**内容**判，不看扩展名（ADR-015 的判定顺序）。
//!
//! ## 为什么必须有这个模块
//!
//!   拖拽是"老玩家的高效路径"：手上有 `xxx.zip` / `xxx.jar`，拖进窗口就该装好。
//!   但**光看扩展名判不出来**：
//!
//!   * 资源包、光影、数据包**全都是 `.zip`**（只是里面的结构不同）；
//!   * Mod 也可以被作者打包成 `.zip`（虽然多数是 `.jar`）；
//!   * 整合包也是 `.zip`（CurseForge）或 `.mrpack`（Modrinth）；
//!   * 名字更是随便起 —— `sodium-fabric-0.5.8.jar` 与 `材质包.zip` 谁是谁，只能靠**里面装了什么**。
//!
//!   ADR-015 把这件事定成了**判定顺序**（不是并列的 if）：
//!
//!   ```text
//!   ① 整合包（manifest.json / modrinth.index.json）
//!   ② Mod（fabric.mod.json / quilt.mod.json / META-INF/mods.toml / mcmod.info）
//!   ③ 资源包 / 光影 / 数据包（pack.mcmeta、shaders/）
//!   ```
//!
//!   ★ **顺序不能换**：整合包里面**也**有 `mods/` 目录，先判 Mod 会把它误判成单个 Mod，
//!     于是"装一个整合包"变成"往 mods/ 里丢一个压缩包"—— 游戏读不到，用户以为装上了。
//!     同理，光影包里也可能带 `pack.mcmeta`。
//!
//! ## 判据
//!
//!   本模块只做**纯判定**（给字节 / 给路径，给结论），不碰实例、不知道实例在哪 ——
//!   于是每一条顺序都能用真 zip 喂进单测（见文件尾部）。
//!   唯一的例外是"目录"那一组（[`classify_dir`] / [`plan_dir`]）：目录里有什么
//!   只能读盘才知道，那几条用**真的临时目录**测。

use crate::domain::resources::ResourceKind;

/// 拖进来的东西（判定结果）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DroppedKind {
    /// 整合包 —— 走"建实例"那条路（不是"把文件放进某个目录"）
    Modpack,
    /// 单个资源（Mod / 资源包 / 光影 / 数据包）—— 走 [`ResourceKind::install_dir`]
    Resource(ResourceKind),
    /// **一个目录** —— 里面有几个文件能装（具体装哪几个由 [`plan_dir`] 定）
    Folder,
    /// 认不出来 —— 带上**为什么**（如实说，不猜）
    Unknown(String),
}

impl DroppedKind {
    /// 给界面用的一句话（"这是什么"）
    pub fn display(&self) -> String {
        match self {
            DroppedKind::Modpack => "整合包".to_string(),
            DroppedKind::Resource(k) => k.display().to_string(),
            DroppedKind::Folder => "目录".to_string(),
            DroppedKind::Unknown(_) => "认不出来".to_string(),
        }
    }

    /// 认不出来时的原因（认得出时为空）
    pub fn reason(&self) -> String {
        match self {
            DroppedKind::Unknown(why) => why.clone(),
            _ => String::new(),
        }
    }
}

/// "认不出来"的统一写法：**每一条理由都带上文件名**。
///
/// ★ 为什么这件事值得单独一个函数：一次拖进来 20 个文件时，
///   只说"这个文件不是有效的压缩包"等于没说 —— 用户不知道该处理哪一个。
///   凡是能说出名字的地方都必须说。
fn unknown_with(file_name: &str, why: impl std::fmt::Display) -> DroppedKind {
    if file_name.is_empty() {
        DroppedKind::Unknown(why.to_string())
    } else {
        DroppedKind::Unknown(format!("「{file_name}」{why}"))
    }
}

/// 把 `classify_names` 得出的"认不出来"补上文件名（别的类别原样返回）
fn with_name(kind: DroppedKind, file_name: &str) -> DroppedKind {
    match kind {
        DroppedKind::Unknown(why) => unknown_with(file_name, why),
        other => other,
    }
}

/// 中央目录里的条目名（**不解压**，只看名字）。
///
/// 返回 `Err` = 这不是一个能读的压缩包（此时调用方按扩展名兜底或如实报"读不了"）。
fn entry_names(bytes: &[u8]) -> Result<Vec<String>, String> {
    let reader = std::io::Cursor::new(bytes.to_vec());
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("这个文件不是有效的压缩包（{e}）"))?;
    let mut out = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        match archive.by_index_raw(i) {
            Ok(e) => out.push(e.name().replace('\\', "/")),
            Err(e) => return Err(format!("里的文件目录读不出来：{e}")),
        }
    }
    Ok(out)
}

/// 根目录下有没有这个条目（`a/b.txt` 只在**根**下找，不认 `overrides/a/b.txt`）
fn has_root(names: &[String], name: &str) -> bool {
    names.iter().any(|n| n == name)
}

/// 有没有以 `prefix` 开头的**目录**（例如 `shaders/`）
fn has_dir(names: &[String], prefix: &str) -> bool {
    let p = format!("{prefix}/");
    names.iter().any(|n| n.starts_with(&p) && n.len() > p.len())
}

/// 分类（ADR-015 的顺序，逐条判）
///
/// `file_name` 只用来**写进"认不出来"的理由**（让用户看得懂是哪个文件），
/// 判定本身一个字都不看它 —— 这正是这个模块存在的意义。
pub fn classify_bytes(bytes: &[u8], file_name: &str) -> DroppedKind {
    let names = match entry_names(bytes) {
        Ok(n) => n,
        Err(e) => return unknown_with(file_name, e),
    };
    with_name(classify_names(&names), file_name)
}

/// 同上，但直接从**盘上的文件**读中央目录（不解压、不整个读进内存）。
///
/// ★ 为什么要有这一版：光影包动辄几百 MB，为了看目录名把整个文件读进内存是浪费 ——
///   `ZipArchive` 本来就只读中央目录（会 seek）。
pub fn classify_file(path: &std::path::Path) -> DroppedKind {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return unknown_with(&file_name, format!("读不了：{e}")),
    };
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => return unknown_with(&file_name, format!("这个文件不是有效的压缩包（{e}）")),
    };
    let mut names = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        match archive.by_index_raw(i) {
            Ok(e) => names.push(e.name().replace('\\', "/")),
            Err(e) => return unknown_with(&file_name, format!("里的文件目录读不出来：{e}")),
        }
    }
    with_name(classify_names(&names), &file_name)
}

/// **按路径**判：是目录就走目录那套，是文件就走文件那套。
///
/// ★ 为什么必须有这一层：拖进来的**可能是个目录**（`mods`、解压出来的整合包、
///   别人给的"材质包合集"）。以前这两种输入都掉进"读不了这个文件"里 ——
///   用户看到的是"找不到这个文件：E:\...\mods"，一句没法照着做的话。
pub fn classify_path(path: &std::path::Path) -> DroppedKind {
    if path.is_dir() {
        return classify_dir(path);
    }
    classify_file(path)
}

/// 一个目录：**里面有哪些文件能装**（只看这一层）。
///
/// 返回 `(能装的文件, 跳过的理由)`。跳过的也带理由 —— "只装了这一层的 3 个"里
/// 少了什么、为什么少，必须能说出来。
pub fn plan_dir(dir: &std::path::Path) -> (Vec<(std::path::PathBuf, ResourceKind)>, Vec<String>) {
    let mut installable = Vec::new();
    let mut skipped = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(it) => it,
        Err(e) => return (installable, vec![format!("读不了这个目录：{e}")]),
    };
    // 顺序要稳定：`read_dir` 的顺序随文件系统变，逐条提示语会跳来跳去
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());

    for e in items {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            // ★ 不递归：递归会**悄悄**装一堆用户没打算装的东西（压缩包解压出来的
            //   `mods/` 里往往还有别的版本残留）。只说清楚"子目录没装"。
            skipped.push(format!("{name}/：子目录里的东西没有装（只装这一层的文件）"));
            continue;
        }
        match classify_file(&p) {
            DroppedKind::Resource(k) => {
                if crate::domain::resources::filename_matches(k, &name) {
                    installable.push((p, k));
                } else {
                    skipped.push(format!(
                        "{name}：看着像{}，但扩展名不是 {} —— 装了游戏也读不到",
                        k.display(),
                        k.extensions().join(" / ")
                    ));
                }
            }
            DroppedKind::Modpack => skipped.push(format!(
                "{name}：这是一个**整合包**（会建出新实例），请单独拖它、不要放在目录里"
            )),
            DroppedKind::Folder => skipped.push(format!("{name}：这是个目录")),
            DroppedKind::Unknown(why) => skipped.push(why),
        }
    }
    (installable, skipped)
}

/// 一个**目录**是什么：解压出来的整合包 / 一包能装的文件 / 什么都没有。
///
/// ★ 三种结论都如实说，尤其第三种 —— "我把 mods 文件夹拖进来了，怎么没反应"是
///   最容易被做成静默失败的场景（目录里全是 `.disabled` / 子目录时）。
pub fn classify_dir(dir: &std::path::Path) -> DroppedKind {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    // ★ 解压出来的整合包：根下有清单元数据。我们**不替他压**（overrides 动辄几个 GB，
    //   压一遍既慢又占盘；而且"哪个目录才是包根"经常得猜）——如实告诉他怎么做。
    for marker in ["manifest.json", "modrinth.index.json"] {
        if dir.join(marker).is_file() {
            return DroppedKind::Unknown(format!(
                "「{name}」是一个**解压出来的**整合包目录 —— 请把它压成 zip 再拖进来；\
                 或者把它里面的 mods 目录整个拖进来（那会按 Mod 一个个装）"
            ));
        }
    }

    let (installable, _) = plan_dir(dir);
    if installable.is_empty() {
        /*
         * ★★ "拖的是**上一级**目录"是最常见的误解，而且它以前会得到一句没用的话
         *   （"这个目录里没有能装的文件"）—— 而用户明明看见里面有一堆 jar。
         *   所以先把两种典型情形认出来，直接告诉他该拖哪一层：
         *     · 里面就有 `mods/` / `resourcepacks/` / … → 拖那个子目录；
         *     · 看起来是**别的启动器的游戏目录** → 这一版不支持整个导入，
         *       如实说，并给出能立刻做的那一步。
         */
        let known: Vec<String> = ["mods", "resourcepacks", "shaderpacks", "datapacks"]
            .iter()
            .filter(|n| dir.join(n).is_dir())
            .map(|n| format!("{n}/"))
            .collect();
        /*
         * ★ 顺序：**先判"这是不是一个完整的游戏目录"**。
         *   真实的 `.minecraft`（官方/PCL/HMCL 留下的）里同时有 `versions/` 与
         *   `mods/` —— 先判 `mods/` 的话，用户得到的只是一句"把 mods/ 拖进来"，
         *   而他那件更大的事（"我想把整个整合包/游戏搬过来"）没人回答。
         */
        if dir.join("versions").is_dir() || dir.join("launcher_profiles.json").is_file() {
            return DroppedKind::Unknown(format!(
                "「{name}」看起来是一个**完整的游戏目录**（官方启动器或别的启动器留下的）—— \
                 这一版还不能整个导入它；想搬 Mod 的话把它里面的 mods 目录拖进来，\
                 存档要自己在文件管理器里复制到目标的 saves/ 里"
            ));
        }
        if !known.is_empty() {
            return DroppedKind::Unknown(format!(
                "「{name}」这一层没有能直接装的东西 —— 资源在它里面的子目录里：\
                 把 {} 整个拖进来就行（拖子目录才对，拖外层的文件夹不算）",
                known.join("、")
            ));
        }
        return DroppedKind::Unknown(format!(
            "「{name}」这个目录里没有能装的文件（只看这一层）—— \
             要装的话请拖具体的 Mod / 资源包 / 光影 / 数据包文件，或者一个装着它们的目录"
        ));
    }
    DroppedKind::Folder
}

/// 分类的**唯一实现**（[`classify_bytes`] 与 [`classify_file`] 都走这里）。
///
/// ★ 这里**刻意不接文件名**：判定一个字都不看它（这正是这个模块存在的意义），
///   而"认不出来"的理由由 [`unknown_with`] 统一补上名字。
fn classify_names(names: &[String]) -> DroppedKind {
    // ---------- ① 整合包 ----------
    // ★ CurseForge 的 `manifest.json` 与 Modrinth 的 `modrinth.index.json` 都只认**根下**的
    //   （整合包的 overrides 里也可能有同名文件，认错了会拿别人的清单去装）
    if has_root(names, "manifest.json") || has_root(names, "modrinth.index.json") {
        return DroppedKind::Modpack;
    }

    // ---------- ② Mod ----------
    // 四种加载器各自的元数据文件（ADR-020 的同一套事实来源）
    const MOD_MARKERS: [&str; 5] = [
        "fabric.mod.json",
        "quilt.mod.json",
        "META-INF/mods.toml",
        "META-INF/neoforge.mods.toml",
        "mcmod.info",
    ];
    if MOD_MARKERS.iter().any(|m| has_root(names, m)) {
        return DroppedKind::Resource(ResourceKind::Mod);
    }

    // ---------- ③ 光影（先于资源包：光影包里也常带 pack.mcmeta） ----------
    if has_dir(names, "shaders") {
        return DroppedKind::Resource(ResourceKind::Shader);
    }

    // ---------- ④ 资源包 / 数据包（都靠 pack.mcmeta，用 assets/ 与 data/ 分开） ----------
    if has_root(names, "pack.mcmeta") {
        if has_dir(names, "data") && !has_dir(names, "assets") {
            return DroppedKind::Resource(ResourceKind::Datapack);
        }
        return DroppedKind::Resource(ResourceKind::ResourcePack);
    }

    DroppedKind::Unknown(
        "里没有整合包清单、没有 Mod 信息、也没有 pack.mcmeta —— \
         它看起来不是一个能装的东西（如果你确定它能用，告诉我它属于哪一类）"
            .to_string(),
    )
}

/// 装完之后**必须告诉用户**的话（没有要提醒的返回 `None`）。
///
/// ★ 判据都在这里、不在命令层：这两句话分别对应 ADR-015 的两条要求
///   （"光影包必须配合 OptiFine 或 Iris" 与"装了也读不到就别说装好了"）。
///   做成纯函数是为了能用真值表钉住（见测试）。
pub fn note_for(kind: &DroppedKind, has_loader: bool, has_shader_support: bool) -> Option<String> {
    match kind {
        DroppedKind::Resource(ResourceKind::Mod) if !has_loader => Some(
            "★ 这个实例是纯原版（没有加载器），Mod 放进去也不会被读取 —— \
             要用它得先给这个实例装一个加载器（Fabric / Forge / NeoForge / Quilt）"
                .to_string(),
        ),
        DroppedKind::Resource(ResourceKind::Shader) if !has_shader_support => Some(
            "★ 这个实例没有 OptiFine 或 Iris，光影不会生效 —— 想用的话先装上其中一个"
                .to_string(),
        ),
        /*
         * 目录：里面是 Mod 还是光影要逐个看 —— 提示语由命令层按**实际装了哪些**给
         * （`install_dropped_dir`），这里给不出"一句话"就不给。
         */
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 造一个**真的 zip**（只放条目名，内容空）：判定只看目录，不看内容
    fn zip_with(entries: &[&str]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for e in entries {
                w.start_file(*e, opts).unwrap();
                w.write_all(b"x").unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn a_curseforge_pack_is_a_modpack_not_a_mod() {
        // ★ 这条就是"顺序不能换"的判据：整合包里**也有** mods/ 与 manifest.json
        let bytes = zip_with(&["manifest.json", "mods/jei.jar", "overrides/config/x.toml"]);
        assert_eq!(classify_bytes(&bytes, "pack.zip"), DroppedKind::Modpack);
    }

    #[test]
    fn a_modrinth_pack_is_a_modpack_even_if_named_zip() {
        let bytes = zip_with(&["modrinth.index.json", "overrides/mods/a.jar"]);
        assert_eq!(classify_bytes(&bytes, "随便起的名字.zip"), DroppedKind::Modpack);
    }

    #[test]
    fn a_fabric_mod_jar_is_a_mod() {
        let bytes = zip_with(&["fabric.mod.json", "net/example/Mod.class"]);
        assert_eq!(
            classify_bytes(&bytes, "sodium.jar"),
            DroppedKind::Resource(ResourceKind::Mod)
        );
        // Forge / NeoForge / 老版 Forge 的写法都要认
        for marker in ["META-INF/mods.toml", "META-INF/neoforge.mods.toml", "mcmod.info", "quilt.mod.json"] {
            let z = zip_with(&[marker]);
            assert_eq!(
                classify_bytes(&z, "m.jar"),
                DroppedKind::Resource(ResourceKind::Mod),
                "{marker} 应该被认成 Mod"
            );
        }
    }

    /// ★ Mod 判定要**先于**资源包：有些 Mod 的 jar 里也塞了 `pack.mcmeta`（自带的示例资源包）
    #[test]
    fn mod_wins_over_resource_pack_when_both_markers_exist() {
        let bytes = zip_with(&["fabric.mod.json", "pack.mcmeta"]);
        assert_eq!(
            classify_bytes(&bytes, "both.jar"),
            DroppedKind::Resource(ResourceKind::Mod)
        );
    }

    #[test]
    fn a_resource_pack_is_a_resource_pack_and_a_shader_is_a_shader() {
        let rp = zip_with(&["pack.mcmeta", "assets/minecraft/lang/zh_cn.json"]);
        assert_eq!(
            classify_bytes(&rp, "材质包.zip"),
            DroppedKind::Resource(ResourceKind::ResourcePack)
        );

        // ★ 光影包里常带 pack.mcmeta，但 `shaders/` 才是它的身份
        let sh = zip_with(&["pack.mcmeta", "shaders/shadow.fsh", "shaders/gbuffers_terrain.vsh"]);
        assert_eq!(
            classify_bytes(&sh, "光影.zip"),
            DroppedKind::Resource(ResourceKind::Shader)
        );

        // 数据包：pack.mcmeta + data/（没有 assets/）
        let dp = zip_with(&["pack.mcmeta", "data/example/recipe/x.json"]);
        assert_eq!(
            classify_bytes(&dp, "datapack.zip"),
            DroppedKind::Resource(ResourceKind::Datapack)
        );
    }

    #[test]
    fn pack_manifest_only_counts_at_the_root() {
        // overrides 里的 manifest.json **不算**（那是整合包内容的一部分）
        let bytes = zip_with(&["overrides/manifest.json", "config/x.toml"]);
        assert!(matches!(classify_bytes(&bytes, "x.zip"), DroppedKind::Unknown(_)));
    }

    /// ★ 每一条"认不出来"的理由都要**带上文件名**：一次拖 20 个文件时，
    ///   不带名字的理由等于没说（用户不知道该处理哪一个）。
    #[test]
    fn every_unknown_reason_names_the_file() {
        // ① 能读的 zip，但里面没有能认的东西
        let junk = zip_with(&["readme.txt", "image.png"]);
        let k = classify_bytes(&junk, "我的文件.zip");
        match &k {
            DroppedKind::Unknown(why) => {
                assert!(why.starts_with("「我的文件.zip」"), "理由要以文件名开头：{why}");
                assert!(why.contains("不是一个能装的东西"), "{why}");
            }
            other => panic!("不该认出类别：{other:?}"),
        }
        assert_eq!(k.display(), "认不出来");
        assert!(!k.reason().is_empty());

        // ② 根本不是压缩包（拖进来一个 .txt）
        let k2 = classify_bytes(b"hello, not a zip", "note.txt");
        assert!(k2.reason().contains("「note.txt」"), "{}", k2.reason());
        assert!(k2.reason().contains("不是有效的压缩包"), "{}", k2.reason());

        // ③ 盘上的文件走的是另一条实现，也要带名字
        let d = std::env::temp_dir().join(format!("ieml-drop-name-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        let f = d.join("说明.txt");
        std::fs::write(&f, b"not a zip").unwrap();
        let k3 = classify_file(&f);
        assert!(k3.reason().contains("说明.txt"), "{}", k3.reason());
    }

    /*
     * ---------- 装完要说的那两句话（ADR-015 的两条要求） ----------
     *
     * 做成纯函数是为了能用真值表钉住：**只有该说的时候才说** ——
     * 说了不该说的，用户会去关一个正常的东西；该说没说，他会对着一个读不到的文件发呆。
     */

    #[test]
    fn notes_fire_only_when_the_install_would_be_useless() {
        let m = DroppedKind::Resource(ResourceKind::Mod);
        let s = DroppedKind::Resource(ResourceKind::Shader);
        let rp = DroppedKind::Resource(ResourceKind::ResourcePack);

        // 纯原版装 Mod → 必须提醒
        assert!(note_for(&m, false, false).is_some());
        // 有加载器 → 什么都不说
        assert!(note_for(&m, true, false).is_none());
        // 没 OptiFine/Iris 装光影 → 必须提醒；有 → 不说
        assert!(note_for(&s, true, false).is_some());
        assert!(note_for(&s, true, true).is_none());
        // 资源包与整合包**从来不需要**这类提醒
        assert!(note_for(&rp, false, false).is_none());
        assert!(note_for(&DroppedKind::Modpack, false, false).is_none());
        // 目录里的东西要逐个看才知道该说什么（由命令层按实际装了哪些给）
        assert!(note_for(&DroppedKind::Folder, false, false).is_none());

        // 提醒里要有"下一步做什么"，不能只说"不行"
        let n = note_for(&m, false, false).unwrap();
        assert!(n.contains("加载器"), "{n}");
        let n2 = note_for(&s, true, false).unwrap();
        assert!(n2.contains("OptiFine") && n2.contains("Iris"), "{n2}");
    }

    /*
     * ---------- 拖进来一个**目录**（`classify_dir` / `plan_dir`） ----------
     *
     * 这一组用**真的临时目录**测：判定本身包含"这一层有哪些文件"，纯造字符串测不出来。
     */

    /// 真造一个目录（测试结束不清理 —— 用进程 id 分隔，不撞别人的）
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("ieml-drop-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_zip(path: &std::path::Path, entries: &[&str]) {
        std::fs::write(path, zip_with(entries)).unwrap();
    }

    /// 一包混杂的文件：能装的装上、不能装的说清为什么 —— **一个都不能静默丢掉**
    #[test]
    fn a_folder_installs_what_it_can_and_says_why_for_the_rest() {
        let d = temp_dir("mixed");
        write_zip(&d.join("sodium.jar"), &["fabric.mod.json"]); // Mod
        write_zip(
            &d.join("材质.zip"),
            &["pack.mcmeta", "assets/minecraft/lang/zh_cn.json"],
        ); // 资源包
        std::fs::write(d.join("readme.txt"), b"mods I like").unwrap(); // 不是压缩包
        std::fs::create_dir_all(d.join("old")).unwrap(); // 子目录

        let (installable, skipped) = plan_dir(&d);
        let names: Vec<String> = installable
            .iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["sodium.jar".to_string(), "材质.zip".to_string()]);
        // 两类各自的去向不能混（Mod 进 mods/，资源包进 resourcepacks/）
        assert_eq!(installable[0].1, ResourceKind::Mod);
        assert_eq!(installable[1].1, ResourceKind::ResourcePack);

        assert_eq!(skipped.len(), 2, "跳过两条要各带理由：{skipped:?}");
        assert!(skipped.iter().any(|s| s.contains("readme.txt")), "{skipped:?}");
        assert!(skipped.iter().any(|s| s.contains("old/")), "{skipped:?}");

        // 目录本身：有能装的就认（不是"认不出来"）
        assert_eq!(classify_dir(&d), DroppedKind::Folder);
        assert_eq!(classify_dir(&d).display(), "目录");
    }

    /// 扩展名与内容对不上时**跳过并说清楚**（装了游戏也读不到，不能算装上）
    ///
    /// ★ 用什么当例子很讲究：`.jar` **不能**用 —— 资源包/光影/数据包的
    ///   `extensions()` 里本来就有 `.jar`（老版本与特殊用途真的这么发），
    ///   拿它当"扩展名不对"会让这条测试变成假的。
    ///   用真会遇到的场景：从网盘/聊天软件下来的文件被改成了别的后缀。
    #[test]
    fn a_file_whose_extension_does_not_match_is_skipped_with_a_reason() {
        let d = temp_dir("badext");
        // 内容是资源包（pack.mcmeta + assets/），名字却带了个不是 zip/jar 的后缀
        write_zip(&d.join("材质.pack"), &["pack.mcmeta", "assets/x/y.json"]);
        let (installable, skipped) = plan_dir(&d);
        assert!(installable.is_empty(), "扩展名不对的不该装：{installable:?}");
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].contains("材质.pack"), "{skipped:?}");
        assert!(skipped[0].contains("资源包"), "要说清它看着像什么：{skipped:?}");
        assert!(skipped[0].contains(".zip"), "要说出对的后缀：{skipped:?}");
    }

    /// 空目录 / 只有垃圾的目录：**说清楚**，不能"拖进去没反应"
    #[test]
    fn an_empty_or_useless_folder_is_told_so() {
        let empty = temp_dir("empty");
        let k = classify_dir(&empty);
        match &k {
            DroppedKind::Unknown(why) => {
                assert!(why.contains("没有能装的文件"), "{why}");
                assert!(why.contains("只看这一层"), "要说明范围：{why}");
            }
            other => panic!("不该认出类别：{other:?}"),
        }

        // 只装了子目录（用户很可能以为"我明明拖了 mods 进来"）
        let only_sub = temp_dir("onlysub");
        std::fs::create_dir_all(only_sub.join("mods")).unwrap();
        let k2 = classify_dir(&only_sub);
        match &k2 {
            // ★ 这里**不许**只回一句"没有能装的文件"：用户看得见里面那些 jar，
            //   要说的是"你拖的是上一级，把里面的 mods 拖进来"
            DroppedKind::Unknown(why) => {
                assert!(why.contains("mods/"), "要点名那个子目录：{why}");
                assert!(why.contains("整个拖进来"), "要给下一步：{why}");
            }
            other => panic!("不该认出类别：{other:?}"),
        }
    }

    /// 别的启动器 / 官方启动器留下的**整个游戏目录**：如实说不支持整个导入，并给能立刻做的那一步
    #[test]
    fn another_launchers_game_folder_is_answered_honestly() {
        let d = temp_dir("mcroot");
        std::fs::create_dir_all(d.join("versions").join("1.20.1")).unwrap();
        // ★ 真实的 .minecraft 里**也有** mods/ —— "先判 mods/" 的那种写法会给出
        //   一句偏离重点的话（用户问的是"能不能整个搬过来"）
        std::fs::create_dir_all(d.join("mods")).unwrap();
        std::fs::write(d.join("options.txt"), b"lang:zh_cn").unwrap();
        std::fs::write(d.join("launcher_profiles.json"), b"{}").unwrap();

        let k = classify_dir(&d);
        match &k {
            DroppedKind::Unknown(why) => {
                assert!(why.contains("游戏目录"), "{why}");
                assert!(why.contains("还不能整个导入"), "不能假装能导：{why}");
                assert!(why.contains("mods"), "要给出能立刻做的那一步：{why}");
            }
            other => panic!("不该认出类别：{other:?}"),
        }

        // ★ 有 versions/ 但同时**这一层就有**能装的文件时，按"能装"处理（别抢）
        write_zip(&d.join("sodium.jar"), &["fabric.mod.json"]);
        assert_eq!(classify_dir(&d), DroppedKind::Folder);
    }

    /// 解压出来的整合包目录：如实告诉他"压成 zip 再拖"，并给第二条路
    #[test]
    fn an_extracted_pack_folder_is_told_to_be_zipped() {
        let d = temp_dir("unzipped");
        std::fs::write(d.join("manifest.json"), b"{}").unwrap();
        std::fs::create_dir_all(d.join("mods")).unwrap();
        write_zip(&d.join("mods/jei.jar"), &["META-INF/mods.toml"]);

        let k = classify_dir(&d);
        match &k {
            DroppedKind::Unknown(why) => {
                assert!(why.contains("解压出来的"), "{why}");
                assert!(why.contains("压成 zip"), "要给下一步：{why}");
                assert!(why.contains("mods"), "要给第二条路：{why}");
            }
            other => panic!("不该认出类别：{other:?}"),
        }
        // ★ 不能把它当成"一包 Mod"直接装 —— 那会往 mods/ 里丢一个整合包的目录
        assert_ne!(k, DroppedKind::Folder);

        // 目录里的 manifest.json 也不算"这个文件是整合包"（它已经解压了）
        assert!(matches!(
            classify_file(&d.join("manifest.json")),
            DroppedKind::Unknown(_)
        ));
    }

    /// 按路径分流：目录走目录那套，文件走文件那套
    #[test]
    fn classify_path_routes_folders_and_files_differently() {
        let d = temp_dir("route");
        write_zip(&d.join("a.jar"), &["fabric.mod.json"]);
        assert_eq!(
            classify_path(&d.join("a.jar")),
            DroppedKind::Resource(ResourceKind::Mod)
        );
        assert_eq!(classify_path(&d), DroppedKind::Folder);
    }
}
