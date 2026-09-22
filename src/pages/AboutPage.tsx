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

const REPO = 'https://github.com/Heshan001/IEML';

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
            <div className="about-line">
              {upd.phase === 'unsupported'
                ? '演示模式下没有更新能力'
                : upd.phase === 'available'
                  ? `有新版本 ${upd.version}，正在后台下载`
                  : upd.phase === 'ready'
                    ? `新版本 ${upd.version} 已经下好了`
                    : upd.phase === 'checking'
                      ? '正在检查…'
                      : '已是最新版本'}
            </div>
            <Button
              variant={upd.phase === 'ready' ? 'primary' : 'secondary'}
              size="sm"
              loading={checking || upd.phase === 'checking'}
              onClick={() => {
                setChecking(true);
                void update.checkNow({ silent: false });
                window.setTimeout(() => setChecking(false), 1200);
              }}
            >
              {upd.phase === 'ready' ? '重启并更新' : '检查更新'}
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
              部分资源在 CurseForge 上被作者关掉了「允许第三方分发」，那种资源任何启动器都下不到 ——
              遇到时界面会直说是这个原因，而不是含糊地报"下载失败"。
            </li>
            <li>
              皮肤与披风走 Mojang 官方接口，需要正版账号；离线模式只影响"用什么名字进单人游戏"，
              不会、也不能绕过正版验证。
            </li>
            <li>本程序按 GPL-3.0 发布，源码在 {REPO}。你可以自由使用、修改、再分发。</li>
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
