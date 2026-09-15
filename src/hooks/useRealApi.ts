/**
 * 真实数据源 Hook
 * ------------------------------------------------------------------
 * 页面通过这个 hook 拿到真实后端 API；在浏览器里跑时返回 null，
 * 页面据此降级到演示数据并显示明确提示（而不是假装有数据）。
 *
 * ★ 为什么不让页面直接 import '../bridge/tauri.ts'：
 *   那会把 @tauri-apps/api 打进浏览器 bundle（虽然能跑，但白白多背代码）。
 *   这里走 `getRealApi()` 的动态导入，Vite 会自动分包。
 */
import { useEffect, useState } from 'react';
import { getRealApi, type RealApi } from '../bridge';

export interface RealApiState {
  api: RealApi | null;
  /** 是否正在加载 */
  loading: boolean;
  /** 是否运行在真实桌面后端里 */
  isDesktop: boolean;
}

/** 全局缓存一次，避免每个页面都动态导入 */
let cached: RealApi | null = null;
let cachedResolved = false;
const waiters = new Set<(api: RealApi | null) => void>();

export function useRealApi(): RealApiState {
  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const [state, setState] = useState<RealApiState>(() => ({
    api: cached,
    loading: isDesktop && !cachedResolved,
    isDesktop,
  }));

  useEffect(() => {
    if (!isDesktop) {
      setState({ api: null, loading: false, isDesktop: false });
      return;
    }
    if (cachedResolved) {
      setState({ api: cached, loading: false, isDesktop: true });
      return;
    }

    let alive = true;
    const settle = (api: RealApi | null) => {
      if (alive) setState({ api, loading: false, isDesktop: true });
    };
    waiters.add(settle);

    if (waiters.size === 1) {
      void getRealApi().then((api) => {
        cached = api;
        cachedResolved = true;
        for (const w of waiters) w(api);
        waiters.clear();
      });
    }

    return () => {
      alive = false;
      waiters.delete(settle);
    };
  }, [isDesktop]);

  return state;
}

/**
 * 统一的人类可读体积
 */
export function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

/** 把秒数变成"约 1 分 20 秒" */
export function humanDuration(seconds: number): string {
  if (seconds < 60) return `约 ${Math.round(seconds)} 秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `约 ${m} 分 ${s} 秒` : `约 ${m} 分`;
  return `约 ${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
