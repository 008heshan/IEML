//! 平台相关：数据目录、Java 探测、机器信息
//!
//! 这里的原则：**能探测就探测，探测不到就给出可行动的说明**，
//! 绝不假装知道（例如本机没有 Java 时，要告诉用户"需要 Java 21"而不是"启动失败"）。

use crate::domain::java::JavaRuntime;
use std::path::{Path, PathBuf};

/// 应用数据目录
#[derive(Debug, Clone)]
pub struct AppPaths {
    /// **游戏**根目录（用户选的那个）—— 里面只该有游戏的东西（`.minecraft`）。
    pub root: PathBuf,
    /// 启动器**自己**的数据目录（实例清单 / 自动下载的 Java / 缓存 / 日志）。
    ///
    /// ★★ 2026-09-23（用户：「这个根目录只创建装游戏的根目录，**不要附带启动器文件**」
    ///   以及确认「启动器自己的目录要搬出游戏根目录：**是的**」）：
    ///   这几样东西与"游戏在哪"无关，放在用户挑的游戏盘里只会让那个目录变脏，
    ///   还会在换盘时被一起留下。统一放到系统的应用数据目录
    ///   （Windows：`%APPDATA%\IEML`）。
    ///
    ///   ★ 与 `root` 的关系：`root` 是**游戏的家**，`own_root` 是**启动器的家**。
    ///     用户换游戏目录时，只有前者变。
    pub own_root: PathBuf,
    /// 共享游戏文件（原版库、assets、已装版本）—— 多实例复用。
    ///
    /// ★★ 2026-09-15：它的**名字**从 `shared` 改成了 `.minecraft`
    ///   （用户要求"游戏文件应该和启动器数据绑定在一块，在启动器数据内部来个
    ///   `.minecraft` 这么个文件夹来存游戏数据，就像 PCL 那样"）。
    ///
    ///   字段名仍叫 `shared`（"共享"是它的**职责**，`.minecraft` 是它的**位置**）——
    ///   全仓库 45 处引用都走这个字段，所以换位置只需要改这一行。
    pub shared: PathBuf,
    /// 实例目录（在**游戏根目录**下：`<root>/instances`）
    ///
    /// ★★ 2026-09-24（用户：「我在用 D 盘的目录，为什么版本列表的版本给我定位到
    ///   `C:\Users\…\AppData\Roaming\IEML\instances` 了」）：
    ///   实例目录里装的是**游戏数据** —— 每个实例的游戏工作目录
    ///   （`game/` 里的 `saves` 存档、`mods`、`config`、`options.txt`）与它自己的
    ///   `natives` 都在这下面。它必须跟用户挑的**游戏盘**走，与 `.minecraft` 同级。
    ///
    ///   放在 `%APPDATA%` 里的两个直接后果（真机实测）：
    ///   ① 用户在 D 盘攒的实例**全部作废** —— `D:\IEML\instances` 有 6 个版本目录 /
    ///      122.8 MB，而 C 盘那份只有一个 30.9 MB 的空壳，清单里的三个实例里
    ///      有两个（`vanilla-262` / `vanilla-1122`）在 C 盘根本不存在；
    ///   ② 存档会悄悄写进系统盘，而用户在游戏根目录里永远找不到自己的世界。
    ///
    ///   所以 2026-09-23 那次"把 instances 一起搬进 own_root"**搬错了一半**：
    ///   清单 / 偏好 / Java / 缓存 / 日志留在 `own_root` 是对的（那才是启动器自己的东西），
    ///   实例目录不是 —— 见 `AppPaths::own_root` 的对比说明。
    pub instances: PathBuf,
    /// 自动下载的 Java（在 `own_root` 下）
    pub java: PathBuf,
    /// 缓存（在 `own_root` 下）
    pub cache: PathBuf,
    /// 日志（在 `own_root` 下）
    pub logs: PathBuf,
}

/// 游戏数据目录的名字（PCL 同款：数据根目录下的 `.minecraft`）
pub const GAME_DIR_NAME: &str = ".minecraft";

/// 老布局的名字（0.1.0-beta.2 及以前叫 `shared`）
pub const LEGACY_SHARED_NAME: &str = "shared";

impl AppPaths {
    pub fn resolve() -> Self {
        Self::from_root(resolve_data_root())
    }

    /// 从一个已知根目录拼出全部子路径（测试与"数据目录迁移"复用）
    ///
    /// ★★ 2026-09-23：启动器自己的目录现在挂在 **`own_root`**（`%APPDATA%\IEML`）
    ///   而不是游戏根目录下 —— 见 `AppPaths::own_root` 的说明。
    ///
    /// ★★ 2026-09-24：**实例目录是这条规矩的例外，它留在游戏根目录里**
    ///   （`<root>/instances`）—— 那里面是存档与 Mod，属于游戏数据，
    ///   必须跟着用户挑的游戏盘走。理由见 `AppPaths::instances` 的说明。
    pub fn from_root(root: PathBuf) -> Self {
        let own_root = default_own_root();
        Self {
            shared: root.join(GAME_DIR_NAME),
            instances: root.join("instances"),
            java: own_root.join("java"),
            cache: own_root.join("cache"),
            logs: own_root.join("logs"),
            root,
            own_root,
        }
    }

    /// ★ 数据根目录的**选址记录文件**（放在数据根目录旁边，不在里面）。
    ///
    ///   为什么不能放在数据目录里：选址记录本身就是"数据目录在哪"的答案，
    ///   放进被它决定的目录里是循环依赖 —— 一旦用户搬走数据目录，
    ///   启动器就再也找不到那条记录了。
    ///
    ///   位置：`dirs_data_dir()/IEML/datadir.txt`（也就是**旧的默认位置**）。
    ///   那个位置永远可写，而且与平台无关。
    pub fn location_file() -> PathBuf {
        legacy_data_roots()[0].join("datadir.txt")
    }

    /// 启动时确保**游戏根目录**存在。
    ///
    /// ★★ 2026-09-22（用户：「这个根目录只创建装游戏的根目录，**不要附带启动器文件**」）：
    ///   这里**只建游戏那一边**（游戏根目录 + 它的 `.minecraft` + `instances`）；
    ///   启动器自己的目录（java / cache / logs）改成
    ///   **用到时才建**（见 `ensure_own`）——
    ///   于是"刚选好的空目录"里不会再凭空冒出一堆启动器文件。
    ///
    ///   ★ 2026-09-24：`instances` 属于**游戏那一边**（它装的是存档与 Mod），
    ///     所以从 `ensure_own` 挪到了这里 —— 判据见 `AppPaths::instances`。
    ///     用户那句"不要附带启动器文件"针对的是**启动器自己的**文件，
    ///     不是"游戏根目录里一个子目录都不许有"（`.minecraft` 一直都在）。
    pub fn ensure(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.root)?;
        std::fs::create_dir_all(self.game_dir())?;
        std::fs::create_dir_all(&self.instances)?;
        Ok(())
    }

    /// 游戏目录（`.minecraft`）—— 版本、存档、Mod 都在这一层里
    pub fn game_dir(&self) -> PathBuf {
        self.root.join(".minecraft")
    }

    /// 启动器**自己的**目录。用到时才调（懒建，见 `ensure` 的说明）。
    ///
    /// ★ 2026-09-24：列表里**没有 `instances`** —— 它跟着游戏根目录，
    ///   由 `ensure()` 建（见 `AppPaths::instances`）；
    ///   也没有 `shared` —— 它的位置就是 `.minecraft`，同样由 `ensure()` 建。
    pub fn ensure_own(&self) -> std::io::Result<()> {
        for p in [&self.java, &self.cache, &self.logs] {
            std::fs::create_dir_all(p)?;
        }
        Ok(())
    }

    /// 某个实例的目录
    pub fn instance_dir(&self, slug: &str) -> PathBuf {
        self.instances.join(slug)
    }

    /// ★ 实例的**游戏目录** —— 也就是游戏进程的工作目录。
    ///   `saves/`、`mods/`、`config/`、`options.txt` 全都在这里，
    ///   启动时作为 `--gameDir` 传给游戏（见 commands_real::prepare_spec）。
    ///
    ///   为什么单独抽成方法：这个路径原来在三个地方各写了一遍
    ///   （启动 / 扫 Mod / 装 Mod），而其中两处写的是 `instance_dir`
    ///   而不是 `instance_dir/game` —— 结果是 Mod 下到了一个游戏永远不读的目录。
    ///   路径只允许有一个来源。
    pub fn instance_game_dir(&self, slug: &str) -> PathBuf {
        self.instance_dir(slug).join("game")
    }

    /// 实例的 mods 目录（属于游戏目录，不是实例目录）
    pub fn instance_mods_dir(&self, slug: &str) -> PathBuf {
        self.instance_game_dir(slug).join("mods")
    }

    /// ★★ **任意一种社区资源的安装目录**（Mod / 资源包 / 光影 / 数据包）。
    ///
    /// 与 `instance_mods_dir` 同源（都在**游戏目录**下，不是实例目录下）——
    /// 这是唯一会让"装好了但游戏读不到"出错的点：
    /// 游戏进程的工作目录是 `instances/{slug}/game`，
    /// 它只会在 `<gameDir>/resourcepacks` 里找资源包，别处一律看不见。
    ///
    /// `kind` 用 `domain::resources::ResourceKind`，目录名由它给
    /// （**只有一份**描述，见那个模块的说明）。
    pub fn instance_resource_dir(
        &self,
        slug: &str,
        kind: crate::domain::resources::ResourceKind,
    ) -> PathBuf {
        self.instance_game_dir(slug).join(kind.install_dir())
    }

    /* ============ 启动器自己的文件（★★ A-4 修复：搬出游戏根目录） ============ */

    /// ★★ 启动器自己的一个文件（`instances.json` / `prefs.json` /
    ///   `ms_client_id.txt` / `cf_api_key.txt`）—— 它们住在**启动器自己的家**
    ///   （`own_root`，Windows 上是 `%APPDATA%\IEML`），**不在游戏根目录里**。
    ///
    ///   2026-09-24（缺陷报告 A-4）：「启动器数据目录搬出游戏根目录」原来**只搬了一半** ——
    ///   这几个文件当时还留在游戏根目录里。真机后果：用户在「候选盘」那页删掉一个
    ///   游戏根目录，会**连实例清单与全部设置一起删掉**，而两道确认框里都没有这句话。
    ///
    ///   ★ 同日的第二次修正（见 `AppPaths::instances`）：搬走的是**启动器自己的**
    ///     东西（这四个文件 + java/cache/logs）；**实例目录搬回来了** ——
    ///     它装的是存档与 Mod，属于游戏数据，得跟用户挑的游戏盘走。
    pub fn own_file(&self, name: &str) -> PathBuf {
        self.own_root.join(name)
    }

    /// 同上，但用来**读**：优先 `own_root`，那儿没有才回退到游戏根目录的老位置。
    ///
    /// ★ 为什么要留回退：老用户（0.1.0-rc.1 及以前）的文件就在游戏根目录里。
    ///   启动时的 [`adopt_records`] 会把它们**复制**过来；万一复制失败
    ///   （磁盘满 / 权限），读这一侧仍然读得到老位置 —— 不至于让用户觉得"东西没了"。
    pub fn own_file_for_read(&self, name: &str) -> Option<PathBuf> {
        let own = self.own_file(name);
        if own.is_file() {
            return Some(own);
        }
        let legacy = self.legacy_record_file(name);
        if legacy.is_file() {
            return Some(legacy);
        }
        None
    }

    /// 这四个文件在**游戏根目录**里的老位置（0.1.0-rc.1 及以前）。
    pub fn legacy_record_file(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// 实例清单文件（`list_instances` / `save_instances` 用的那个）
    pub fn instances_file(&self) -> PathBuf {
        self.own_file("instances.json")
    }

    /// 全局偏好文件（主题 / 下载源 / 并发数 / 账号 uuid …）
    pub fn prefs_file(&self) -> PathBuf {
        self.own_file("prefs.json")
    }
}

fn dirs_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Application Support");
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".local/share");
    }
    PathBuf::from(".")
}

/* ====================== 数据目录选址（ADR：默认避开系统盘） ====================== */

/// 旧的（也是"记录文件"所在的）数据根目录。
///
/// ★ 顺序有意义：**第一个**就是记录文件的宿主目录，也是迁移的源目录。
pub fn legacy_data_roots() -> Vec<PathBuf> {
    vec![dirs_data_dir().join("IEML")]
}

/// 启动器**自己**的数据目录（实例清单 / Java / 缓存 / 日志）。
///
/// ★★ 2026-09-23：与"游戏在哪"**解耦** —— 见 `AppPaths::own_root`。
///   这里就用系统的应用数据目录（Windows `%APPDATA%`），
///   与游戏根目录在不在同一个盘无关。
///
/// ★ 为什么不做成"跟着便携模式走"：便携模式的语义是"整个程序连同数据一起带走"，
///   那需要把游戏数据也带上 —— 那是另一个决定（用户没要求），
///   现在只做"启动器自己的东西别弄脏游戏目录"这一件事。
fn default_own_root() -> PathBuf {
    /*
     * ★ 测试与自动化要能改：环境变量 `IEML_OWN_DIR` 覆盖。
     *   没有它的话，单测一跑就会去动**开发机真实的** %APPDATA%\IEML。
     */
    if let Ok(custom) = std::env::var("IEML_OWN_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    dirs_data_dir().join("IEML")
}


/// 一个候选磁盘上，我们打算用的子目录名
const DATA_DIR_NAME: &str = "IEML";

/// ★ 解析数据根目录。
///
/// 优先级（高 → 低），**每一步都留下证据，绝不猜**：
///   ① 环境变量 `IEML_DATA_DIR` —— 给"绿色版/多份配置"用的显式覆盖
///   ② 启动器 exe 旁边的 `ieml-portable.txt` —— 便携模式（内容是目录名）
///   ③ `datadir.txt` 记录 —— 上次选定/用户手选的结果
///   ④ `%APPDATA%\IEML` —— **只有在它不是系统盘时才用它**（老用户无感升级）
///   ⑤ 自动选址：**空闲空间最大的非系统盘**（本机是 D:）
///   ⑥ 实在找不到非系统盘 → 老实回到 `%APPDATA%\IEML`（并在记录里写明原因）
///
/// ## 为什么要做这件事
///
/// 用户的诉求：「数据目录应该默认避开系统盘」。
/// 一个装了十几个整合包的启动器，`libraries` + `assets` + 实例很容易超过
/// 20 GB；而系统盘通常是最小、最满、也最不该被写满的那一块（写满会
/// 让整个 Windows 出问题）。所以默认选址必须落在数据盘上。
pub fn resolve_data_root() -> PathBuf {
    // ① 环境变量覆盖
    if let Some(v) = std::env::var_os("IEML_DATA_DIR") {
        let p = PathBuf::from(v);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }

    // ② 便携模式：exe 旁边放一个 ieml-portable.txt
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        let flag = exe_dir.join("ieml-portable.txt");
        if flag.is_file() {
            return exe_dir.join(DATA_DIR_NAME);
        }
    }

    let location_file = AppPaths::location_file();

    // ③ 记录文件：只有"这一行确实指向一个我们能写的地方"才采信
    if let Ok(text) = std::fs::read_to_string(&location_file) {
        let line = text.lines().next().unwrap_or("").trim().to_string();
        if !line.is_empty() {
            let p = PathBuf::from(line);
            if is_usable_data_root(&p) {
                return p;
            }
            say!(
                "[IEML/paths] 记录里的数据目录不可用（{}），重新选址",
                p.display()
            );
        }
    }

    let legacy = legacy_data_roots()[0].clone();

    // ④ 老位置不在系统盘 → 保持原样（老用户升级后完全无感）
    if !is_on_system_drive(&legacy) {
        write_location(&location_file, &legacy);
        return legacy;
    }

    // ⑤ 自动选址：空闲空间最大的非系统盘
    if let Some(best) = pick_best_volume() {
        let root = best.path.join(DATA_DIR_NAME);
        if ensure_writable(&root) {
            say!(
                "[IEML/paths] 默认数据目录在系统盘上，已改到 {}（空闲 {:.1} GB）",
                root.display(),
                best.free_gb
            );
            write_location(&location_file, &root);
            return root;
        }
    }

    // ⑥ 兜底：没有别的盘可用（单盘机器）
    say!(
        "[IEML/paths] 没有可用的非系统盘，数据目录仍放在 {}",
        legacy.display()
    );
    write_location(&location_file, &legacy);
    legacy
}

fn write_location(file: &Path, root: &Path) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, format!("{}\n", root.display()));
}

/// 这个路径能不能当数据根目录：能建、能写。
fn is_usable_data_root(p: &Path) -> bool {
    if p.as_os_str().is_empty() {
        return false;
    }
    ensure_writable(p)
}

fn ensure_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".ieml-write-probe");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 玩家指定一个新的数据根目录（2026-09-17 用户要求）。
///
/// ## 语义：**新建一个，旧的原样不动**
///
/// 用户的原话是「单独建一个根目录，源目录不删」。所以这里**不做迁移** ——
/// 一个字节都不搬、也不删。切换之后：
///   * 新根目录是**空的**，游戏要重新装（该盘上的空间自己算）
///   * 旧根目录里的版本、存档、Mod **原封不动地留在那**，随时可以切回去
///
/// ★ 为什么不做"顺手搬过去"：那是一个会失败一半的操作（几十 GB、
///   跨盘、中途断电），而失败之后的界面没法诚实描述"搬了多少"。
///   要做也得单独一轮，配断点续搬与校验。**这一版只做切换，并把话说清楚。**
///
/// ## 拒绝的几种情况（每一条都给出具体原因，不返回一句"路径非法"）
///
/// * 空路径、相对路径 —— 相对谁？没有意义
/// * 和当前根目录同一个 —— 无操作，不该写记录文件
/// * 在**当前根目录里面** —— 数据目录套数据目录，扫描与清理都会失控
/// * 当前根目录在**目标里面** —— 同上，方向相反
/// * 建不出来 / 写不进去（只读盘、权限不够）—— 现在就说，别等下载到一半
///
/// ## 不拒绝但会**告诉调用方**的
///
/// 目标在系统盘上。默认选址是刻意躲开系统盘的（数据能到 20 GB+），
/// 但玩家可能有自己的理由（只有一块盘）。所以这是**提示**不是错误 ——
/// 判断权在他，我们只负责别让他不知情。
pub fn set_data_root(target: &Path, current: &Path) -> Result<(), String> {
    validate_data_root(target, current)?;
    /*
     * ★★ 2026-09-22：**只把游戏根目录建出来**（`<root>/.minecraft`）。
     *
     *   用户的抱怨："这个根目录只创建装游戏的根目录，**不要附带启动器文件**"。
     *   建这一层是必要的（否则重启后第一次进游戏会因为目录不存在而失败），
     *   但**启动器自己的目录一个都不在这里建** —— 它们由 `ensure_own()` 懒建。
     */
    if let Err(e) = std::fs::create_dir_all(target.join(".minecraft")) {
        say!("[IEML/paths] 建游戏目录失败（不影响记录选择）：{e}");
    }
    write_location(&AppPaths::location_file(), target);
    say!(
        "[IEML/paths] 数据目录已改为 {}（旧目录 {} 保持原样，未搬未删）",
        target.display(),
        current.display()
    );
    Ok(())
}

/// 上面那件事的**纯校验部分**（不碰磁盘、不写记录文件）。
///
/// ★ 为什么拆出来：`set_data_root` 成功时会写 `datadir.txt` ——
///   如果测试直接调它，跑一次单测就会把**开发机真实的**数据目录记录改掉。
///   拆开之后测试只验判据，不产生副作用。
///
/// 注意 `is_usable_data_root` 那一步**会建目录**（要试写）——
/// 所以测试传的一定是临时目录。
pub fn validate_data_root(target: &Path, current: &Path) -> Result<(), String> {
    if target.as_os_str().is_empty() {
        return Err("路径是空的。".into());
    }
    if !target.is_absolute() {
        return Err(format!(
            "要一个完整路径（形如 D:\\IEML），现在是相对路径：{}",
            target.display()
        ));
    }

    // 用规范化后的形式比较，避免 `D:\IEML` 与 `D:\IEML\` 被当成两个地方
    let t = norm_path(target);
    let c = norm_path(current);

    if t == c {
        return Err("这就是当前的数据目录，没有变化。".into());
    }
    if t.starts_with(&c) {
        return Err(format!(
            "这个目录在当前数据目录**里面**（{}）。\
             数据目录不能嵌套 —— 否则版本扫描和清理会把彼此当内容。",
            current.display()
        ));
    }
    if c.starts_with(&t) {
        return Err(format!(
            "当前数据目录（{}）在你选的位置**里面**。\
             选一个与它无关的目录。",
            current.display()
        ));
    }

    if !is_usable_data_root(target) {
        return Err(format!(
            "这个位置建不出来或写不进去：{}。\
             换个目录，或者先确认盘符存在、不是只读的。",
            target.display()
        ));
    }
    Ok(())
}

/// 系统盘（Windows 上是 `%SystemRoot%` 所在的盘符）—— 默认不该往上写游戏数据。
pub fn is_on_system_drive(p: &Path) -> bool {    #[cfg(windows)]
    {
        let Some(sys) = std::env::var_os("SystemRoot") else {
            return false;
        };
        let sys_drive = PathBuf::from(sys)
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_uppercase());
        let p_drive = p
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_uppercase());
        match (sys_drive, p_drive) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        false
    }
}

#[derive(Debug, Clone)]
struct Volume {
    path: PathBuf,
    free_gb: f64,
}

/// 挑一个非系统盘：**先看空闲空间**，同分再看盘符顺序（结果稳定，便于复现）。
fn pick_best_volume() -> Option<Volume> {
    #[cfg(windows)]
    {
        use sysinfo::Disks;
        let disks = Disks::new_with_refreshed_list();
        let mut best: Option<Volume> = None;
        let mut all: Vec<Volume> = Vec::new();
        for d in disks.list() {
            let mount = d.mount_point().to_path_buf();
            if is_on_system_drive(&mount) {
                continue;
            }
            let free_gb = d.available_space() as f64 / 1024.0 / 1024.0 / 1024.0;
            // 太空的盘（可移动介质）不当默认：至少要能装下两份游戏
            if free_gb < 5.0 {
                continue;
            }
            all.push(Volume { path: mount, free_gb });
        }
        all.sort_by(|a, b| {
            b.free_gb
                .partial_cmp(&a.free_gb)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.path.cmp(&b.path))
        });
        if let Some(first) = all.into_iter().next() {
            best = Some(first);
        }
        best
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/* ====================== 可以放游戏数据的盘（设置页"在启动器里选"） ====================== */

/// 一块能放游戏数据的盘 —— **给设置页的选择列表用**。
///
/// ★★ 用户 2026-09-20：「我希望数据目录是在启动器里选，不需要到资源管理器里找」。
///
///   所以这里给的**不只是盘符**：`free_gb`（够不够装游戏）与 `is_system`
///   （默认选址刻意躲开它）是玩家真正要据此决定的两件事；`suggested` 直接给
///   "我们打算建的目录"，目录名取自本文件的 [`DATA_DIR_NAME`] ——
///   **前端不许自己拼路径**：拼错就是"界面说的位置"和"文件实际落下的位置"
///   不是同一个地方，而那种错**一点报错都没有**。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    /// 挂载点（Windows 上是 `D:\`）
    pub path: String,
    /// 剩余空间（GB，一位小数）
    pub free_gb: f64,
    /// 总容量（GB，一位小数）
    pub total_gb: f64,
    /// 在系统盘上 —— 提示，不是错误（只有一块盘的机器上它就是唯一选择）
    pub is_system: bool,
    /// 建议的根目录：`<挂载点>\IEML`
    pub suggested: String,
    /// ★ 建议的那个目录**就是**现在正在用的那个（**精确到路径**）
    pub is_current: bool,
    /// 现在用的根目录**在这块盘上**（可能不是 `suggested` 那个目录）
    ///
    /// ★★ 这两个字段为什么要分开：第一版只有"这块盘是不是当前盘"，
    ///   于是玩家把根目录设成 `D:\测试目录` 之后，**D: 那一行整行被标成
    ///   「正在用」、按钮禁用** —— 他就再也换不回 `D:\IEML` 了，
    ///   只能去开系统文件夹对话框（而那个正是他想避开的）。
    ///   2026-09-20 由用户自己的操作暴露：他真的把根目录换成了 `D:\测试目录`。
    pub on_current_drive: bool,
}

/// 列出所有卷（**含系统盘**，一块都不藏 —— 藏了单盘机器就没得选）。
///
/// ★ 顺序：非系统盘在前，同组按剩余空间从大到小，最后按盘符定序（结果稳定）。
///   这与自动选址 [`pick_best_volume`] 是**同一套判据**，不另立一份。
pub fn list_volumes(current: &Path) -> Vec<VolumeInfo> {
    #[cfg(windows)]
    {
        use sysinfo::Disks;
        const GB: f64 = 1024.0 * 1024.0 * 1024.0;
        let round1 = |v: f64| (v * 10.0).round() / 10.0;

        let disks = Disks::new_with_refreshed_list();
        let mut out: Vec<VolumeInfo> = disks
            .list()
            .iter()
            .map(|d| {
                let mount = d.mount_point().to_path_buf();
                let suggested = mount.join(DATA_DIR_NAME);
                VolumeInfo {
                    path: mount.to_string_lossy().to_string(),
                    free_gb: round1(d.available_space() as f64 / GB),
                    total_gb: round1(d.total_space() as f64 / GB),
                    is_system: is_on_system_drive(&mount),
                    is_current: same_path(&suggested, current),
                    on_current_drive: current.starts_with(&mount),
                    suggested: suggested.to_string_lossy().to_string(),
                }
            })
            .collect();
        out.sort_by(|a, b| {
            a.is_system
                .cmp(&b.is_system)
                .then(
                    b.free_gb
                        .partial_cmp(&a.free_gb)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
                .then_with(|| a.path.cmp(&b.path))
        });
        out
    }
    #[cfg(not(windows))]
    {
        let _ = current;
        Vec::new()
    }
}

/// 两个路径是不是同一个地方。
///
/// ★ 只用来判"这一行是不是现在正在用的那个" —— 所以按 Windows 的规矩比：
///   大小写不敏感、末尾分隔符不算差别（`D:\IEML` 与 `D:\IEML\` 是一个地方）。
///   不解析 `..`、不碰符号链接：这里比的是**我们自己拼出来的**建议路径
///   与用户记录里的路径，不是任意两个用户输入。
///
/// ★ 2026-09-24：规范化那一步改成共用 [`norm_path`] —— 原来这里有一份自己的
///   实现（顺带把 `/` 也归一了），"是不是同一处"在收养老目录时也要用，
///   两份实现迟早会对 `D:/IEML` 这种写法给出不同答案。
///   （副作用：非 Windows 上不再强制小写 —— 那三个平台本来就大小写敏感，
///   而这只影响开发机上的单测，发行版只有 Windows。）
pub fn same_path(a: &Path, b: &Path) -> bool {
    !a.as_os_str().is_empty() && norm_path(a) == norm_path(b)
}

/// 这个目录是不是"一次手滑会删掉一大片"的那种（盘符根 / 用户目录 / 系统目录）。
///
/// ★ 危险操作的判据要**宽进严出**：宁可多拦几个（用户还能去资源管理器自己删），
///   也不能放过一个 —— 放过的代价是不可恢复的。
pub fn is_dangerous_root(p: &Path) -> bool {
    // 盘符根：`D:` 这种（去掉尾分隔符后只剩两字符且以冒号结尾）
    let s = p.to_string_lossy();
    let trimmed = s.trim_end_matches(['\\', '/']);
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        return true;
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        if same_path(p, Path::new(&home)) {
            return true;
        }
    }
    for key in ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
        if let Some(v) = std::env::var_os(key) {
            if same_path(p, Path::new(&v)) {
                return true;
            }
        }
    }
    false
}

/* ====================== 「用过的游戏文件夹」列表（PCL 那种） ====================== */

/// 设置页那个**文件夹列表**的一行。
///
/// ★★ 用户 2026-09-20（直接给了 PCL 的截图）：「**这个切换列表我想要 PCL 这样的**」。
///
///   PCL 的「文件夹列表」列的是**你用过的 .minecraft 文件夹**（名字 + 路径），
///   而不是"机器上有哪些盘"。盘符列表是我上一版的做法 —— 它每次都要你重新想
///   "放哪"；而 PCL 那种是**回到你去过的那个地方**，一次点击。
///
///   ★ 两边都要有：用过的（`known`，存在记录文件里）+
///     在盘上扫到的同款目录（`found`，`<盘>\IEML` 且**确实存在**）——
///     后者让"第一次用这个功能"的人也有东西可点，而不是对着一行空白。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownRoot {
    /// 完整路径（**数据根目录**；游戏数据在它下面的 `.minecraft`）
    pub path: String,
    /// 显示名：取路径最后一段（`D:\测试目录` → `测试目录`）
    pub name: String,
    /// 这个目录现在还在不在。**不在的照样列出来**（PCL 也是），
    /// 但只能"移除"，不能"用这个" —— 点一个不存在的目录只会报错。
    pub exists: bool,
    /// 就是现在正在用的那个（**精确到路径**，不是"同一块盘"）
    pub is_current: bool,
    /// 在系统盘上 —— 提示，不是错误（只有一块盘的机器上它就是唯一选择）
    pub on_system_drive: bool,
    /// 这一行从哪来：`known` = 记录里用过；`found` = 在盘上扫到的同款目录
    pub source: String,
}

/// 记录文件放**记录目录**（`%APPDATA%\IEML\`）里，与 `datadir.txt` 并排。
///
/// ★ 为什么不放数据根目录里：它记的是"启动器知道哪些文件夹" ——
///   而这正是**在数据目录不可用/要换掉**时需要读的东西。放进数据目录里，
///   一旦换到别处就看不到自己的历史了（自举问题）。
fn known_roots_file() -> PathBuf {
    AppPaths::location_file()
        .parent()
        .map(|d| d.join("known-roots.json"))
        .unwrap_or_else(|| PathBuf::from("known-roots.json"))
}

/// 最多记几个。★ 有上限是为了**不让这个文件无限长大**（每换一次加一条）；
/// 12 个足够覆盖"我有几个盘、几个测试目录"的真实使用。
const MAX_KNOWN_ROOTS: usize = 12;

/// 读记录（新→旧）。坏文件/没文件都当空表 —— **读不到不等于没有**，
/// 但也绝不能因此拦启动（这个文件只是"便利"，不是数据）。
pub fn load_known_roots() -> Vec<PathBuf> {
    load_known_roots_from(&known_roots_file())
}

/// ★ 真正的实现带**文件参数** —— 与 `validate_data_root` 拆出来的理由一样：
///   成功路径会**写**真实记录文件，测试直接跑它等于"跑一次单测就改掉开发机的列表"。
fn load_known_roots_from(file: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        say!("[IEML/paths] 文件夹列表读不出来（文件坏了），这次当空的");
        return Vec::new();
    };
    v.get("roots")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(|s| PathBuf::from(s.trim()))
                .filter(|p| !p.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn write_known_roots(file: &Path, roots: &[PathBuf]) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let arr: Vec<String> = roots
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let body = serde_json::json!({ "roots": arr });
    if let Err(e) = std::fs::write(file, serde_json::to_string_pretty(&body).unwrap_or_default()) {
        // ★ 写失败**不拦任何事**：这只是"下次少一个快捷入口"，不是数据丢失
        say!("[IEML/paths] 文件夹列表写不进去（{e}）：下次少一个入口，不影响别的事");
    }
}

/// 把某个目录记进"用过"（**去重、置顶**）。
///
/// ★ 判重用 [`same_path`]（大小写与末尾分隔符不算差别）：
///   否则 `D:\IEML` 与 `d:\ieml\` 会变成两条，用户看到两个一模一样的入口。
pub fn remember_root(root: &Path) {
    if root.as_os_str().is_empty() {
        return;
    }
    remember_root_at(&known_roots_file(), root);
}

fn remember_root_at(file: &Path, root: &Path) {
    let mut roots = load_known_roots_from(file);
    roots.retain(|p| !same_path(p, root));
    roots.insert(0, root.to_path_buf());
    roots.truncate(MAX_KNOWN_ROOTS);
    write_known_roots(file, &roots);
}

/// 从"用过"里去掉一条（目录已经没了时用户会点它）。
pub fn forget_root(root: &Path) {
    forget_root_at(&known_roots_file(), root);
}

fn forget_root_at(file: &Path, root: &Path) {
    let mut roots = load_known_roots_from(file);
    let before = roots.len();
    roots.retain(|p| !same_path(p, root));
    if roots.len() != before {
        write_known_roots(file, &roots);
    }
}

/// 组装设置页要显示的那张列表：**用过的 + 盘上扫到且确实存在的**，当前那个排最前。
pub fn list_known_roots(current: &Path) -> Vec<KnownRoot> {
    let mut out: Vec<KnownRoot> = Vec::new();
    let mut push = |p: &Path, source: &str| {
        if out.iter().any(|r| same_path(Path::new(&r.path), p)) {
            return;
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            // 盘根目录（`D:\`）没有 file_name —— 用盘符当名字
            .unwrap_or_else(|| p.to_string_lossy().trim_end_matches(['\\', '/']).to_string());
        out.push(KnownRoot {
            path: p.to_string_lossy().to_string(),
            name,
            exists: p.is_dir(),
            is_current: same_path(p, current),
            on_system_drive: is_on_system_drive(p),
            source: source.to_string(),
        });
    };

    // ① 现在正在用的那个排最前（PCL 的截图里也是"当前文件夹"在最上面）
    push(current, "known");
    // ② 用过的（新 → 旧）
    for p in load_known_roots() {
        push(&p, "known");
    }
    // ③ 盘上扫到的同款目录（`<盘>\IEML`）—— **只收确实存在的**
    for v in list_volumes(current) {
        let p = PathBuf::from(&v.suggested);
        if p.is_dir() {
            push(&p, "found");
        }
    }
    out
}

/// ★★ 把老布局的 `shared/` 挪成 `.minecraft/`（**同盘改名，秒完成**）。
///
/// ## 为什么用 `rename` 而不是像 `migrate_data_root` 那样逐个复制
///
///   `migrate_data_root` 处理的是**跨目录（可能跨盘）**的搬家，所以只能复制。
///   而这里两边都在同一个数据根目录下 —— 同一卷上的 `rename` 是**原子**的：
///   要么完全没动，要么一步到位，不存在"复制到一半"的中间态。
///   这也让 1.4 GB 的游戏文件**瞬间**完成，而不是复制几分钟再删源。
///
/// ## 四种情况
///
///   · `shared/` 在、`.minecraft/` **不存在**   → 改名（唯一会动手的情况）
///   · `shared/` 在、`.minecraft/` 是**空目录**  → 删掉空壳再改名
///     （`AppPaths::ensure()` 在任何一次启动里都会把 `.minecraft/` 建出来，
///       所以"空壳"是**常态**而不是异常 —— 不处理它，迁移就永远不会发生）
///   · `.minecraft/` 里**有东西**               → 什么都不做：已经是新布局，
///     那个 `shared/` 可能是用户自己放的东西，也可能是上次没搬完的残留 —— 不猜、不动
///   · 两个都不在                               → 什么都不做（全新安装）
///
/// 返回 `Some(路径)` = 这次真的搬了（调用方要如实打印出来）。
pub fn migrate_shared_into_game_dir(root: &Path) -> std::io::Result<Option<PathBuf>> {
    let old = root.join(LEGACY_SHARED_NAME);
    let new = root.join(GAME_DIR_NAME);
    if !old.is_dir() {
        return Ok(None);
    }
    if new.exists() {
        // 空目录 = `ensure()` 建的空壳，可以安全删掉；有内容就一律不动
        let empty = std::fs::read_dir(&new)?.next().is_none();
        if !empty {
            return Ok(None);
        }
        std::fs::remove_dir(&new)?;
    }
    std::fs::rename(&old, &new)?;
    /*
     * ★ 改完名**必须验一下**：`rename` 成功后目标一定在，但这里再确认一次
     *   是有意的 —— 这一步之后我们会在界面上说"游戏数据在 .minecraft 里"，
     *   说出口的东西得有证据。
     */
    if !new.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("改名后没找到 {}", new.display()),
        ));
    }
    Ok(Some(new))
}

/// ★★ 把老位置的数据搬到新位置（**只补齐，绝不删改**）。
///
/// ## 两条铁律
///
///   ① **只复制、绝不删除源** —— 搬家中途断电/被杀，用户不能同时失去两边。
///   ② **目标已有的东西一个字节都不动** —— 目标上的数据是用户
///      "现在正在用的那份"，源那边是"以前那份"。任何情况下都该以目标为准。
///
/// ## 为什么是"补齐"而不是"搬一次就完事"
///
///   实测踩到过一个**真的丢了用户数据**的 bug（由本函数与前端一起造成）：
///   某次启动后 `instances.json` 被写成了 `{"instances":[],...}`
///   （前端"读失败也允许写"的锅，已在那边修好），
///   而这里当时只按"目标存在就跳过"处理 → 用户建的三个版本
///   从界面上消失了，而老位置的文件明明还好好地躺在那里。
///
///   所以现在：**目标缺什么就补什么**。
///   · 目标没有的目录/文件 → 从源复制过去（能自动修好上面那种损坏）
///   · 目标已有 → 一个字节都不碰
///   · 目标的 `instances.json` 是**空列表**而源里有人 → 用源的（见下）
///
///   这一条与"用户主动删掉某个版本后它会不会复活"不冲突：
///   复制是**单向**的（源 → 目标），用户删的只是目标那一份，
///   源那份动不了目标。所以最多是"老位置还留着一份尸体"，
///   不会把删掉的东西变回来。
///
/// 返回复制了多少字节；`Ok(0)` = 什么都不需要做。
pub fn migrate_data_root(old: &Path, new: &Path) -> std::io::Result<u64> {
    if !old.is_dir() || old == new {
        return Ok(0);
    }
    // 只认真正的数据子目录，别把用户的杂物搬过去
    /*
     * ★★ 2026-09-24：这里**只剩 `instances`** —— 它现在是"游戏那一边"的目录
     *   （`<root>/instances`，装的是存档与 Mod，见 `AppPaths::instances`），
     *   跟着游戏根目录一起搬是对的。
     *
     *   而 `java` / `cache` / `logs` **必须从这张表里删掉**：它们是启动器自己的东西，
     *   只认 `own_root`（`%APPDATA%\IEML`）。留在这张表里的后果是真机上量到的：
     *   每次启动都把 `%APPDATA%\IEML\cache`（1839 个文件 / 9.5 MB）复制进
     *   `D:\IEML\cache` —— 于是游戏盘上白占一份、启动器又不读它
     *   （用户 2026-09-22 说的"根目录不要附带启动器文件"正是这件事）。
     *   老位置里那三样由 `adopt_own_dirs` 往 `own_root` 收养（方向反过来）。
     */
    let mut copied = 0u64;
    for name in ["instances"] {
        let from = old.join(name);
        if from.is_dir() {
            /*
             * ★ 实例目录用**按 mtime 判胜负**的补齐（不是"目标已有就跳过"）：
             *   实例里是用户自己会改的东西（options.txt / 存档 / Mod），
             *   而"错位置那两天"写进去的正是老位置那一份 —— 见
             *   `merge_instances_by_mtime` 的说明（真机上差 12 天的 options.txt）。
             */
            copied += merge_instances_by_mtime(&from, &new.join(name))?;
        }
    }

    /*
     * ★★ 游戏文件这一项：**按目标根目录当前的布局决定往哪儿放**。
     *
     *   0.1.0-beta.3 实测踩到的真 bug（教训写在这里）：
     *   一开始这里写的是死映射 `old/shared → new/.minecraft`。结果某次启动时，
     *   目标根目录**自己还停在老布局**（`new/shared` 在、`new/.minecraft` 不在），
     *   于是这一步把几个月前留在 C 盘的老数据复制进了 `new/.minecraft/` ——
     *   凭空造出一个"新布局"目录，而真正的数据还在 `new/shared/` 里。
     *   之后布局迁移看到 `.minecraft` 已有内容就按规矩跳过（它不能猜）——
     *   用户下次打开就会觉得"我的版本都不见了"。
     *
     *   判据改成"看目标现在是什么布局"：
     *     · 目标已有 `.minecraft`（或根本没有 `shared`）→ 新布局 → 放进 `.minecraft`
     *     · 目标还有 `shared`                        → 老布局 → 放进 `shared`
     *   两边都试一遍源（老根的 `shared` 与新根的 `.minecraft`），因为源根自己
     *   也可能已经是新布局。
     */
    let dest_name = if new.join(GAME_DIR_NAME).exists() || !new.join(LEGACY_SHARED_NAME).exists() {
        GAME_DIR_NAME
    } else {
        LEGACY_SHARED_NAME
    };
    for from_name in [LEGACY_SHARED_NAME, GAME_DIR_NAME] {
        let from = old.join(from_name);
        if from.is_dir() {
            copied += copy_tree(&from, &new.join(dest_name))?;
        }
    }

    for name in ["instances.json", "prefs.json"] {
        let from = old.join(name);
        if !from.is_file() {
            continue;
        }
        let to = new.join(name);
        if should_take_record(&from, &to)? {
            if let Some(p) = to.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(&from, &to)?;
            copied += std::fs::metadata(&to).map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(copied)
}

/// 目标上的那份记录要不要用源那份替换？
///
/// 判据只有一条：**目标不存在，或者目标是个"空壳"而源里有东西**。
/// 其余情况一律**不动目标** —— 目标上的记录是用户当下正在用的那份。
fn should_take_record(from: &Path, to: &Path) -> std::io::Result<bool> {
    if !to.is_file() {
        return Ok(true);
    }
    let dst = std::fs::read_to_string(to).unwrap_or_default();
    let src = std::fs::read_to_string(from).unwrap_or_default();

    // 只在 **数组元素个数** 上比较，不看别的字段 —— 判据越窄越安全。
    let count = |t: &str| -> Option<usize> {
        let v: serde_json::Value = serde_json::from_str(t).ok()?;
        v.get("instances")?.as_array().map(|a| a.len())
    };
    match (count(&dst), count(&src)) {
        // 目标 0 条、源有人 → 这几乎一定是被写坏了，补回来
        (Some(0), Some(n)) if n > 0 => Ok(true),
        _ => Ok(false),
    }
}

/// ★★ 启动时把**老位置**（游戏根目录）里的启动器文件"收养"到 `own_root`（A-4 修复）。
///
/// 管这四个：`instances.json`、`prefs.json`、`ms_client_id.txt`、`cf_api_key.txt`。
///
/// ## 三条规矩（与 `migrate_data_root` 一致）
///
///   ① **只复制、绝不删源** —— 用户随时可能退回旧版启动器，那份还在原地；
///   ② 目标已有、而且**不比源旧** → 一个字节都不动（目标那份才是"现在正在用的"）；
///   ③ 真要覆盖目标之前，先把目标备份成 `<名字>.bak` —— 万一判断错了，东西还在。
///
/// ## 为什么判据里必须有"源比目标新"这一条
///
///   这是在本机真机上量出来的：`D:\IEML\instances.json`（游戏根目录那份）
///   是**应用一直在写**的那份，而 `%APPDATA%\IEML\instances.json` 是
///   2026-09-13 的**陈旧副本**（连主题都还停在 dark）。
///   若只按"目标存在就跳过"，用户最近十天的改动会被那份陈旧副本永远盖住 ——
///   那正是 A-4 里"两处各有一份、谁看谁糊涂"的坑（我自己就据它误判过一次）。
///
/// 返回复制了多少字节（0 = 什么都不需要做）。
pub fn adopt_records(paths: &AppPaths) -> u64 {
    const NAMES: [&str; 4] = [
        "instances.json",
        "prefs.json",
        "ms_client_id.txt",
        "cf_api_key.txt",
    ];
    let mut copied = 0u64;
    for name in NAMES {
        let from = paths.legacy_record_file(name);
        if !from.is_file() {
            continue;
        }
        let to = paths.own_file(name);
        if !should_adopt(&from, &to) {
            continue;
        }
        if let Err(e) = std::fs::create_dir_all(&paths.own_root) {
            say!(
                "[IEML/records] 建不了启动器数据目录（{}）：{e}",
                paths.own_root.display()
            );
            continue;
        }
        if to.is_file() {
            let bak = paths.own_root.join(format!("{name}.bak"));
            let _ = std::fs::copy(&to, &bak);
            say!("[IEML/records] 覆盖前把目标那份备份到 {}", bak.display());
        }
        match std::fs::copy(&from, &to) {
            Ok(n) => {
                copied += n;
                say!(
                    "[IEML/records] {name} 复制到启动器自己的目录（{n} 字节）—— 游戏根目录那份保留不动"
                );
            }
            Err(e) => say!("[IEML/records] 复制 {name} 失败：{e}"),
        }
    }
    copied
}

/// 目标那份要不要用源那份替换？（[`adopt_records`] 的判据）
fn should_adopt(from: &Path, to: &Path) -> bool {
    if !to.is_file() {
        return true; // 目标没有 → 直接补
    }
    // 目标是个"空壳"而源里有东西 → 补（沿用 should_take_record 的老规矩）
    if matches!(should_take_record(from, to), Ok(true)) {
        return true;
    }
    // ★ 源比目标新 → 源才是"当前在用的那份"（见 adopt_records 的说明）
    let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    match (mtime(from), mtime(to)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// ★★ 2026-09-24：把**游戏根目录里的启动器目录**收养到 `own_root`。
///
/// 管这三个：`java`、`cache`、`logs`。
///
/// ## 为什么需要它
///
///   0.1.0-beta 时代的启动器把它们建在游戏根目录里（`<root>/java` 之类），
///   而 2026-09-23 之后启动器**只读 `own_root` 下那一份** ——
///   老用户升级上来会看到"我下好的 Java 不见了"（要走一遍重新下载 ~200 MB）。
///   这里在启动时把缺的补过去；顺带也是 `migrate_data_root` 的反方向：
///   搬家只搬游戏数据，启动器自己的东西**从游戏盘收回系统盘的家**。
///
/// ## 三条规矩（与 `adopt_records` / `migrate_data_root` 一致）
///
///   ① 只复制、绝不删源（游戏根目录那份留着，用户想回退旧版还能用）；
///   ② 目标已有的文件一个字节都不动（`copy_tree` 的语义）；
///   ③ 源就是 `own_root` 自己时直接跳过 —— 否则等于自己复制自己。
///
/// 返回复制了多少字节（0 = 什么都不需要做）。
pub fn adopt_own_dirs(paths: &AppPaths, legacy_root: &Path) -> u64 {
    if same_path(legacy_root, &paths.own_root) {
        return 0;
    }
    let mut copied = 0u64;
    for name in ["java", "cache", "logs"] {
        let from = legacy_root.join(name);
        if !from.is_dir() {
            continue;
        }
        match copy_tree(&from, &paths.own_root.join(name)) {
            Ok(0) => {}
            Ok(n) => {
                copied += n;
                say!(
                    "[IEML/paths] 把游戏根目录里的 {name} 收养到启动器目录（{n} 字节）—— 源那份保留不动"
                );
            }
            Err(e) => say!("[IEML/paths] 收养 {name} 失败：{e}"),
        }
    }
    copied
}

/// 路径的规范化形式 —— **只用于比较，不碰磁盘**。
///
///   分隔符统一成 `\`、去掉结尾的分隔符、Windows 上不分大小写。
///   `D:\IEML`、`d:/ieml/`、`D:\IEML\\` 都归到同一个值。
///
/// ★ 抽出来的理由：`validate_data_root` 里原来有一份一模一样的闭包，
///   而"这两个目录是不是同一处"在收养老目录时又要用一次 ——
///   路径比较只允许有一个来源，否则两处会对 `D:\IEML` 与 `d:\ieml\`
///   给出不同答案。
fn norm_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.trim_end_matches('\\').to_string();
    #[cfg(windows)]
    let s = s.to_lowercase();
    PathBuf::from(s)
}

/// 递归复制：**目标已有的文件一个字节都不动**，缺什么补什么。
/// 为什么不是"目标存在就整体跳过"：那样目标上任何一处损坏
/// （例如被写空的 `instances.json`）都永远修不回来。见
/// `migrate_data_root` 的说明 —— 这是实测丢过用户数据之后改的。
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<u64> {
    copy_tree_rule(from, to, false)
}

/// ★★ 2026-09-24：**实例目录**的跨根补齐 —— 与 `copy_tree` 只差一条：
/// 同名文件**按 mtime 判胜负**（源更新就赢；覆盖前把目标那份备份成 `.ieml-bak`）。
///
/// ## 为什么只有实例目录需要这条
///
///   `.minecraft` 里是库 / jar / 资源包这些**内容由版本决定**的东西，mtime 没有意义
///   （重新下载就会变），所以那边继续用"目标已有就跳过"最安全。
///   而实例目录里装的是**用户自己会改的东西**：`options.txt` 的游戏内设置、
///   `config/`、`mods/`、存档。
///
///   真机上量到的实例（`fabric-262`，2026-09-24）：
///     · 老位置（`%APPDATA%\IEML\instances`）那份 `options.txt` = **当天 14:01 玩的**
///       （`lang:zh_cn`、`renderDistance:12`、音乐音量 0.0）
///     · 游戏根（`D:\IEML\instances`）那份 = 09-12 的
///       （`lang:en_us`、`renderDistance:16`、音乐音量 1.0）
///   只按"目标存在就跳过"的话，用户换回游戏盘之后**今天的设置会被 12 天前的盖掉** ——
///   而且他会以为是自己记错了。判据改成 mtime 之后，赢的是"最后一次真正玩过"的那份。
///
///   ★ 与 `adopt_records` 是同一条规矩（源更新 → 源赢），只是这里多一层备份：
///     覆盖前把目标那份存成 `<文件名>.ieml-bak`（游戏/加载器都不认这个后缀，
///     不会被当成 Mod 或存档读进去），万一判错了东西还在。
///
/// ## 为什么不会每次启动都来回覆盖
///
///   `std::fs::copy` 会把源的 mtime 一起带过去（Windows 上是 `CopyFileEx`），
///   加上这里是**严格大于**才覆盖 —— 复制过一次之后两边 mtime 相等，
///   下一次启动就什么都不做了。
fn merge_instances_by_mtime(from: &Path, to: &Path) -> std::io::Result<u64> {
    copy_tree_rule(from, to, true)
}

/// `copy_tree` 与 `merge_instances_by_mtime` 的共同实现。
/// `newer_wins = false` → 目标已有就跳过；`true` → 源更新就覆盖（先备份目标）。
fn copy_tree_rule(from: &Path, to: &Path, newer_wins: bool) -> std::io::Result<u64> {
    std::fs::create_dir_all(to)?;
    let mut bytes = 0u64;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let src = e.path();
        let dst = to.join(e.file_name());
        let meta = e.metadata()?;
        if meta.is_dir() {
            bytes += copy_tree_rule(&src, &dst, newer_wins)?;
        } else if meta.is_file() {
            if dst.is_file() {
                if !newer_wins || !is_newer(&src, &dst) {
                    continue; // 目标已有 → 不动（那是用户正在用的那份）
                }
                let bak = backup_name(&dst);
                match std::fs::copy(&dst, &bak) {
                    Ok(_) => say!("[IEML/paths] 覆盖前把 {} 备份到 {}", dst.display(), bak.display()),
                    Err(e) => {
                        // 备份不成功就**不覆盖** —— 判据再合理也不能冒丢数据的风险
                        say!("[IEML/paths] {} 备份失败（{e}），这一步跳过", dst.display());
                        continue;
                    }
                }
                say!(
                    "[IEML/paths] {} 比目标新，用它覆盖 {}（存进实例目录的新家）",
                    src.display(),
                    dst.display()
                );
            }
            // 半截的 .part 不该跟着搬家：新家会用新路径重新下
            if src
                .file_name()
                .map(|n| {
                    let s = n.to_string_lossy();
                    s.contains(".part") || s.ends_with(".tmp")
                })
                .unwrap_or(false)
            {
                continue;
            }
            std::fs::copy(&src, &dst)?;
            bytes += meta.len();
        }
    }
    Ok(bytes)
}

/// 源文件是不是**比**目标文件新（严格大于；取不到 mtime 就按"不新"处理）。
fn is_newer(src: &Path, dst: &Path) -> bool {
    let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    match (mtime(src), mtime(dst)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// 覆盖前的备份名：`options.txt` → `options.txt.ieml-bak`。
fn backup_name(dst: &Path) -> PathBuf {
    let mut name = dst.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    name.push_str(".ieml-bak");
    dst.with_file_name(name)
}

/* ====================== 机器信息 ====================== */

#[derive(Debug, Clone, serde::Serialize)]
pub struct MachineInfo {
    pub total_memory_gb: f64,
    pub available_memory_gb: f64,
    pub cpu_count: usize,
    pub os: String,
    pub arch: String,
    pub data_dir: String,
}

pub fn machine_info(paths: &AppPaths) -> MachineInfo {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();

    let total = sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let avail = sys.available_memory() as f64 / 1024.0 / 1024.0 / 1024.0;

    MachineInfo {
        total_memory_gb: (total * 10.0).round() / 10.0,
        available_memory_gb: (avail * 10.0).round() / 10.0,
        cpu_count: sys.cpus().len(),
        os: System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string()),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: paths.root.to_string_lossy().to_string(),
    }
}

/* ====================== 子进程：别弹控制台窗口 ====================== */

/*
 * ★★ Windows 上，启动一个**控制台子系统**程序（java.exe / tar.exe /
 *    taskkill.exe / cmd.exe）而不传 `CREATE_NO_WINDOW`，系统会**弹出一个
 *    控制台窗口**。
 *
 *    用户报的原话：「安装 Forge 调出来个啥也没有的 cmd 是何意味」——
 *    那个"啥也没有"的黑框就是 Forge 安装器的 java 进程：
 *    它的输出被启动器接走了（我们要拿它判断成功失败、给用户看进度），
 *    窗口里自然什么都没有，只剩一个空壳挂在屏幕上。
 *    对用户来说这就是"启动器怎么突然弹了个黑框"。
 *
 *    这与"要不要用命令行安装"无关 —— 我们本来就必须用命令行跑 Forge 的
 *    installer jar（那是 Forge 官方唯一的无人值守接口：
 *    `java -jar forge-installer.jar --installClient <dir>`）。
 *    问题只在于**窗口不该露出来**。静默地跑，然后把结果如实报告，
 *    这才是"自动安装"该有的样子。
 *
 *    所以这里提供**唯一**的抑制入口。新增任何创建子进程的代码都应该用它，
 *    不要再各处手写 `0x0800_0000` —— 那个数字抄错一次就是一个新黑框，
 *    而且不会有任何报错提示你。
 */

/// `CREATE_NO_WINDOW`：不为新进程创建控制台窗口。
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 给 `std::process::Command` 加上"不弹窗"标志（非 Windows 上是空操作）。
pub fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 给 `tokio::process::Command` 加上"不弹窗"标志（非 Windows 上是空操作）。
///
/// ★ 异步侧必须单独有一个：`tokio::process::Command` 与 `std::process::Command`
///   是两个不同的类型，trait 也不通用。**Forge 安装器走的正是这一条** ——
///   老代码只给 `std::process::Command` 加了标志，异步那处漏了，
///   于是唯一一处会弹黑框的地方恰好就是用户天天要点的"安装 Forge"。
pub fn hide_console_async(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/* ====================== Java 探测 ====================== */

/// 跑一次 `java -version`，拿它的主版本号（拿不到返回 `None`）。
///
/// 用途：**给某个具体的 java.exe 判版本**，而不是走整条扫描。
/// 典型场景是"跑第三方安装器之前先确认这个 Java 支持它要的参数"——
/// 实测踩过：OptiFine 的安装器要 `--add-exports`，那是 **Java 9+** 才有的选项，
/// 拿 Java 8 去跑会得到 `Unrecognized option: --add-exports` 加
/// `Could not create the Java Virtual Machine`，安装器一行都没执行。
pub fn java_major_of(exe: &Path) -> Option<u32> {
    if !exe.is_file() {
        return None;
    }
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("-version");
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr).to_string()
        + &String::from_utf8_lossy(&out.stdout);
    parse_java_version(&text).map(|(_, major)| major)
}

/// 扫描本机的 Java 运行时。
///
/// ## 这一版为什么重写（用户报"它根本不知道去哪里找 java"）
///
/// 用户的原话：「IEML 管我要 java21，但我的电脑里确实有 java21，还有 25，
/// 也就是说它根本不知道去哪里找 java」。**他是对的**：
///
///   · 他的 Java 21 是 **Minecraft 官方启动器**下的，躺在
///     `%APPDATA%\.minecraft\runtime\java-runtime-delta`（真实存在，`release`
///     文件写着 `JAVA_VERSION="21.0.7"`）；
///   · 他的 Java 8 也在那儿：`%APPDATA%\.minecraft\runtime\jre-legacy`（`1.8.0_51`）；
///   · 而老版 `scan_java` 只看四处：`JAVA_HOME` / `PATH` / `Program Files\*` /
///     自己下载的 `data/java`。
///
///   于是启动器眼里本机"只有 Java 25"，1.12.2（需要 Java 8）也就没有 Java 8 可用。
///
/// ## 现在的来源（按可信度排序，全部保留 provenance）
///
///   ① IEML 自己下载的 —— `downloaded`
///   ② 用户手动指定的 —— `manual`
///   ③ Mojang 官方运行时 —— `mojang`（`.minecraft/runtime/*`，**这次补上的关键一处**）
///   ④ Windows 注册表登记的 JRE/JDK —— `registry`
///   ⑤ 其它启动器记下来的（PCL2 的 `config.json`）—— `launcher`
///   ⑥ `JAVA_HOME` / `PATH` —— `system`
///   ⑦ 常见安装根目录（Adoptium / Oracle / Zulu / Microsoft / Temurin …）—— `system`
///   ⑧ 根目录浅扫描（`C:\jdk*`、`D:\java*` …）—— `scan`
///
/// ## 为什么要"先把候选路径收集完，再去并行探测"
///
///   `probe_java` 要真的跑一次 `java -version`（50~300 ms）。
///   老实现是**边发现边探测**、一个一个串行跑 —— 一次扫描能卡好几秒，
///   而 `scan_java` 是 IPC 命令，卡住的是整个界面。
///   现在先做零成本的路径收集 + 去重，再并行探测（最多 8 路）。
pub fn scan_java(paths: &AppPaths) -> Vec<JavaRuntime> {
    scan_java_with_extra(paths, &[])
}

/// 同上，外加**用户手动指定**的 java.exe 路径（设置页里挑的）。
pub fn scan_java_with_extra(paths: &AppPaths, manual: &[String]) -> Vec<JavaRuntime> {
    let mut by_path: Vec<(String, PathBuf)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut push = |path: PathBuf, source: &str, by_path: &mut Vec<(String, PathBuf)>| {
        let key = canonical_key(&path);
        if seen.insert(key) {
            by_path.push((source.to_string(), path));
        }
    };

    // ③ Mojang 官方运行时（这次补上的关键一处）
    for exe in mojang_runtime_javas() {
        push(exe, "mojang", &mut by_path);
    }

    // ④ 注册表（Windows）
    for exe in registry_javas() {
        push(exe, "registry", &mut by_path);
    }

    // ⑤ 其它启动器缓存
    for exe in other_launcher_javas() {
        push(exe, "launcher", &mut by_path);
    }

    // ①② 自己下载的 + 用户手选（最可信，排最前）
    let mut preferred: Vec<(String, PathBuf)> = Vec::new();
    for s in manual {
        let p = PathBuf::from(s);
        let exe = if p.is_file() { p } else { java_exe_in(&p) };
        push(exe, "manual", &mut preferred);
    }
    if let Ok(entries) = std::fs::read_dir(&paths.java) {
        for e in entries.flatten() {
            push(java_exe_in(&e.path()), "downloaded", &mut preferred);
        }
    }
    // ⑥ JAVA_HOME
    if let Ok(home) = std::env::var("JAVA_HOME") {
        push(java_exe_in(Path::new(&home)), "system", &mut by_path);
    }
    // ⑥ PATH
    if let Some(path_var) = std::env::var_os("PATH") {
        let name = if cfg!(windows) { "java.exe" } else { "java" };
        for dir in std::env::split_paths(&path_var) {
            let exe = dir.join(name);
            if exe.is_file() {
                push(exe, "system", &mut by_path);
            }
        }
    }
    // ⑦ 常见安装根目录
    for root in common_java_roots() {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for e in entries.flatten() {
                let exe = java_exe_in(&e.path());
                if exe.is_file() {
                    push(exe, "system", &mut by_path);
                }
            }
        }
    }
    // ⑧ 根目录浅扫描
    for exe in shallow_drive_javas() {
        push(exe, "scan", &mut by_path);
    }

    preferred.extend(by_path);

    // 并行探测：先做零成本收集，再一次性花钱
    let results = probe_many(preferred);

    let mut found: Vec<JavaRuntime> = Vec::new();
    for rt in results {
        push_unique(&mut found, rt);
    }
    // 主版本高的排前面；同版本按路径稳定排序（界面每次看到同样的顺序）
    found.sort_by(|a, b| {
        b.major
            .cmp(&a.major)
            .then_with(|| a.path.cmp(&b.path))
    });
    found
}

/// 探测结果的上限：防止某个病态的 PATH 把扫描拖成分钟级
const MAX_JAVA_CANDIDATES: usize = 64;
/// 并行度：`java -version` 是进程启动，8 路足够快也不至于把机器打满
const PROBE_CONCURRENCY: usize = 8;

fn probe_many(candidates: Vec<(String, PathBuf)>) -> Vec<JavaRuntime> {
    let candidates: Vec<(String, PathBuf)> =
        candidates.into_iter().take(MAX_JAVA_CANDIDATES).collect();
    if candidates.is_empty() {
        return Vec::new();
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let slots: Vec<std::sync::Mutex<Option<JavaRuntime>>> =
        (0..candidates.len()).map(|_| std::sync::Mutex::new(None)).collect();

    let workers = PROBE_CONCURRENCY.min(candidates.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if i >= candidates.len() {
                    break;
                }
                let (source, exe) = &candidates[i];
                if let Some(rt) = probe_java(exe, source) {
                    if let Ok(mut slot) = slots[i].lock() {
                        *slot = Some(rt);
                    }
                }
            });
        }
    });

    slots
        .into_iter()
        .filter_map(|s| s.into_inner().ok().flatten())
        .collect()
}

/// 路径去重用的键：**不要求路径真实存在**（`canonicalize` 会失败），
/// 所以先把能解析的解析掉，再统一大小写与分隔符。
fn canonical_key(p: &Path) -> String {
    let resolved = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    resolved
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase()
}

/// Mojang 官方启动器的运行时目录。
///
/// 实测（本机）：`%APPDATA%\.minecraft\runtime\` 下有
/// `java-runtime-delta`（**Java 21.0.7**）与 `jre-legacy`（**Java 8.0_51**）。
/// 这两份是"用户确实有 java21/java8"的真相所在 —— 老版完全没扫。
#[cfg(windows)]
fn mojang_runtime_javas() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(appdata).join(".minecraft").join("runtime"));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        roots.push(PathBuf::from(home).join(".minecraft").join("runtime"));
    }
    // 官方启动器允许自定义游戏目录，常见的几处也认一下
    for d in ["D:", "E:", "F:"] {
        roots.push(PathBuf::from(format!("{d}\\.minecraft\\runtime")));
        roots.push(PathBuf::from(format!("{d}\\Minecraft\\.minecraft\\runtime")));
    }
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for e in entries.flatten() {
            let exe = java_exe_in(&e.path());
            if exe.is_file() {
                out.push(exe);
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn mojang_runtime_javas() -> Vec<PathBuf> {
    Vec::new()
}

/// Windows 注册表里登记的 Java。
///
/// 覆盖三种登记方式（装机量都不小）：
///   · `HKLM\SOFTWARE\JavaSoft\JDK\<ver>\JavaHome`
///   · `HKLM\SOFTWARE\JavaSoft\JRE\<ver>\JavaHome`
///   · `HKLM\SOFTWARE\JavaSoft\Java Development Kit\<ver>\JavaHome`（老式）
/// 32 位视图（`WOW6432Node`）也要看。
#[cfg(windows)]
fn registry_javas() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let mut out = Vec::new();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let bases = [
        r"SOFTWARE\JavaSoft",
        r"SOFTWARE\WOW6432Node\JavaSoft",
        r"SOFTWARE\Eclipse Adoptium",
        r"SOFTWARE\WOW6432Node\Eclipse Adoptium",
        r"SOFTWARE\Microsoft\JDK",
        r"SOFTWARE\Azul Systems\Zulu",
        r"SOFTWARE\BellSoft",
    ];
    for base in bases {
        let Ok(key) = hklm.open_subkey_with_flags(base, KEY_READ) else {
            continue;
        };
        collect_java_homes(&key, &mut out, 0);
    }
    out
}

#[cfg(windows)]
fn collect_java_homes(key: &winreg::RegKey, out: &mut Vec<PathBuf>, depth: u32) {
    use winreg::enums::KEY_READ;
    if depth > 3 {
        return;
    }
    for name in key.enum_keys().flatten() {
        let Ok(child) = key.open_subkey_with_flags(&name, KEY_READ) else {
            continue;
        };
        // 有的厂商直接把 JavaHome 写在版本键上，有的多一层（MSI 的 MSIReg 之类）
        for value_name in ["JavaHome", "Path", "InstallationPath"] {
            if let Ok(v) = child.get_value::<String, _>(value_name) {
                if !v.trim().is_empty() {
                    let p = PathBuf::from(v.trim());
                    let exe = java_exe_in(&p);
                    if exe.is_file() {
                        out.push(exe);
                    }
                }
            }
        }
        collect_java_homes(&child, out, depth + 1);
    }
}

#[cfg(not(windows))]
fn registry_javas() -> Vec<PathBuf> {
    Vec::new()
}

/// 别的启动器记下来的 Java 位置。
///
/// 实测本机：`%APPDATA%\PCL\config.json` 的 `JavaList` 里正好列着三份
/// （Java 8 / 21 / 25）—— PCL 已经帮我们探测过一遍了，直接采信它的**路径**，
/// 但**版本号仍然由我们自己跑 `java -version` 得出**（别人的结论会过期）。
#[cfg(windows)]
fn other_launcher_javas() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(appdata) = std::env::var("APPDATA") else {
        return out;
    };
    let mut configs: Vec<(PathBuf, &[&str])> = vec![
        (
            PathBuf::from(&appdata).join("PCL").join("config.json"),
            &["JavaList", "Folder"][..],
        ),
        (
            // HMCL 的 java 列表在 `%APPDATA%\HMCL\java.txt`（每行一个目录）
            PathBuf::from(&appdata).join("HMCL").join("java.txt"),
            &[][..],
        ),
    ];
    // 便携版常见的几个位置
    configs.push((
        PathBuf::from(&appdata)
            .join(".minecraft")
            .join("PCL")
            .join("config.json"),
        &["JavaList", "Folder"][..],
    ));

    for (file, _hint) in configs {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        if file.extension().map(|e| e == "txt").unwrap_or(false) {
            for line in text.lines() {
                let line = line.trim();
                if !line.is_empty() {
                    let exe = java_exe_in(Path::new(line));
                    if exe.is_file() {
                        out.push(exe);
                    }
                }
            }
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        walk_json_for_java_dirs(&v, &mut out, 0);
    }
    out
}

#[cfg(not(windows))]
fn other_launcher_javas() -> Vec<PathBuf> {
    Vec::new()
}

/// 在 JSON 里找形如 `"C:\\...\\bin\\"`（或 `...\\bin`）的字符串。
///
/// 刻意**不写死字段名**：PCL 的字段（`JavaList[].Folder`）在版本之间改过名，
/// 而"以 `bin` 结尾的路径"这件事本身就是判据 —— 认它比认字段名耐用。
fn walk_json_for_java_dirs(v: &serde_json::Value, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 6 {
        return;
    }
    match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.len() < 4 {
                return;
            }
            let looks_like_bin = t
                .trim_end_matches(['\\', '/'])
                .to_lowercase()
                .ends_with("\\bin")
                || t.to_lowercase().ends_with("/bin");
            if !looks_like_bin {
                return;
            }
            let dir = PathBuf::from(t);
            let exe = dir.join(if cfg!(windows) { "java.exe" } else { "java" });
            if exe.is_file() {
                out.push(exe);
            }
        }
        serde_json::Value::Array(a) => {
            for x in a {
                walk_json_for_java_dirs(x, out, depth + 1);
            }
        }
        serde_json::Value::Object(o) => {
            for (_, x) in o {
                walk_json_for_java_dirs(x, out, depth + 1);
            }
        }
        _ => {}
    }
}

/// 根目录浅扫描：`C:\jdk25\jdk-25.0.3+9`、`D:\java\jdk-21` 这种手装布局。
///
/// ★ 实测本机就有一个：`JAVA_HOME` 指向 `C:\jdk25\jdk-25.0.3+9`。
///   深度限制 3 层 —— 再深就不是"用户手装的 JDK"，而是某个软件自带的运行时，
///   扫进来只会让列表变脏。
#[cfg(windows)]
fn shallow_drive_javas() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let drives: Vec<String> = ('C'..='Z')
        .map(|c| format!("{c}:\\"))
        .filter(|d| Path::new(d).is_dir())
        .collect();
    for drive in drives {
        let Ok(entries) = std::fs::read_dir(&drive) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if !looks_like_java_dir(&name) {
                continue;
            }
            // 这一层可能直接就是 JAVA_HOME，也可能再套一层（`C:\jdk25\jdk-25.0.3+9`）
            let direct = java_exe_in(&e.path());
            if direct.is_file() {
                out.push(direct);
            }
            if let Ok(inner) = std::fs::read_dir(e.path()) {
                for i in inner.flatten() {
                    let exe = java_exe_in(&i.path());
                    if exe.is_file() {
                        out.push(exe);
                    }
                }
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn shallow_drive_javas() -> Vec<PathBuf> {
    Vec::new()
}

fn looks_like_java_dir(name: &str) -> bool {
    const KEYS: [&str; 14] = [
        "jdk", "jre", "java", "adoptium", "temurin", "zulu", "corretto", "graal", "liberica",
        "semeru", "bellsoft", "openjdk", "microsoft-jdk", "dragonwell",
    ];
    KEYS.iter().any(|k| name.contains(k))
}

fn common_java_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        vec![
            PathBuf::from(r"C:\Program Files\Eclipse Adoptium"),
            PathBuf::from(r"C:\Program Files\Java"),
            PathBuf::from(r"C:\Program Files\Zulu"),
            PathBuf::from(r"C:\Program Files\Microsoft"),
            PathBuf::from(r"C:\Program Files\BellSoft"),
            PathBuf::from(r"C:\Program Files (x86)\Java"),
        ]
    }
    #[cfg(target_os = "macos")]
    {
        vec![PathBuf::from("/Library/Java/JavaVirtualMachines")]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        vec![
            PathBuf::from("/usr/lib/jvm"),
            PathBuf::from("/usr/java"),
        ]
    }
}

fn java_exe_in(dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "java.exe" } else { "java" };
    // 常见布局：<root>/bin/java、<root>/jre/bin/java、<root>/Contents/Home/bin/java
    let candidates = [
        dir.join("bin").join(name),
        dir.join("jre").join("bin").join(name),
        dir.join("Contents").join("Home").join("bin").join(name),
    ];
    for c in &candidates {
        if c.is_file() {
            return c.clone();
        }
    }
    candidates[0].clone()
}

/// 跑 `java -version` 读出真实版本信息。
/// 探测失败返回 None —— 宁可少列一个，也不列一个用不了的。
fn probe_java(exe: &Path, source: &str) -> Option<JavaRuntime> {
    if !exe.is_file() {
        return None;
    }

    let mut cmd = std::process::Command::new(exe);
    cmd.arg("-version");
    // ★ 不弹黑框（唯一入口，见上面的 `hide_console`）
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    // java -version 把版本写到 stderr
    let text = String::from_utf8_lossy(&out.stderr).to_string()
        + &String::from_utf8_lossy(&out.stdout);

    let (version, major) = parse_java_version(&text)?;
    let vendor = detect_vendor(&text, exe);
    // 官方 Oracle JDK 在启动器里默认禁用（授权限制）—— 必须在 move 之前算出来
    let disabled_by_default = vendor.contains("Oracle");

    Some(JavaRuntime {
        path: exe.to_string_lossy().to_string(),
        major,
        version,
        vendor,
        arch: std::env::consts::ARCH.to_string(),
        source: source.to_string(),
        disabled_by_default,
        bytes: dir_size(exe.parent().and_then(|p| p.parent()).unwrap_or(Path::new("."))),
    })
}

/// 从 `java -version` 的输出里解析版本号。
/// 形如：openjdk version "17.0.10" 2024-01-16 / java version "1.8.0_402"
pub fn parse_java_version(text: &str) -> Option<(String, u32)> {
    let re = regex::Regex::new(r#"version "([^"]+)""#).ok()?;
    let caps = re.captures(text)?;
    let raw = caps.get(1)?.as_str().to_string();

    // 1.8.0_402 → 8 ; 17.0.10 → 17 ; 21 → 21
    let mut parts = raw.split(['.', '_', '-']);
    let first: u32 = parts.next()?.parse().ok()?;
    let major = if first == 1 {
        parts.next()?.parse().ok()?
    } else {
        first
    };
    Some((raw, major))
}

fn detect_vendor(text: &str, exe: &Path) -> String {
    let lower = text.to_lowercase();
    let path_lower = exe.to_string_lossy().to_lowercase();
    let mut hay = format!("{lower} {path_lower}");

    /*
     * ★★ 老 JRE 的 `java -version` 输出里**没有厂商信息**。
     *
     *   实测（本机 `%APPDATA%\.minecraft\runtime\jre-legacy\bin\java.exe`）：
     *   `java version "1.8.0_51"` 一行，前两行是 `java version` + `Java(TM) SE
     *   Runtime Environment`。于是路径里也没有 "oracle" 字样时就会落到
     *   "未知厂商"。
     *
     *   为什么这不只是"显示不好看"：`disabled_by_default` 判的是
     *   `vendor.contains("Oracle")` —— Oracle 的 JDK 因授权限制默认禁用。
     *   识别不出厂商，一个装在自选目录（`D:\java\jdk-8u401`）的 Oracle JDK
     *   就会被**当成普通 Java 正常使用**，用户可能莫名其妙吃授权问题。
     *
     *   可靠得多的办法：JDK 9+ 与 Mojang 的运行时都在版本目录里放一个
     *   `release` 文件，里面写着 `JAVA_VENDOR="Oracle Corporation"` 这类事实。
     *   它是**盘上的证据**，比字符串猜谜准。
     */
    if let Some(home) = exe.parent().and_then(|p| p.parent()) {
        if let Ok(release) = std::fs::read_to_string(home.join("release")) {
            hay.push(' ');
            hay.push_str(&release.to_lowercase());
        }
        // 老 JRE 没有 release 文件，但 `lib/rt.jar` 的时代有 COPYRIGHT
        if let Ok(c) = std::fs::read_to_string(home.join("COPYRIGHT")) {
            let head: String = c.chars().take(600).collect();
            hay.push(' ');
            hay.push_str(&head.to_lowercase());
        }
    }

    if hay.contains("temurin") || hay.contains("adoptium") {
        "Temurin".into()
    } else if hay.contains("zulu") || hay.contains("azul") {
        "Zulu".into()
    } else if hay.contains("oracle") {
        "Oracle".into()
    } else if hay.contains("microsoft") {
        "Microsoft".into()
    } else if hay.contains("liberica") || hay.contains("bellsoft") {
        "Liberica".into()
    } else if hay.contains("graalvm") || hay.contains("graal") {
        "GraalVM".into()
    } else if hay.contains("corretto") || hay.contains("amazon") {
        "Corretto".into()
    } else if hay.contains("semeru") || hay.contains("ibm") {
        "Semeru".into()
    } else if hay.contains("openjdk") {
        "OpenJDK".into()
    } else {
        "未知厂商".into()
    }
}

fn push_unique(list: &mut Vec<JavaRuntime>, rt: JavaRuntime) {
    if !list.iter().any(|x| x.path == rt.path) {
        list.push(rt);
    }
}
/// 目录占用（用于让用户看到"自动下载的 Java 占了多大"）
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for e in entries.flatten() {
        let p = e.path();
        if let Ok(meta) = e.metadata() {
            if meta.is_dir() {
                total += dir_size(&p);
            } else {
                total += meta.len();
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * ★★ 2026-09-23（用户第 5 条：「如果选中版本没有 mod 文件夹，**创建文件夹并放入**，
     *   避免下载到"虚空"里；如果选择**原版**也得这样，即使不可运行」）：
     *
     *   这条保障**本来就在**（`install_resource` 里那句 `create_dir_all`），
     *   但以前**没有判据钉住它** —— 谁把那句删了、或者把路径算错一层，
     *   表现就是"装完找不到文件"（用户说的"下到虚空里"），**而且不报错**。
     *
     *   所以这里验两件事，对**每一种资源**都验一遍：
     *     ① 目录**能**被建出来（调用前断言它不存在，否则测不出"生不生成"）；
     *     ② 路径形状是 `<实例>/game/<install_dir>` —— 游戏的工作目录就是 `game/`，
     *        资源必须落在**它下面**才读得到。
     *   ★ 「原版也得这样」在这里自然成立：资源目录只与**实例**有关、
     *     与实例有没有加载器无关 —— 这条测试里的实例根本没有加载器。
     */
    #[test]
    fn 装资源前目录必须建出来() {
        use crate::domain::resources::ResourceKind;

        let tmp = std::env::temp_dir().join(format!("ieml-resdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);

        let paths = AppPaths {
            root: tmp.clone(),
            own_root: tmp.clone(),
            shared: tmp.join(".minecraft"),
            instances: tmp.join("instances"),
            java: tmp.join("java"),
            cache: tmp.join("cache"),
            logs: tmp.join("logs"),
        };

        for kind in ResourceKind::ALL {
            let dir = paths.instance_resource_dir("demo", kind);
            if kind == ResourceKind::Modpack {
                assert_eq!(kind.install_dir(), "", "整合包不该有资源目录");
                continue;
            }
            assert!(
                !dir.exists(),
                "{kind:?} 的目录在调用前不该存在（这才测得出生不生成）"
            );
            std::fs::create_dir_all(&dir).expect("创建资源目录");
            assert!(dir.is_dir(), "{kind:?} 的目录应当被建出来：{}", dir.display());
            assert!(
                dir.ends_with(std::path::Path::new("game").join(kind.install_dir())),
                "{kind:?} 的目录应当在 <实例>/game/ 下：{}",
                dir.display()
            );
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /*
     * ★★ 2026-09-22（用户：「这个根目录只创建装游戏的根目录，**不要附带启动器文件**」）：
     *   选定新根目录时**只建 `.minecraft`**（游戏那一边），
     *   启动器自己的目录由 `ensure_own()` 懒建。
     *
     *   ★ 这里直接测 `AppPaths::ensure()` 的形状（不碰 `set_data_root` ——
     *     它会写真实的 datadir.txt，跑一次单测就改掉开发机的记录）。
     *     临时目录里的断言：根目录下**只有游戏那边的东西**
     *     （`.minecraft` + `instances`），
     *     不该冒出 java / cache / logs / shared。
     */
    #[test]
    fn ensure_只建游戏目录_不建启动器目录() {
        let tmp = std::env::temp_dir().join(format!("ieml-ensure-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("建临时目录");

        // 用 AppPaths 的字段直接拼一份（不 resolve，避免读到开发机的真实配置）
        // ★ 注意 `shared` 的**位置**就是 `.minecraft`（字段名是历史遗留，见它的文档注释）
        // ★ 2026-09-23：java / cache / logs 挂在 `own_root`（另一个临时目录）——
        //   这条测试仍然要断言"**游戏根目录里不出现它们**"。
        // ★ 2026-09-24：`instances` 反过来 —— 它是游戏那边的（存档 / Mod），
        //   所以它**必须**出现在游戏根目录里，而不是 own_root 里。
        let own = std::env::temp_dir().join(format!("ieml-own-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&own);
        let paths = AppPaths {
            root: tmp.clone(),
            own_root: own.clone(),
            shared: tmp.join(".minecraft"),
            instances: tmp.join("instances"),
            java: own.join("java"),
            cache: own.join("cache"),
            logs: own.join("logs"),
        };

        paths.ensure().expect("ensure 应当成功");

        let names: Vec<String> = std::fs::read_dir(&tmp)
            .expect("读临时目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        for want in [".minecraft", "instances"] {
            assert!(
                names.iter().any(|n| n == want),
                "应当建出游戏目录 {want}，实际：{names:?}"
            );
        }
        for bad in ["shared", "java", "cache", "logs"] {
            assert!(
                !names.iter().any(|n| n == bad),
                "不该在根目录建启动器目录 {bad}，实际：{names:?}"
            );
        }

        // `ensure_own()` 才是建启动器目录的那一个
        // ★ 列表里**没有 `shared`** —— 它的位置就是 `.minecraft`（上面已经建过了）
        // ★ 2026-09-23：它们建在 **own_root** 下，不再在游戏根目录里
        // ★ 2026-09-24：也没有 `instances` —— 它是游戏那边的，由 `ensure()` 建
        paths.ensure_own().expect("ensure_own 应当成功");
        for want in ["java", "cache", "logs"] {
            assert!(own.join(want).is_dir(), "ensure_own 之后应当在 own_root 下有 {want}");
            assert!(
                !tmp.join(want).exists(),
                "**游戏根目录里不该出现**启动器目录 {want}"
            );
        }
        assert!(
            !own.join("instances").exists(),
            "own_root 里**不该**再出现 instances —— 它跟着游戏根目录"
        );

        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&own);
    }

    /*
     * ★★ 换数据根目录的判据（2026-09-17 用户要求"单独建一个根目录，源目录不删"）。
     *
     *   测的是 `validate_data_root`（纯校验）而**不是** `set_data_root` ——
     *   后者成功时会写真实的 `datadir.txt`，跑一次单测就会把开发机的
     *   数据目录记录改掉。所以副作用那一步不在这里测。
     */
    #[test]
    fn data_root_rejects_empty_and_relative() {
        let cur = PathBuf::from(r"D:\IEML");
        assert!(validate_data_root(Path::new(""), &cur).is_err(), "空路径该拒");
        assert!(
            validate_data_root(Path::new(r"newdata"), &cur).is_err(),
            "相对路径该拒（相对谁？没有意义）"
        );
    }

    #[test]
    fn data_root_rejects_same_path_even_with_trailing_slash() {
        let cur = PathBuf::from(r"D:\IEML");
        assert!(validate_data_root(Path::new(r"D:\IEML"), &cur).is_err(), "同一个该拒");
        assert!(
            validate_data_root(Path::new(r"D:\IEML\"), &cur).is_err(),
            "只差一个反斜杠也是同一个地方，不该当成「变了」"
        );
    }

    #[test]
    fn data_root_rejects_nesting_in_both_directions() {
        let cur = PathBuf::from(r"D:\IEML");
        let inside = PathBuf::from(r"D:\IEML\sub");
        assert!(
            validate_data_root(&inside, &cur).is_err(),
            "数据目录套数据目录：扫描与清理会把彼此当内容"
        );
        let outside = PathBuf::from(r"D:\");
        assert!(
            validate_data_root(&outside, &cur).is_err(),
            "反过来也不行：当前目录在目标里面"
        );
    }

    #[test]
    fn data_root_accepts_a_writable_temp_dir() {
        let cur = PathBuf::from(r"D:\IEML");
        // 必须是个真的能建的临时目录 —— 校验里那一步会试写
        let tmp = std::env::temp_dir().join(format!("ieml-dataroot-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let r = validate_data_root(&tmp, &cur);
        assert!(r.is_ok(), "能建能写的目录该通过，实际：{r:?}");
        // 校验会顺便把目录建出来（试写探针需要），这里收干净
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn volume_list_is_self_consistent() {
        let vols = list_volumes(Path::new(r"D:\IEML"));
        if vols.is_empty() {
            return; // 非 Windows：这个列表本来就是空的
        }
        for v in &vols {
            assert!(
                v.suggested.starts_with(&v.path),
                "建议目录必须在这块盘里：{} vs {}",
                v.suggested,
                v.path
            );
            assert!(
                v.suggested.ends_with(DATA_DIR_NAME),
                "目录名必须来自 DATA_DIR_NAME（前端不许自己拼）：{}",
                v.suggested
            );
            assert!(v.free_gb <= v.total_gb + 0.1, "剩余不可能大于总量：{v:?}");
        }
        // 非系统盘要排在系统盘前面 —— 除非机器上只有系统盘
        assert!(
            !vols[0].is_system || vols.iter().all(|v| v.is_system),
            "系统盘不该排在最前（默认选址刻意躲开它）：{vols:?}"
        );
    }

    /// ★ "现在用的目录在哪块盘上"必须**恰好命中一块** ——
    ///   命中 0 块（界面上一片"正在用"都没有）或命中 2 块（两块都说正在用）
    ///   都是那种"看起来只是显示问题"、实际会让用户选错盘的错。
    #[test]
    fn exactly_one_volume_is_the_suggested_one_of_the_current_root() {
        let vols = list_volumes(Path::new(r"D:\IEML"));
        if vols.is_empty() {
            return;
        }
        let probe = PathBuf::from(&vols[0].suggested);
        let marked = list_volumes(&probe);
        let cur: Vec<&VolumeInfo> = marked.iter().filter(|v| v.is_current).collect();
        assert_eq!(cur.len(), 1, "当前那一行必须恰好标出一块：{marked:?}");
        assert_eq!(cur[0].path, vols[0].path);
        assert!(cur[0].on_current_drive);
    }

    /// ★★ 用户在 D: 上选了一个**自定义目录**（`D:\测试目录`）时：
    ///   建议行（`D:\IEML`）**不能**被标成"正在用" —— 否则那一行的按钮会被禁用，
    ///   玩家就换不回 `D:\IEML` 了（2026-09-20 用户真踩到：他换成了 `D:\测试目录`）。
    #[test]
    fn a_custom_folder_does_not_disable_the_whole_drive() {
        let custom = Path::new(r"D:\__ieml_test_custom__");
        let vols = list_volumes(custom);
        if vols.is_empty() {
            return;
        }
        assert!(
            vols.iter().all(|v| !v.is_current),
            "建议目录都不是现在用的那个，谁都不该标『正在用』：{vols:?}"
        );
        let on_same_drive = vols.iter().find(|v| custom.starts_with(&v.path));
        if let Some(v) = on_same_drive {
            assert!(v.on_current_drive, "同一块盘要认出来：{v:?}");
        }
    }

    #[test]
    fn same_path_ignores_case_and_trailing_separator() {
        assert!(same_path(Path::new(r"D:\IEML"), Path::new(r"d:\ieml\")));
        assert!(!same_path(Path::new(r"D:\IEML"), Path::new(r"D:\IEML2")));
        assert!(!same_path(Path::new(""), Path::new("")));
    }

    /* ---------- 「用过的游戏文件夹」列表（PCL 那种） ---------- */

    /// ★ 这些测试**一律用临时文件**，绝不碰 `%APPDATA%\IEML\known-roots.json` ——
    ///   与 `data_root_accepts_a_writable_temp_dir` 是同一条规矩：
    ///   单测不许改开发机的真实状态。
    fn tmp_roots_file(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ieml-known-roots-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d.join("known-roots.json")
    }

    #[test]
    fn known_roots_dedupe_and_move_to_front() {
        let f = tmp_roots_file("dedupe");
        let _ = std::fs::remove_file(&f);

        remember_root_at(&f, Path::new(r"D:\IEML"));
        remember_root_at(&f, Path::new(r"E:\IEML"));
        // ★ 同一个地方的不同写法（大小写 + 末尾分隔符）**不许**变成两条
        remember_root_at(&f, Path::new(r"d:\ieml\"));

        let got = load_known_roots_from(&f);
        assert_eq!(got.len(), 2, "应该只剩两条：{got:?}");
        assert_eq!(got[0], PathBuf::from(r"d:\ieml\"), "最近用过的排最前");
        assert_eq!(got[1], PathBuf::from(r"E:\IEML"));

        let _ = std::fs::remove_dir_all(f.parent().unwrap());
    }

    #[test]
    fn known_roots_are_capped_and_forgettable() {
        let f = tmp_roots_file("cap");
        let _ = std::fs::remove_file(&f);
        for i in 0..(MAX_KNOWN_ROOTS + 5) {
            remember_root_at(&f, Path::new(&format!(r"D:\ieml-{i}")));
        }
        assert_eq!(load_known_roots_from(&f).len(), MAX_KNOWN_ROOTS, "有上限");

        forget_root_at(&f, Path::new(r"D:\ieml-24"));
        assert!(
            !load_known_roots_from(&f)
                .iter()
                .any(|p| p == Path::new(r"D:\ieml-24")),
            "移除之后就没了"
        );

        let _ = std::fs::remove_dir_all(f.parent().unwrap());
    }

    /// ★ **坏文件不许拦启动**：这个文件只是"便利"，不是数据。
    #[test]
    fn a_corrupt_roots_file_is_treated_as_empty() {
        let f = tmp_roots_file("corrupt");
        std::fs::write(&f, b"{ this is not json").unwrap();
        assert!(load_known_roots_from(&f).is_empty());

        // 而且还能被重新写回一份好的
        remember_root_at(&f, Path::new(r"D:\IEML"));
        assert_eq!(load_known_roots_from(&f).len(), 1);

        let _ = std::fs::remove_dir_all(f.parent().unwrap());
    }

    /// 列表里**当前那个排最前**、名字取最后一段、盘根目录不 panic。
    #[test]
    fn list_marks_the_current_root_first_with_a_readable_name() {
        let custom = PathBuf::from(r"D:\__ieml_list_test__");
        let list = list_known_roots(&custom);
        assert!(!list.is_empty(), "至少要有当前这一条");
        assert!(list[0].is_current, "当前那个必须排最前：{list:?}");
        assert_eq!(list[0].name, "__ieml_list_test__", "名字取路径最后一段");
        assert_eq!(list[0].source, "known");
        // 同一个路径不许出现两次（known 与 found 去重）
        let same = list
            .iter()
            .filter(|r| same_path(Path::new(&r.path), &custom))
            .count();
        assert_eq!(same, 1, "同一路径只该有一行：{list:?}");
    }

    #[test]
    fn parse_modern_version() {
        let t = r#"openjdk version "17.0.10" 2024-01-16"#;
        assert_eq!(parse_java_version(t), Some(("17.0.10".into(), 17)));
    }

    #[test]
    fn parse_legacy_18_version() {
        let t = r#"java version "1.8.0_402""#;
        assert_eq!(parse_java_version(t), Some(("1.8.0_402".into(), 8)));
    }

    #[test]
    fn parse_major_only() {
        let t = r#"openjdk version "21" 2023-09-19"#;
        assert_eq!(parse_java_version(t), Some(("21".into(), 21)));
    }

    #[test]
    fn parse_garbage_returns_none() {
        assert_eq!(parse_java_version("no version here"), None);
    }

    /// ★★ 2026-09-20：这条断言**原来写的是** `p.root.to_string_lossy().contains("IEML")`
    ///   —— 那是错的，而且错得会咬人：
    ///
    ///   从「新建/切换游戏根目录」起（beta.46），玩家可以把数据目录设成**任意路径**；
    ///   beta.51 把入口做成"在启动器里选"之后，用户第一次试就把根目录换成了
    ///   `D:\测试目录` —— 于是 `cargo test --lib` 里这条**红给开发者看**，
    ///   而它判的其实是"用户做了一个合法的选择"。
    ///   （真事：这一轮 verify 就是这么红的。）
    ///
    ///   现在只断言真正该成立的事：**绝对路径**、且各子目录都挂在它下面。
    #[test]
    fn app_paths_shape() {
        let p = AppPaths::resolve();
        assert!(
            p.root.is_absolute(),
            "数据根目录必须是绝对路径：{}",
            p.root.display()
        );
        /*
         * ★★ 2026-09-23（用户确认「启动器自己的目录要搬出游戏根目录：是的」）：
         *   java / cache / logs 挂在 `own_root`（%APPDATA%\IEML）。
         *
         * ★★ 2026-09-24（用户：「我在用 D 盘的目录，为什么版本列表的版本给我定位到
         *   `C:\Users\…\Roaming\IEML\instances` 了」）：
         *   **实例目录回到游戏根目录**（存档 / Mod 是游戏数据，跟着用户挑的盘走）——
         *   这条断言因此整个反过来了。判据见 `AppPaths::instances`。
         */
        assert!(
            p.own_root.is_absolute(),
            "启动器数据目录必须是绝对路径：{}",
            p.own_root.display()
        );
        assert!(
            p.instances.starts_with(&p.root),
            "实例目录必须在**游戏根目录**下：{:?}（root={:?}）",
            p.instances,
            p.root
        );
        assert!(
            !p.instances.starts_with(&p.own_root),
            "实例目录**不该**在启动器数据目录里：{:?}",
            p.instances
        );
        assert!(p.instances.ends_with("instances"));
        // ★ 启动器自己的三样东西留在 own_root 里（与实例目录分开）
        for (name, dir) in [("java", &p.java), ("cache", &p.cache), ("logs", &p.logs)] {
            assert!(
                dir.starts_with(&p.own_root),
                "{name} 必须在启动器数据目录下：{dir:?}"
            );
            assert!(
                !dir.starts_with(&p.root),
                "{name} **不该**在游戏根目录里：{dir:?}"
            );
        }
        // ★ 游戏数据在数据根目录内的 `.minecraft`（PCL 同款布局）
        assert!(
            p.shared.ends_with(GAME_DIR_NAME),
            "游戏数据目录应该是 .minecraft：{:?}",
            p.shared
        );
        assert_eq!(p.shared.parent().unwrap(), p.root);
    }

    /* ---------- 游戏数据布局：shared/ → .minecraft/（0.1.0-beta.3） ---------- */

    /// 老布局（`shared/`）要**整体改名**成 `.minecraft/`，内容一个不少。
    #[test]
    fn legacy_shared_becomes_minecraft() {
        let root = tmp("layout1");
        std::fs::create_dir_all(root.join("shared").join("libraries")).unwrap();
        std::fs::write(root.join("shared").join("libraries").join("a.jar"), b"JAR").unwrap();

        let moved = migrate_shared_into_game_dir(&root).unwrap();
        assert!(moved.is_some(), "应该真的搬了");
        assert!(!root.join("shared").exists(), "旧目录应该已经不在了");
        assert_eq!(
            std::fs::read(root.join(".minecraft").join("libraries").join("a.jar")).unwrap(),
            b"JAR"
        );
    }

    /// ★ 目标是个**空壳目录**时也要搬。
    ///
    ///   `AppPaths::ensure()` 每次启动都会把 `.minecraft/` 建出来，所以"空壳"
    ///   是常态。如果不处理它，迁移就永远不会发生 —— 而日志还会说"不用搬"。
    #[test]
    fn empty_shell_is_replaced_by_the_legacy_dir() {
        let root = tmp("layout2");
        std::fs::create_dir_all(root.join("shared").join("assets")).unwrap();
        std::fs::write(root.join("shared").join("assets").join("x.bin"), b"X").unwrap();
        std::fs::create_dir_all(root.join(".minecraft")).unwrap(); // ensure() 建的空壳

        let moved = migrate_shared_into_game_dir(&root).unwrap();
        assert!(moved.is_some(), "空壳不算数，应该照搬");
        assert!(root.join(".minecraft").join("assets").join("x.bin").is_file());
    }

    /// ★ 目标里**已经有东西** → 一个字节都不动（用户的 `shared/` 可能是别的东西）。
    #[test]
    fn non_empty_minecraft_is_never_touched() {
        let root = tmp("layout3");
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::fs::write(root.join("shared").join("old.txt"), b"OLD").unwrap();
        std::fs::create_dir_all(root.join(".minecraft")).unwrap();
        std::fs::write(root.join(".minecraft").join("new.txt"), b"NEW").unwrap();

        assert!(migrate_shared_into_game_dir(&root).unwrap().is_none());
        assert!(root.join("shared").join("old.txt").is_file(), "旧目录必须原样保留");
        assert_eq!(
            std::fs::read(root.join(".minecraft").join("new.txt")).unwrap(),
            b"NEW"
        );
    }

    /// 全新安装：两个都没有 → 什么都不做（不报错、不建目录）。
    #[test]
    fn fresh_install_does_nothing() {
        let root = tmp("layout4");
        assert!(migrate_shared_into_game_dir(&root).unwrap().is_none());
        assert!(!root.join(".minecraft").exists());
    }

    /// 重复调用是安全的（第二次已经没有 `shared/` 了）。
    #[test]
    fn migration_is_idempotent() {
        let root = tmp("layout5");
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::fs::write(root.join("shared").join("f.txt"), b"F").unwrap();
        assert!(migrate_shared_into_game_dir(&root).unwrap().is_some());
        assert!(migrate_shared_into_game_dir(&root).unwrap().is_none());
        assert!(root.join(".minecraft").join("f.txt").is_file());
    }

    /* ---------- 数据目录迁移：**绝不丢用户数据** ---------- */

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ieml-migrate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// ★★ 目标已有的文件**一个字节都不许动**。
    ///
    ///   这是"绝不丢用户数据"的第一条。目标那份是用户**当下正在用**的，
    ///   源那份是"以前那份" —— 任何情况下都该以目标为准。
    #[test]
    fn migration_never_overwrites_existing_destination_files() {
        let old = tmp("old1");
        let new = tmp("new1");

        std::fs::create_dir_all(old.join("instances")).unwrap();
        std::fs::create_dir_all(new.join("instances")).unwrap();
        std::fs::write(old.join("instances").join("a.txt"), "OLD").unwrap();
        std::fs::write(new.join("instances").join("a.txt"), "NEW").unwrap();
        // 源里还有一个目标没有的文件 → 应该补过去
        std::fs::write(old.join("instances").join("b.txt"), "ONLY-IN-OLD").unwrap();

        migrate_data_root(&old, &new).unwrap();

        assert_eq!(
            std::fs::read_to_string(new.join("instances").join("a.txt")).unwrap(),
            "NEW",
            "★ 目标已有的文件被源覆盖了 —— 这就是丢用户数据"
        );
        assert_eq!(
            std::fs::read_to_string(new.join("instances").join("b.txt")).unwrap(),
            "ONLY-IN-OLD",
            "目标缺的文件应该补齐"
        );
        // 源必须原样留着（只复制、绝不删源）
        assert!(old.join("instances").join("a.txt").is_file());
        assert!(old.join("instances").join("b.txt").is_file());
    }

    /// ★★ 目标的 `instances.json` 被写成了空列表、而源里有人 → 必须补回来。
    ///
    ///   这条是**实测事故**的回归测试：
    ///   某次启动后 `instances.json` 变成 `{"instances":[],"active_id":null}`，
    ///   用户建的三个版本从界面上消失了 —— 而老位置的文件明明还在。
    ///   当时这里只按"目标存在就跳过"处理，于是永远修不回来。
    #[test]
    fn migration_repairs_an_emptied_instance_list() {
        let old = tmp("old2");
        let new = tmp("new2");

        let three = r#"{"instances":[{"id":"a"},{"id":"b"},{"id":"c"}],"active_id":"a"}"#;
        std::fs::write(old.join("instances.json"), three).unwrap();
        // 目标被写坏了
        std::fs::write(new.join("instances.json"), r#"{"instances":[],"active_id":null}"#).unwrap();

        migrate_data_root(&old, &new).unwrap();

        let got = std::fs::read_to_string(new.join("instances.json")).unwrap();
        assert!(
            got.contains("\"id\": \"a\"") || got.contains("\"id\":\"a\""),
            "★ 被写空的实例列表没有补回来，实际内容：{got}"
        );
    }

    /// 反过来：目标里**有**用户自己的实例，源里也有别的 →
    /// **不许**用源的替换目标的（否则用户新装的版本会消失）。
    #[test]
    fn migration_does_not_replace_a_healthy_instance_list() {
        let old = tmp("old3");
        let new = tmp("new3");

        std::fs::write(old.join("instances.json"), r#"{"instances":[{"id":"old"}],"active_id":null}"#)
            .unwrap();
        std::fs::write(
            new.join("instances.json"),
            r#"{"instances":[{"id":"mine-1"},{"id":"mine-2"}],"active_id":null}"#,
        )
        .unwrap();

        migrate_data_root(&old, &new).unwrap();

        let got = std::fs::read_to_string(new.join("instances.json")).unwrap();
        assert!(got.contains("mine-1"), "目标里的实例被源覆盖了：{got}");
        assert!(!got.contains("\"old\""), "源里那条不该被塞进来：{got}");
    }

    /// 目标完全不存在 → 源整份搬过去。
    #[test]
    fn migration_copies_everything_when_destination_is_empty() {
        let old = tmp("old4");
        let new = tmp("new4");

        std::fs::create_dir_all(old.join("shared").join("assets")).unwrap();
        std::fs::write(old.join("shared").join("assets").join("x.bin"), vec![7u8; 64]).unwrap();
        std::fs::create_dir_all(old.join("instances").join("saves")).unwrap();
        std::fs::write(old.join("instances").join("saves").join("level.dat"), b"save").unwrap();
        std::fs::write(old.join("instances.json"), r#"{"instances":[{"id":"z"}],"active_id":null}"#)
            .unwrap();

        let copied = migrate_data_root(&old, &new).unwrap();
        assert!(copied > 0, "应该真的复制了东西");
        // ★ 老根的 `shared/` 落到新根的 `.minecraft/`（布局在 0.1.0-beta.3 改过）
        assert!(new.join(GAME_DIR_NAME).join("assets").join("x.bin").is_file());
        assert!(new.join("instances").join("saves").join("level.dat").is_file());
        assert!(new.join("instances.json").is_file());
    }

    /// ★ 目标根**还停在老布局**（`shared/` 在）时，跨根补齐必须放进 `shared/`，
    ///   **绝不能**凭空造一个 `.minecraft/`。
    ///
    ///   这是 0.1.0-beta.3 实测踩到的真 bug 的回归测试：当时那一步把 C 盘的老数据
    ///   复制进了新根的 `.minecraft/`，而真数据还在 `shared/` —— 之后布局迁移
    ///   看到 `.minecraft` 有内容就跳过，用户会以为版本都丢了。
    #[test]
    fn migration_respects_the_destination_layout() {
        let old = tmp("old4c");
        let new = tmp("new4c");
        std::fs::create_dir_all(old.join(LEGACY_SHARED_NAME).join("assets")).unwrap();
        std::fs::write(
            old.join(LEGACY_SHARED_NAME).join("assets").join("legacy.bin"),
            vec![3u8; 16],
        )
        .unwrap();
        // 目标根**还在老布局**：有 shared/，没有 .minecraft/
        std::fs::create_dir_all(new.join(LEGACY_SHARED_NAME)).unwrap();

        migrate_data_root(&old, &new).unwrap();

        assert!(
            new.join(LEGACY_SHARED_NAME).join("assets").join("legacy.bin").is_file(),
            "补齐应该落在目标当前的布局里（shared/）"
        );
        assert!(
            !new.join(GAME_DIR_NAME).exists(),
            "不许凭空造出一个 .minecraft/ —— 那会让真数据看起来不见了"
        );
    }

    /// 新根如果已经是新布局（`.minecraft/`），跨根搬家也要照搬，别再去找 `shared/`。
    #[test]
    fn migration_reads_the_new_layout_too() {
        let old = tmp("old4b");
        let new = tmp("new4b");
        std::fs::create_dir_all(old.join(GAME_DIR_NAME).join("libraries")).unwrap();
        std::fs::write(
            old.join(GAME_DIR_NAME).join("libraries").join("y.jar"),
            vec![1u8; 32],
        )
        .unwrap();

        migrate_data_root(&old, &new).unwrap();
        assert!(new.join(GAME_DIR_NAME).join("libraries").join("y.jar").is_file());
    }

    /// 半截的下载残留不该跟着搬家（新位置会用新路径重下）。
    ///
    /// ★ 2026-09-24：例子从 `cache` 换成 `instances` —— 跨根搬家现在只搬
    ///   `instances`（启动器自己的 java/cache/logs 不再跟着搬，见 `migrate_data_root`），
    ///   而"半截文件不搬"这条规矩本身没变（实例里也有 `.part` 残留）。
    #[test]
    fn migration_skips_partial_downloads() {
        let old = tmp("old5");
        let new = tmp("new5");
        std::fs::create_dir_all(old.join("instances")).unwrap();
        std::fs::write(old.join("instances").join("a.jar.part.3"), b"junk").unwrap();
        std::fs::write(old.join("instances").join("b.jar"), b"good").unwrap();

        migrate_data_root(&old, &new).unwrap();

        assert!(
            !new.join("instances").join("a.jar.part.3").exists(),
            "半截的分片不该搬过去"
        );
        assert!(new.join("instances").join("b.jar").is_file());
    }

    /// ★★ 2026-09-24：启动器自己的目录**不再被搬进新的游戏根目录**。
    ///
    ///   真机上量到过的后果：`%APPDATA%\IEML\cache`（1839 个文件 / 9.5 MB）
    ///   被复制进 `D:\IEML\cache`，而启动器只读 own_root 那份 ——
    ///   游戏盘白占一份，用户看到的就是"根目录里附带了一堆启动器文件"。
    #[test]
    fn migration_leaves_launcher_dirs_out_of_the_game_root() {
        let old = tmp("old6");
        let new = tmp("new6");
        for name in ["java", "cache", "logs"] {
            std::fs::create_dir_all(old.join(name)).unwrap();
            std::fs::write(old.join(name).join("x.bin"), b"launcher").unwrap();
        }
        std::fs::create_dir_all(old.join("instances")).unwrap();
        std::fs::write(old.join("instances").join("keep.bin"), b"game").unwrap();

        migrate_data_root(&old, &new).unwrap();

        assert!(
            new.join("instances").join("keep.bin").is_file(),
            "游戏那一边的 instances 还是该搬"
        );
        for name in ["java", "cache", "logs"] {
            assert!(
                !new.join(name).exists(),
                "启动器目录 {name} 不该被搬进游戏根目录：{}",
                new.join(name).display()
            );
        }
    }

    /// ★★ 2026-09-24：**实例目录里的同名文件按 mtime 判胜负** —— 而且只对实例目录。
    ///
    ///   为什么：实例目录放的是用户自己会改的东西（`options.txt` 的游戏内设置、
    ///   存档、Mod）。用户被"错位置"坑了的那两天里，**写进去的是老位置那一份**；
    ///   只按"目标已有就跳过"，他换回游戏盘之后今天的设置会被十几天前那份盖掉。
    ///
    ///   真机上的对照（`fabric-262`）：老位置 = 当天 14:01（`lang:zh_cn`），
    ///   游戏根 = 09-12（`lang:en_us`）。
    ///
    ///   ★ 反面的那一半也要钉住：`.minecraft` 里的同名文件**不按 mtime**
    ///     （库/jar 的 mtime 没有意义），继续"目标已有就跳过"。
    #[test]
    fn instances_migration_lets_the_newer_copy_win() {
        let old = tmp("old7");
        let new = tmp("new7");
        let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        let game = |root: &Path| root.join("instances").join("s1").join("game");

        // 老位置（那两天应用实际在写的那份）
        std::fs::create_dir_all(game(&old)).unwrap();
        std::fs::write(game(&old).join("options.txt"), b"lang:zh_cn").unwrap();
        std::fs::write(game(&old).join("only-in-old.txt"), b"from-old").unwrap();
        std::fs::write(old.join("instances").join("s1").join("s1-only.bin"), b"x").unwrap();
        // 游戏根（十几天前那份）
        std::fs::create_dir_all(game(&new)).unwrap();
        std::fs::write(game(&new).join("options.txt"), b"lang:en_us").unwrap();
        std::fs::write(game(&new).join("only-in-new.txt"), b"keep-me").unwrap();
        // 显式拨 mtime：目标（游戏根）那份是一小时前，源（老位置）那份是现在
        set_mtime(&game(&new).join("options.txt"), hour_ago);
        set_mtime(&game(&old).join("options.txt"), std::time::SystemTime::now());

        // `.minecraft` 里的同名文件（同样的 mtime 关系）—— 应当**不动**
        std::fs::create_dir_all(old.join(GAME_DIR_NAME).join("libraries")).unwrap();
        std::fs::write(old.join(GAME_DIR_NAME).join("libraries").join("a.jar"), b"res-downloaded").unwrap();
        std::fs::create_dir_all(new.join(GAME_DIR_NAME).join("libraries")).unwrap();
        std::fs::write(new.join(GAME_DIR_NAME).join("libraries").join("a.jar"), b"already-here").unwrap();
        set_mtime(&new.join(GAME_DIR_NAME).join("libraries").join("a.jar"), hour_ago);
        set_mtime(&old.join(GAME_DIR_NAME).join("libraries").join("a.jar"), std::time::SystemTime::now());

        migrate_data_root(&old, &new).unwrap();

        let opts = game(&new).join("options.txt");
        assert_eq!(
            std::fs::read_to_string(&opts).unwrap(),
            "lang:zh_cn",
            "★ 老位置那份更新（用户最后真正玩过的那份）→ 它该赢"
        );
        let bak = game(&new).join("options.txt.ieml-bak");
        assert_eq!(
            std::fs::read_to_string(&bak).unwrap(),
            "lang:en_us",
            "被覆盖的那份必须留下备份（判错了也还有救）"
        );
        assert!(game(&new).join("only-in-old.txt").is_file(), "缺的要补");
        assert_eq!(
            std::fs::read_to_string(game(&new).join("only-in-new.txt")).unwrap(),
            "keep-me",
            "目标独有的文件不许动"
        );
        assert!(new.join("instances").join("s1").join("s1-only.bin").is_file(), "实例目录整体都要补");
        // 源一个字节都不删
        assert!(game(&old).join("options.txt").is_file());
        // ★ `.minecraft` 不按 mtime：目标已有就跳过
        assert_eq!(
            std::fs::read_to_string(new.join(GAME_DIR_NAME).join("libraries").join("a.jar")).unwrap(),
            "already-here",
            "库/jar 不该按 mtime 覆盖（那会让每次启动都可能重写共享文件）"
        );
        assert!(
            !new.join(GAME_DIR_NAME).join("libraries").join("a.jar.ieml-bak").exists(),
            "没覆盖就不该产生备份"
        );

        // 幂等：复制过一次之后两边 mtime 相等（`fs::copy` 会带 mtime）→ 第二次什么都不做
        let again = migrate_data_root(&old, &new).unwrap();
        assert!(
            again < std::fs::metadata(&opts).unwrap().len() + 1,
            "第二次不该再重复复制那一份（实际复制了 {again} 字节）"
        );
    }

    /// ★★ 2026-09-24：反方向 —— 游戏根目录里的启动器目录被**收养**到 own_root。
    ///
    ///   覆盖三件事：① 缺的复制过去；② 目标已有的文件一个字节都不动；
    ///   ③ 源就是 own_root 时不做任何事（否则等于自己复制自己，白跑一遍）。
    #[test]
    fn adopt_own_dirs_copies_launcher_dirs_into_own_root() {
        let (p, root, own) = tmp_paths("adopt");
        // 游戏根目录里留着老式启动器目录
        std::fs::create_dir_all(root.join("java").join("jdk-21")).unwrap();
        std::fs::write(root.join("java").join("jdk-21").join("bin.exe"), b"jdk").unwrap();
        std::fs::create_dir_all(root.join("cache")).unwrap();
        std::fs::write(root.join("cache").join("a.json"), b"from-game-root").unwrap();
        // 目标**已经有**同名文件（用户在用的那份）→ 绝不能被覆盖
        std::fs::create_dir_all(own.join("cache")).unwrap();
        std::fs::write(own.join("cache").join("a.json"), b"mine").unwrap();
        // 只有游戏根目录才有的第二个文件 → 该补过去
        std::fs::write(root.join("cache").join("b.json"), b"extra").unwrap();
        // 游戏根目录里没有 logs → 不该被凭空造出来
        let copied = adopt_own_dirs(&p, &root);

        assert!(copied > 0, "应当真的复制了东西");
        assert!(
            own.join("java").join("jdk-21").join("bin.exe").is_file(),
            "游戏根目录里下好的 Java 应当被收养"
        );
        assert_eq!(
            std::fs::read_to_string(own.join("cache").join("a.json")).unwrap(),
            "mine",
            "目标已有的文件一个字节都不许动"
        );
        assert_eq!(
            std::fs::read_to_string(own.join("cache").join("b.json")).unwrap(),
            "extra",
            "目标缺的文件应当补上"
        );
        assert!(!own.join("logs").exists(), "源里没有的目录不该凭空造");
        // 源照旧（只复制、绝不删源）
        assert!(root.join("cache").join("a.json").is_file());
        assert!(root.join("java").join("jdk-21").join("bin.exe").is_file());
        // 第二次跑：没什么可补的 → 0 字节
        assert_eq!(adopt_own_dirs(&p, &root), 0, "补齐之后不该再有动作");
        // 源 == own_root（本机就是 `%APPDATA%\IEML`）→ 直接跳过
        assert_eq!(adopt_own_dirs(&p, &own), 0, "源就是自己的家，不该自己复制自己");
    }

    /// 路径比较：`D:\IEML`、`d:/ieml/`、`D:\IEML\\` 必须是同一处。
    /// （收养老目录时用它判断"源是不是就是自己的家"，判错就会白复制一遍。）
    #[test]
    fn norm_path_is_forgiving_about_separators_and_case() {
        let a = norm_path(Path::new("D:\\IEML"));
        assert_eq!(a, norm_path(Path::new("D:\\IEML\\")));
        assert_eq!(a, norm_path(Path::new("D:/IEML/")));
        assert_eq!(a, norm_path(Path::new("D:\\IEML\\\\")));
        #[cfg(windows)]
        assert_eq!(a, norm_path(Path::new("d:\\ieml")), "Windows 上不分大小写");
        assert_ne!(a, norm_path(Path::new("D:\\IEML2")));
    }

    /// 系统盘判定：`%SystemRoot%` 所在的盘就是系统盘。
    #[test]
    #[cfg(windows)]
    fn system_drive_detection_is_sane() {
        let sys = std::env::var("SystemRoot").expect("Windows 一定有 SystemRoot");
        assert!(
            is_on_system_drive(Path::new(&sys)),
            "{sys} 应该在系统盘上"
        );
        // 别的盘符不该被判成系统盘（本机 C 是系统盘、D/E 不是）
        let sys_drive = Path::new(&sys)
            .components()
            .next()
            .unwrap()
            .as_os_str()
            .to_string_lossy()
            .to_uppercase();
        for d in ['D', 'E', 'F'] {
            let p = format!("{d}:\\");
            if !Path::new(&p).is_dir() {
                continue;
            }
            if format!("{d}:") == sys_drive {
                continue;
            }
            assert!(
                !is_on_system_drive(Path::new(&p)),
                "{p} 不是系统盘却被判成系统盘"
            );
        }
    }

    /* ==================== ★★ A-4：启动器自己的文件不住游戏根目录 ==================== */

    /// 造一对临时根目录（游戏根 + 启动器的家），返回拼好的 `AppPaths`。
    fn tmp_paths(tag: &str) -> (AppPaths, PathBuf, PathBuf) {
        let root = tmp(&format!("a4-root-{tag}"));
        let own = tmp(&format!("a4-own-{tag}"));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
        std::fs::create_dir_all(&root).unwrap();
        let p = AppPaths {
            shared: root.join(GAME_DIR_NAME),
            instances: root.join("instances"),
            java: own.join("java"),
            cache: own.join("cache"),
            logs: own.join("logs"),
            root: root.clone(),
            own_root: own.clone(),
        };
        (p, root, own)
    }

    /// 这四个文件的**目标位置**必须都在 `own_root` 下，而且不在游戏根目录里。
    #[test]
    fn launcher_records_live_in_own_root_not_in_the_game_root() {
        let (p, root, own) = tmp_paths("where");
        for name in [
            "instances.json",
            "prefs.json",
            "ms_client_id.txt",
            "cf_api_key.txt",
        ] {
            let f = p.own_file(name);
            assert!(f.starts_with(&own), "{name} 应当在 own_root 下：{}", f.display());
            assert!(
                !f.starts_with(&root),
                "{name} **不该**在游戏根目录里：{}",
                f.display()
            );
        }
        assert!(p.instances_file().starts_with(&own));
        assert!(p.prefs_file().starts_with(&own));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
    }

    /// 把文件的 mtime 拨到指定时刻。
    ///
    /// ★ 为什么测试里必须显式拨：`should_adopt` 判的是 `源 mtime > 目标 mtime`，
    ///   而"先 write 目标、再 write 源"这种写法**在同一个毫秒里就会相等** ——
    ///   相等时按规矩不收养（目标优先），于是测试会**偶发地红**
    ///   （第一次跑就撞上了：`adopt_records_lets_the_newer_copy_win_and_backs_up_the_old_one`）。
    ///   判据本身没问题，是测试的构造不够确定。
    fn set_mtime(p: &std::path::Path, t: std::time::SystemTime) {
        let f = std::fs::File::options()
            .write(true)
            .open(p)
            .expect("打开文件以改 mtime");
        f.set_modified(t).expect("设置 mtime");
    }

    /// 老用户：文件都在游戏根目录里 → 启动时被**复制**到 `own_root`，源保留。
    /// 第二次调用必须什么都不做（幂等）。
    #[test]
    fn adopt_records_copies_from_the_game_root_and_keeps_the_source() {
        let (p, root, own) = tmp_paths("adopt");
        let inst = r#"{"instances":[{"id":"a"},{"id":"b"}],"active_id":"a"}"#;
        std::fs::write(root.join("instances.json"), inst).unwrap();
        std::fs::write(root.join("prefs.json"), r#"{"theme":"daiqing"}"#).unwrap();
        std::fs::write(root.join("ms_client_id.txt"), "1111\n").unwrap();

        let copied = adopt_records(&p);
        assert!(copied > 0, "应当真的复制了东西");
        assert_eq!(
            std::fs::read_to_string(own.join("instances.json")).unwrap(),
            inst,
            "清单应当一字不差地复制过去"
        );
        assert_eq!(
            std::fs::read_to_string(own.join("prefs.json")).unwrap(),
            r#"{"theme":"daiqing"}"#
        );
        assert!(own.join("ms_client_id.txt").is_file());
        assert!(
            root.join("instances.json").is_file(),
            "★ 源文件必须保留（用户可能退回旧版启动器）"
        );

        // 幂等：第二次不再复制（目标已是新的那份）
        assert_eq!(adopt_records(&p), 0, "第二次不该再复制");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
    }

    /// ★ 真机上量出来的那条：目标（`%APPDATA%`）那份是**陈旧副本**，
    ///   源（游戏根目录）比它新 → 必须用源，并且把旧的目标备份下来。
    #[test]
    fn adopt_records_lets_the_newer_copy_win_and_backs_up_the_old_one() {
        let (p, root, own) = tmp_paths("newer");
        std::fs::create_dir_all(&own).unwrap();
        // 先写目标（旧），再写源（新）—— 时间顺序就是判据
        std::fs::write(own.join("instances.json"), r#"{"instances":[{"id":"stale"}],"active_id":null}"#)
            .unwrap();
        std::fs::write(
            root.join("instances.json"),
            r#"{"instances":[{"id":"fresh-1"},{"id":"fresh-2"}],"active_id":"fresh-1"}"#,
        )
        .unwrap();
        /* ★ 显式把目标的 mtime 拨到 10 分钟前：不能靠"两次 write 的先后"，
           同一毫秒里两次 write 的 mtime 会相等，判据（`>`）就判不出来 —— 实测踩过 */
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        set_mtime(&own.join("instances.json"), old);

        let copied = adopt_records(&p);
        assert!(copied > 0, "源更新 → 应当收养");
        let got = std::fs::read_to_string(own.join("instances.json")).unwrap();
        assert!(got.contains("fresh-2"), "应当用新的那份：{got}");
        let bak = own.join("instances.json.bak");
        assert!(bak.is_file(), "被覆盖的那份必须留一个 .bak");
        assert!(
            std::fs::read_to_string(&bak).unwrap().contains("stale"),
            "备份里应当是原来那份"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
    }

    /// 反过来：目标（已经在 `own_root` 里、且更新）比源新 → **一个字节都不动**。
    #[test]
    fn adopt_records_leaves_a_newer_target_alone() {
        let (p, root, own) = tmp_paths("target");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(root.join("instances.json"), r#"{"instances":[{"id":"old"}],"active_id":null}"#)
            .unwrap();
        std::fs::write(
            own.join("instances.json"),
            r#"{"instances":[{"id":"mine-1"},{"id":"mine-2"}],"active_id":null}"#,
        )
        .unwrap();
        /* ★ 同理：把源的 mtime 拨到 10 分钟前，保证"目标更新"是**确定的**事实 */
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        set_mtime(&root.join("instances.json"), old);

        assert_eq!(adopt_records(&p), 0, "目标更新时不该动它");
        let got = std::fs::read_to_string(own.join("instances.json")).unwrap();
        assert!(got.contains("mine-1"), "目标被覆盖了：{got}");
        assert!(!own.join("instances.json.bak").exists(), "没覆盖就不该产生 .bak");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
    }

    /// 读的那一侧：`own_root` 没有时回退到游戏根目录的老位置（老用户升级的当次启动）。
    #[test]
    fn own_file_for_read_falls_back_to_the_old_game_root_location() {
        let (p, root, own) = tmp_paths("read");
        assert_eq!(p.own_file_for_read("instances.json"), None, "两边都没有 → None");

        std::fs::write(root.join("instances.json"), "{}").unwrap();
        assert_eq!(
            p.own_file_for_read("instances.json"),
            Some(root.join("instances.json")),
            "只有老位置有 → 读老位置"
        );

        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("instances.json"), "{}").unwrap();
        assert_eq!(
            p.own_file_for_read("instances.json"),
            Some(own.join("instances.json")),
            "两边都有 → **优先** own_root"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&own);
    }
}
