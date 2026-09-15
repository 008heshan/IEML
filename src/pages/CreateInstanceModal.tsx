/**
 * 创建版本（弹窗）
 * ------------------------------------------------------------------
 * 「创建版本」与下载页的「安装游戏」是**同一件事**，所以这里直接复用
 * `InstallComposer` —— 两个入口共用一份实现，规则与交互不会漂移。
 *
 * 弹窗形态只保留给「在别的页面顺手建一个版本」的场景
 * （例如实例设置页的「新建一个版本」按钮）。
 *
 * ★ 历史修正：这里原来用一张内置的 `MC_PROFILES` 表（只有 10 个版本）当版本列表，
 *   与下载页拉的真实清单（900+ 个）是两套数据 —— 用户在弹窗里根本找不到
 *   自己想玩的版本。现在统一用真实清单。
 */
import { useEffect, useState } from 'react';
import { useApp } from '../state/AppContext';
import { Modal } from '../ui';
import { InstallComposer } from '../components/InstallComposer';

export function CreateInstanceModal() {
  const { openVersion } = useApp();
  const [open, setOpen] = useState(false);
  const [initialVersion, setInitialVersion] = useState<string | undefined>(undefined);

  useEffect(() => {
    const onCreate = () => {
      setInitialVersion(undefined);
      setOpen(true);
    };
    window.addEventListener('ieml:create', onCreate);
    return () => window.removeEventListener('ieml:create', onCreate);
  }, []);

  useEffect(() => {
    const onWithVersion = (e: Event) => {
      const v = (e as CustomEvent<string>).detail;
      if (v) setInitialVersion(v);
      setOpen(true);
    };
    window.addEventListener('ieml:create-with-version', onWithVersion);
    return () => window.removeEventListener('ieml:create-with-version', onWithVersion);
  }, []);

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="创建版本"
      size="lg"
      subtitle="选游戏版本、配加载器、命名 —— 都在这一页里一次配好"
    >
      <InstallComposer
        variant="modal"
        initialVersion={initialVersion}
        onCancel={() => setOpen(false)}
        onInstalled={(inst) => {
          setOpen(false);
          openVersion(inst.id);
        }}
      />
    </Modal>
  );
}
