//! **中文搜 Mod**：本地别名表 + 平台原生搜索双路（ADR-016）。
//!
//! ## 为什么要有它
//!
//!   中国玩家记的是**中文名**：「工业时代」「等价交换」「暮色森林」。
//!   而 Modrinth / CurseForge 上的项目叫 `ic2`、`projecte`、`twilightforest` ——
//!   把中文原样丢给它们的搜索接口，多半是**零结果**，而用户会以为"没有这个 Mod"。
//!   （把"查不到"说成"没有"是这个仓库反复栽过的坑。）
//!
//! ## 三步（ADR-016 的原文顺序）
//!
//! ```text
//!   ① 查本地别名表：命中 → 用英文关键词去搜（可能有好几个候选，按顺序试）
//!   ② 没命中 → 原样提交给平台（Modrinth 对中文有一点支持）
//!   ③ 还是没有结果 → 界面上如实说"试试英文名"（**这一条在界面**，不在这里）
//! ```
//!
//! ## 判据（本模块的单测钉住的部分）
//!
//!   * **只对含中文的输入查表**：英文查询一个字节都不许被改（用户输入
//!     `sodium` 却去搜 `jei` 是灾难）；
//!   * **最长匹配优先**：`工业时代2` 命中 `工业时代` 而不是 `工业`；
//!   * **候选是"按顺序试"的列表**，不是"只试第一个"（同一个 Mod 在 Modrinth 与
//!     CurseForge 上的 slug 经常不同，只试一个等于放弃一半）；
//!   * 查不到就返回 `None` —— **绝不编一个英文词出来**。
//!
//! ## 词表的边界（说实话的部分）
//!
//!   ADR-016 说"优先复用开源词表，自建部分靠搜索日志 + 人工校对"。这里是一张
//!   **起步表**：只收**我能在真机上核对到结果**的那些条目（见
//!   `tools/live/live-alias-check.mjs` —— 它对每个条目真的发一次搜索，
//!   命中不了就报出来）。宁可表短而准，也不要一张"看起来很长、一半搜不到"的表：
//!   后者会让用户对"启动器能搜中文"这件事失去信任。
//!
//!   ★ 表是**静态数据**、一次构建进包、不做网络更新（ADR-016 明文）。

/// 一条别名：中文名 → 依次尝试的英文关键词
pub struct Alias {
    /// 用户可能输入的中文名（可以有多个说法，见 [`TABLE`]）
    pub key: &'static str,
    /// 拿去搜的英文词，**按顺序试**（第一个最可能命中）
    pub terms: &'static [&'static str],
}

/// 起步词表（每条都有真机判据；见模块说明）
///
/// ★ 排序无所谓（匹配按"最长键优先"），但**同一个项目的中文说法要写成独立条目**
///   （「物品管理器」与「JEI」是两种输入习惯，不该要求用户知道哪个是"官方"说法）。
pub const TABLE: &[Alias] = &[
    /*
     * ★★ 候选词的**顺序与写法**不是猜的：每一项都由
     *   `tools/live/live-alias-check.mjs` 真的发一次搜索核对过
     *   （写错了的表现很具体：用户搜「暮色森林」会得到一堆同人附属项目，
     *     而正主一条都没有 —— 第一版就是这样，探针当场抓到）。
     *
     *   ★ 一个反直觉的实测结论：**平台的搜索按"项目名"打分，不按 slug**。
     *     所以对老牌 Mod，候选词要写**名字**（`The Twilight Forest`）而不是
     *     slug（`twilightforest`）—— 后者在 CurseForge 上连正主都搜不出来
     *     （搜到的全是附属）。slug 形式仍然留着当后面的候选，一份都别丢。
     */
    // ---- 老牌大 Mod（中文圈叫法与英文名差得最远的那些） ----
    Alias { key: "工业时代", terms: &["Industrial Craft 2", "industrial-craft", "industrialcraft", "ic2"] },
    Alias { key: "工业时代2", terms: &["Industrial Craft 2", "industrial-craft", "industrialcraft", "ic2"] },
    Alias { key: "等价交换", terms: &["projecte", "ProjectE", "equivalent-exchange"] },
    Alias { key: "暮色森林", terms: &["The Twilight Forest", "twilight forest", "twilightforest"] },
    Alias { key: "通用机械", terms: &["mekanism"] },
    Alias { key: "热力膨胀", terms: &["Thermal Expansion", "thermal-expansion", "thermal"] },
    Alias { key: "建筑", terms: &["BuildCraft", "buildcraft"] },
    Alias { key: "林业", terms: &["Forestry", "forestry"] },
    Alias { key: "更多实用设备", terms: &["Extra Utilities", "extra-utilities"] },
    Alias { key: "匠魂", terms: &["Tinkers Construct", "tinkers-construct", "tinkers-construct-3"] },
    Alias { key: "神秘时代", terms: &["Thaumcraft", "thaumcraft"] },
    Alias { key: "植物魔法", terms: &["botania"] },
    Alias { key: "血魔法", terms: &["Blood Magic", "blood-magic"] },
    Alias { key: "我的工厂", terms: &["MineFactory Reloaded", "minefactory-reloaded"] },
    Alias { key: "应用能源", terms: &["Applied Energistics 2", "applied-energistics-2", "ae2"] },
    Alias { key: "应用能源2", terms: &["Applied Energistics 2", "applied-energistics-2", "ae2"] },
    Alias { key: "无中生有", terms: &["Ex Nihilo", "ex-nihilo"] },
    Alias { key: "虚无世界", terms: &["Advent of Ascension", "nevermine", "advent-of-ascension"] },
    // ---- 现在最常搜的 ----
    Alias { key: "机械动力", terms: &["create"] },
    Alias { key: "农夫乐事", terms: &["farmers-delight"] },
    Alias { key: "物品管理器", terms: &["jei", "jei-just-enough-items"] },
    Alias { key: "合成辅助", terms: &["jei", "rei"] },
    Alias { key: "钠", terms: &["sodium"] },
    Alias { key: "锂", terms: &["lithium"] },
    Alias { key: "磷", terms: &["phosphor"] },
    Alias { key: "铷", terms: &["rubidium"] },
    Alias { key: "光影前置", terms: &["iris"] },
    Alias { key: "虹彩", terms: &["iris"] },
    Alias { key: "苹果皮", terms: &["apple-skin", "appleskin"] },
    Alias { key: "玉", terms: &["jade"] },
    Alias { key: "旅行地图", terms: &["journeymap"] },
    Alias { key: "小地图", terms: &["xaeros-minimap", "journeymap"] },
    Alias { key: "投影", terms: &["litematica"] },
    Alias { key: "地毯", terms: &["carpet"] },
    Alias { key: "星辉魔法", terms: &["astral-sorcery"] },
    Alias { key: "匠造", terms: &["tinkers-construct"] },
    Alias { key: "更多的合成", terms: &["crafttweaker"] },
    Alias { key: "合成修改", terms: &["crafttweaker", "kubejs"] },
    Alias { key: "优化", terms: &["embeddium", "sodium", "optifine"] },
    Alias { key: "遗迹", terms: &["yungs-better-dungeons"] },
    Alias { key: "地牢", terms: &["yungs-better-dungeons"] },
    Alias { key: "村民", terms: &["easy-villagers", "villager-names"] },
    Alias { key: "背包", terms: &["travelers-backpack", "sophisticated-backpacks"] },
    Alias { key: "储物抽屉", terms: &["storage-drawers"] },
    Alias { key: "抽屉", terms: &["storage-drawers"] },
    Alias { key: "管道", terms: &["pipez", "mekanism"] },
    Alias { key: "火力发电机", terms: &["mekanism"] },
    Alias { key: "起源", terms: &["origins"] },
    Alias { key: "农夫", terms: &["farmers-delight"] },
    Alias { key: "自动钓鱼", terms: &["autofish"] },
    Alias { key: "血量显示", terms: &["neat", "ToroHUD", "torohud"] },
    Alias { key: "一键背包整理", terms: &["inventory-profiles-next", "inventory-tweaks"] },
    Alias { key: "连锁采集", terms: &["veinmining", "vein-mining"] },
    Alias { key: "经验修补", terms: &["mending"] },
    Alias { key: "灾厄村民", terms: &["illagers"] },
    Alias { key: "结构", terms: &["structory", "when-dungeons-arise"] },
    Alias { key: "更好的下界", terms: &["better-nether"] },
    Alias { key: "更好的末地", terms: &["better-end"] },
    Alias { key: "暮色", terms: &["twilightforest"] },
    Alias { key: "科幻", terms: &["techreborn"] },
    Alias { key: "科技复兴", terms: &["techreborn"] },
    Alias { key: "简单农业", terms: &["simple-farming"] },
    Alias { key: "丰收", terms: &["harvest-with-ease"] },
    Alias { key: "附魔描述", terms: &["enchdesc", "enchantment-descriptions"] },
    Alias { key: "苹果核", terms: &["applecore"] },
    Alias { key: "豆腐", terms: &["tofucraft"] },
    Alias { key: "竹", terms: &["bamboo"] },
    Alias { key: "更多箱子", terms: &["iron-chests"] },
    Alias { key: "铁箱子", terms: &["iron-chests"] },
    Alias { key: "滑翔伞", terms: &["paraglider"] },
    Alias { key: "声音物理", terms: &["sound-physics-remastered"] },
    Alias { key: "动态光源", terms: &["dynamic-lights", "lambdynamiclights"] },
    Alias { key: "光影", terms: &["iris", "oculus"] },
    Alias { key: "连接材质", terms: &["continuity"] },
    Alias { key: "苔藓", terms: &["moss"] },
];

impl Alias {
    /// 这条别名是不是"用户想要的那个"（用于真机探针逐条核对时显示）
    pub fn display_terms(&self) -> String {
        self.terms.join(" / ")
    }
}

/// 查询里有没有中文（CJK 统一表意文字）
///
/// ★ 只在**有中文**时才查表：英文查询必须原样透传。
///   这条不是优化，是判据 —— 用户输 `sodium` 却被换成 `jei` 是灾难。
pub fn has_chinese(s: &str) -> bool {
    s.chars().any(|c| {
        let n = c as u32;
        (0x4E00..=0x9FFF).contains(&n)      // 基本区
            || (0x3400..=0x4DBF).contains(&n) // 扩展 A
    })
}

/// 归一化：去掉空白、全角转半角、统一小写
///
/// ★ 为什么要去空白：用户会输「工业 时代」「物品 管理器」，
///   而词表里没有空格。判据见单测。
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_whitespace() {
            continue;
        }
        // 全角 ASCII（！-～）→ 半角
        let n = c as u32;
        if (0xFF01..=0xFF5E).contains(&n) {
            out.push(char::from_u32(n - 0xFEE0).unwrap_or(c));
        } else {
            out.push(c);
        }
    }
    out.to_lowercase()
}

/// 命中的结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasHit {
    /// 词表里的那一条（中文）
    pub key: String,
    /// 依次要试的英文关键词
    pub terms: Vec<String>,
}

/// 查表（ADR-016 的第 ① 步）
///
/// 匹配规则（三条，都有单测）：
///   1. **最长键优先**：`工业时代2` 命中「工业时代2」而不是「工业时代」；
///   2. 键是输入的**子串**（`我想找暮色森林mod` 也能中）；
///   3. 输入是键的**前缀**且不短于两个字（边打边搜时「暮色」→「暮色森林」）。
///
/// 没有中文、或者什么都没匹配上 → `None`（**不编词**）。
pub fn lookup(query: &str) -> Option<AliasHit> {
    if !has_chinese(query) {
        return None;
    }
    let q = normalize(query);
    if q.is_empty() {
        return None;
    }

    // ① 键是输入的子串：取**最长**的那个键
    let mut best: Option<&Alias> = None;
    for a in TABLE {
        let k = normalize(a.key);
        if k.is_empty() || !q.contains(&k) {
            continue;
        }
        if best.map(|b| normalize(b.key).chars().count() < k.chars().count()).unwrap_or(true) {
            best = Some(a);
        }
    }
    if let Some(a) = best {
        return Some(AliasHit {
            key: a.key.to_string(),
            terms: a.terms.iter().map(|t| t.to_string()).collect(),
        });
    }

    // ② 输入是某个键的前缀（够长才算）：取第一个匹配（词表顺序 = 常用度）
    if q.chars().count() >= 2 {
        for a in TABLE {
            let k = normalize(a.key);
            if k.starts_with(&q) {
                return Some(AliasHit {
                    key: a.key.to_string(),
                    terms: a.terms.iter().map(|t| t.to_string()).collect(),
                });
            }
        }
    }
    None
}

/// 界面用的一句话（把"我拿什么去搜的"如实说出来）
pub fn explain(hit: &AliasHit) -> String {
    format!(
        "「{}」是中文叫法，按 {} 搜的",
        hit.key,
        hit.terms.first().cloned().unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★★ 最重要的一条：**英文查询一个字节都不许被改**
    #[test]
    fn english_queries_are_never_rewritten() {
        for q in ["sodium", "JEI", "Create", "applied energistics", "twilightforest"] {
            assert!(lookup(q).is_none(), "{q} 不该命中别名表");
            assert!(!has_chinese(q), "{q} 不含中文");
        }
    }

    /// 常见中文叫法要能命中，而且**给的是按顺序试的候选**
    #[test]
    fn common_chinese_names_map_to_english_terms() {
        let hit = lookup("暮色森林").expect("暮色森林必须命中");
        assert_eq!(hit.key, "暮色森林");
        /*
         * ★ 候选词是**项目名**而不是 slug —— 真机实测：CurseForge 按名字打分，
         *   用 `twilightforest` 搜连正主都搜不出来（全是附属项目）。
         */
        assert_eq!(hit.terms[0], "The Twilight Forest");

        let jei = lookup("物品管理器").expect("物品管理器必须命中");
        assert_eq!(jei.terms[0], "jei");

        // 有多个候选的：**顺序有意义**（先试最可能的）
        let ic2 = lookup("工业时代2").expect("工业时代2 必须命中");
        assert_eq!(ic2.key, "工业时代2", "最长匹配优先");
        assert_eq!(ic2.terms[0], "Industrial Craft 2");
        assert!(
            ic2.terms.iter().any(|t| t == "ic2"),
            "slug 形式也要留着当后面的候选"
        );
    }

    /// 最长匹配：不能因为「工业时代」在表里就把「工业时代2」也映射到它
    #[test]
    fn the_longest_key_wins() {
        assert_eq!(lookup("工业时代2").unwrap().key, "工业时代2");
        assert_eq!(lookup("工业时代").unwrap().key, "工业时代");
        // 两词的候选可以一样（同一个 Mod 的两种叫法），但**键**必须是最长那个
        assert_eq!(lookup("应用能源2").unwrap().key, "应用能源2");
    }

    /// 键是输入的一部分也能中（用户会连着打一串）
    #[test]
    fn a_key_inside_a_longer_query_still_matches() {
        let hit = lookup("我想找暮色森林mod").expect("包含也算命中");
        assert_eq!(hit.key, "暮色森林");
        let hit2 = lookup("有没有 机械动力 整合包").expect("带空格也要中");
        assert_eq!(hit2.terms[0], "create");
    }

    /// 边打边搜：输入是键的前缀（够两个字）
    #[test]
    fn a_prefix_of_a_key_matches_while_typing() {
        /*
         * ★ 「暮色」在词表里**自己也有一条**（玩家的俗称），所以它命中的是那一条 ——
         *   精确的键优先于"某键的前缀"。判据因此看**候选词**，不看键名。
         *   （第一版这里断言键等于「暮色森林」，被真机/单测当场纠正。）
         */
        let shorthand = lookup("暮色").expect("「暮色」应当能命中（俗称）");
        assert_eq!(shorthand.terms[0], "twilightforest");

        // 真正的前缀匹配：打的字比键短、表里没有同名的键
        let typing = lookup("物品管").expect("「物品管」应当按前缀命中");
        assert_eq!(typing.key, "物品管理器");
        assert_eq!(typing.terms[0], "jei");

        // 一个字太短，不许猜（「匠」既可能是匠魂也可能是别的）
        assert!(lookup("匠").is_none(), "一个字不该猜");
        // 完全无关的中文：如实返回 None（不编词）
        assert!(lookup("完全不存在的模组名").is_none());
    }

    /// 归一化：空格、全角、大小写都不影响匹配
    #[test]
    fn normalization_handles_spaces_and_fullwidth() {
        assert_eq!(normalize(" 物品 管理器 "), "物品管理器");
        assert_eq!(normalize("ＪＥＩ"), "jei");
        assert_eq!(lookup("物品 管理器").unwrap().terms[0], "jei");
    }

    /// 词表本身要干净：键不重复、候选非空、没有空字符串
    #[test]
    fn the_table_is_well_formed() {
        let mut seen = std::collections::HashSet::new();
        for a in TABLE {
            assert!(!a.key.trim().is_empty(), "有空键");
            assert!(has_chinese(a.key), "键「{}」里没有中文", a.key);
            assert!(!a.terms.is_empty(), "「{}」没有候选词", a.key);
            for t in a.terms {
                assert!(!t.trim().is_empty(), "「{}」有空的候选词", a.key);
                assert!(!has_chinese(t), "「{}」的候选词「{t}」里有中文（应当是英文关键词）", a.key);
            }
            assert!(seen.insert(normalize(a.key)), "键「{}」重复了", a.key);
        }
        // 起步表不追求长：但也不该短到没有意义
        assert!(TABLE.len() >= 30, "词表只有 {} 条，太少", TABLE.len());
    }

    /// 界面那句话要说得出"拿什么搜的"
    #[test]
    fn the_explanation_names_the_term() {
        let hit = lookup("物品管理器").unwrap();
        let text = explain(&hit);
        assert!(text.contains("物品管理器"), "{text}");
        assert!(text.contains("jei"), "{text}");
    }
}
