/**
 * 应用内的确认弹窗（**替代 `window.confirm`**）
 * ------------------------------------------------------------------
 * ## 为什么必须自己画一个
 *
 * 2026-09-24 真机查出来的事（见 `docs/BUG-REPORT-2026-09-24.md` 的 A-0）：
 *
 * 1. `tauri-plugin-dialog` 在窗口创建时注入了一段脚本，把 `window.confirm` 换成了
 *    **async 包装**：
 *    ```js
 *    window.confirm = async function (i) { return await invoke('plugin:dialog|confirm', …) };
 *    ```
 *    于是它**永远返回 Promise**，而不是布尔；
 * 2. 而全仓库 14 处写的都是**同步**判断：`if (!confirm(msg)) return;` ——
 *    `!Promise` 恒为 `false` ⇒ **每一道"确定要删除吗"的闸门都形同虚设**；
 * 3. 雪上加霜：这份安装里 `plugin:dialog|confirm` **没被 ACL 授权**
 *    （`tauri-plugin-dialog-2.7.3` 的 `default` 权限集是
 *    `["allow-message","allow-save","allow-open"]`，没有 `allow-confirm`），
 *    所以那个 Promise 直接以 `Command plugin:dialog|confirm not allowed by ACL` 失败 ——
 *    **框也不会弹**。用户点删除 = 什么都不问，直接删。
 *
 * 结论：不能指望 `window.confirm`。这里自己画一个：
 *   · API 是 **Promise<boolean>**（`await` 得到真正的 true/false）——
 *     调用点必须 `await`，从语法上杜绝"把 Promise 当真值"这种错；
 *   · 走应用自己的 `Modal`，观感与主题一致（原生弹窗在玻璃界面里本来就出戏）；
 *   · 文案支持 `**加粗**`（`RichText`）与换行（`delete.ts` 生成的说明是多行的）。
 *
 * ★ 用法（**必须 await**）：
 * ```tsx
 * const confirm = useConfirm();
 * ...
 * if (!(await confirm({ title: '删除版本', message: copy.message, danger: true }))) return;
 * ```
 * ★ 默认焦点给**取消**：危险操作里 Enter 不该等于"确定"。
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button, Modal } from './index';
import { RichText } from './RichText';

export interface ConfirmOptions {
  /** 正文，支持 `**加粗**` 与换行 */
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除类）：确定按钮用红色 */
  danger?: boolean;
}

type Ask = (opts: ConfirmOptions | string) => Promise<boolean>;

const ConfirmCtx = createContext<Ask | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<
    (ConfirmOptions & { resolve: (v: boolean) => void }) | null
  >(null);
  /** 防止"同一个确认被点两次"（连点确定/取消时 promise 只该 resolve 一次） */
  const settledRef = useRef(false);

  const ask = useCallback<Ask>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        settledRef.current = false;
        setReq({ ...(typeof opts === 'string' ? { message: opts } : opts), resolve });
      }),
    [],
  );

  const done = useCallback(
    (v: boolean) => {
      if (settledRef.current) return;
      settledRef.current = true;
      req?.resolve(v);
      setReq(null);
    },
    [req],
  );

  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal
        open={!!req}
        onClose={() => done(false)}
        title={req?.title ?? '确认'}
        size="md"
        footer={
          <>
            {/* ★ 默认焦点在**取消**上：危险操作不该让 Enter 直接等于"确定" */}
            <Button variant="secondary" autoFocus onClick={() => done(false)}>
              {req?.cancelText ?? '取消'}
            </Button>
            <Button
              variant={req?.danger ? 'danger' : 'primary'}
              onClick={() => done(true)}
            >
              {req?.confirmText ?? '确定'}
            </Button>
          </>
        }
      >
        <div className="confirm-text">
          <RichText text={req?.message ?? ''} />
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

/** 取"问一句"的能力。必须在 `ConfirmProvider` 内使用。 */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmCtx);
  if (!ask) {
    /*
     * ★ 抛错而不是退回 `window.confirm`：退回去就等于悄悄恢复成"点了不问直接删"，
     *   而那正是这条缺陷的形态。宁可当场炸出来。
     */
    throw new Error('useConfirm 必须在 <ConfirmProvider> 里使用（见 src/ui/confirm.tsx）');
  }
  return ask;
}
