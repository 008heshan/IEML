# tools/ —— 脚本按**用途**分目录（ADR-053）

> 规矩：**一个脚本只回答一个问题**，名字里说清它回答什么。
> 目录名说清"什么时候该跑它"。

```
tools/
├─ verify.mjs                          一键门禁总入口（其余检查都由它串起来）
├─ set-version.mjs                     版本号：六处一起改 + --check / --docs
├─ make-icons.mjs                      从 design/mockup.html 生成 Tauri 图标
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
├─ live/      ★ 真机验证：要桌面版 / 要联网 / 要看真实 DOM（默认手动跑）
│   ├─ live-ui-check.mjs               用 WebView2 的 CDP 读真实 DOM 并跑断言
│   ├─ live-inuse-check.mjs            「盘上有」与「有版本在用」是不是分开说的
│   ├─ live-java-display-check.mjs     界面上显示的 Java 要求与真实要求一致
│   ├─ live-ms-login-check.mjs         正版登录（要自己的 client_id）
│   ├─ live-optifine-incompat-check.mjs Fabric + 高清修复：有桥接包 / 真不兼容两段
│   ├─ live-resource-check.mjs         资源中心：四种资源都能查到
│   ├─ live-single-instance-check.mjs  单实例：再开一次是「调起在跑的那个」而不是多开
│   ├─ live-glass-check.mjs            ★ 液态玻璃三档：折射状态 / 高光跟手 / 取色 / 帧时间（32 条）
│   ├─ probe-webview-glass.mjs         ★ 先证明"能不能真折射"：backdrop-filter 里的 SVG 滤镜
│   │                                    + 截图像素对照（含"坏引用"正对照）—— 换机器先跑它
│   └─ shot.mjs                        按 plan.json 驱动浏览器截图
│
├─ probe/     ★ 打上游接口，先证明事实再写代码（要联网；结论会被固化成测试）
│   ├─ probe-curseforge.mjs            CF：连通性 / key / 各类资源有没有结果
│   ├─ probe-curseforge-deep.mjs       CF：classId / 加载器编号 / 指纹端点 / CDN 候选
│   ├─ probe-ms-devicecode.ps1         微软设备码流程的原型探测
│   ├─ probe-ms-clientids.ps1          ★ 哪个 client_id 真能用（带随机编造的对照组）
│   ├─ probe-browse.mjs                ★ 空关键词"列热门"有没有内容 / 翻页重不重复
│   ├─ probe-bmclapi.mjs / probe-mirrors.mjs / probe-sources.mjs   镜像与源
│   ├─ probe-assets.mjs / probe-chunk-throttle.mjs / probe-dev.mjs
│   ├─ probe-fabric-sources.mjs / probe-java-dll.mjs
│   └─ （一次性探针用完就删：结论已经写成单元测试/live 测试，留着只是噪音）
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
| 证明"上游到底是不是这样" | `tools/probe/`（**先证明再写代码**，ADR-050） |
| 证明"用户真的点得到、真的能起来" | `tools/live/`（要桌面版） |
| 查"这台机器上盘里到底怎么了" | `tools/diag/` |
| 改版本号 | `node tools/set-version.mjs <版本>` |

## 两条纪律

1. **一次性脚本用完要删**：结论写进测试或文档之后，脚本本身只剩噪音
   （本轮就删了 4 个 CurseForge 探针与 5 个引用旧绝对路径的死脚本）。
2. **脚本名字要回答"它回答什么问题"**：`xxx2.mjs` 这种后缀一律不许出现 ——
   它等同于"我不知道这两个有什么区别"（本轮把 `check-natives2` 之类全部改名）。
