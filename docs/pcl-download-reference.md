一、系统目标

在复杂网络环境下，稳定、高速地获取并校验所有 Minecraft 相关文件。核心指标：速度、成功率、数据一致性。



二、整体架构：四大核心组件

text

┌─────────────────────────────────────────────┐

│              下载源管理                       │

│  (Download Source Management)                │

│  - 官方源 / BMCLAPI 镜像源                   │

│  - 自动选择、切换、回退                       │

└──────────────────┬──────────────────────────┘

&#x20;                  │

┌──────────────────▼──────────────────────────┐

│              NetFile 系统                    │

│  - 多源 URL 数组                             │

│  - 本地目标路径                              │

│  - FileChecker 校验对象                      │

└──────────────────┬──────────────────────────┘

&#x20;                  │

┌──────────────────▼──────────────────────────┐

│             加载器框架                        │

│  - LoaderTask<TInput, TOutput>              │

│  - LoaderDownload                           │

│  - LoaderCombo                              │

└──────────────────┬──────────────────────────┘

&#x20;                  │

┌──────────────────▼──────────────────────────┐

│           组件专用逻辑                        │

│  - 游戏本体 / Forge / OptiFine / Fabric     │

└─────────────────────────────────────────────┘

三、下载源管理

3.1 支持的源

官方源：Mojang、Forge、Fabric 官方地址



BMCLAPI：国内镜像源，解决官方源国内访问慢的问题



MCBBS 镜像：备用镜像源



3.2 源选择策略

由 DlSourceLoader() 函数统一管理



优先尝试 BMCLAPI，失败或超时自动切换到其他源



动态优先级：连接官方源 < 4 秒则优先官方，否则优先 BMCLAPI



当多个源返回不一致文件时，自动选择正确的那个



3.3 源回退规则

单源失败 → 切换到下一个可用源



所有源失败 → 触发重试逻辑



BMCLAPI 返回 429 Too Many Requests → 降低并发 + 延迟重试



四、NetFile 系统

4.1 结构定义

每个待下载文件抽象为一个 NetFile 对象：



text

NetFile {

&#x20;   urls: Vec<String>,        // 多个候选下载 URL

&#x20;   target\_path: PathBuf,     // 本地保存路径

&#x20;   checker: FileChecker,     // 校验规则

}



FileChecker {

&#x20;   sha1: Option<String>,     // SHA1 校验值

&#x20;   size: Option<u64>,        // 文件大小

}

4.2 职责

封装下载一个文件所需的全部信息



支持多源回退（urls 数组）



支持下载后校验（checker）



作为 LoaderDownload 的输入单元



五、加载器框架

5.1 三种加载器类型

LoaderTask<TInput, TOutput>



职责：数据处理



典型用途：分析待下载文件列表、准备下载任务、处理已下载文件



特点：泛型，输入输出明确



LoaderDownload



职责：专门下载 NetFile 对象列表



处理内容：进度跟踪、重试、回退



特点：并发调度，信号量控制



LoaderCombo



职责：组合多个加载器



处理内容：任务间依赖关系、整体进度跟踪



特点：复合操作，流水线编排



5.2 加载器链示例

下载 Minecraft 客户端时：



text

LoaderCombo {

&#x20;   LoaderTask: 下载并解析版本 JSON

&#x20;   LoaderDownload: 下载 libraries 和 assets

&#x20;   LoaderTask: 校验所有文件

}

六、核心下载工作流

以下载 Minecraft 客户端为例：



text

步骤 1: 检查版本

&#x20; → 调用 McDownloadClient()

&#x20; → 检查目标版本是否已存在



步骤 2: 创建加载器链

&#x20; → 调用 McDownloadClientLoader()

&#x20; → 创建一系列加载器任务



步骤 3: 下载并分析 JSON

&#x20; → 下载版本 JSON 文件

&#x20; → 分析 libraries 列表

&#x20; → 分析 assets 列表



步骤 4: 并行下载

&#x20; → 并行下载所有 libraries

&#x20; → 并行下载所有 assets

&#x20; → 大文件（Client.jar）使用多线程分块下载



步骤 5: 校验文件

&#x20; → 逐一进行 SHA1 完整性校验

&#x20; → 失败文件重新下载

七、组件专用逻辑

7.1 Forge / NeoForge

text

1\. 下载安装器 JAR

2\. 从安装器中提取库信息

3\. 通过 ForgelikeInjector() 使用 Java 运行安装器

4\. 完成注入

7.2 OptiFine

text

根据版本新旧分两种方法：

\- 新版本：运行 Java 安装器

\- 老版本：直接进行文件操作

7.3 Fabric / LiteLoader

text

遵循与其他加载器相似的模式

具体实现有差异

八、容错与重试策略

8.1 智能重试

最多 3 次尝试



最长 30 秒超时



核心函数：NetRequestByClientRetry



8.2 降级策略

首次下载失败 → 自动关闭多线程 → 单线程重试



目的：兼容不支持并发请求的服务器



适用场景：老服务器、限流服务器



8.3 错误码处理

错误码	处理方式

429 Too Many Requests	判定失败，降低并发，延迟重试

503 Service Unavailable	切换源，重试

超时	切换源，重试

校验失败	删除文件，重新下载

8.4 数据一致性

多源返回文件不一致时，自动选择正确的那个



以 SHA1 校验为准



九、多线程分块下载

9.1 单文件多线程

大文件（Client.jar）逻辑上分割成多个分段（Chunk）



独立线程并行拉取每个分段



本地按偏移量合并



9.2 并发控制

通过 SemaphoreSlim 动态控制并发数



官方宣称支持“百线程并行”



BMCLAPI 场景下限制并发（建议不超过 8-16）



9.3 分块策略

分块大小：约 1MB



使用 HTTP Range 请求获取指定字节范围



十、磁盘 I/O 与缓存优化

10.1 网络底层

全面换用 HttpClient 替代 WebRequest/WebClient



支持 GZip 等压缩格式的响应读取



支持 HTTP 缓存协商（ETag/Cache-Control）



避免重复下载未变更的文件



10.2 内存缓存

小文件缓存使用 MemoryStream 而非 Queue<Byte>



目的：提高内存操作性能



10.3 路径记忆

单独记忆每种资源上次下载到的文件夹



防止路径混淆



十一、给 IEML 的移植要点

11.1 必须保留的核心策略

多源管理 + 自动回退



NetFile 抽象（多 URL + 校验）



加载器/任务化编排



单文件多线程分块下载



失败降级到单线程



429 指数退避



SHA1 流式校验



11.2 Rust 实现对应

PCL 组件	Rust 对应

NetFile	struct RemoteAsset

LoaderTask	async fn / Future

LoaderDownload	DownloadPipeline

LoaderCombo	组合 Future / JoinSet

SemaphoreSlim	tokio::sync::Semaphore

MemoryStream	BytesMut

HttpClient	reqwest

FileChecker	Sha1Verifier

11.3 禁止事项

不要复制 PCL 的 VB.NET 代码



不要使用 PCL 特有命名（NetFile、LoaderDownload、DlSourceLoader）



不要自研 HTTP/TLS、JSON、压缩、哈希



不要一次性读入大文件



11.4 验收标准

原版客户端下载速度接近 PCL



BMCLAPI 不触发 429



断网重连后能续传



校验失败能自动重下



下载峰值内存 < 100MB



十二、关键函数对照表

PCL 函数	职责	IEML 对应模块

McDownloadClient()	检查版本是否存在	core::version::check\_installed

McDownloadClientLoader()	创建加载器链	core::download::build\_pipeline

DlSourceLoader()	源选择与回退	core::download::SourceManager

ForgelikeInjector()	Forge 注入	core::modloader::forge::inject

NetRequestByClientRetry	智能重试	core::download::retry

