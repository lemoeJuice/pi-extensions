# Design Intent：项目设计意图

状态：**设计阶段，尚未实现或启用**。

负责项目长期 requirements、architectural invariants、关键设计决策及理由、被否决方案，以及 supersede / conflict / dependency 演化。设计与关键决策在本插件内统一管理，不再拆分。

- [完整设计](docs/design.md)
- [实现细节：存储、审批、查询、检查与测试](docs/implementation.md)
- [与 Rolling Context 的简短集成说明](docs/integration.md)
- [Rolling Context 设计](../rolling-context/docs/design.md)

项目级真相保存在项目文件中，须显式批准；会话中的临时选择不能自动成为项目设计。当前仅有文档，没有 `index.ts`，未加入根包加载配置，文档中的接口均为拟议功能。
