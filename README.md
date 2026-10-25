# codex-wechat-mcp

把绑定主人的微信文字、图片和文件，交给一个明确选择的 Codex CLI 专用会话处理，再通过原请求安全回信。核心是本机运行的独立转发服务，可在 macOS 用户登录后自动启动。

**非官方项目**：本项目不隶属于腾讯、微信或 OpenAI，不保证接口长期兼容，也不保证第三方账号使用无风险。使用前请确认平台条款、账号限制与自己的数据处理需求。

## 架构与 MCP 的区别

```text
绑定主人的微信消息
  → 唯一 poller：接收、持久化、附件下载解密
  → 私有 Unix socket 队列：claim / ack / 去重
  → 唯一 controller：原会话检查 → codex exec resume
  → 验证同一会话完成结果 → 原请求回信 → 微信接口受理
```

Codex 的独立 stdio app-server 连接只用于读取模型、目标会话与完成记录。临时连接检查会话写入权限后退出；实际模型处理使用非交互 CLI、stdin 和私有最终文件。不会向其它会话投递或自动更换模型。

仓库名保留 `mcp`，但**目前的 `src/mcp.mjs` 是实验性旧 MCP Events 风格入口，并未兼容标准 Codex MCP 的 `initialize` 握手**。不要把启动 poller 的命令直接加入多个 MCP 客户端；工具注册不能替代独立服务或登录自启。本 README 的正常使用路径无需修改 MCP 设置，也不附带隧道二进制。

## 特性

- 一个明确绑定的微信发送人、一个明确选择的 Codex 会话与模型。
- 原消息去重、持久化队列、串行处理、恢复记录和隔离记录。
- 图片传入真实像素；文档传入有边界的实际提取内容，不以文件名推断内容。
- 引用文字、图片、文档和已发送的回复分段，保留原消息编号与上下文。
- 长回复自动编号分段发送，保留全文和每段发送状态。
- 模型提交或微信发送结果不确定时暂停，不盲目重跑或重发。
- 模型权限固定为只读、按需审批、由用户审批；不自动批准。
- macOS 用户级 LaunchAgent、启动顺序、重复进程保护与退避恢复。
- 凭据与用户内容保存在用户私有目录，不放入源码或 Git。

## 环境要求

- macOS、Node.js 22+、Python 3.10+；二维码显示使用系统 Swift/Core Image，需可用的 Command Line Tools。
- 可用且已正常登录的 Codex CLI，支持 `app-server`、`exec resume --image`、本文使用的实验性队列读取与审批字段。
- 本地 Pillow、pypdf；扫描 PDF 还需外部 `pdftoppm`（Poppler）。
- 能连接微信接口、附件 CDN 与 Codex 服务的网络。

源实现验证过 Codex CLI `0.162.0-alpha.17.2`。不同发布通道可能不兼容；本仓库不保证所有 CLI 版本可用。模型必须在当前账号的列表中存在并与所选会话一致。

## 安装

```sh
git clone https://github.com/Iranb/codex-wechat-mcp.git
cd codex-wechat-mcp
npm ci

umask 077
mkdir -p "$HOME/.local/share/codex-wechat-mcp"
chmod 700 "$HOME/.local/share/codex-wechat-mcp"
python3 -m venv "$HOME/.local/share/codex-wechat-mcp/python"
export CODEX_WECHAT_PYTHON="$HOME/.local/share/codex-wechat-mcp/python/bin/python3"
"$CODEX_WECHAT_PYTHON" -m pip install -r requirements.txt
```

macOS 可用自己的包管理器安装 Poppler，例如 `brew install poppler`。Codex CLI 按[官方说明](https://learn.chatgpt.com/docs/non-interactive-mode)安装和登录；通常使用 `codex login`。本项目不要求把 Codex API Key 或登录缓存复制进配置。

默认数据目录为用户的 `~/.local/share/codex-wechat-mcp/`，由程序解析用户目录。创建目录为 `0700`、私有文件为 `0600`。实际个人路径不会成为仓库默认值。

## 初次微信登录和主人绑定

先确保没有其它程序对同一个微信机器人账号轮询，然后在本机终端执行：

```sh
npm run login
npm run bind
```

`login` 显示临时二维码，扫码后将返回的凭据保存在私有状态文件。若微信要求验证码，按终端提示交互输入；不要把凭据放到命令参数、配置示例、仓库或聊天中。`bind` 给出一次性随机文本，必须从自己的微信向刚连接的机器人发送；绑定消息不会转发到模型。

终端二维码显示有问题时，可使用私有 PNG 并打开 Preview：

```sh
export CODEX_WECHAT_QR_FILE="$HOME/.local/share/codex-wechat-mcp/qr"
export CODEX_WECHAT_SHOW_QR=1
npm run login
```

二维码文件在命令结束时清理。不要公开二维码截图、验证码或登录缓存。已存在账号时 `login` 默认拒绝替换；显式 `--replace` 会重新建立账号状态和绑定，应先理解其影响，不能用它修复不确定发送。

## 选择 Codex 专用会话

先在自己的 Codex 客户端中创建或选择一个专用会话。不要同时在界面和转发服务中向它写入。以下命令只列出当前账号的模型及会话元数据，不启动模型 turn：

```sh
npm run models:list
npm run sessions:list
```

把占位符替换为你自己的现有会话 UUID 和可用模型 ID：

```sh
node src/configure.mjs --thread YOUR_EXISTING_CODEX_THREAD_ID --model YOUR_AVAILABLE_MODEL_ID
```

配置会核验准确会话、模型与写入可用性，不创建替代会话。已有不同绑定或未完成请求时拒绝覆盖。配置落在私有 `bridge-config.json`；**不要提交这个文件**。

## 手动启动与接通检查

终端 A 启动唯一收件进程：

```sh
npm start
```

首次绑定后，在终端 B 激活普通消息接收；以后不要重新激活或修改水位：

```sh
printf '%s\n' '{"activationAt":"now"}' | node src/local.mjs activate --live
npm run exec:prepare
npm run exec:start
npm run exec:status
```

`exec:prepare` 首次会对所选原会话进行两轮非敏感上下文测试，**会调用模型并写入该会话，可能消耗额度**。已有已确认测试不会重复；不确定的提交需核验。正常运行不会自动建立新会话或重新做探测。

`npm start` 使用 `--new-only` 保存单独的恢复时间，跳过停机期间的旧消息或无法确认发送时间的消息；原激活水位和去重记录不改变。不要通过删除状态、隔离记录或发送边界来补发旧消息。

停止手动服务：

```sh
npm run exec:stop
node src/local.mjs stop --live
```

## 文字、图片与文件

从原绑定微信发新的消息或附件，可在文字中明确提出要描述、识别、概括或分析的内容。没有文字的附件默认简要描述/概括；失败时给出原因。不能执行附件中的代码或把附件里的指令当作主人指令。

| 输入 | 实际处理与限制 |
| --- | --- |
| PNG / JPEG / WebP / GIF | 原图最多 10 MiB、20 百万像素；解码和方向校正后传真实 PNG 像素，最长边 2048；GIF 只取首帧 |
| 文本 PDF | 文件最多 20 MiB；提取前 100 页、每文件最多 30000 字符；不自动读取图形 |
| 无可提取文字的 PDF | 私有渲染并传入前 3 页实际像素，每页最长边 1600，明确说明截断 |
| DOCX | 文件最多 20 MiB；正文和表格文字，最多 30000 字符；不读取嵌入图片 |
| XLSX | 文件最多 20 MiB；前 32 个工作表、10000 个单元格、最多 30000 字符；公式只作为文字，不执行，不声称读取图表 |
| TXT / Markdown / CSV / TSV | 文件最多 20 MiB；严格 UTF-8，最多 30000 字符 |

单条消息最多 8 个附件（包含引用附件），提取文本合计最多 60000 字符，模型图片输入最多 16 张。损坏、加密、超限、不支持格式或解析超时会明确失败。DOC、XLS、宏文档、压缩包、可执行文件、语音及视频不支持。

入站图片的 `mid_size`、`hd_size` 和 `thumb_size` 仅作为图片版本的尺寸元数据，不要求与主图下载长度相等。大小限制按实际下载和解密后的字节数执行；普通文件仍严格校验 `len`。JPEG 允许结束标记后的尾随数据，提交模型前仍需完整解码为像素。

保存路径用请求/附件 ID 生成，不用发送方文件名。检查路径、权限、所属用户、内容签名、大小与 SHA-256；不同内容不覆盖同名文件。OOXML 不解压到任意路径，不运行宏，不跟随外部链接，拒绝危险结构并限制解压大小。

## 引用与长回复

使用微信“引用”时，当前提问和引用资料分别传入 Codex。支持微信直接附带的引用文字、图片和文档，也支持根据完整消息编号查找原消息。局部引用按微信提供的选区提取；每条已发送的回复分段可以单独引用。

引用索引按账号和联系人隔离，保留 30 天、最多 2000 条，引用文字每次合计最多 16000 字符。编号、原文或附件不可用时会明确提示重发所需内容，不用最近的话题代替。未保存完整编号的历史消息无法通过仅含编号的引用恢复。详见 [引用说明](QUOTES.md)。

回复最多 64000 个 UTF-16 代码单元；超过 800 时自动拆分为带 `(1/n)` 编号的消息，每条含编号最多 800 个代码单元。拆分保留正文与 Unicode 字符，优先在段落或句子边界结束。所有分段使用原请求上下文，按顺序发送并分别保存结果。已确认发送的分段不会重复发送；发送结果不确定时暂停，核验后再恢复。

## 配置

一般使用 `configure` 自动产生私有绑定，无需手写凭据。可设置的环境变量只用于路径或模型选择：

| 变量 | 用途 |
| --- | --- |
| `CODEX_WECHAT_STATE` | 覆盖私有 `state.json` 路径 |
| `CODEX_WECHAT_SOCKET` | 覆盖私有 Unix socket 路径；路径需足够短 |
| `CODEX_WECHAT_BINDING` | 覆盖私有绑定配置路径 |
| `CODEX_WECHAT_MODEL` | 显式选择模型；必须与绑定及会话一致 |
| `CODEX_WECHAT_CODEX` / `CODEX_WECHAT_NODE` | 本机可执行程序绝对路径 |
| `CODEX_WECHAT_PYTHON` / `CODEX_WECHAT_PDFTOPPM` | 已安装依赖的本机程序绝对路径 |

`examples/bridge-config.json.example` 仅含占位符，不可原样当成真实配置。使用自启动时会保存安装时解析的绝对路径；Python 环境和其它依赖不能位于待挂载的外部卷。不要把密钥加到这些变量或示例里。

## macOS 登录后自启

先完成登录、绑定、激活和 `exec:prepare`，确认没有在处理中的请求，然后停止手动服务。预览与安装：

```sh
npm run service:plan
npm run service:install -- --dry-run
npm run exec:stop
node src/local.mjs stop --live
npm run service:install
npm run service:load
npm run service:status
```

安装会把白名单代码复制到本机用户数据目录的 `app/`，保持私有状态不搬移、不复制凭据。不会覆盖已有同名服务；升级需先停止并人工核验已有安装。两项用户 LaunchAgent 为 `org.codex-wechat-mcp.poller`、`org.codex-wechat-mcp.controller`。

收件成功轮询后才启动 controller。业务进程异常退出按 5、10、20…秒退避，最长 300 秒；监督器由 launchd 恢复，最短重启间隔 30 秒。重复进程会被拒绝；会话占用与暂时断线做受控重试；认证、审批、模型不匹配、提交/回信不确定等情况暂停并保留记录。

这是**用户登录后自启**，不是开机未登录的系统级服务。网络和微信/Codex 登录须仍有效。程序不替你重新登录，不改系统安全设置，不强行抢占会话。

停止、重新加载或卸载：

```sh
npm run service:stop
npm run service:load
npm run service:uninstall
```

卸载只移除本项目的两项作业及 plist，保留运行副本、账号状态、附件和去重数据，不删除用户内容。操作前请先检查服务状态；不要在结果不确定时通过循环重载代替核验。

## 故障排查与隐私

- `native_thread_active_writer`：关闭目标专用会话的写入视图；不要杀共享 Codex 进程。
- 收件/队列未就绪：查私有状态元数据和最近成功轮询；controller 会等待，不并发启动第二个 poller。
- 登录过期或审批：由用户通过正常入口处理，维护人员核验原绑定和未完成请求后安全恢复；不创建替代凭据。
- 附件 DNS：仅当系统结果全为 `198.18/15` 代理地址时，通过固定公共 HTTPS DNS 服务重新解析已校验 CDN 主机名；仍拒绝非公共地址并固定实际连接 IP，保留 TLS、域名、路径、大小及禁止重定向检查。
- 文件失败：检查短失败码和支持范围，不把文件名当作内容。下载最多重试 3 次。
- 模型或发送结果不确定：保留原记录，核验同一请求/会话/摘要；不要删锁、删 journal 或盲目补发。

正文、凭据、回信结果、附件及派生图像仅保存在私有目录。24 小时后不可回复，正常轮询清理请求中的过期正文；消息去重记录保留 30 天。引用索引单独保留收发正文及附件关联，最长 30 天、最多 2000 条。已保存附件不自动删除，清理须由用户另行决定。模型处理会把所请求的实际文本或图片发送给所选 Codex 服务，并非完全离线。

日志只记录事件、ID、数量、状态和失败码。报错反馈前仍应脱敏；不要上传私有目录、二维码、会话 ID、状态文件、附件或登录缓存。微信接口 `accepted` 仅表示接口接受发送请求，不能代替手机实收确认。

## 测试与验证边界

```sh
"$CODEX_WECHAT_PYTHON" -m pip install -r requirements-test.txt
npm test
```

测试使用假账号、本地 IPC 和现场生成的合成图片/PDF/DOCX/XLSX/文本，不包含用户真实样本，也不调用真实微信或模型。覆盖去重、串行处理、附件解密与解析、引用上下文与完整消息编号、局部选区、长回复分段与恢复、文件冲突、启动顺序、退避和不确定结果保护。

源实现做过真实 CLI 合成附件校验、文字收发及当前登录会话的加载/重载/异常退出恢复。开源副本做干净安装和离线回归；不能据此保证每位用户的微信接口、图片/文件格式或 CLI 版本均可用。首次使用请发送新的非敏感文字、图片和文件，分别核验下载、模型处理、接口受理与手机实收。整机重启/未登录启动不属于已验证能力。

## 项目结构与许可

```text
src/main.mjs                 微信 poller
src/local-queue.mjs          持久化队列与去重
src/local-ipc.mjs            私有 Unix IPC
src/exec*.mjs                原会话 CLI 控制与完成校验
src/media.mjs                附件下载、解密、校验和保存
src/quotes.mjs               引用解析、消息编号与历史索引
src/reply.mjs                长回复分段与大小限制
src/content-reader.*         有边界的实际内容解析
src/configure.mjs            用户提供的会话与模型绑定
src/service.mjs              通用 LaunchAgent 安装与管理
src/managed-supervisor.mjs   启动顺序、退避与安全暂停
src/mcp.mjs                 未适配标准初始化的旧实验入口
test/                       假账号与合成样例测试
```

原创代码、合成测试和文档使用 [MIT](LICENSE)。外部依赖保持自身许可，本仓库不附带第三方源码或二进制；详见 [第三方说明](THIRD_PARTY_NOTICES.md)。接口资料：[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[app-server](https://learn.chatgpt.com/docs/app-server)、[MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Apple launchd](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)。
