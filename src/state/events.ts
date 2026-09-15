/**
 * 界面内部的**事件契约**（一个字符串只写一次）
 * ------------------------------------------------------------------
 * 这个项目用 `window` 自定义事件做跨页面的动作传递（`ieml:launch-request`
 * 等，见 AppShell / LaunchPage / SettingsPage）。事件名是**隐式接口**：
 * 发的一方和收的一方各写一遍字符串，拼错一个字母就静默失效 ——
 * 界面上表现为"点了按钮什么都没发生"，而且没有任何报错。
 *
 * 所以从这一版起，**新增的事件名一律写在这里**，两边都 import 它。
 *
 * ## 为什么不用 AppContext 直接给动作
 *
 *   `openModBrowse` 这种动作的接收方（`ModsPanel`）只在
 *   `state.subPage === 'mods'` 时挂载 —— 从「概览」页点按钮时它**还没挂载**，
 *   context 里的一个"待处理标志"反而更难写对（要处理"挂载后消费一次"）。
 *   事件在这里是更简单也更可靠的形状：先切页签，再发事件，
 *   接收方挂载时用一次性的 `useEffect` 订阅即可。
 */

/** 从任意页面请求「打开 Mod 安装面板」（值：无） */
export const EVT_OPEN_MOD_BROWSE = 'ieml:open-mod-browse';

/**
 * 请求切到某个页签（值：`{ instanceId?: string; sub: SubPageId }`）
 *
 * ★ 与 `ieml:open-mod-browse` 的区别：这个只管切页签，不打开任何弹窗。
 *   分开是因为"我要装 Mod"和"我要看 Mod 管理页"是两个动作：
 *   前者要弹搜索框，后者不该弹。
 */
export const EVT_GOTO_SUBPAGE = 'ieml:goto-subpage';
