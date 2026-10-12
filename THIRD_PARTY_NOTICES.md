# 第三方与来源说明

本仓库的 MIT 许可用于原创桥接逻辑、命令行脚本、合成测试和文档。仓库没有附带第三方源码、模型权重、SDK、隧道客户端或其他第三方二进制。原运行环境中的独立隧道客户端采用 Apache-2.0，其程序及配套文件没有纳入发布范围，也没有改为 MIT。

以下依赖由使用者单独安装并按各自许可使用，仓库 MIT 许可不替代其原许可。若重新打包或分发这些依赖，需保留上游要求的版权、许可和 NOTICE。

| 依赖/工具 | 用途 | 上游许可与来源 |
| --- | --- | --- |
| Node.js | 运行桥接服务，使用内置模块 | [Node.js LICENSE（MIT 及组件声明）](https://github.com/nodejs/node/blob/main/LICENSE) |
| Codex CLI | 官方登录、会话读取与非交互模型调用 | [Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE) |
| Pillow | 本地图片解码、方向校正、合成测试 | [MIT-CMU](https://github.com/python-pillow/Pillow/blob/main/LICENSE) |
| pypdf | 本地 PDF 文本提取 | [BSD-3-Clause](https://github.com/py-pdf/pypdf/blob/main/LICENSE) |
| Poppler/pdftoppm | 扫描 PDF 页面渲染，作为外部独立进程调用 | [GPL-2.0-or-later 及上游声明](https://gitlab.freedesktop.org/poppler/poppler/-/blob/master/COPYING)；不在仓库中分发 |
| ReportLab | 生成非敏感合成 PDF 测试 | [BSD 许可](https://pypi.org/project/reportlab/4.4.10/)；仅测试依赖 |
| python-docx | 生成合成 DOCX 测试 | [MIT](https://github.com/python-openxml/python-docx/blob/master/LICENSE)；仅测试依赖 |
| openpyxl | 生成合成 XLSX 测试 | [MIT](https://openpyxl.readthedocs.io/en/stable/)；仅测试依赖 |
| Apple 系统框架/Swift | macOS 本地二维码显示 | 由系统 SDK 提供，不在仓库中分发 |

接口资料与致谢：[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[Cloudflare DNS JSON 接口](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)。微信协议兼容代码仅用于使用者自己的账号，不代表腾讯或 OpenAI 的认可或授权。
