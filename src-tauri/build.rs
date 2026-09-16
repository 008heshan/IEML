// Tauri 构建脚本：只在需要时重新运行
fn main() {
    tauri_build::build()
}

// ★★ 2026-09-16：图标换了但 exe 里还是旧的 —— 说明这个构建脚本没有被重跑。
// 改这一行是为了让 cargo 认定"构建脚本变了"，从而重新生成 Windows 图标资源。
// （真正的修法是 build.rs 里声明 cargo:rerun-if-changed=icons，见下一轮的计划。）
