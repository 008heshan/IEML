/**
 * 「拿哪个字段当磁盘目录名」—— **只有这一份判定**。
 * ------------------------------------------------------------------
 * ★★ 2026-09-30 真机 bug（用户：「不显示」）：
 *
 *   `ModsPanel` 里调用后端时传的是 `active.id`，而 `id` 是**账本里的实例身份**
 *   （`inst-mulcf1gv`），磁盘上的目录名是 **`config.slug`**
 *   （`26.3-fabric-0.19.5`）。后端拿它当目录名拼路径 ⇒ 去读
 *   `.minecraft/versions/inst-mulcf1gv/mods` ⇒ **不存在** ⇒ Mod 列表 0 个。
 *
 *   真机证据（后端写的 `mods-diag.txt`）：
 *   ```
 *   scan_mods(instance_id="inst-mulcf1gv", …)
 *   实际读的目录：D:\IEML\.minecraft\versions\inst-mulcf1gv\mods
 *   结果：目录不存在或读不出来
 *   ```
 *
 * ## 为什么要专门抽一个函数（而不是就地改对那一行）
 *
 *   两个字段**都是 `string`** ⇒ 编译器一个字都不会说；
 *   而症状（"目录里明明有文件、界面却 0 个"）与"这个实例真的没有 Mod"
 *   **长得一模一样** ⇒ 不盯着看根本发现不了。
 *
 *   ⇒ 把"该用哪个"收成一份**有测试**的判定：以后任何一个新页面要按实例取磁盘路径，
 *     都走这里，而不是各自 `instance.???` 猜一个。
 */

/** 判定只需要这两个字段（避免依赖整个 `Instance` 类型，测试更好写） */
export interface InstancePathFields {
  /** 账本里的实例身份（`inst-…`）—— **不是**目录名 */
  id: string;
  config: { slug: string };
}

/**
 * 这个实例在磁盘上的**目录名**。
 *
 * ★ 永远是 `config.slug`。空的话返回 `null`（调用方**不许**拿 `id` 顶上 ——
 *   那正是这个 bug 的形状：看起来"有个值"，实际指向一个不存在的目录）。
 */
export function instanceDirSlug(inst: InstancePathFields | null | undefined): string | null {
  if (!inst) return null;
  const slug = inst.config?.slug?.trim();
  return slug ? slug : null;
}
