/**
 * 皮肤头像（本地裁头部，不请求任何头像站）—— **尺寸由参数决定**。
 *
 * ## 为什么抽成一个组件
 *
 *   64×64 皮肤里：**头部在 (8,8) 的 8×8**，**帽子层在 (40,8) 的 8×8**。
 *   要显示成 `size` 像素，就得把整图放大到 `64 × (size/8)`，
 *   再按坐标平移到负方向：头部 `-(size)`、帽子 `-(5 × size)`（帽子在 x=40 = 5×8）。
 *
 *   ★ 这套数字**是一组**，单独改一个就会错位 —— `AccountPanel` 里那段注释
 *     （"三个数字是一套，别单独改"）说的就是这件事。
 *     抽出来之后尺寸成为**唯一参数**，不会再有人手抄第二份。
 *
 * ## 为什么是两个元素而不是一个多背景元素
 *
 *   原来试过 `background-image: url(s), url(s)` + 两组 position/size ——
 *   坐标算对了，但多背景的图层序 / 逗号解析 / React 把数组序列化成字符串，
 *   **任何一处出错都会静默地只画出一层**，代码上还看不出来。
 *   两个元素显式叠放：谁在上面由 DOM 顺序决定，出问题一眼看得出是哪层。
 *
 * ## 2026-09-23 的 bug（用户截图："头像不显示"）
 *
 *   我上一轮在账号菜单里手写了 `backgroundSize: '800% 800%'` + `backgroundPosition: '0 0'`
 *   —— **`0 0` 取到的是皮肤左上角那 8×8，而现代皮肤那一块是空的**（头在 (8,8)）。
 *   于是头像是个空白方块。★ 结论和上面那条一样：别手抄这套坐标。
 */
/**
 * **纯函数**：算出某一层该怎么摆。
 *
 * ★ 抽出来是为了**能被单测盯住** —— 这套坐标（源图坐标 × 显示尺寸）
 *   手抄一次就会错，而错了在界面上只是"头像不对"，不会报任何错。
 *   `tests/skin-head.test.mjs` 直接核对"源图第 (8,8) 那 8×8 是否正好落在可见窗口里"。
 */
export function skinLayer(
  /** 源图坐标（64×64 皮肤里的像素位置） */
  src: { x: number; y: number },
  /** 这一层的显示边长 */
  size: number,
): { backgroundSize: string; backgroundPosition: string } {
  /*
   * 显示 `size` 像素 = 源图 8 像素（头部就是 8×8）→ 缩放系数 k = size / 8。
   * 整图（64px 宽）缩放后 = 64k = 8·size。
   * 要让源图 (x,y) 落在这一层的左上角，就把背景往负方向平移 (x·k, y·k)。
   */
  const k = size / 8;
  const scaled = 64 * k;
  return {
    backgroundSize: `${scaled}px ${scaled}px`,
    backgroundPosition: `${-src.x * k}px ${-src.y * k}px`,
  };
}

/** 64×64 皮肤里两块的源坐标 —— 头部与帽子层（**只此一份**） */
export const SKIN_SRC = {
  head: { x: 8, y: 8 },
  hat: { x: 40, y: 8 },
} as const;

export function SkinHead({
  url,
  size,
  className,
}: {
  /** 皮肤图 URL（Mojang 的 textures 地址） */
  url: string | null;
  /** 显示边长（像素）—— 头部区域就是这么大 */
  size: number;
  className?: string;
}) {
  /** 帽子层比头大一圈（9/8），三个数是一套：尺寸、居中偏移、坐标 */
  const hatSize = (size * 9) / 8;
  const hatOffset = (hatSize - size) / 2;
  const head = skinLayer(SKIN_SRC.head, size);
  const hat = skinLayer(SKIN_SRC.hat, hatSize);

  return (
    <span
      className={`skin-head${className ? ' ' + className : ''}`}
      style={{ width: size, height: size }}
    >
      {url ? (
        <>
          <span
            className="skin-head-layer"
            style={{
              backgroundImage: `url(${url})`,
              backgroundSize: head.backgroundSize,
              backgroundPosition: head.backgroundPosition,
            }}
          />
          <span
            className="skin-head-layer skin-head-hat"
            style={{
              backgroundImage: `url(${url})`,
              backgroundSize: hat.backgroundSize,
              backgroundPosition: hat.backgroundPosition,
              width: hatSize,
              height: hatSize,
              left: -hatOffset,
              top: -hatOffset,
            }}
          />
        </>
      ) : null}
    </span>
  );
}
