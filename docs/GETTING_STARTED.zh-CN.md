# 上手教程：让 ChatGPT 在你的电脑上干活

[English](GETTING_STARTED.md) | [简体中文](GETTING_STARTED.zh-CN.md)

这份教程带你从零走到“在 ChatGPT 网页里说一句话，它就读你的项目、改文件、跑测试”。照着做大约十五分钟。每一步都写了做完应该看到什么；看到的不一样，就先停在那一步，翻到最后的[卡住了怎么办](#卡住了怎么办)。

接 Claude.ai 的步骤一样，只有第 4 步填地址的位置不同。只想让同一台电脑上的 Claude Code 或 Codex 用 DevMate，做完第 2 步就够了，见 [README](../README.zh-CN.md#同一台电脑上的客户端)。

## 你需要什么

- 一台 Windows、macOS 或 Linux 电脑，上面有你的项目。
- [Node.js](https://nodejs.org) 24 或更高，[Git](https://git-scm.com) 2.41 或更高。
- 一个能添加自定义 MCP 连接器的 ChatGPT 或 Claude 账号。哪些套餐能改文件、哪些只能读，由它们决定，见 [你的套餐允许什么](../README.zh-CN.md#你的套餐允许什么)。
- Windows 上建议先装 PowerShell 7：`winget install --id Microsoft.PowerShell --source winget`。模型习惯把两条命令用 `&&` 连起来，系统自带的 PowerShell 5.1 不认这个写法。装不装都能用，DevMate 找到 7 就自动用 7。

## 第 1 步：装上 DevMate

选一种就行，以后可以再加别的入口，它们共用同一个运行时。

- **用 VS Code**：在扩展视图里搜索 **DevMate** 并安装。
- **只用命令行**：从 [Releases](https://github.com/Kukutx/DevMate/releases) 下载 `devmate-cli-<版本>.tgz`，运行 `npm install -g ./devmate-cli-<版本>.tgz`。

装完检查一遍：

```powershell
devmate doctor
```

应该看到一串 `[ ok ]`，最后一行是 `DevMate <版本>: …`。此时说“运行时没有运行”是正常的，下一步就启动它。出现 `[FAIL]` 的那一行，下面的 `->` 写着怎么修。

## 第 2 步：启动，并共享一个项目

DevMate 只让模型碰你明确共享出去的文件夹。

**用 VS Code**：打开你的项目文件夹，按 `Ctrl+Shift+P`，运行 **DevMate: Start DevMate Runtime**。这个文件夹会以读写方式共享，窗口会提示一次。底部状态栏出现一个插头图标和 **DevMate**。

**用命令行**：

```powershell
devmate start
devmate project add C:\Projects\MyApp
devmate project list
```

`project list` 里应该能看到你的项目，`access` 是 `write`。只想让模型看、不让它改，就在 `project add` 后面加 `--read-only`。

到这里，同一台电脑上的客户端已经可以用了。

## 第 3 步：给 ChatGPT 一条到你电脑的路

ChatGPT 在云端，它要有一个能从外面访问到你电脑的地址。先用最省事的一种试通，以后再换成长期用的。

| 你的情况 | 用哪一种 | 特点 |
| --- | --- | --- |
| 先试试看 | 快速隧道 | 什么都不用注册。DevMate 重启、更新时地址不变；**电脑重启或停止 DevMate 之后地址会变**，变了就要在 ChatGPT 里重新添加一次 |
| 只用 ChatGPT，账号能登录 OpenAI Platform | OpenAI 隧道 | 隧道 ID 永远不变，不经过第三方。只有创建隧道的那个账号的 ChatGPT 能用 |
| 长期用，有自己的域名 | Cloudflare 隧道 | 地址永远不变，可以加登录。域名的 DNS 要由 Cloudflare 管理 |
| 长期用，有自己的服务器 | 自己的中继 | 地址不变，中间没有任何第三方 |

**快速隧道**（教程接下来用它）。先装 Cloudflare 的小程序 `cloudflared`：Windows 上 `winget install Cloudflare.cloudflared`，macOS 上 `brew install cloudflared`。然后：

```powershell
devmate connect quick
devmate restart
devmate doctor
```

在 VS Code 里可以改用 **DevMate: Configure Connection**，它会一步步问你。

`doctor` 里这一行是 `[ ok ]` 才算通了：

```
[ ok ] connection.public: https://<一个名字>.trycloudflare.com/mcp/<key> reaches this runtime
```

刚启动的十几秒里它可能还在等地址生效，再运行一次 `doctor` 就好。

其余三种的做法见 [README 的“连接客户端”](../README.zh-CN.md#chatgpt-网页版和-claudeai)。

## 第 4 步：把地址交给 ChatGPT

**先复制地址。** 三种办法给出的是同一个地址：

- VS Code：点底部状态栏的 **DevMate**，选 **Copy MCP URL**。
- 浏览器扩展：点 DevMate 图标，点 **Copy the MCP address**。
- 命令行：`devmate mcp-url`。

> **这个地址要像密码一样对待。** 快速隧道没有登录，地址最后那一段密钥就是唯一的锁：拿到完整地址的人能读写你共享的项目、在你的电脑上运行命令。只把它粘贴进你自己的 ChatGPT 或 Claude，不要发到聊天群、截图或工单里。`devmate doctor` 显示的地址是不带密钥的，可以放心贴。

**在 ChatGPT 里添加。** 下面是 2026 年 10 月的界面，按钮上的字随界面语言和版本会有出入，位置和顺序是一样的：

1. 打开 `chatgpt.com/plugins`。
2. 点“添加”，选“添加自定义 MCP 服务器”。
3. 名字填 `DevMate`。
4. “服务器地址”里粘贴刚才复制的地址。
5. “认证”选“无认证”。（给通路加了登录的话选 OAuth，见 README。）
6. 勾上那个表示你了解风险的确认框。
7. 点“创建为插件”，再点“连接”。

连接成功后，ChatGPT 会列出 DevMate 提供的工具。想让它不必每用一个工具都问你一次，在这个插件的设置里把“授权”改成允许全部工具；保持默认也可以，它会在改东西之前问你。

**在 Claude.ai 里添加**：设置里的连接器（Connectors）→ 添加自定义连接器 → 粘贴同一个地址。

确认它真的连上了：

```powershell
devmate doctor
```

`client` 那一行会写着最近连上来的客户端是谁、什么时候。

## 第 5 步：第一次对话

新开一个对话，确认 DevMate 插件在这次对话里是启用的，然后一句一句试：

1. `给我一个项目概览。` 它会调用 `project_overview`，告诉你分支、改动、技术栈和能跑的脚本。
2. `在项目里搜 TODO，列出前十条。`
3. `运行测试，告诉我哪些失败了。`
4. `修掉第一个失败的测试，改完再跑一遍。` 这一步它会改文件。每一处改动都可以撤回：让它“把刚才的改动撤回”，或者自己看 `devmate ui --open` 里的 Changes。
5. 装了 DevMate 的浏览器扩展的话：`列出我浏览器现在打开的标签页。`

模型看到的是你共享的项目，别的文件夹它碰不到。它运行的命令是以你的系统账户在你的电脑上真的运行的。

## 第 6 步：它想让别的 Agent 干活时，你来点头

ChatGPT 可以把一整件任务交给你电脑上装的 Codex 或 Claude Code。那花的是你在它们那边的账户和额度，所以默认每个任务都先问你：ChatGPT 会说“the owner has to allow this task at their computer first”，任务停在那里，什么都还没运行。

在你的电脑上回答：

- 编辑器会弹出提醒；
- 或者打开工作台：`devmate ui --open`，在 **Approvals** 一页。那里显示任务的原文、用哪个 Agent 和模型，可以允许这一次、允许并在这个 Agent 断开前不再问、或者拒绝。

不想每次被问：`devmate delegation allow`。完全不让客户端派任务：`devmate delegation off`。这两条只能在你自己的电脑上执行，连进来的客户端改不了。

## 每天怎么用

- **运行时一直在后台。** 关掉 VS Code 或终端不会停掉它。要停：`devmate stop`。
- **DevMate 更新或你重启了运行时之后**：什么都不用做，快速隧道也一样：隧道一直在跑，地址不变。
- **电脑重启、注销，或你停止了 DevMate（`devmate stop`、编辑器里的停止）之后**：用快速隧道的话地址变了，第 4 步要重做一次（2026 年 10 月时 ChatGPT 不能修改已有插件的地址，只能新建一个；旧的那个卸载掉，名字被占着的话先给旧的改名）。这是快速隧道的性质。不想重做，就换成第 3 步表格里另外三种地址固定的通路。
- **换一个项目**：在 VS Code 里打开那个文件夹并运行 **DevMate: Change Folder Sharing**，或 `devmate project add <文件夹>`。共享了不止一个项目时，在对话里告诉模型你说的是哪一个。
- **看它做过什么**：`devmate ui --open` 打开工作台。

## 安全上要知道的三件事

1. **地址就是钥匙。** 没开登录时，能访问地址的人就是“你”。
2. **可写就等于能在你电脑上运行命令。** DevMate 不是沙箱。对不完全信任的客户端，只用只读共享。
3. **默认是“受保护”档**：共享文件夹、读取 `.env` 这类凭据文件、回答 Agent 的提问，都只能你在自己的电脑上做。嫌麻烦可以 `devmate access full` 把这些交给连进来的客户端，随时可以 `devmate access guarded` 收回。打开完全访问又没有登录时，请格外保管好地址。

完整的规则在 [SECURITY.md](../SECURITY.md)。

## 卡住了怎么办

先运行 `devmate doctor`。它逐项检查，并在每个有问题的项目下面用 `->` 写出怎么修。

| 你看到的 | 怎么办 |
| --- | --- |
| ChatGPT 连接时报错，或工具列表是空的 | `devmate doctor` 看 `connection.public` 是不是 `[ ok ]`。不是的话地址没通：等十几秒再试，或 `devmate restart` 后重新复制地址 |
| 昨天还好好的，今天 ChatGPT 说连不上 | 用的是快速隧道，电脑重启过或 DevMate 停止过，地址变了（`devmate doctor` 会说地址从什么时候起没变过）。重做第 4 步 |
| ChatGPT 能读不能改 | 你的套餐对自定义连接器只允许读，或者项目是只读共享的。`devmate project list` 看 `access` |
| 模型说文件夹要“由所有者在自己的电脑上共享” | 你来共享：在装了 DevMate 的编辑器里打开它，或 `devmate project add <文件夹>` |
| 模型说“the owner has to allow this task at their computer first” | 见第 6 步 |
| 命令报错说 `&&` 不是有效的语句分隔符 | 命令跑在 PowerShell 5.1 里。装 PowerShell 7 后 `devmate restart` |
| `DevMate … is still running, older than this command` | 更新之后运行时还是旧的：`devmate restart` |
| 浏览器扩展说连不上 DevMate | 先 `devmate start`。还是不行，运行 `devmate chrome`，它会说浏览器有没有登记、有没有连上 |

要报告问题：`devmate doctor --report` 会生成一份去掉了凭据、路径、账户名和地址的报告，发出去之前请自己再看一遍。

更多内容：[README](../README.zh-CN.md) 是完整的参考，[现状](STATUS.md) 如实列出了哪些验证过、哪些没有。
