# 待补功能（按顺序做，一次一个）

记录的是**已经确认是缺口、但还没做**的东西。每条都带证据，避免下次重新论证一遍。
做完一条就把它移到底部的「已完成」，并在 `FIELD-NOTES.md` 里补该缺陷的教训。

约定：一次只动一条；改完按 `AGENTS.md` 的验证清单跑一遍，再合进 `main`。

---

## P0

### 1. 会话标题透传（Paseo → DSH）

**现象**：`dsh web` 的会话列表里，Paseo 里跑出来的会话全是「未命名」，或者标题是
`<chat-history-summary> Chat history from…` 这种原始首条消息的截断。

**证据**：`ProviderSessionConfig.title` 在 `paseo-plugin/server/*.ts` 中 0 处引用；
DSH 侧的会话头（`session.v4.jsonl.zstd` 首行）没有 title 字段，标题是投影里
`rows.title.val` 由首条 user message 推出来的。

**做法**：先确认 DSH 运行时有没有设置会话标题的接口（`paseo/session` 协议或
`sessionTitle` 服务）。有就透传；没有就退一步——在导入/新建时把 Paseo 的 title 作为
首条系统旁注写入，或干脆不提，避免制造假标题。

**验收**：在 Paseo 里新建一个带标题的 agent，`dsh web` 对应会话显示同一个标题；
关闭 Paseo 标题时不产生 `chat-summary` 这类噪音。

### 2. 失败重试在时间线上可见

**现象**：模型调用失败重试时，界面上没有任何痕迹；连续失败最终报错，用户只看到一条空
`[error]`。

**证据**：`assistant/attempt` 事件被丢弃（`FIELD-NOTES.md` 已知限制第 1 条）。

**做法**：不逐条显示 attempt，只在同一回合内**连续 ≥2 次 attempt** 时折叠成一行
「重试中（第 N 次）」；用户主动取消不产生该行（这是当初不敢加的原因）。

**验收**：手工制造一次重试（例如临时改错 key 再改回）时时间线出现折叠行；点取消不出现。

---

## P1

### 3. MCP 服务器共享

**现象**：Paseo 给 agent 配的 MCP 服务器传不到 DSH；DSH 自己的 MCP 也不出现在 Paseo 侧。

**证据**：`ProviderSessionConfig.mcpServers` / `toolPolicy` 在插件里 0 处引用。

**做法**：需要 DSH 侧支持按会话注入 MCP；先确认 DSH 的 MCP 挂载方式（插件配置 or
运行时接口），再决定是"启动时写 profile patch"还是"会话级注入"。

**验收**：在 Paseo 里给 agent 加一个 MCP server，DSH 会话里能调用其工具；反向能在
Paseo 看到 DSH 已挂载的 MCP。

### 4. 结构化输出（`outputSchema`）

**证据**：`ProviderPrompt.outputSchema` 0 处引用。

**做法**：把 schema 透传给 DSH 的请求投影，拿回结构化结果；DSH 不支持时**响亮失败**，
不要静默忽略。

**验收**：带 schema 的调用返回可校验 JSON；不支持时收到明确错误。

### 5. 时间线补齐 compaction / goal / 权限事件

**现象**：`/compact` 压完，界面看不到「压了多少、释放多少 token」；goal 变化、权限切换
也没有记录。

**证据**：时间线只映射 13 种会话事件里的 4 种（`timeline.ts` 的 `consume`）。

**做法**：优先 compaction（有明确的 `compaction/start` 与 `compaction/summary` 事件），
映射成一条折叠的系统行。

**验收**：手动 `/compact` 后时间线出现一条「压缩 N 条，释放 M token」。

### 6. 会话回退 / 检查点

**证据**：`revert` 在插件里 0 处引用。

**做法**：先看 DSH 有没有"回退到某条消息"的能力；没有就明确在 README 写"不支持回退"，
不要留一个点了没反应的按钮。

---

## P2

### 7. catalog 缓存

**现象**：每次打开模型选择器都要 spawn 一个 `dsh` 子进程，并轮询最多 3 秒等异步物化。

**做法**：实现 SDK 契约里的 `getCatalogCacheKey`（按 profile + 配置指纹缓存），
配合短暂 TTL。

### 8. 桥的自动断言与 CI

**现象**：`dsh-bridge/lib/server.js` 848 行没有单测；仓库没有 CI，验证全靠本机手跑。

**做法**：至少给协议映射（事件 → 时间线项、usage、目录）建立快照测试；CI 跑
`tsc --noEmit` + `plugin-check`（隔离 profile）。

### 9. 成本显示（需要单价，暂缓）

**现象**：Paseo 的 `totalCostUsd` 恒为 0。

**证据**：DSH 只提供 token 分桶，没有 USD 投影；要显示金额必须自带价目表，而
`AGENTS.md` 禁止硬编码具体模型信息。**结论：除非 profile 里能配单价，否则不做。**

### 10. Windows 兼容

桥里有 bash 路径与输出编码假设，未在 Windows 上验证过。

---

## 已完成

- **上下文占用**（`contextWindowUsedTokens` / `MaxTokens`）——`f67be46`，见
  `FIELD-NOTES.md` 第 21 条。分子在事件流里、分母在模型目录里，两层都要改。
- **自动压缩阈值 400k**——运行配置（`~/.dsh/profiles/paseo/cordis.patch.yml`），不入库。
- **手动压缩**——`/compact` 已可用，走 `dsh-command-compact`，不受阈值限制。
