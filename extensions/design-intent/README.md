# Design Intent：项目设计意图

状态：**MVP 已实现并由包清单加载**。读取需项目受信任，并在会话中明确授权，或启动时传入 `--design-intent-read`。项目写入只由显式用户审批命令执行。

负责项目长期 requirements、architectural invariants、关键设计决策及理由、被否决方案，以及 supersede / conflict / dependency 演化。设计与关键决策在本插件内统一管理，不再拆分。

- [完整设计](docs/design.md)
- [实现细节：存储、审批、查询、检查与测试](docs/implementation.md)
- [与 Rolling Context 的简短集成说明](docs/integration.md)
- [Rolling Context 设计](../rolling-context/docs/design.md)

项目级真相保存在项目文件中，须显式批准；会话中的临时选择不能自动成为项目设计。可用工具 `design_intent_query/get/propose/check`；命令 `/design-intent` 提供查询与审批。自然语言一致性检查目前只返回带证据的 `unknown`，不声称自动证明架构符合。
