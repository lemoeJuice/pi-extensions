# Rolling Context：滚动式上下文管理

状态：**MVP 已实现并由包清单加载**。首次仍为 `observe` 模式；需要传入 `--rolling-context-mode on` 才启用自动投影编辑。原生 compact 保持开启。

Design Intent 可选契约在 `session_start`（runtime 就绪后）校验，不在扩展 factory 加载时查询工具。provider 缺失允许独立运行；发现不兼容 provider 则报告错误，并在上下文改写和 checkpoint 执行边界再次校验，停止 Rolling 改写而保留原生 compact。

目标是把模型上下文从不断增长的会话日志，改为「可验证的工作状态 + 最近执行窗口 + 按需召回」，在保留原始历史的同时，逐步移出已经消费、过时或低价值的内容。这里只管理当前任务的执行记忆，`task-decision` 不会自动成为项目设计事实。

完整方案见 [`docs/design.md`](docs/design.md)，包括 pi API 可行性、记忆结构、淘汰策略、预算、恢复机制和分阶段实现计划。

具体模块接口、状态格式、回合规划、提交恢复与测试见 [`docs/implementation.md`](docs/implementation.md)。

项目级长期设计由独立的 [Design Intent](../design-intent/README.md) 管理；两者边界见[简短集成说明](../design-intent/docs/integration.md)。

可用工具：`context_note`、`context_recall`。可用命令：`/rolling-context status|inspect|on|off|observe|pin|unpin|checkpoint`。MVP 不启用小模型提取；面对未覆盖上下文、图片、未知扩展消息或不安全 checkpoint 时保守回退。功能边界详见 [`docs/implementation.md`](docs/implementation.md)。

在 TUI 输入 `/rolling-context ` 可看到子命令补全与说明；`/rolling-context help` 显示完整帮助。
`status` 查看状态（无参数时默认执行）；`inspect` 查看连续性摘要及条目 ID；
`on` 启用后续自动维护，`observe` 仅观察，`off` 停止后续 Rolling 改写（都不回滚已有 edits/checkpoints）；
`pin ITEM_ID` / `unpin ITEM_ID` 固定或解除固定当前分支条目，ID 从 `inspect` 获取；
`checkpoint` 等待 idle 并人工确认，随后验证覆盖和净节省再请求 compact。

`/rolling-context checkpoint` 的人工确认可在 Pi 本地界面或 Remote session 网页完成；网页不在目标 session 时请求会保持排队，进入对应页面后重放。该确认没有等待超时，Pi 会在收到批准后复核 session branch 与待处理消息，再启动 compact。

默认 hot→warm 批次至少间隔 4 个完整 turn，累计节省 2048 估算 tokens；checkpoint 与普通 warm 最短驻留为 16 turn。可用 `--rolling-context-warm-interval`、`--rolling-context-batch-saving`、`--rolling-context-checkpoint-interval` 调整。先 preview after-warm 再判断 checkpoint；高缓存命中时普通收益门槛翻倍。已有 capsule 不重复摘要。

每个 completed turn 保存不进模型 context 的 telemetry（observe/off 也记录）。现有 daemon 的 session 页面点击 **Context Graph**，或访问 `/s/<sessionId>/context`，查看 context size、composition、stateBytes 及事件标记。未知 usage 不猜为 0；图表 token 数为宿主估算。自己的 checkpoint 收起的来源可按需召回，但不撤销 foreign compaction 或其他插件的隐藏/脱敏。
