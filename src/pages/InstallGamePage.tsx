/**
 * 安装游戏（一级页，0.1.0-rc.1 新增）
 * ------------------------------------------------------------------
 * ★★ 用户第 4 条原话：
 *   「**安装游戏我也要单开一页，以解放视觉繁乱**……默认页面：游戏版本选择。
 *     单开一页选择模组加载器，UI 排版你来设计，要好看实用」
 *
 * 为什么它以前是个页签、以及为什么那样不行：
 *   它原来是「下载」页的第一个页签，而那个页签自己又是一个**左右两栏**的
 *   组合安装器（900+ 版本清单 + 加载器 + 附加组件 + 版本名称 + 摘要）。
 *   于是一屏里同时存在：页头（下载）→ 一排页签（6 格）→ 左栏清单 → 右栏四块。
 *   **两层导航 + 十几个控件**，第一眼看到的就是"繁乱"。
 *
 * 现在分成两步，每一步只回答一个问题：
 *   ① 选择游戏版本   —— 默认就在这里
 *   ② 选择模组加载器 —— 选完版本之后才出现，也随时可以点回第一步
 *
 * ★ 这一页**自己不含任何安装逻辑**：全部在 `InstallComposer` 里
 *   （它与「创建版本」弹窗共用同一份实现，规则只有一处）。
 *   这一页只负责：页头 + 把安装器放进整页形态。
 */
import { useApp } from '../state/AppContext';
import { Chip } from '../ui';
import { useRealApi } from '../hooks/useRealApi';
import { InstallComposer } from '../components/InstallComposer';

export function InstallGamePage() {
  const { go, toast } = useApp();
  const { isDesktop } = useRealApi();

  return (
    <div className="page-fill">
      <div className="page-head">
        <div>
          <h1 className="page-title">安装游戏</h1>
          <p className="page-desc">
            先选游戏版本，再挑模组加载器 —— 不选加载器就是纯原版
          </p>
        </div>
        {!isDesktop ? <Chip tone="warning">浏览器演示模式 —— 真实下载要桌面版</Chip> : null}
      </div>

      <InstallComposer
        variant="page"
        onInstalled={() => {
          /*
           * ★ 与它还在下载页时**完全一样的行为**（那时是 `toast` + `go('versions')`）：
           *   装完把人送到「版本列表」—— 下一步动作（启动 / 改设置）都在那里。
           *   安装器自己已经弹过一条「装好了」，这里只说"人在哪能继续"。
           */
          toast('info', '已加入版本列表', '去「版本列表」双击它就能进设置或启动。');
          go('versions');
        }}
      />
    </div>
  );
}
