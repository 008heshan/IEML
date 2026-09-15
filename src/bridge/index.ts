/**
 * 后端选择器
 * ------------------------------------------------------------------
 * 检测运行环境：在 Tauri 里用 Rust 后端，在浏览器里用网页实现。
 * UI 只依赖 Backend 接口，所以两边可以并行开发，切换零成本。
 */
import type { Backend } from './types.ts';
import { createWebBackend } from './web.ts';

/** 是否运行在 Tauri 容器里 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let cached: Backend | null = null;

export function getBackend(): Backend {
  if (cached) return cached;

  if (isTauri()) {
    try {
      // 动态导入，避免浏览器构建把 @tauri-apps/api 打进包里
      // 注意：这里必须是同步决定，所以用已注入的全局判断 + 同步 require 语义。
      // Vite 会把 dynamic import 变成真正的按需加载，Tauri 下必然命中。
      cached = createTauriBackendLazy();
      return cached;
    } catch {
      // 落到网页实现
    }
  }
  cached = createWebBackend();
  return cached;
}

/**
 * Tauri 后端的懒加载外壳。
 *
 * 为什么不在顶层 import `@tauri-apps/api/core`：
 *   浏览器里没有 Tauri 注入的 IPC 对象，顶层 import 虽然不报错，但会让
 *   网页构建多背一份无用的代码。这里用 Proxy 把调用推迟到真正用到时。
 */
function createTauriBackendLazy(): Backend {
  let real: Backend | null = null;
  let loading: Promise<Backend> | null = null;

  async function ensure(): Promise<Backend> {
    if (real) return real;
    loading ??= import('./tauri.ts').then((m) => {
      real = m.createTauriBackend();
      return real;
    });
    return loading;
  }

  const handler: ProxyHandler<Backend> = {
    get(_target, prop: string) {
      return (...args: unknown[]) => {
        return ensure().then((b) => {
          const fn = b[prop as keyof Backend] as unknown as (...a: unknown[]) => unknown;
          return fn.apply(b, args);
        });
      };
    },
  };
  return new Proxy({} as Backend, handler);
}

export type { Backend, BackendInfo, CrashReport, LaunchResult, InstallRequest } from './types.ts';

/**
 * 真实后端 API（仅 Tauri 下可用）
 * ------------------------------------------------------------------
 * 这组 API 让 UI 直接调用 Rust 的真实能力：元数据、下载、启动、登录。
 * 浏览器模式下返回 null —— 页面据此降级到演示数据并明确提示用户。
 */
export type RealApi = typeof import('./tauri.ts');

let realApiPromise: Promise<RealApi | null> | null = null;

export function getRealApi(): Promise<RealApi | null> {
  if (!isTauri()) return Promise.resolve(null);
  realApiPromise ??= import('./tauri.ts').catch(() => null);
  return realApiPromise;
}

/** 同步探测：是否运行在真实桌面后端里（用于渲染分支，不阻塞） */
export const hasRealBackend = isTauri();
