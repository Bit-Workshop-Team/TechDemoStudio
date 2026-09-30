# 安全说明（SECURITY）

## 报告问题

发现安全问题时，请**不要**直接开公开 Issue，改用 GitHub 的
[私密漏洞报告](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
（仓库 → Security → Report a vulnerability）。收到后会尽快确认并给出修复计划。

请在报告里尽量附上：影响版本、复现步骤、是否需要本机交互、以及可能的后果。

## 本软件能接触到什么

一个本地桌面演示程序，正常使用时只涉及三类敏感数据：

| 数据 | 存放位置 | 保护方式 |
| --- | --- | --- |
| 大模型 API Key | `%APPDATA%\TechDemoStudio\config.json` 的 `apiKeyStorage` | Windows 上用 Electron `safeStorage`（DPAPI，绑定当前用户）加密后以 base64 密文落盘 |
| 配置项（模型名、暗码、节奏等） | 同一个 `config.json` | 明文 JSON |
| 对局数据 | 只在内存中 | 不落盘、不上报 |

其它事实：

- **不采集任何遥测 / 统计数据**，不写远程日志，没有回传接口；
- 网络请求只有一类：由**主进程**按你配置的 `Base URL` 直接请求该服务商的
  `POST {baseUrl}/chat/completions` 与 `GET {baseUrl}/models`；渲染进程通过 CSP
  `connect-src 'none'` 被禁止发起任何请求；
- 模型返回的文本一律通过 `textContent` 写入 DOM，不做 HTML 解析（避免把模型输出当代码执行）；
- 仓库里不含任何真实 API Key、账号、邮箱、内网地址或机器名；`config.json`、
  `shots/`、`e2e-out.txt` 等含运行痕迹的产物都在 `.gitignore` 中。

## 已知风险与取舍

这些是有意为之的取舍，请在部署前评估：

1. **Electron 22 已停止支持（EOL）**。为了让软件能在 **Windows 7 SP1** 上运行，
   必须使用 Chromium 108 这一代运行时（Electron 22 是最后支持 Win7 的版本线）。
   这意味着底层 Chromium 存在已公开但上游不再修复的 CVE。缓解措施：界面**完全离线**，
   只加载 `file://` 下的本地资源；已配置严格 CSP（禁内联脚本、禁远程连接、禁 iframe）；
   主进程只暴露白名单 IPC。**建议**：只在受控的演示机上运行，不要用它浏览网页或打开
   不受信任的 HTML/文件；如果不需要 Win7 兼容，请自行升级到受支持的 Electron 版本线。
2. **API Key 在极少数环境可能明文落盘**。当系统不支持 `safeStorage` 加密时
   （`safeStorage.isEncryptionAvailable()` 为 false），配置会退回 `{"encrypted": false, "plain": "..."}`
   保存，并会在控制台打印一条警告。这类机器上请自行保护用户目录权限，或改用低权限、
   可随时吊销的 Key。设置界面底部有「配置文件位置」按钮可直接查看该文件。
3. **设置界面会把 API Key 回显给渲染进程**（否则无法做「显示 / 修改」），并支持一键明文显示。
   这是本地单人应用的必要功能，但意味着：**任何能在这台机器上操作界面或读到屏幕的人都能拿到 Key**。
   DevTools 已在打包版本中默认关闭（仅开发模式或显式 `--dev` 时打开）。
   请为演示机使用独立的、额度受限的 Key。
4. **退出暗码（默认 `114514`）不是安全边界**。它只是防止现场观众误触退出全屏的
   便利手段：任务管理器结束进程、断电、注销都能绕过它。演示期间请把机器置于
   观众接触不到的位置，并建议在设置里改成只有自己知道的暗码。
5. **`Base URL` 由使用者填写**，主进程会按该地址发起请求（相当于本机请求任意地址）。
   这是「支持任意兼容 OpenAI 协议的第三方服务」所必需的能力，请只填写可信地址。
6. **安装包未做代码签名**（无证书），Windows SmartScreen 可能提示「未知发布者」。
   校验安装包完整性请用 Release 页面的 `SHA256SUMS.txt`。
7. 构建期的 `npm audit` 会报 `extract-zip` 的两个高危通告（经由 `electron` 的下载/解压流程）。
   它们只影响**构建机器**上的依赖安装（需要恶意构造的压缩包才能触发），
   Electron 22 已 EOL 且上游无修复版本，因此不升级、仅记录；发布产物本身不受影响。

## 加固建议（部署演示机时）

- 为演示机单独申请一个**额度受限、可随时吊销**的 API Key，不要复用主力 Key；
- 演示机使用非管理员账号运行（安装包默认 `asInvoker`，不需要管理员权限即可安装到用户目录）；
- 在需要长期无人值守的场景，配合系统的「自动登录 + 开机自启 + 组策略禁用任务管理器」使用；
- 定期到 Release 页面下载最新构建（`SHA256SUMS.txt` 校验），不要使用来历不明的二次打包。

## 支持的版本

只对仓库 `main` 分支上的最新提交和最新 Release 提供修复。历史安装包不再回补安全更新。
