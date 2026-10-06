# Design Intent：项目设计意图

状态：**MVP 已实现并由包清单加载**。默认直接读取受信任的当前项目内固定 `.pi/design-intent.json`，不弹读取确认；可用 `--design-intent-read false` 禁用。项目根、符号链接、文件大小和格式校验仍生效；不自动读取 sources 引用的外部文档。项目写入只由显式用户审批执行。

负责项目长期 requirements、architectural invariants、关键设计决策及理由、被否决方案，以及 supersede / conflict / dependency 演化。设计与关键决策在本插件内统一管理，不再拆分。

- [完整设计](docs/design.md)
- [实现细节：存储、审批、查询、检查与测试](docs/implementation.md)
- [与 Rolling Context 的简短集成说明](docs/integration.md)
- [Rolling Context 设计](../rolling-context/docs/design.md)

项目级真相保存在项目文件中，须显式批准；会话中的临时选择不能自动成为项目设计。可用工具 `design_intent_query/get/propose/check`；命令 `/design-intent` 提供查询与审批。自然语言一致性检查目前只返回带证据的 `unknown`，不声称自动证明架构符合。

agent 提出提案时，有 UI 就立即显示 **Accept / Reject / Later**。Accept 再展示准确 diff 和文件副作用，确认后才提交；Later 或关闭提示保留候选；无 UI 只保存待审提案。**Reject 停止当前 agent 工作流，并在工具输出请用户用下一条普通消息说明理由**，不弹理由输入框、不写无理由的否决记录，也不回滚已执行的操作。需要长期记录否决及理由时，再使用 `/design-intent reject PROPOSAL reason` 确认写入。待审候选也可用 `/design-intent review PROPOSAL`、`/design-intent accept PROPOSAL` 处理。

加载、读取和仅保存提案都不创建 `.pi/design-intent.json`；第一次明确批准且成功的项目提交才创建该文件。显式带理由的 reject 命令也可能首次建库，即时 Reject 则不会。

即时 Accept 和命令共用同一审批提交函数；候选 hash、当前 branch、项目源版本、信任状态、取消信号和文件锁仍由扩展复核，daemon 不授权或写意图文件。普通 select/confirm 在本地 TUI 与网页具有相同业务效果，没有默认超时；pending 由 Pi 进程内 broker 持有，重连时同步，网络断线不会注入取消。代理支持范围见 [daemon 说明](../daemon/README.md#compatibility-and-limits)。
