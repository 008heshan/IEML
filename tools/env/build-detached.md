加脱机构建入口：这台机器上 `pnpm desktop:build` 跑不通，而 exe 本来不需要它

## 现场（用户：「构建」）

`pnpm desktop:build` 在**这个环境**里必然失败，两条路都断：

1. `tauri build` 需要 `cargo-tauri` 那个二进制 —— **本机没装**
   （`~/.cargo/bin` 里没有），而且**装不了**：
   `cargo install tauri-cli` 报 `Could not resolve host: index.crates.io`
   （离线）。于是 `cargo tauri build` 得到 `error: no such command: tauri`。
2. 走 npm CLI 那条路失败得**更难懂**：`@tauri-apps/cli` 是 native addon，
   它内部要 cargo 去跑同一个缺失的子命令；而在代理 shell 里那个 `cargo`
   解析成了 Electron 垫片（本机唯一的 `node` 是 DSH 的
   `ELECTRON_RUN_AS_NODE=1` + Electron 垫片），于是报的是
   `error: unrecognized subcommand 'D:\DSH\DSH Desktop\DSH Desktop.exe'`
   —— 一句话里没有任何线索指向真正的原因。

★ 之前那些"构建成功"其实是**把旧的 exe 又复制了一遍**：
`target/release/ieml.exe` 的时间戳一直停在 10-06 17:26，
而部署脚本只校验"桌面那份 == target 那份"（两份都是旧的，自然相等）。

## 真正的构建需要什么（查证过，不是推测）

`tools/env/deploy-desktop.ps1` 复制的是 `src-tauri/target/release/ieml.exe`。
那个文件由普通的 `cargo build --release` 产出：
`tauri-build` 的 codegen 在**编译期**读 `tauri.conf.json` 的
`frontendDist`（`"../dist"`）并把资源嵌进二进制
（`tauri-build-2.6.3/src/codegen/context.rs:87-91`）。

⇒ 真正的两步是：**先把前端构建进 `dist/`，再编译**。
`tauri.conf.json` 的 `beforeBuildCommand` 就是 `pnpm exec vite build` ——
tauri CLI 本来也是跑这一条。**所以不需要 tauri CLI。**

## 加了什么

`tools/env/build-detached.cmd` + `build-detached.vbs`：

* 走 `wscript.exe` 起，**不是代理 shell 的后代** ⇒ 环境干净
  （代理 shell 会把 `ELECTRON_RUN_AS_NODE=1` 注入每条命令，
  而且**清不掉**：实测 `set "X=" & echo [%X%]` 仍打印 `[1]`）；
* 窗口样式 0 ⇒ **不弹 cmd 窗口**（用户明确抱怨过疯狂弹窗）；
* 三步都写进 `build-out.log`：`vite build` → `cargo build --release` → 部署。

用法：`wscript.exe //nologo tools\env\build-detached.vbs`

## 结果

```
✓ built in 1.15s                      （vite）
Compiling ieml v0.19.2                （cargo）
built   : 9,764,864 bytes  14:48:02
desktop : 9,764,864 bytes  14:48:02
sha256  : 79672230A5A52542A929CDADAC5C6A0773A330504E775D331F228229456B510D
OK: the Desktop launcher is byte-identical to the fresh build
→ exe 里的前端就是当前 dist，不是旧的一份（9 个文件逐字节/brotli 比对）
```

**桌面 `IEML.exe` 现在是 0.19.2，含整合包误判的修复。**
