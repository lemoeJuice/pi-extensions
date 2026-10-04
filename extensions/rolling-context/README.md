# Rolling Context：滚动式上下文管理

状态：**MVP 已实现并由包清单加载**。首次仍为 `observe` 模式；需要传入 `--rolling-context-mode on` 才启用自动投影编辑。原生 compact 保持开启。

目标是把模型上下文从不断增长的会话日志，改为「可验证的工作状态 + 最近执行窗口 + 按需召回」，在保留原始历史的同时，逐步移出已经消费、过时或低价值的内容。这里只管理当前任务的执行记忆，`task-decision` 不会自动成为项目设计事实。

完整方案见 [`docs/design.md`](docs/design.md)，包括 pi API 可行性、记忆结构、淘汰策略、预算、恢复机制和分阶段实现计划。

具体模块接口、状态格式、回合规划、提交恢复与测试见 [`docs/implementation.md`](docs/implementation.md)。

项目级长期设计由独立的 [Design Intent](../design-intent/README.md) 管理；两者边界见[简短集成说明](../design-intent/docs/integration.md)。

可用工具：`context_note`、`context_recall`。可用命令：`/rolling-context status|inspect|on|off|observe|pin|unpin|checkpoint`。MVP 不启用小模型提取；面对未覆盖上下文、图片、未知扩展消息或不安全 checkpoint 时保守回退。功能边界详见 [`docs/implementation.md`](docs/implementation.md)。
