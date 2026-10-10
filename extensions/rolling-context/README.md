# Rolling Context · projection v2

Rolling Context 默认 `on`，是透明的 semantic context cache。Raw session 是完整 evidence log；正常 aging 只改变每次模型请求的 projection，不产生 `context_edit` 或 Rolling compaction，不需要主 agent 调用任何维护工具。

每个 source 独立保持 `EXACT / CAPSULE / COLD`，并区分 `desiredRepresentation` 与 `committedRepresentation`。模型输入保持 chronology，在原位置替换 capsule。Cold 工具结果只保留短来源 ref 和协议配对，原文仍可 `context_recall`。图片、未知格式或压缩失败只让对应 source 留 exact，不阻塞其他来源。

272k 是缺省容量上限，实际优先使用当前模型窗口，扣除 output reserve 和 safety margin。没有固定 32k target，也没有 checkpoint cadence / blocked 生命周期。低 occupancy 以经济性选择 mutation frontier；高 occupancy 提高 aging 紧迫程度。一次 batch 只估算一次最早 mutation 后的 KV suffix 成本。

正常命令：`/rolling-context status|on|off|observe|inspect`。`on` 应用 committed representations，`observe` 只观察候选，`off` 使用宿主原有 projection；两者不会撤销 legacy edits/native compactions。新 session 自动启用；旧版本由命令写入的明确 off/observe 继续有效，旧默认值不产生永久 observe 锁定。

Daemon session 的 **Context Graph** 页面提供 **Graph | Projection**。Graph 保留 Turn 0、completed turns、provider usage、事件日志和 inspector，增加 resident composition、generation、frontier、KV invalidation 与 break-even。Projection 提供 **Rendered** 和 **Mapping / Diff**，读取真正 `context_with_system` hook 输出的快照，用来源/hash/representation 重建并逐消息校验，不重新运行 planner。`Recall raw` 遵守当前 branch 的 redaction/compaction 授权。

Generic reducer 优先做保留 unique facts 和顺序的确定性重复缩减；无法缩减时，通过 Pi 自带 `modelRegistry.streamSimple` 发起有界辅助语义请求。每 turn 最多两项、单项最多 32,000 字符/1,200 output tokens/8 秒；失败或语义风险过高保留 exact。它不会调用 primary agent 或其工具，但有额外模型费用和延迟。

State 保存 append-only representation deltas，capsule 只保存一次；request snapshots 保存可复用 mapping 段、哈希、bounded previews 和 totals。未关联 raw source 的 prompt/extension 内容按哈希只存一次，超过归档限制时显示 unavailable，绝不把 preview 冒充完整输入。

旧 `rolling-context.note.v1`、state、context edits、own checkpoints、native compaction 和 Design Intent 历史投影继续可读/inspect/recall。v1 planner/shell 已隔离到 `legacy/`，默认入口不调用它。`lib.ts` 只保留兼容 export。

详见 [v2 implementation](docs/implementation.md)。历史设计见 [v1 implementation](docs/implementation-v1.md) 与 [v1 design](docs/design.md)，其 target/checkpoint 规则不适用于默认 v2。

验证：`node --experimental-strip-types --test --test-isolation=none test/*.test.mjs`。Daemon 集成测试需要 localhost 临时端口。120-turn zero-cooperation fixture 覆盖 read/edit/bash/test/unknown tools、重启、多个 generations、cold recall、raw immutability 和真实快照回放；fixture usage 是模拟数据，不能作为真实 provider 成本实验。
