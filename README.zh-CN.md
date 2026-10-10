# DevMate

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://img.shields.io/github/actions/workflow/status/Kukutx/DevMate/ci.yml?branch=main&label=CI)](https://github.com/Kukutx/DevMate/actions/workflows/ci.yml) [![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/kukutx.devmate-agent?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=kukutx.devmate-agent) [![Release](https://img.shields.io/github/v/release/Kukutx/DevMate?label=release)](https://github.com/Kukutx/DevMate/releases) [![License: MIT](https://img.shields.io/github/license/Kukutx/DevMate)](LICENSE)

DevMate 让聊天里的模型直接在你自己的电脑上干活：读写和搜索项目文件、运行命令和测试、使用 Git、看到编辑器已经报出的错误，并把整件任务交给本机安装的编码 Agent。它是一个本地运行时，通过 [MCP](https://modelcontextprotocol.io) 对外提供这些能力。

主要用法是把 ChatGPT 网页版接到本机，用已经在付的聊天订阅继续开发。它不绑定 ChatGPT：Claude 和任何支持 MCP 的客户端都连接同一个运行时。

- **你的电脑，你的通路。** 不经过我们的任何服务中转。云端客户端通过你自己的隧道到达本机（Cloudflare、OpenAI 官方隧道、你的反向代理或 SSH），DevMate 会端到端验证这条通路。
- **共享什么，由你在自己的电脑上决定。** 共享哪些文件夹、只读还是读写、凭据文件是否受保护。连接进来的客户端只能收紧，不能放宽。
- **所有入口共用一个运行时。** 任意多个 VS Code 窗口、Obsidian 和命令行在一台机器上共用一个运行时，由操作系统保证。
- **编辑器知道的，它也知道。** 编译、类型和 lint 报错直接取自 VS Code，不用跑构建。

```
 ChatGPT 网页版 · Claude.ai                  Claude Code · Codex · 本机上的任何 MCP 客户端
          │  经你自己的隧道走 HTTPS                        │  http://127.0.0.1:8788/mcp
          ▼                                                ▼          或 `devmate mcp`（stdio）
   入口端口 8789 ───────────────────┐      ┌─────────────── 控制端口 8788
   只提供 MCP 和 OAuth              ▼      ▼                只属于所有者：命令行、编辑器、工作台
                              ┌──────────────────┐
                              │  DevMate 运行时  │  每个实例目录一个
                              │  所有调用在这里  │  文件 · 搜索 · Git · 命令
                              │  统一授权        │  编辑器诊断 · Agent
                              └──────────────────┘
                                 ▲      ▲      ▲
                          VS Code 窗口 · Obsidian · `devmate` 命令行
```

![DevMate 工作台，显示一个项目尚未提交的改动](docs/media/workbench.png)

DevMate 4 是全新架构，不读取、不迁移、不兼容 3.x 的任何状态、配置或接口。[从 3.x 升级？](#从-3x-升级)

## 安装

**前提：** Node.js 24 或更高版本，Git 2.41 或更高版本（macOS 开发者工具自带的 Git 更旧，用 `brew install git` 更新）。命令行和 Obsidian 还需要 `rg`（[ripgrep](https://github.com/BurntSushi/ripgrep)）；VS Code 扩展自带。

| 入口 | 安装方式 |
| --- | --- |
| VS Code 扩展 | 在扩展视图里搜索 **DevMate**，或运行 `ext install kukutx.devmate-agent`。离线安装：从 [Releases](https://github.com/Kukutx/DevMate/releases) 下载 `devmate-<版本>.vsix`，运行 `code --install-extension devmate-<版本>.vsix` |
| Obsidian 插件 | **设置 → 第三方插件 → 浏览 → DevMate**。手动安装：把 Releases 里的 `devmate-obsidian-<版本>.zip` 解压到 `<库>/.obsidian/plugins/devmate/` 并启用。只支持桌面版 |
| 命令行 | 从 Releases 下载 `devmate-cli-<版本>.tgz`，运行 `npm install -g ./devmate-cli-<版本>.tgz`。它不带任何依赖，安装时不需要联网。卸载用 `npm uninstall -g devmate-agent` |

`devmate doctor`（或编辑器里的 **DevMate: Doctor**）逐项检查这次安装需要的一切，并按你的系统给出每一项的修复命令。

## 最初五分钟

用 VS Code：

1. 打开一个项目文件夹，在命令面板里运行 **DevMate: Start DevMate Runtime**。这个文件夹会以读写方式共享，窗口会告诉你一次。
2. 运行 **DevMate: Copy MCP URL**。同一台电脑上的客户端到这一步就够了：`claude mcp add --transport http devmate http://127.0.0.1:8788/mcp`。
3. 要接 ChatGPT 网页版或 Claude.ai，先运行一次 **DevMate: Configure Connection**（见[连接客户端](#连接客户端)），再把复制到的地址作为自定义 MCP 连接器填进去。
4. 让模型“给我一个项目概览”。它会调用 `project_overview`，然后就可以干活了。

只用命令行：

```powershell
devmate start                          # 启动后台运行时；已在运行则直接接入
devmate project add C:\Projects\Example
devmate doctor
devmate mcp-url                        # 给客户端填的地址
devmate ui --open                      # 在浏览器里打开工作台
```

## 三个入口，一个运行时

| 入口 | 适合 | 额外提供 |
| --- | --- | --- |
| 命令行 `devmate` | 不开编辑器也要用 | 完整入口：启动、共享文件夹、配置连接、打开工作台、调用任何操作。`devmate mcp` 以标准输入输出提供 MCP，供“把服务器当程序启动”的客户端使用 |
| VS Code 扩展 | 日常开发 | 编辑器里的报错、当前文件和选区；状态栏项 |
| Obsidian 插件 | 知识库 | 笔记检索、属性、关系图和库操作 |

一个实例目录（默认 `~/.devmate/runtime`）同一时刻只有一个运行时进程。

- 多个 VS Code 窗口、Obsidian 和命令行可以同时开着。同时点“启动”也只会启动一个，其余自动接入。
- 每个编辑器窗口只操作自己的文件夹。关掉一个窗口不影响运行时和其他窗口。
- **关掉编辑器之后运行时仍在运行**，配置了公网连接的话连接也还在，直到你停止它：`devmate stop`，或编辑器里的 **Stop DevMate Runtime**。停止会影响所有入口，所以编辑器会先确认。
- 运行时意外退出后，下一次启动直接可用。打开了 `devMate.autoStart` 的 VS Code 会把它拉起来；你主动停止的不会被拉起。

## 命令行

| 命令 | 作用 |
| --- | --- |
| `devmate start` / `stop` / `restart` / `status` | 后台运行时 |
| `devmate serve` | 在前台运行，Ctrl+C 结束 |
| `devmate doctor` | 体检。运行时没启动也能用，会告诉你下一步 |
| `devmate logs [--lines N]` | 最近的运行日志 |
| `devmate project add [目录] [--name 名称] [--read-only]` / `list` / `remove` | 共享什么。不写目录就是当前目录 |
| `devmate access [guarded \| full]` | 权限档：连接进来的客户端可以决定什么（见下文“谁可以做什么”） |
| `devmate mcp-url` | 给客户端填的地址 |
| `devmate mcp` | 以标准输入输出提供 MCP；运行时没启动会自动拉起 |
| `devmate connect local \| cloudflare \| openai-tunnel \| https \| ssh …` | 云端客户端到本机的通路。`--auth oauth` 要求登录 |
| `devmate secret set <名称>` / `list` / `remove <名称>` | 连接凭据。值从标准输入读取，不会出现在命令行历史里 |
| `devmate login-code` | 一次性登录码（启用登录时） |
| `devmate ui [--open]` | 工作台的一次性链接 |
| `devmate operations` / `help <操作>` | 全部操作；以及某一个操作的准确输入 |
| `devmate <操作> --json '{…}'` | 调用任何操作；也可以 `--file` 或 `--stdin` |

所有命令都接受 `--instance <目录>` 来使用另一个实例。命令行能做工作台和扩展能做的一切。

命令在 Windows 上用 PowerShell 执行：装了 PowerShell 7 就用它，否则用系统自带的 5.1。5.1 不支持 `&&` 和 `||`，而模型习惯这样写，建议安装 PowerShell 7（`winget install Microsoft.PowerShell`）。macOS 和 Linux 上用 bash，没有 bash 时用 `sh`。

## VS Code 扩展

命令（命令面板里都在 **DevMate:** 之下）：

| 命令 | 作用 |
| --- | --- |
| Start / Stop / Restart DevMate Runtime | 共享的运行时 |
| Change Folder Sharing | 按文件夹设为读写、只读或不共享 |
| Select This Window Workspace | 一个窗口共享了多个文件夹时，选定这个窗口在哪个里面工作 |
| Configure Connection | 云端客户端通路的向导，以及是否要求登录 |
| Copy MCP URL · Copy One-Time Sign-In Code | 客户端需要的东西 |
| Open Workbench · Doctor · Show Menu · Show Runtime Status | 查看状态 |
| Discover Operations · Call Operation | 排查问题 |

VS Code 的显示语言为简体中文时，命令和设置的说明以中文显示。

设置（只在用户设置里生效，仓库里的 `.vscode/settings.json` 改不了它们）：

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `devMate.shareFolders` | `readWrite` | 你打开的受信任文件夹默认怎样共享：`readWrite`、`readOnly`、`ask`、`never`。未受信任的工作区永远不共享 |
| `devMate.shareEditorContext` | `true` | 客户端能否看到当前文件、选区、打开的文件和诊断 |
| `devMate.autoStart` | `true` | 随编辑器启动运行时，意外退出后再拉起 |
| `devMate.runtimePort` | `8788` | 由此编辑器启动运行时时使用的本机端口 |
| `devMate.nodeCommandPath` | 空 | Node.js 24+ 的可执行文件，自动找不到时填写 |
| `devMate.runtimeInstanceDirectory` | 空 | 使用 `~/.devmate/runtime` 以外的实例目录 |

- 打开的文件夹默认以读写共享，窗口会提示一次，带 **Change…** 按钮。你取消共享的文件夹会一直保持不共享，直到你重新共享。
- 不用单独安装 ripgrep：PATH 上没有 `rg` 时，运行时使用 VS Code 自带的那一份，并记住它，之后不开编辑器也能用。
- 自带 MCP 支持的编辑器会自动发现本机端点。
- 扩展需要 VS Code 1.101 或更高版本，在真实编辑器的 1.101 和 1.133 上测试过。
- **远程窗口（SSH、WSL、Dev Containers）：** 扩展运行在远程一侧，所以 DevMate、Node.js 和共享的文件夹都是远程机器上的，“本机地址”指的也是那台机器。这种用法还没有测试过。

## Obsidian 插件

- **DevMate: Start runtime** 启动运行时；状态栏显示当前状态，点击打开侧栏。
- **DevMate: Attach this vault** 把库共享出去并提供笔记工具（检索、属性、关系图、移动和回收）。第一次会问你：读写、只读，还是暂不共享。共享的是整个库目录，所以连接的客户端也能用文件工具访问它。
- **DevMate: Change how this vault is shared** 随时更改。**Detach** 只是停用笔记工具，不改变共享。
- **DevMate: Stop shared runtime** 和 **Restart shared runtime** 会先确认，因为它们影响所有入口。
- Agent 等你批准或回答问题时，Obsidian 会提醒你；用 **DevMate: Open workbench** 打开工作台去回答。

**须知。** 插件只支持桌面版，需要另外安装 Node.js 24（找不到时在插件设置里填它的路径；ripgrep 也要自己安装）。它把 DevMate 运行时作为后台进程启动，Obsidian 关闭后运行时仍在运行，直到你执行 **Stop shared runtime**。运行时只监听 `127.0.0.1`（端口 8788 和 8789，另有一个用于库操作的本机端口）。它的状态、凭据和它自己的程序文件保存在库之外的 `~/.devmate/runtime`。这些程序文件以可读的纯文本形式装在 `main.js` 里（没有任何编码），由插件写到那里，每次启动都逐个校验哈希。除非你配置了公网连接（Cloudflare Tunnel、OpenAI Secure MCP Tunnel、SSH 或你自己的 HTTPS 代理），它不发起任何网络连接。没有遥测，不需要账号，不收费。

4.0 的插件已经在 Windows 上真实的 Obsidian 1.12.7 里加载并操作过：加载、启动运行时、以只读和读写共享库、笔记工具、停止和停用。macOS 和 Linux 上的 Obsidian，以及在已安装的 3.x 插件之上更新，还没有试过。遇到问题请反馈。

## 连接客户端

### 同一台电脑上的客户端

不需要隧道，也不需要登录：

```
http://127.0.0.1:8788/mcp
```

| 客户端 | 配置 |
| --- | --- |
| Claude Code | `claude mcp add --transport http devmate http://127.0.0.1:8788/mcp` |
| Codex CLI | `codex mcp add devmate --url http://127.0.0.1:8788/mcp` |
| VS Code 自带的 MCP 支持 | 装了扩展就自动发现 |
| 只会启动程序的客户端 | 命令填 `devmate`，参数填 `mcp`，例如 `{ "command": "devmate", "args": ["mcp"] }` |

其他客户端：添加一个 HTTP（Streamable HTTP）MCP 服务器并填这个地址。来自其他来源的浏览器端客户端会被拒绝，除非你把它的来源加进 DevMate 配置的 `allowedOrigins`；只添加你自己运行的客户端。

### ChatGPT 网页版和 Claude.ai

它们从云端访问你的 MCP 服务，所以需要一条从外部到本机的通路。DevMate 提供四种，都不依赖 ngrok：

| 通路 | 适用 | 特点 |
| --- | --- | --- |
| `openai-tunnel` | ChatGPT、Codex | OpenAI 官方隧道。只有出站连接，没有公网地址，也不需要域名 |
| `cloudflare` | ChatGPT、Claude 及任何客户端 | 你自己域名上的 Cloudflare 命名隧道，DevMate 负责运行 `cloudflared`。免费 |
| `https` | 任何客户端 | 你已经在维护的反向代理 |
| `ssh` | 任何客户端 | OpenSSH 反向转发到你自己的服务器，由那里提供 HTTPS |

**Cloudflare 隧道**

1. 在 Cloudflare Zero Trust 里创建一条隧道，加一个公开主机名，例如 `devmate.example.com`，服务地址设为 `http://127.0.0.1:8789`。
2. 配置并保存令牌：

```powershell
devmate connect cloudflare --url https://devmate.example.com/mcp --executable "C:\Program Files (x86)\cloudflared\cloudflared.exe"
devmate secret set CLOUDFLARE_TUNNEL_TOKEN      # 粘贴令牌后回车；也可以用管道传入
devmate restart
devmate doctor
```

3. 把 `devmate mcp-url` 输出的地址作为自定义 MCP 连接器填进 ChatGPT 或 Claude。

**OpenAI 隧道**

在 OpenAI Platform 的组织设置里创建隧道，下载官方 `tunnel-client`：

```powershell
devmate connect openai-tunnel --tunnel-id tunnel_xxxxxxxx --executable C:\Tools\OpenAI\tunnel-client.exe
devmate secret set CONTROL_PLANE_API_KEY
devmate restart
```

`devmate mcp-url` 会输出隧道 ID；在 ChatGPT 里选择“隧道”连接类型并填入它。

**真的连通了吗**

隧道进程活着不等于通路可用。DevMate 会作为真正的 MCP 客户端从公网地址连回来，列出工具并调用一次，而且应答必须来自当前这个运行时；之后定期复查，断了就如实显示。`devmate doctor` 里 `connection.public` 一项为 `ok` 才算通。OpenAI 隧道没有公网地址可探测，需要从 ChatGPT 里实际调用一次工具来确认。

连接器启动失败不会拖垮本地使用，也不会被隐藏：`doctor` 和 `connection.status` 会给出原因。保存了新凭据后可以只重启连接器：`devmate connection.restart`。

## 谁能做什么

- **两个端口，两种信任。** 控制端口（默认 `127.0.0.1:8788`）只属于你：工作台、命令行、编辑器、本机上的 MCP 客户端。入口端口（默认 `8789`）只提供 MCP 和 OAuth，隧道和代理只能指向它；控制端口拒绝一切经过代理转发的请求。
- **共享什么，在你的电脑上决定。** 文件夹从编辑器、`devmate project add` 或本机工作台共享。连接进来的客户端不能共享文件夹，不能放宽只读，不能关闭凭据文件保护，也不能把你取消共享的文件夹带回来；它只能收紧。
- **可写就等于完全访问。** 在可写的项目里，客户端可以运行命令，而命令以你的系统账户运行。只要有一个项目是可写的，对其他文件夹的限制能让守规矩的模型不越界，但挡不住恶意的客户端。对不完全信任的客户端，只用只读共享：这时没有命令可运行，上面的限制才是真正的边界。DevMate 不是沙箱。
- **默认 `auth.mode` 是 `none`。** 能到达 MCP 地址的就是你。公网地址要像密码一样保密，或者启用登录。
- **可选的登录（OAuth）。** `devmate connect … --auth oauth` 要求公网地址的客户端登录：第一次连接时跳到 DevMate 的授权页，输入 `devmate login-code` 生成的一次性代码。还可以用 `auth.member.create` 创建只读或可写、限定到具体项目的身份。不公开自身说明（客户端元数据文档）的客户端，由你在配置的 `auth.clients` 里登记它的名字和回调地址。本机上的客户端始终不需要登录。
- **审批和提问由你在自己的电脑上回答。** Agent 请求批准时，你在编辑器或本机工作台里回答。任何连接进来的客户端都不能回答，包括派发这个任务的模型。
- **嫌这些碍事时：完全访问。** 默认的权限档是“受保护”（guarded），也就是上面这些规则。如果你主要在聊天客户端里干活、不想每次都回到电脑前，可以在自己的电脑上打开“完全访问”（full）：`devmate access full`，VS Code 里的 **DevMate: Change Permission Profile**，或 Obsidian 里的 **Permissions…**。之后，以你的身份连接进来的客户端可以共享文件夹、放宽权限、读取凭据文件、设置能力引擎、回答 Agent 的提问、运行体检；你派发的 Agent 请求的权限自动批准（每一次都留有记录）。它立即生效，只有你在自己的电脑上才能打开；`devmate access guarded` 随时收回。打开之后，能访问你 MCP 地址的人不经询问就能以你的身份做一切：请保管好地址，或者要求登录。登录的成员身份不受影响，仍然只有授予它的权限。
- **凭据类文件默认受保护。** `.env`、密钥文件、`.npmrc` 等不会被文件工具读取或列出内容；Git 状态里会列出它们的名字并标记“不要提交”。你可以在自己的电脑上对某个项目关闭这项保护。
- **命令行里的凭据不外显。** 进程列表和活动记录里，命令行中内联的令牌、密码会被替换成 `[redacted]`；实际执行的命令不变。这只识别常见写法，不是保证。
- **工作台的会话只留在它自己的浏览器标签页里。** 工作台通过一次性链接进入，会话从不以 cookie 形式存在，其他本机服务拿不到。
- 模型读到的文件内容、命令输出和网页内容都是数据，不是给模型的指令。

完整的策略和已知限制见 [SECURITY.md](SECURITY.md)。

## 模型可以用的工具

| 类别 | 工具 | 说明 |
| --- | --- | --- |
| 上手 | `project_overview` `project_list` | 一次返回 Git 分支与改动、项目自己的 Agent 指令（`AGENTS.md` 等）、可运行的脚本、顶层结构和编辑器报错数 |
| 编辑器 | `editor_diagnostics` `editor_context` | VS Code 已经算出的编译、类型和 lint 报错；你当前的文件、选区和打开的文件 |
| 找代码 | `workspace_files` `workspace_find` `workspace_search` | 目录列表、glob 查找、ripgrep 内容搜索。遵守 `.gitignore`，大仓库也快 |
| 读 | `workspace_read` | 带行号，大文件按行分页（32 MiB 以内）。UTF-16 和本机传统编码（如 GBK）可以读取，不能在这里改写 |
| 改 | `workspace_edit` `workspace_write` `workspace_mkdir` `workspace_move` `workspace_delete` | 精确文本替换，多处修改原子生效。覆盖已有文件必须带上读到的哈希，不会盲写 |
| 撤销 | `workspace_history` `workspace_restore` | 经 DevMate 改动、覆盖或删除的文件都能恢复，默认保留 30 天 |
| 运行 | `shell_run` `process_read` `process_write` `process_stop` `process_list` | 真实的 shell 语义（`npm test`、`git commit`）。输出按游标分页；长时间运行的命令在后台继续，可读输出、写标准输入、整棵进程树停止 |
| Git | `git_status` `git_diff` `git_log` `git_show` `git_blame` `git_branches` | 只读，不会执行仓库里配置的任何程序。写操作用 `shell_run` |
| 派发 | `agents_delegate` `agents_result` `providers_list` | 把整件任务交给本机的编码 Agent |
| 领域能力 | `capability_list` `capability_call` | 浏览器控制与 QA、Godot、逆向分析、Obsidian，以及你配置的外部 MCP 服务 |
| 其余操作 | `operations_list` `operations_call` `connection_status` | 工作流、任务、Agent 之间的消息、作业、产物和引用，按名字调用 |

- `projectId` 可以是项目 ID、项目根目录或唯一的项目名；只共享了一个项目时可以省略。有多个项目时，只读工具跟随你正在使用的编辑器窗口，写操作必须写明项目。
- 没有“共享文件夹”这个工具。那是你自己的事；模型会被告知请你去做。
- 模型只带着三十多个工具的定义，其余操作不占用对话上下文。
- 工具带有准确的提示（只读、写入、破坏性、对外），客户端只在真正需要时请求确认。
- 调用被取消或超时，只是不再等待：已经启动的命令或 Agent 任务继续运行，随后仍可读取或停止。
- 服务同时支持 2026-07-28 和 2025 年的 MCP 协议版本。
- 逆向分析引擎包含读取（以及可以写入）Windows 上其他进程内存的工具。两者默认关闭，只有你在自己的电脑上打开才生效（`allowProcessAccess`、`allowMemoryWrite`）；连接进来的客户端打不开。全部引擎见 [docs/CAPABILITIES.md](docs/CAPABILITIES.md)。

## 派发给本机的编码 Agent

一次调用即可把任务交给本机安装的 Codex、Claude Code、Gemini CLI 或 Grok CLI：

```json
{ "projectId": "Example", "provider": "claude", "prompt": "修复 tests/login.test.ts 里失败的用例并说明原因" }
```

- 任务在等待时间内完成就直接返回结果和改动的文件列表，否则返回 `agentId`，用 `agents_result` 继续等待。
- 再次传入同一个 `agentId` 会在原会话里继续，保留上下文。
- Agent 用它自己的账户、额度和工具在项目目录里工作。它向你提出的审批和提问出现在工作台，VS Code 和 Obsidian 会提醒你，由你在自己的电脑上回答。
- 同一家厂商内部的协作（Claude Code 会话之间互发消息、Codex 的子 Agent）由它们原生完成。DevMate 负责客户端之间这一段，例如从 ChatGPT 网页把任务交给本机的 Claude Code。

需要多个 Agent 在一个工作流里互相发消息、分配任务时，使用 `workflow.*`、`agents.*`、`message.*`、`task.*` 这组更细的操作，或者在工作台里操作。

## 工作台

`devmate ui --open` 在浏览器里打开工作台：项目、文件、改动、命令、编辑器报错、Agent 及其活动、消息、任务、审批、产物和引用。`open_devmate_workbench` 在支持 MCP Apps 的客户端（ChatGPT、Claude 等）里打开同一个界面；在那里它显示一切，但共享文件夹和回答 Agent 仍然要在你的电脑上做。

## 遇到问题

先运行 `devmate doctor`，它会指出具体哪一项不对以及怎么修。

| 现象 | 原因和处理 |
| --- | --- |
| `DevMate runtime is not running` | 运行 `devmate start`，或在编辑器里启动 |
| `Port 8788 … is already used by another program` | 换一个端口：`devmate start --port 8790`，或修改设置 `devMate.runtimePort` |
| `DevMate needs Node.js 24 or newer` | 安装 Node.js 24+，或在编辑器的 DevMate 设置里填它的可执行文件路径 |
| `Git … is too old` | 更新到 Git 2.41 或更高版本，然后重启 DevMate |
| 提示 PowerShell 5.1 没有 `&&` | 让模型改用 `;` 和 `if ($?) { … }`，或安装 PowerShell 7 后重启 DevMate |
| 模型说文件夹“由所有者在自己的电脑上共享” | 你自己来共享：在装有 DevMate 的编辑器里打开它，或运行 `devmate project add <文件夹>`。想让客户端自己能做这些事：`devmate access full` |
| 模型说某个项目只读，或某个文件夹被取消了共享 | 这是你在本机做过的决定。要改就在本机改：编辑器里的 **Change Folder Sharing**、`devmate project add`，或本机工作台 |
| 内嵌工作台里提示“Answer this on your computer”，或 Agent 一直在等批准 | 审批在本机回答：`devmate ui --open`，或编辑器里的提醒。打开 `devmate access full` 后会自动批准 |
| `rg was not found on PATH` | 按提示安装 ripgrep，然后 `devmate restart`；或者在 VS Code 里打开一次 DevMate，之后就用编辑器自带的那一份 |
| `The origin … is not allowed` | 这是一个浏览器端客户端：如果它是你自己运行的，把它的来源加进配置的 `allowedOrigins` |
| 云端客户端连不上 | 看 `doctor` 的 `connection.*` 几项；`devmate logs` 查看连接器输出 |
| 启动失败 | 错误信息里带原因；完整日志在实例目录的 `runtime.log` |

## 从 3.x 升级

4.0 从零开始。更新之后：

- 3.x 的任何东西都不会被读取：项目、连接和登录要重新设置。编辑器里的旧设置会被忽略；磁盘上的旧状态原样保留，可以删除。
- ngrok、Gateway 和 Runner 都没有了。云端客户端现在通过你自己的隧道进来，见[连接客户端](#连接客户端)。MCP 地址变了，要在 ChatGPT 或 Claude 里更新连接器。
- DevMate 不再内置 ngrok 支持。已有的 ngrok 固定域名仍然可以用，并且可以交给 DevMate 启动和看护：

  ```powershell
  devmate connect https --url https://<你的域名>/mcp --executable "C:\Tools\ngrok\ngrok.exe" --args "http {port} --url https://{host}"
  devmate restart
  ```

  `{port}` 是要转发到的本机入口端口（默认 8789，不是 8788），`{host}` 是公网域名。这个程序随连接启动，退出后自动拉起，随运行时停止。Tailscale Funnel、frp 等同理。
- 如果 3.x 的 Gateway 还在运行，它可能占着 8788 端口，4.0 会提示端口被占用。把所有编辑器窗口关一次，或结束旧的 `node` 进程，再启动。
- 模型看到的工具名变了；客户端刷新连接器后就会拿到新的。

## 卸载

卸载扩展或插件不会停止运行时，因为其他入口可能还在用它。先停止它（**Stop DevMate Runtime**，或 `devmate stop`），再卸载。DevMate 保存的一切都在实例目录里（默认 `~/.devmate/runtime`）：删除它就清除了状态、凭据和可恢复的文件版本。你的项目文件不会因此被动到。

## 数据保留

状态保存在实例目录的一个 SQLite 数据库里。事件日志、操作回执、已结束的作业和审批、可恢复的文件版本按 `retentionDays`（默认 30 天）自动清理。项目、工作流、消息和任务不会被清理。

## 兼容性

在 4.x 之内，下列内容视为公开接口：上面这些工具的名字和参数、操作名、配置键、命令行命令，以及工作台资源 `ui://devmate/workbench/v1`。其中任何一项的变化都会写进更新日志，改名时旧名字会继续可用一个次版本。有一项测试固定了工具的名字和参数，所以不会无意中改动。保存的状态带有格式编号：较旧的版本不会触碰较新版本写入的状态，并会说明涉及哪两个版本。4.x 不读取 3.x 的状态。

## 开发

```powershell
npm ci
npm run lint               # 只查真错误：未定义的名字、不可达代码等
npm run check              # 清单、版本一致、工作流动作固定到提交、语法
npm run test:unit          # 全部测试
npm run test:vscode-host   # 在真实的 VS Code 里运行扩展：两个编辑器加第三个窗口共用一个运行时
npm run candidate          # 构建一次，对打包产物做冒烟，把一次发布要发的全部内容写到 dist/release/
```

推送与 `package.json` 版本一致的 `X.Y.Z` 标签（不带 `v`）会验证该提交，并发布 GitHub Release 和 VS Code 市场版本。发布步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

| 目录 | 内容 |
| --- | --- |
| `runtime/` | 运行时：所有调用的统一入口与授权（`service.mjs`）、全部操作（`operations/`）、SQLite 状态（`store.mjs`）、MCP 层（`mcp.mjs`）、HTTP（`main.mjs`）、实例锁、命令与进程、文件与 Git、连接、Agent 适配器（`agents/`） |
| `runtime/engines/` | 浏览器、Godot、逆向等领域能力 |
| `runtime/platform/` | 进程树、路径、工具等底层辅助 |
| `workbench/` | 工作台，MCP App 与本机页面共用 |
| `vscode-host/` `obsidian-plugin/` | 两个宿主 |
| `tests/` `scripts/` | 测试；构建、检查、冒烟和打包脚本 |

每个操作只在 `runtime/operations/` 里定义一次，经 `runtime/service.mjs` 的注册表统一授权。MCP、命令行和工作台都从这里获得它。

## 文档

- [领域能力](docs/CAPABILITIES.md)：浏览器、Godot、逆向分析、Obsidian
- [安全策略](SECURITY.md)及已知限制
- [更新日志](CHANGELOG.md)
- [参与贡献与发布](CONTRIBUTING.md) · [支持](SUPPORT.md) · [行为准则](CODE_OF_CONDUCT.md)
- [4.0 审计台账](docs/AUDIT-4.0.md)：三轮复审发现了什么、修了什么、哪些没法验证

## 许可

[MIT](LICENSE)
