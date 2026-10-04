# Rolling Context × Design Intent

```text
User request
    ↓
Design Intent 提供相关 requirements / invariants / decisions
    ↓ 只读、带项目来源和版本的投影/引用
Rolling Context 执行当前任务，维护 task-decision 和执行状态
    ↓ 必要时提供实际修改范围/证据
Design Intent 检查是否违背已批准意图
```

- **单一来源**：Design Intent 的项目文件维护长期真相；Rolling Context 只缓存相关 ID、版本和短投影，不复制演化关系或批准状态库。
- **低耦合**：使用 `design_intent_query/get/check` 的普通工具结果及标记过的入口投影；不共享内部模块、数据库或依赖事件总线。查询/展开由 agent 调用，Rolling Context 不直接执行另一插件的内部逻辑。
- **检查点**：分开显示「相关 Design Intent」和「当前任务执行决策」。源版本不明/已变时重新 query；刷新未完成则旧投影标为历史/待核验，不称为当前真相。
- **禁止自动晋升**：`context_note`、task-decision、代码修改和测试结果都不能覆盖/supersede intent；变更必须另提案并由用户批准。
- **检查结果只是证据**：违背意图时修复实现或请求修改 intent；报告不更新设计，也不把“未发现违背”当完整证明。
- **可独立运行**：没有 Design Intent 时 Rolling Context 按原设计工作；没有 Rolling Context 时 Design Intent 正常查询/审批。不可用不是“没有约束”。

详见 [Rolling Context design](../../rolling-context/docs/design.md) 与 [Design Intent design](design.md)。

实现细节分别见 [Rolling Context implementation](../../rolling-context/docs/implementation.md) 与 [Design Intent implementation](implementation.md)。
