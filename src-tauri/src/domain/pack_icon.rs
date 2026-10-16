//! **整合包的封面**：哪张图算数、多大算合法、该不该落盘（2026-10-17）。
//!
//! ## 缺口是什么（用户原话：「启动器，整合包版本图标应该显示整合包自己的封面」）
//!
//!   原来只有**一条**来源：装包时从包体根目录里抽 `icon.png`（见
//!   `modrinth::extract_pack_icon`）。而现实是：
//!     · Modrinth 的 `.mrpack` **规范里没有图标**（根下只有 `modrinth.index.json`
//!       与 `overrides/`）—— 作者放不放那张图全看心情；
//!     · CurseForge 的 `.zip` 里只有 `manifest.json` + `modlist.html` + `overrides/`，
//!       **从来没有**图标文件。
//!   ⇒ 抽不到就什么都没留下，界面退回自绘的版本图标。
//!   而**平台上的封面一直都有**（Modrinth 的 `icon_url`、CF 的 `logo.thumbnailUrl`），
//!   界面上早就拿得到它 —— 只是从来没往下传给后端、也没落过盘。
//!
//! ## 所以这里定三条判据
//!
//!   ① **优先级**：包体内的作者图标 > 平台 API 封面 > 没有（界面自绘）。
//!      作者放进包里的那张是他自己选的成品图，API 那份是同一张图的远端副本 ——
//!      一样的优先级顺序，但包体那份**不用发请求**。
//!   ② **必须是真图片**（按**文件头**认，不按扩展名）：远端给什么字节都可能
//!      （一段 HTML 错误页、一个被劫持的响应体），**不能把任意字节写成"封面"** ——
//!      界面拿到一段 HTML 当 PNG 会渲染成破图，比没有封面难看，而且没人查得出为什么。
//!   ③ **体积上限走现成的那一档**：`ArtifactClass::Image`（8 MiB，见
//!      `archive_guard::default_limit_for` 的表）。不另立一个数。
//!
//! ## 这个模块**只做判定**，不碰网络、不碰盘
//!
//!   于是它零 `crate::` 依赖（只用同目录的 `archive_guard`），
//!   可以用 rustc 把**同一个源文件**单编成小程序真跑断言
//!   （`cargo test --lib` 在这台机器上跑不了，见项目记忆）。

use super::archive_guard::{ArtifactClass, ByteCap};

/// 封面在实例目录里的**唯一文件名**（`<实例>/.ieml/pack-icon.png`）。
///
/// ★ 读到与写到必须用**同一个常量**：这两处一旦写岔，症状是"装的时候留下了、
///   列表里就是不显示"，而两边代码看起来都对。
/// ★ 名字里的 `.png` 是**历史包袱，故意留着**（0.21.x 已经装好的实例里就是这个
///   名字，改了会让那些封面变成孤儿）。存进去的字节可能是 JPEG/WebP/GIF ——
///   所以**真实类型由 [`sniff`] 认**，不由文件名认，读的那一端据此给对的 MIME。
pub const PACK_ICON_FILE: &str = "pack-icon.png";

/// 图片的**真实类型**（按文件头认出来的那一种）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    WebP,
}

impl ImageKind {
    /// 给 `data:` URI 用的 MIME。
    ///
    /// ★ 必须按**实际字节**给：写死 `image/png` 而字节是 JPEG 时，
    ///   浏览器不保证会去嗅探内容，结果是**破图**（旧读法就是这个毛病）。
    pub fn mime(self) -> &'static str {
        match self {
            ImageKind::Png => "image/png",
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Gif => "image/gif",
            ImageKind::WebP => "image/webp",
        }
    }
}

/// 按**文件头**认出图片类型；不是图片就是 `None`。
///
/// ★ 为什么不看扩展名：远端 URL 的扩展名完全不说明内容
///   （`…/logo.png` 回一段 HTML 是常态），而 zip 里的名字也只是一个字符串。
pub fn sniff(bytes: &[u8]) -> Option<ImageKind> {
    /// PNG 的 8 字节签名
    const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() >= 8 && bytes[..8] == PNG {
        return Some(ImageKind::Png);
    }
    // JPEG：SOI + 第一个段的标记
    if bytes.len() >= 3 && bytes[..3] == [0xFF, 0xD8, 0xFF] {
        return Some(ImageKind::Jpeg);
    }
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return Some(ImageKind::Gif);
    }
    // WebP：`RIFF` + 4 字节长度 + `WEBP`
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageKind::WebP);
    }
    None
}

/// 不接受的理由（每一档都有**给用户看的一句话**，不是给工程师看的枚举名）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    /// 一个字节都没有
    Empty,
    /// 超过这一档的上限
    TooBig,
    /// 不是认得出的图片
    NotAnImage,
}

impl Reject {
    /// 一句话（日志用；界面不直接显示 —— 没有封面时界面**自绘图标**，不报错）
    pub fn why(self) -> &'static str {
        match self {
            Reject::Empty => "封面是空的（0 字节）",
            Reject::TooBig => "封面超过了这一类别的体积上限",
            Reject::NotAnImage => "这份字节不是图片（按文件头认不出 PNG/JPEG/GIF/WebP）",
        }
    }
}

/// 封面这一类的体积上限 —— **只此一处**（`ArtifactClass::Image` = 8 MiB）。
///
/// ★ 8 MiB 对"给人看的小图"是极宽的一档（真实包图标 20~200 KB，作者放大的也就 1~2 MB）。
///   它的作用不是"限制正常图片"，而是**拦住一个被劫持的源往盘上灌垃圾** ——
///   与 `archive_guard` 那一整张表同一个口径，所以直接用它，不另取数。
pub fn cap() -> ByteCap {
    ByteCap::for_class(ArtifactClass::Image)
}

/// 这份字节能不能当封面用：**必须是真图片、且不超过上限**。
pub fn validate(bytes: &[u8], cap: ByteCap) -> Result<ImageKind, Reject> {
    if bytes.is_empty() {
        return Err(Reject::Empty);
    }
    if cap.over_limit(bytes.len() as u64) {
        return Err(Reject::TooBig);
    }
    sniff(bytes).ok_or(Reject::NotAnImage)
}

/// 能不能用（按默认上限）—— 用于"包体里抽到的那张值不值得直接用"。
pub fn is_usable(bytes: &[u8]) -> bool {
    validate(bytes, cap()).is_ok()
}

/// 这张封面是**从哪来的**（写日志、排查时用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconOrigin {
    /// 包体根目录里作者放的那张
    Archive,
    /// 平台 API 上的封面（Modrinth `icon_url` / CF `logo`）
    Api,
}

impl IconOrigin {
    pub fn label(self) -> &'static str {
        match self {
            IconOrigin::Archive => "包体里的作者图标",
            IconOrigin::Api => "平台上的封面",
        }
    }
}

/// 选中的那张封面。
#[derive(Debug, Clone, Copy)]
pub struct IconChoice<'a> {
    pub bytes: &'a [u8],
    pub kind: ImageKind,
    pub origin: IconOrigin,
}

/// **两条来源选一张**：包体内的作者图标 > 平台 API 封面 > 没有（`None`）。
///
/// ★ 某一档"存在但不合法"（不是图片 / 太大 / 空）时**继续往下挑**，
///   而不是就此放弃：包体里塞了一张坏图、而平台上那张是好的，这种组合真的会出现。
/// ★ 全都不合法 ⇒ `None`：界面退回自绘的版本图标（那本来就是"没有真图标"时的样子）。
pub fn pick_icon<'a>(archive: Option<&'a [u8]>, api: Option<&'a [u8]>) -> Option<IconChoice<'a>> {
    let cap = cap();
    for (bytes, origin) in [
        (archive, IconOrigin::Archive),
        (api, IconOrigin::Api),
    ] {
        if let Some(b) = bytes {
            if let Ok(kind) = validate(b, cap) {
                return Some(IconChoice {
                    bytes: b,
                    kind,
                    origin,
                });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一张最小的合法 PNG（8 字节签名 + IHDR 的开头，够 `sniff` 认出来）
    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    ];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
    const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00";
    const WEBP: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 ";

    #[test]
    fn sniffs_by_content_not_extension() {
        assert_eq!(sniff(PNG), Some(ImageKind::Png));
        assert_eq!(sniff(JPEG), Some(ImageKind::Jpeg));
        assert_eq!(sniff(GIF), Some(ImageKind::Gif));
        assert_eq!(sniff(WEBP), Some(ImageKind::WebP));
        // 一段 HTML 错误页**不是**图片 —— 这正是"别把任意字节写成 .png"要拦的
        assert_eq!(sniff(b"<!DOCTYPE html><html>404</html>"), None);
        // 只差一个字节的近似签名也不算
        assert_eq!(sniff(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x00]), None);
    }

    #[test]
    fn mime_follows_the_real_bytes() {
        assert_eq!(ImageKind::Png.mime(), "image/png");
        assert_eq!(ImageKind::Jpeg.mime(), "image/jpeg");
        assert_eq!(ImageKind::WebP.mime(), "image/webp");
    }

    #[test]
    fn cap_is_the_image_class_limit() {
        assert_eq!(cap().max_bytes, Some(8 * 1024 * 1024));
    }

    #[test]
    fn rejects_empty_garbage_and_oversized() {
        assert_eq!(validate(&[], cap()), Err(Reject::Empty));
        assert_eq!(validate(b"not an image", cap()), Err(Reject::NotAnImage));
        // ★ 这两份"大图"必须以真签名开头：全零的字节**不是图片**，
        //   拿它测上限会测成 `NotAnImage`（第一版就这么错了，被 rustc 真跑抓出来）。
        let mut exact = PNG.to_vec();
        exact.resize(8 * 1024 * 1024, 0);
        let mut big = exact.clone();
        big.push(0);
        assert_eq!(validate(&big, cap()), Err(Reject::TooBig));
        // 恰好等于上限**放行**（`over_limit` 是"大于"）
        assert!(validate(&exact, cap()).is_ok());
    }

    #[test]
    fn archive_wins_over_api() {
        let got = pick_icon(Some(PNG), Some(JPEG)).expect("应当选中包体里那张");
        assert_eq!(got.origin, IconOrigin::Archive);
        assert_eq!(got.kind, ImageKind::Png);
    }

    #[test]
    fn bad_archive_falls_through_to_api() {
        // 包体里那张是坏的（HTML）⇒ 用平台那张
        let got = pick_icon(Some(b"<html>oops</html>"), Some(JPEG)).expect("应当退到平台封面");
        assert_eq!(got.origin, IconOrigin::Api);
        // 包体里那张太大 ⇒ 同样往下走（同样要以真签名开头）
        let mut big = PNG.to_vec();
        big.resize((8 * 1024 * 1024) + 1, 0);
        let got = pick_icon(Some(&big), Some(PNG)).expect("应当退到平台封面");
        assert_eq!(got.origin, IconOrigin::Api);
    }

    #[test]
    fn nothing_usable_means_no_choice() {
        assert!(pick_icon(None, None).is_none());
        assert!(pick_icon(Some(b""), Some(b"garbage")).is_none());
    }

    #[test]
    fn is_usable_matches_validate() {
        assert!(is_usable(PNG));
        assert!(!is_usable(&[]));
        assert!(!is_usable(b"<html></html>"));
    }
}
