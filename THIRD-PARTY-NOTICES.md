# 第三方组件与许可（THIRD-PARTY NOTICES）

本项目的自有代码以 MIT 许可发布（见 `LICENSE`）。其中有一处**派生内容**必须保留上游署名，
另有若干运行时依赖，一并列在这里。

## 1. dsh-gomoku —— 默认系统提示词与板块设计参考（MIT）

- 上游仓库：https://github.com/omdsh-dev/dsh-gomoku
- 用途：`src/shared/default-prompts.js` 中的默认系统提示词（规则说明、术语解释、棋盘文本格式、
  返回 JSON 格式与正反示例、强制思考流程）改写自该插件的默认提示词；五子棋板块的交互设计
  （15×15 无禁手、黑先白后、双 AI 对战、思考过程分侧展示、非法落子重试）也参考了该插件。
- 上游许可：MIT

```
MIT License

Copyright (c) 2026 dsh-external

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. 运行时与构建依赖

| 组件 | 版本 | 许可 | 说明 |
| --- | --- | --- | --- |
| Electron | 22.3.27 | MIT | 桌面运行时（Chromium + Node）；锁定 22.x 是为了兼容 Windows 7 |
| electron-builder | 26.15.3 | MIT | 仅构建期使用（devDependency），不进入安装包 |
| electron-builder 的传递依赖 | — | MIT / ISC / Apache-2.0 等 | 仅构建期使用，完整清单见 `package-lock.json` |

构建产物中**不包含**任何 GPL/AGPL 组件；**不包含**第三方字体、图片或音视频素材，
界面图标全部由 `tools/make-icon.js` 与本仓库内的 SVG 代码生成。

## 3. 模型服务

本软件是通用的大模型 HTTP 客户端，不捆绑任何模型服务，也不包含任何 API Key。
使用者需自行准备 API Key，并遵守对应服务商的条款（默认端点为 DeepSeek 官方 API）。
模型在演示过程中返回的文本（思考过程、落子理由）由使用者自行配置的模型服务生成，
不由本项目提供、也不对其内容负责。
