# tools/ —— 脚本按**用途**分目录

> 规矩：**一个脚本只回答一个问题**，名字里说清它回答什么。
> 目录名说清"什么时候该跑它"。

```
tools/
├─ verify.mjs                          一键门禁总入口（其余检查都由它串起来）
├─ set-version.mjs                     版本号：六处一起改 + --check
├─ clean-artifacts.mjs                 清构建/测试废弃产物（历史安装包 + %TEMP% 残留）
├─ make-installer-assets.mjs           生成安装程序的头部图/侧边图（手写 BMP 编码，无依赖）
├─ make-icons.mjs                      生成应用图标（手写 PNG/ICO 编码，无依赖）
├─ gen-curseforge-fingerprint-cases.mjs  CurseForge 指纹判据表（生成/离线复算）
│
├─ gates/     ★ 静态门禁：跟网络无关、进 `pnpm verify`，红了就别交付
│   ├─ audit-spawn-windows.mjs         子进程不许弹控制台窗口（逐处审计）
│   ├─ check-frontend-embedded.mjs     exe 里内嵌的前端 == 当前 dist
│   ├─ bundle-is-prod.cjs              打包产物里的 React 是生产构建
│   └─ exe-strings.mjs                 release exe 里有没有某个字符串
│
├─ env/       构建与交付环境（Windows）
│   ├─ cargo.ps1                       跑 cargo 的唯一入口（vcvars 不可用时自动回退）
│   ├─ cargo-manual-msvc.ps1           回退路径：自己拼 MSVC 环境（版本号自动发现）
│   └─ deploy-desktop.ps1              构建产物 → 桌面，并用 SHA256 证明一致
│
├─ net/       本机网络那点事（一次性调优用，不进交付链）
│   ├─ net-latency-tune.ps1            按实测调 TCP 参数
│   ├─ disable-hvci.ps1 / disable-vbs.ps1   关掉拖慢虚拟化的两个开关
│
├─ release/   发布链（升版 → 清单 → 上传 → 按客户端方式复验）
│   ├─ publish-cnb.mjs                 打包 + 生成 latest.json（--upload 才真传）
│   ├─ verify-manifest.mjs             上传前自检：签名/公钥/地址三者自洽
│   ├─ verify-endpoint.mjs             匿名拉线上清单 + 下载 + 用内置公钥验签
│   └─ check-exe-wiring.mjs            证明"更新能力真的编进了 exe"
│
├─ ci/        给 CI 用的上报（把流水线结果写成公开可读的一份产物）
│   └─ report-status.mjs               CNB 的 endStages 调它；本地无 token 时只打印
│
└─ diag/      ★ 一次性诊断与考古：看本机数据目录、回答"盘上到底怎么了"
    ├─ find-orphans.mjs                找出没有任何地方引用的源文件
    ├─ clean-stale-parts.mjs           清理卡死的 .part / .part.N（默认只报告）
    ├─ natives-*.mjs                   natives 目录、jar 结构、java.library.path 对照
    ├─ version-json-*.mjs              版本 JSON 的字段 / natives 写法
    ├─ jar-has-class.mjs               某个类在不在这个 jar 里（读中央目录，不解压）
    ├─ class-comes-from-which-jar.mjs  某个类应该来自哪个库、盘上有没有
    ├─ diff-loader-libs.mjs            加载器 JSON 与父版 JSON 的库差集
    ├─ fix-merged-version-json.mjs     就地修"合并出来缺库"的版本 JSON
    ├─ java-version-regex.mjs          Java 版本解析正则的样例验证
    └─ diag-*.mjs                      其它专项体检（natives 布局、资源碰撞、线格式字段…）
```

## 怎么选

| 我想… | 去哪儿 |
|---|---|
| 交付前确认一切正常 | `pnpm verify`（= 门禁 + 测试 + 构建） |
| 查"这台机器上盘里到底怎么了" | `tools/diag/` |
| 改版本号 | `node tools/set-version.mjs <版本>` |

## 两条纪律

1. **一次性脚本用完要删**：结论写进测试或文档之后，脚本本身只剩噪音
   （本轮删了 2 个"要 key 的 CF 探针"—— 用户已定"CF 完全不用 key"，
   它们验的那条路不存在了；更早一轮删了 4 个 CurseForge 探针与 5 个引用旧绝对路径的死脚本）。
2. **脚本名字要回答"它回答什么问题"**：`xxx2.mjs` 这种后缀一律不许出现 ——
   它等同于"我不知道这两个有什么区别"（本轮把 `check-natives2` 之类全部改名）。
