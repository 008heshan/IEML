/// <reference types="vite/client" />

/*
 * ★★ 2026-09-16：加这个文件是因为**导入图片编译不过**。
 *
 *   你在 `AppShell.tsx` 里写了 `import brandIcon from '../assets/brand-icon.png'`、
 *   在 `VersionIcon.tsx` 里写了 `import versionIcon from '../assets/version-icon.png'` ——
 *   代码本身没问题，但 **TypeScript 不认识 `.png` 这种导入**：
 *   它需要有模块声明告诉它"`.png` 导入进来的是一个字符串 URL"。
 *
 *   `vite/client` 那份类型里就有这些声明（png/jpg/svg/webp… 全都覆盖）。
 *   `tsc` 之前没报，是因为在它之前**没有人 import 过图片**。
 */