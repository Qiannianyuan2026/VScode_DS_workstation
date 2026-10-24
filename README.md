# DeepSeek 工作台（VS Code 扩展）

在 VS Code 侧边栏里和 DeepSeek 对话：**选中一段代码，就能让它原地改、解释、补注释、写测试**。
定点修改会先在编辑器右侧打开**实时 diff 预览**，确认后才写进文件，一键可撤销。

```
VS Code 侧边栏 ── 提问 / 定点修改 ──► DeepSeek API
       ▲                                   │
       └──── 流式增量渲染 / 会话历史 ◄─────┘
编辑器选区 ──► 上下文打包（文件:行号、前后文、整份文件可选）
           ──► 右侧 diff 实时预览 ──► 应用 / 重新生成 / 放弃
```

## 功能

| 能力 | 说明 |
| --- | --- |
| 侧边栏工作台 | 活动栏 DeepSeek 图标 → 多轮对话、流式输出、Markdown 渲染、代码块一键复制/插入/替换 |
| 定点实时修改 | 选中代码 → `Ctrl+Alt+E` 输入要求 → 右侧 diff **边生成边刷新** → 应用 / 重新生成 / 放弃 |
| 提问与解释 | `Ctrl+Alt+A` 打开工作台并带上选区；右键菜单还有「解释选中代码」「补注释」「生成测试」 |
| 编辑安全 | 写文件前校验文档版本，生成期间文件被改动会拒绝覆盖；撤销前校验内容，避免误伤新改动 |
| 会话管理 | 多会话、自动标题、历史切换/删除、清空；对话持久化在 VS Code 全局存储 |
| 切换文件 | 侧边栏顶栏 📁 按钮 → 快速选择已打开文件或工作区文件，焦点默认留在侧边栏；不再需要点资源管理器 |
| 模型 | 下拉框从 `/models` 自动拉取，只保留 V4 系列；默认 `deepseek-flash`（V4.1 Flash），另有 `deepseek-v4-pro`（V4 Pro）；新模型上线不用改代码 |
| 思考模式 | V4 / Flash 可一键开关「深度思考」（`thinking.type`），强度 `low/high/max` 可配；思考过程折叠展示，旧模型自动隐藏该开关 |
| 上下文 | 选区 + 前后各 N 行、可勾选整份文件（超长自动截断）、文件路径与行号注入提示词 |
| 花费统计 | 每条回答显示本次花费，底部显示会话累计；按官方峰谷价与缓存命中计算，金额可切人民币/美元 |
| 隐私 | API Key 只存 VS Code `SecretStorage`（系统加密），不写设置、不进仓库、不出现在日志 |

## 安装

```powershell
# 1. 安装依赖并构建
npm install
npm run build

# 2. 打包成 vsix
npm run package

# 3. 安装到本机 VS Code（把路径换成实际输出）
code --install-extension .\deepseek-workbench-0.2.3.vsix
```

装好后重新加载窗口（命令面板 → `Developer: Reload Window`），活动栏会出现 DeepSeek 图标。

也可以直接按 `F5` 用开发模式启动（仓库内已带 `.vscode/launch.json`）。

## 首次使用

1. 命令面板执行 **DeepSeek: 设置 DeepSeek API Key**，粘贴 `sk-...`（也可点侧边栏右下角「未配置 Key」）。
2. 打开一个文件，选中几行代码。
3. 按 `Ctrl+Alt+E`，输入「改成 async/await，并补上错误处理」。
4. 右侧出现 diff 实时预览，选 **应用修改**；改坏了按 `Ctrl+Alt+Z` 撤销。

## 命令与快捷键

| 命令 | 快捷键 | 说明 |
| --- | --- | --- |
| DeepSeek: 定点修改选中代码 | `Ctrl+Alt+E` | 输入要求 → 实时 diff → 应用 |
| DeepSeek: 询问选中代码 | `Ctrl+Alt+A` | 打开工作台并带上选区 |
| DeepSeek: 解释选中代码 | — | 直接让模型解释 |
| DeepSeek: 为选中代码补注释 | — | 走定点修改，保持逻辑不变 |
| DeepSeek: 为选中代码生成测试 | — | 在对话里输出测试代码 |
| DeepSeek: 打开工作台 | `Ctrl+Alt+D` | 聚焦侧边栏 |
| DeepSeek: 切换文件（不离开侧边栏） | — | 快速选择文件；焦点留在侧边栏 |
| DeepSeek: 检查 API 配置与连通性 | — | 分开报告「没配 Key / 地址不合法 / 网络或鉴权失败」 |
| DeepSeek: 刷新可用模型列表 | — | 重新拉取 `/models`，新上线的模型会出现在下拉框 |
| DeepSeek: 撤销上一次定点修改 | `Ctrl+Alt+Z` | 安全撤销（内容不匹配会拒绝） |
| DeepSeek: 应用上一次定点修改 | — | 当时选了「放弃」但还想应用 |
| DeepSeek: 新建对话 / 清空历史 | — | 会话管理 |

> macOS 上把 `Ctrl` 换成 `Cmd`。

## 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `deepseek.model` | `deepseek-flash` | 默认模型；可手填任意网关模型 id |
| `deepseek.thinking` | `true` | V4 / Flash 默认开启思考模式（侧边栏可随时切换） |
| `deepseek.reasoningEffort` | `high` | 思考强度 `low` / `high` / `max` |
| `deepseek.extraModels` | `[]` | 手动补充模型 id，出现在下拉框 |
| `deepseek.apiBaseUrl` | `https://api.deepseek.com` | 兼容 OpenAI 协议的服务也可填入 |
| `deepseek.temperature` | `0.2` | 思考模式下 API 会忽略 |
| `deepseek.maxTokens` | `8192` | 单次回复上限（V4 最大 384K） |
| `deepseek.contextLines` | `30` | 选区前后附带行数 |
| `deepseek.maxFileChars` | `60000` | 附带整份文件时的截断阈值 |
| `deepseek.maxHistoryTurns` | `8` | 请求携带的历史轮数 |
| `deepseek.requestTimeoutMs` | `120000` | 请求超时 |
| `deepseek.confirmBeforeApply` | `true` | 改为 `false` 则生成后直接写入 |
| `deepseek.keepFocusAfterFileSwitch` | `true` | 侧边栏切换文件后焦点留在侧边栏；关闭则交给编辑器 |
| `deepseek.currency` | `CNY` | 花费显示货币：`CNY` 或 `USD` |
| `deepseek.usdToCny` | `7.2` | 人民币展示用的美元汇率（只影响显示） |
| `deepseek.extraSystemPrompt` | 空 | 追加自定义要求（团队规范等） |

## 原理要点

- **流式**：`src/core/client.ts` 用 `fetch` + `ReadableStream` 增量读取，`sse.ts` 解析 `data:` 帧；每 50ms 节流刷新一次界面，避免长文卡顿。
- **定点**：`prompt.ts` 把选区连同行号、语言、上下文打包，要求模型**只输出替换代码**；`edit.ts` 从回复里剥掉围栏/说明，并按原文缩进对齐。
- **实时预览**：`preview.ts` 注册 `deepseek-preview:` 虚拟文档，`vscode.diff` 左侧是真实文件、右侧是虚拟文档，生成过程中持续 `onDidChange` 刷新。
- **安全**：应用前比对 `document.version`；撤销前用 `matchesApplied` 确认文件仍是模型写下的内容。
- **模型**：`models.ts` 负责展示名与思考能力判定，并从下拉框、兜底列表、`/models` 结果里统一过滤 V3/R1 旧模型；启动和配置变更时拉取 `/models`，拉不到就用内置兜底；`client.ts` 在 400 且报错指向 `thinking`/`temperature` 等可选参数时自动去掉重试一次，兼容不支持这些参数的网关。
- **花费**：`pricing.ts` 内置官方美元价（峰时/谷时、缓存命中/未命中/输出），用接口返回的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 精确计价；按消息时间判断峰谷，会话累计由每条消息的花费相加；人民币只是按汇率换算的展示值。

## 目录结构

```
src/core/     纯逻辑（SSE、客户端、提示词、改写、Markdown、会话存储），可单测
src/vscode/   VS Code 集成（视图、聊天中枢、上下文、diff 预览、命令、Key 存储）
media/        Webview 的 HTML/CSS/JS 与图标
test/         核心单测 + 基于 vscode 桩的端到端测试
scripts/      零依赖的 vsix 打包脚本
```

## 开发

```powershell
npm run build      # tsc 编译到 dist/
npm run typecheck  # 只做类型检查
npm test           # 编译 + 核心单测 + 端到端测试
npm run package    # 生成 .vsix
```

测试分六组：`core`（纯逻辑）、`client`（SSE、思考参数、缓存用量与错误映射）、`models`（模型识别）、`pricing`（峰谷价与花费计算）、`integration`（用自制的 `test/vscode-stub.js` 替换 `vscode` 模块，验证激活、模型发现、流式问答、花费、diff 预览、写入与撤销）、`webview`（用 jsdom 真正执行 `media/workbench.js`，验证渲染与交互）。所以不启动 VS Code 也能覆盖整条链路。

## 已知限制

- 只支持单文件选区内的修改；跨文件重构只在对话里给建议（模型会以注释说明需要同步改哪里）。
- 一次只保留最近一次修改的撤销记录（多次修改请用编辑器自带的撤销栈）。
- 走系统代理时需自行保证 Node 的 `fetch` 能出网（VS Code 的代理设置不会自动作用于扩展）。
- 未实现自定义 HTTP 代理与多账号切换；`apiBaseUrl` 可指向兼容 OpenAI 协议的网关。
- 花费是按官方牌价与接口用量估算的参考值：人民币按设置汇率换算，中国法定节假日未从峰时里排除，实际以平台账单为准。

## 排障

先运行命令 **DeepSeek: 检查 API 配置与连通性**。它会把三类问题分开报：没配 Key、地址不合法、网络或鉴权失败。详细日志在「输出」面板的 **DeepSeek 工作台** 通道里（同时落盘到 VS Code 日志目录）。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `网络请求失败：Failed to parse URL from sk-...` | 把 API Key 填进了 `deepseek.apiBaseUrl` | 设置里把 API 地址改回 `https://api.deepseek.com`，Key 只用命令保存 |
| `API Key 无效或已失效`（401） | Key 填错、被删除或已撤销 | 重新执行「设置 DeepSeek API Key」 |
| `网络请求失败：ENOTFOUND / ECONNREFUSED / 证书错误` | DNS、代理或证书问题 | 按括号里的底层原因排查；扩展不会自动读取系统代理设置 |
| `请求超时` | 网络慢或回复太长 | 调大 `deepseek.requestTimeoutMs` |
| 下拉框里没有 V4 / Flash | 模型列表没拉到（Key 未配置或 `/models` 失败） | 配好 Key 后执行「刷新可用模型列表」；仍失败会在日志里给出原因 |
| 还需要 V3 / R1 | 0.2.1 起已移除这两个旧模型，旧配置会自动迁移到 `deepseek-flash` | 如确需旧模型，请回退到 0.1.x 版本 |

> 扩展只会把 `sk-...` 形式的密钥从错误提示里脱敏，但配置文件和 VS Code 本地历史仍可能留下明文，所以不要把 Key 写进设置项，泄露后及时在平台撤销。

## 反馈

代码都在 `D:\DS_work`，改完 `npm run package` 重新安装即可。
