# IEML — 极简 Minecraft 启动器

从零构建的 Minecraft 启动器。快、小、好用。

**当前版本：`0.1.0-beta.53`** — 改动见 [`CHANGELOG.md`](CHANGELOG.md)。

真实可运行的桌面应用，437 项 Rust 测试 + 前端测试，真实下载和真实启动都跑通过。

## 快速开始

```bash
pnpm install
pnpm dev              # 浏览器开发，?demo=1 给演示实例
pnpm desktop:dev      # 桌面版
pnpm desktop:build    # 打包 exe + NSIS，并逐字节复制到桌面
                      #   → src-tauri/target/release/ieml.exe
                      #   → src-tauri/target/release/bundle/nsis/IEML_0.1.0-beta.53_x64-setup.exe
pnpm verify           # 一键验证：类型 + 测试 + 端到端 + 构建 + 静态门禁
```

> ★ 上面那个安装包文件名里的版本号是**真的会被校验**的：
> `node tools/set-version.mjs --check` 要求它与其他五处一致，
> `pnpm verify` 里有这一条。改版本号请用 `node tools/set-version.mjs <版本>`，
> 它会顺手把这里一起改掉 —— 手改一定会漏。

国内打包：

```powershell
$env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR = 'https://gh-proxy.com'
pnpm desktop:build
```

## 为什么做这个

Tauri 2 + Rust + React 18。不打包 Chromium，裸 exe 8.9 MB，NSIS 安装包 3.4 MB，Rust 主进程内存 30.5 MB。

数据目录默认不放在系统盘，按空闲空间挑盘。游戏数据放在 `.minecraft`，实例隔离在 `instances/<名字>/game/`。

## 架构

三层，规则只实现一次：

```
UI（React）  →  桥接（一个接口两套实现）  →  领域层（TS ↔ Rust 一一对应）
```

前端只渲染结论，不自己维护业务规则。所有校验、加载器组合判定、Java 区间、Mod 状态判定都在领域层，TS 和 Rust 由同一批测试用例锁定，避免两边漂移。

## 界面

两级导航。一级侧栏 4 项：启动 / 版本列表 / 下载 / 设置。点进某个版本，侧栏整条换成该版本的二级页（概览 / 设置 / Mod / 日志）。

下载页六个页签：安装游戏、整合包、Mod、资源包、光影、数据包。资源中心同时接 Modrinth 和 CurseForge，可按**游戏版本**与**模组加载器**筛选（两个叠加，默认都不限 —— 界面不替你挑版本）。

## 已实现

- 真实下载与启动，全量安装 1.20.1：52 个核心任务 + 3598 个资源文件，0 失败
- Fabric / Quilt / Forge / NeoForge / OptiFine / LiteLoader 安装
- 自动下载 Java（Adoptium），多来源 Java 探测
- 整合包（.mrpack）、Mod 管理、崩溃分析与脱敏导出
- 下载引擎：单连接 + 失败换源 + 429 退避 + 校验自愈 + 真暂停
- 微软设备码登录（离线模式可用）
- 多开实例、单实例（再双击一次是"调起在跑的"）
- 启动器自身的更新：CNB 公开发布仓 + Ed25519 验签（设置页 →「检查启动器更新」）

## 已知限制

这一节是**如实清单**，不是免责声明 —— 写在这里的事，界面上也能看到对应的说法。

- **只发布 Windows**。macOS / Linux 没有实测过（没有 CI、也没有那两台机器），
  `0.1.0` 的范围就是 Windows。见 [`docs/VERSIONING.md`](docs/VERSIONING.md) 的平台口径。
- **Java 自动下载只能走 Adoptium 官方端点** —— 它没有可用的国内镜像
  （实测：TUNA 403、NJU / BFSU / SJTU / ZJU / PKU / 阿里 404、USTC 反爬、
  BMCLAPI 302 到 Cloudflare）。所以网络不好时这一步会失败；
  失败不影响已有 Java：设置页能看到本机扫到的 Java（8 / 21 / 25 …），也可以手动指定路径。
- **CurseForge 需要一把可用的 API Key**。程序内置一把（拿到 exe 就能用）；
  界面里没有填写入口（设置页那一栏当初按用户要求删掉了）。
- **换数据根目录只切换、不迁移**：新目录是空的，旧目录里的版本 / 存档 / Mod
  一个字节都不动，但**要重启启动器才生效**（界面上会挂"重启后生效"的角标）。

## 技术栈

Rust · Tauri 2 · React 18 · TypeScript · Vite · 手写 CSS（无 UI 框架，前端产物约 760 kB）

## 许可

GPL-3.0。与 Mojang / Microsoft 无关联，不含游戏资源文件。
