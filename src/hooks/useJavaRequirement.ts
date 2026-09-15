/**
 * 「Mojang 在版本 JSON 里声明的 Java」→ 取回来并让组件重渲染。
 * ------------------------------------------------------------------
 * ## 为什么 hook 单独放这里
 *
 * 本项目的铁律是 `domain/` 不许有 I/O（见 `src-tauri/src/domain/mod.rs`）。
 * 所以：
 *   · `domain/java-requirement.ts` —— **纯的**：缓存 + 唯一的计算入口；
 *   · 这个文件 —— 只做两件事：**调后端取数**、**把取到的数记进缓存并触发重渲染**。
 *
 * 这样拆开之后，`node --test` 能直接跑领域层那些函数（不需要 DOM / Tauri）。
 *
 * ## 用法
 *
 * ```tsx
 * // 有 `if (!inst) return` 之类条件分支的组件：hook 放最前面，算结论放后面
 * const declared = useDeclaredJava(inst?.mcVersion ?? '');
 * if (!inst) return <Empty />;
 * const req = javaRequirementFor({ mcVersion: inst.mcVersion, declaredJava: declared });
 * ```
 *
 * 没有条件分支的组件可以直接用 `useJavaRequirement`。
 */
import { useEffect, useState } from 'react';
import { useRealApi } from './useRealApi.ts';
import {
  declaredJavaOf,
  rememberDeclaredJava,
  javaRequirementFor,
  type JavaReqInput,
} from '../domain/java-requirement.ts';
import type { JavaRequirement } from '../domain/java.ts';

/**
 * 去后端取一次「这个 MC 版本的版本 JSON 里写没写 Java 要求」。
 *
 * ★ 拉不到就**不写缓存** —— 写个 0 进去等于把"没查到"永久记成"没有"，
 *   那正是这个仓库反复踩过的坑（把一次失败当成结论缓存下来）。下次还会重试。
 */
async function fetchDeclaredJava(mcVersion: string): Promise<number | null> {
  const { getRealApi } = await import('../bridge/index.ts');
  const api = await getRealApi();
  if (!api) return null;
  try {
    const d = await api.metadata.version(mcVersion, 'bmclapi');
    // `java_major` 为 null = Mojang 那份 JSON 里没写这个字段 → 记 0（= "查过了，没写"）
    return d.java_major ?? 0;
  } catch {
    return null;
  }
}

/**
 * React hook：**只负责把 Mojang 声明的那个数取回来**。
 *
 * 刻意做成"取值"而不是"算结论"，因为组件里经常要先判空再渲染 ——
 * 直接返回 `JavaRequirement` 的 hook 会被 `if (!inst) return` 挡在条件分支里，
 * 那违反 Hook 规则（同一个组件两次渲染的 Hook 数量必须一致）。
 */
export function useDeclaredJava(mcVersion: string): number | undefined {
  const { api } = useRealApi();
  const [declared, setDeclared] = useState<number | undefined>(() =>
    declaredJavaOf(mcVersion),
  );

  useEffect(() => {
    if (!mcVersion) return;
    const known = declaredJavaOf(mcVersion);
    if (known !== undefined) {
      setDeclared(known);
      return;
    }
    // 浏览器演示模式没有真实后端 —— 按版本号基线算就够演示了
    if (!api) return;
    let alive = true;
    void fetchDeclaredJava(mcVersion).then((v) => {
      if (!alive) return;
      if (v === null) return; // 没查到 → 不缓存、不更新（下次还会试）
      rememberDeclaredJava(mcVersion, v);
      setDeclared(declaredJavaOf(mcVersion));
    });
    return () => {
      alive = false;
    };
  }, [api, mcVersion]);

  return declared;
}

/**
 * 便利版：先算一次（用缓存/基线），声明值到位后自动重算。
 *
 * ⚠️ 只能在**没有条件 return** 的组件里直接用。有 `if (!x) return` 的组件
 *    请用 `useDeclaredJava` + `javaRequirementFor`（见它们各自的说明）。
 */
export function useJavaRequirement(input: JavaReqInput): JavaRequirement {
  const declared = useDeclaredJava(input.mcVersion);
  return javaRequirementFor({ ...input, declaredJava: declared });
}
