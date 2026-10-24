# Changelog

## 0.2.3

- 每条回答显示本次花费，底部显示当前会话累计花费
- 按官方价格精确计价：区分峰时/谷时、缓存命中/未命中输入与输出
- 支持人民币/美元切换（`deepseek.currency`）与汇率设置（`deepseek.usdToCny`）
- 解析接口返回的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`

## 0.2.2

- 侧边栏顶栏新增「切换文件」按钮：Quick Pick 选择已打开/工作区文件，默认保留侧边栏焦点
- 新增设置 `deepseek.keepFocusAfterFileSwitch`，可改为切换后聚焦编辑器
- 新增命令「DeepSeek: 切换文件（不离开侧边栏）」

## 0.2.1

- 移除旧模型 V3（`deepseek-chat`）与 R1（`deepseek-reasoner`）：下拉框、兜底列表和 `/models` 结果统一过滤
- 旧配置/历史会话里的旧模型名自动迁移到 `deepseek-flash`
- 去掉 reasoner 专用的 temperature 分支，保持请求逻辑单一

## 0.2.0

- 新增 DeepSeek V4 系列：`deepseek-flash`（V4.1 Flash）与 `deepseek-v4-pro`，默认使用 Flash
- 模型下拉框改为从 `/models` 动态拉取，支持手动补充网关模型；新增「刷新可用模型列表」命令
- V4 思考模式开关（侧边栏「深度思考」）+ 思考强度 `low/high/max`
- 兼容性：400 且报错指向 `thinking` / `temperature` 时自动去掉可选参数重试一次
- `maxTokens` 上限放宽到 384K

## 0.1.0

- 侧边栏 DeepSeek 工作台：多轮对话、流式输出、Markdown 与代码块操作
- 定点实时修改：选区 + 指令 → 实时 diff 预览 → 应用 / 重新生成 / 放弃
- 安全写入与撤销：文档版本校验、内容一致性校验
- 命令、右键菜单、快捷键、状态栏入口
- API Key 存入 VS Code 加密存储
- 会话持久化、历史管理、模型切换（chat / reasoner）
