/**
 * 行内强调：把文本里的 `**…**` 渲染成**真的加粗**。
 *
 * ## 为什么要有它（这个坑仓库里栽过两次，第二次是我）
 *
 *   JSX 里的文本节点是**纯文本**，写 `**第三方**` 只会原样显示成带星号的怪东西。
 *   第一次栽的时候在 `DataRootPicker` 那里留了一句注释警告，
 *   结果我在「关于」页又写了一遍 —— 用户直接看到 `**没有任何关系**` 挂在界面上。
 *
 *   ★ 与其每次都靠"记得别写"，不如**让记号能用**：
 *     文案里继续写 `**…**`（写起来自然），由这个组件负责渲染。
 *     它只认 `**` 这一种记号，**不用 `dangerouslySetInnerHTML`** ——
 *     纯文本切分 + 生成 `<b>`，没有任何注入面。
 *
 * 用法：`<RichText text="本程序是**第三方**启动器" />`
 */
import type { ReactNode } from 'react';

export function RichText({ text }: { text: string }): ReactNode {
  const parts = String(text).split('**');
  // 奇数段是被 `**` 夹住的那部分 → 加粗
  return (
    <>
      {parts.map((seg, i) =>
        i % 2 === 1 ? <b key={i}>{seg}</b> : <span key={i}>{seg}</span>,
      )}
    </>
  );
}
