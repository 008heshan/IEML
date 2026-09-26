/**
 * 关于页（用户：「关于与设置，改成关于，给关于单独做一页面，
 * 关于页也要去 AI 味，说人话，并且要写各种声明和法律信息」）。
 *
 * ★ N 那条也在这一页落实：「图十这些附属描述是非必要的，去掉，然后把主文字居中」——
 *   所以这里**没有**一行小字解释"不一致 = 改了版本号没重新构建"那种话，
 *   主文字（名称、版本号、各组标题）**居中**。
 *
 * ## 法律信息写什么（都是事实，不是话术）
 *
 *   · 许可：GPL-3.0（仓库里的 LICENSE 文件）。
 *   · 与 Mojang / Microsoft **无关联**；本程序**不含**任何游戏资源文件。
 *   · 游戏文件从哪来：官方源（Mojang）或社区镜像（BMCLAPI），由下载环节决定。
 *   · Mod / 整合包 / 资源包来自 Modrinth 与 CurseForge 的公开接口，
 *     著作权归各自作者；本程序只做下载与安装。
 *   · 皮肤：走 Mojang 的官方接口，需要正版账号。
 *   · 隐私：不收集、不上传任何信息；账号令牌只保存在本机数据目录里。
 */
import { useState } from 'react';
import { Button, Card, CardTitle, Chip, Note } from '../ui';
import { RichText } from '../ui/RichText';
import { IconInfo, IconShield, IconDrive, IconRefresh, IconBox } from '../ui/Icons';
import { useApp } from '../state/AppContext';
import { APP_VERSION } from '../domain/version-info';
/*
 * ★★ 2026-09-24（B-2 修复）：这句"更新状态 → 人话"的映射原来写在这一页里，
 *   而且是一条**会撒谎**的三元链（只认 4 种状态，其余全说"已是最新版本"）。
 *   现在映射搬进 `domain/update-copy.ts` —— 那里有单测钉着它
 *   （`tests/update-copy.test.mjs`），页面只负责显示。
 */
import { describeUpdate, isUpdateProblem } from '../domain/update-copy';

/*
 * ★★ 2026-09-26：这里原来写的是 `github.com/Heshan001/IEML` —— **一个不存在的地址**
 *   （账号名是 `008heshan`）。用户在这一页看到"源码在 …"，点过去是 404，
 *   而这是一句**给用户看的承诺**（"你可以自由使用、修改、再分发"得先拿得到源码）。
 *   两个仓都指出来：CNB 是**同时用作分发仓**的那个（更新端点就在它上面），
 *   GitHub 是镜像。★ 地址变了要顺手核一眼这个常量。
 */
const REPO = 'https://github.com/008heshan/IEML';
const REPO_CNB = 'https://cnb.cool/IEML_Official/IEML';

export function AboutPage() {
  const { state, update } = useApp();
  const [checking, setChecking] = useState(false);

  const upd = update.state;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">关于</h1>
        </div>
      </div>

      <div className="stack">
        {/* ---------- 头牌：名称 + 版本（居中） ---------- */}
        <Card>
          <div className="about-hero">
            <div className="about-name">IEML 启动器</div>
            <div className="about-ver mono">{APP_VERSION}</div>
            <div className="about-tags">
              <Chip tone="neutral">Tauri 2</Chip>
              <Chip tone="neutral">Rust</Chip>
              <Chip tone="neutral">GPL-3.0</Chip>
            </div>
          </div>
        </Card>

        {/* ---------- 更新 ---------- */}
        <Card>
          <CardTitle icon={<IconRefresh />}>启动器更新</CardTitle>
          <div className="about-center">
            <div className={`about-line${isUpdateProblem(upd.phase) ? ' about-line-err' : ''}`}>
              {describeUpdate(upd)}
            </div>
            <Button
              variant={upd.phase === 'ready' ? 'primary' : 'secondary'}
              size="sm"
              loading={checking || upd.phase === 'checking' || upd.phase === 'installing'}
              disabled={upd.phase === 'downloading'}
              onClick={() => {
                /*
                 * ★★ 2026-09-24（用户报的 bug）：「**在检查到更新并下载完新版本后，
                 *   转变安装按钮时，点击依旧是检查更新，而且还会再给我下一份**」。
                 *
                 *   原来这里**无论什么状态都调 `checkNow()`** —— 按钮文字虽然会变成
                 *   「重启并更新」，点下去却是"再检查一次"：又问他一次服务端、
                 *   拿到新的 Update 对象、把刚下好的那份**从头再下一遍**。
                 *
                 *   现在按状态分支，而且**只做这一件事对应的动作**：
                 *     · ready      → 装（本进程会退出并重开，见 install 的说明）
                 *     · downloading→ 什么都不做（按钮此时是禁用 + 显示进度）
                 *     · installing → 什么都不做
                 *     · 其它        → 才去检查
                 *   `checkNow` 里也加了守卫（手里有下好的包就不再查/不再下）——
                 *   界面之外还可能有人调进来，判据不能只写在按钮里。
                 */
                if (upd.phase === 'ready') {
                  void update.install();
                  return;
                }
                if (upd.phase === 'downloading' || upd.phase === 'installing') return;
                setChecking(true);
                void update.checkNow({ silent: false });
                window.setTimeout(() => setChecking(false), 1200);
              }}
            >
              {upd.phase === 'ready'
                ? '重启并更新'
                : upd.phase === 'downloading'
                  ? '正在下载…'
                  : upd.phase === 'installing'
                    ? '正在安装…'
                    : '检查更新'}
            </Button>
          </div>
        </Card>

        {/* ---------- 声明与法律信息 ---------- */}
        <Card>
          <CardTitle icon={<IconShield />}>声明</CardTitle>
          {/*
            ★★ 2026-09-23 用户（截图）：「**markdown 没生效哦**」——
              这一页的文字原来写的是 `**第三方**` 这种记号，而 **JSX 文本节点是纯文本**，
              于是界面上原样挂着星号（这个仓库栽过第二次了，第一次在根目录弹窗那里）。
              现在统一走 `<RichText>`：文案里继续写 `**…**`，由它渲染成真正的加粗。
          */}
          <ul className="about-list">
            <li>
              <RichText text="本程序是**第三方**启动器，与 Mojang Studios、Microsoft **没有任何关系**，也未获得它们的授权或背书。" />
            </li>
            <li>
              <RichText text="程序本身**不含**任何 Minecraft 游戏文件、素材或音效。游戏文件在你安装版本时，从官方源（Mojang）或社区镜像（BMCLAPI）下载到你自己选择的目录。" />
            </li>
            <li>
              「Minecraft」是 Mojang Studios 的商标。这里提到它只是为了说明这个程序能做什么。
            </li>
            <li>
              <RichText text="Mod、整合包、资源包、光影来自 Modrinth 与 CurseForge 的公开接口，**著作权归各自的作者**。本程序只负责下载与放进对应目录，不修改、不再分发它们。" />
            </li>
            <li>
              <RichText text="CurseForge 的那一路**全部走国内镜像** `mod.mcimirror.top` —— 启动器里**没有 API Key 这回事**，你不需要填任何东西。请求经过它转发，它能看到你查了什么；介意的话可以只用 Modrinth。" />
            </li>
            <li>
              部分资源在 CurseForge 上被作者关掉了「允许第三方分发」，那种资源任何启动器都下不到 ——
              遇到时界面会直说是这个原因，而不是含糊地报"下载失败"。
            </li>
            <li>
              皮肤与披风走 Mojang 官方接口，需要正版账号；离线模式只影响"用什么名字进单人游戏"，
              不会、也不能绕过正版验证。
            </li>
            <li>
              <RichText text="本程序按 GPL-3.0 发布，源码在 **CNB** 与 **GitHub** 两个仓，内容相同。" />
              <div className="dim mono" style={{ marginTop: 4 }}>
                {REPO_CNB}
                <br />
                {REPO}
              </div>
            </li>
          </ul>
        </Card>

        {/* ---------- 隐私 ---------- */}
        <Card>
          <CardTitle icon={<IconShield />}>隐私</CardTitle>
          <ul className="about-list">
            <li>不收集、不上传任何使用信息。没有埋点，没有遥测。</li>
            <li>
              <RichText text="正版账号的登录令牌只保存在**你自己的数据目录**里，只在向 Mojang 请求游戏文件时使用；退出登录会把它删掉。" />
            </li>
            <li>
              联网只发生在这些时候：检查更新、查版本清单、下载游戏与资源、登录正版账号。
              关掉这些操作，程序不发任何请求。
            </li>
            <li>
              本程序会读写你选择的那个数据目录，以及 Minecraft 的标准目录（版本、存档、Mod 等）。
              删掉程序目录不影响你的存档。
            </li>
          </ul>
        </Card>

        {/* ---------- 第三方组件 ---------- */}
        <Card>
          <CardTitle icon={<IconBox />}>第三方组件</CardTitle>
          <ul className="about-list">
            <li>Tauri 2 / Rust（窗口、文件、进程）—— MIT 或 Apache-2.0</li>
            <li>React 18 / Vite 5（界面）—— MIT</li>
            <li>WebView2 运行时（界面渲染引擎）—— 由微软提供，随 Windows 分发</li>
            <li>Java 运行时：本程序不捆绑；用你系统里的，或由你在「Java 运行环境」里下载官方构建</li>
          </ul>
        </Card>

        {/* ---------- 数据放在哪 ---------- */}
        <Card>
          <CardTitle icon={<IconDrive />}>数据目录</CardTitle>
          <div className="about-center">
            <div className="about-line mono">{state.machine?.dataDir ?? '未知'}</div>
            <div className="dim">版本、存档、Mod、日志都在这里。换目录在「设置 → 存储」。</div>
          </div>
        </Card>

        <Note tone="info" icon={<IconInfo />} title="遇到问题">
          崩溃和报错都写在「数据目录 → logs」里。反馈时把日志附上最有用 ——
          关于卡片上的版本号和日志里的对得上，我们才能确认是哪一版的问题。
        </Note>
      </div>
    </>
  );
}
