# Rolling Context 实现细节设计

状态：本文是实现蓝图；当前代码是**受限 MVP**，不是本文所有 P0/P1 能力的完整交付。已接入根包清单、提供 note/recall/状态命令、分支回放、工具结果证据、保守裁剪规划及 checkpoint callback。实现集中在 `index.ts`、`lib.ts`，函数/字段与本文拟议接口可能不同。上层决策见 [design.md](design.md)，双插件边界见[集成说明](../../design-intent/docs/integration.md)。

当前明确限制：首版默认 observe，`--rolling-context-mode on` opt-in；预算使用宿主 `contextWindow`/usage（不可用时回退启发式），扣除 reserve 与安全余量，但仍非 provider 精确 tokenizer；cacheRead 感知批处理/epoch、提取器、持久检索索引和对所有宿主扩展消息类型的适配尚未实现。checkpoint 只在来源覆盖、非多模态和候选预算净收益都可验证时尝试，否则保留上下文/交由原生 compact；这可能导致超预算但避免静默丢失。

## 1. 实现约束与宿主基线

实现、集成测试先固定在 `@earendil-works/pi-coding-agent@1.0.0`；通过验证后再声明支持其他版本。入口导入宿主公开 export，不 deep-import 核心私有实现。

必须遵守：

- 决策类型只使用 `task-decision`；本插件没有项目 intent 的写入口。
- 状态从当前 `getBranch()` 重建；实际裁剪对象来自有效 projection，不能直接发送 raw branch。
- 只在完整边界提交持久化上下文变更；不改原始工具结果，不裁剪 streaming 内容。
- MVP 仅替换已消费的纯文本 toolResult，以及追加单 entry compaction。不删除 assistant/toolResult 配对。
- 不强转只读 `ctx.sessionManager` 调写 API；需要模拟时创建独立内存 SessionManager。
- 维护工作不设置 `continue`，不额外调用主 agent；也不覆盖其他扩展的 continuation。
- 不关闭原生自动 compact。无法证明安全的候选保留并记录原因。

### 已核实的 API 注意点

| 能力 | 使用方式 |
| --- | --- |
| 完整回合 | `turn_end` 有当前 assistant/result entry ID，以及包含前序扩展草稿的 `event.context` |
| 最终边界 | `agent_before_settle` 可写草稿；`agent_settled` 只通知 |
| 草稿组合 | 返回 `entries: [...event.entries, ...ownDrafts]`；不是只返回自己的增量 |
| compact 命令 | `ctx.compact(options): void`，使用 `onComplete/onError`；不能直接 `await ctx.compact()` |
| 用户命令空闲 | 只有命令 context 提供 `waitForIdle()`；生命周期 handler 不能等待自身 idle |
| 预算估算 | 公开 `estimateTokens(message)` 可用；`estimateProjectedContextTokens` 未从根 export 暴露，不依赖它 |
| 系统成本 | projection 包含 system messages；`getContextUsage()` 可能为 undefined 或 tokens=null |
| 嵌套工具 | `executeTool()` 只在工具 context 中提供；边界/命令 handler 不能凭空调用它 |

## 2. 文件与模块接口

```text
index.ts                 # 注册；只做事件/工具/命令的薄连接
lib/types.ts             # 内部 TypeScript 类型和 TypeBox schema
lib/state.ts             # 重建、增量合并、提交识别、配置
lib/groups.ts            # 调用/结果关联、消费状态、保护集合
lib/adapters.ts          # 当前仓库 read/bash/edit 证据适配
lib/memory.ts            # 来源、task-decision、冲突/失效、覆盖校验
lib/planner.ts           # 候选排序、胶囊化、checkpoint、内存模拟
lib/budget.ts            # 公共估算、余量、缓存收益
lib/recall.ts            # 分支检索、分页、编辑来源限制
lib/telemetry.ts         # 数值指标和可解释诊断
```

可选模型提取器在 P2 增加 `extractor.ts`；MVP 不调用辅助模型。小函数可同文件实现，不为每个类型建立类或 registry。

主要纯函数：

```ts
rebuild(branch: SessionEntry[]): RebuiltState
buildGroups(projected: ProjectedSessionEntry[], branch: SessionEntry[]): ExecutionGroup[]
extractEvidence(group: ExecutionGroup, view: EvidenceView): EvidenceDelta
reduceMemory(state: MemorySnapshot, delta: EvidenceDelta): MemorySnapshot
buildProtection(input: PlanInput): ProtectionSet
plan(input: PlanInput): PlanResult
preview(header: SessionHeader, branch: SessionEntry[], drafts: SessionBoundaryDraft[]): SessionProjection
validateCandidate(before: SessionProjection, after: SessionProjection, plan: PlanResult): Diagnostic[]
```

`PlanInput` 显式携带 branch、已有草稿、projection、pendingMessages、模型信息、配置及预期 leaf。函数不捕获全局 session，不做磁盘扫描。主流程可通过 fixture 离线测试。

## 3. 状态与提交数据

沿用 design 中 `MemoryItem`、`MemorySnapshot`、`IntentReference`。追加一个存储 envelope，将业务记忆与裁剪提交区分：

```ts
interface StateEnvelope {
  schemaVersion: 1;
  revision: number;
  parentRevision: number | null;
  planId: string;
  baseLeafId: string | null;
  snapshot: MemorySnapshot;
  edits: Array<{
    targetId: string;
    originalContentHash: string;
    expectedProjectedHash: string;
    replacementHash: string;
    adapterVersion: string;
  }>;
  checkpoint?: {
    firstKeptEntryId: string;
    summaryHash: string;
  };
}
```

- `customType: "rolling-context.state.v1"` 存 envelope。snapshot 描述已取得的事实，edits/checkpoint 描述拟议投影变化，**不表示后者一定已提交**。
- `planId` 对基础 leaf、状态增量、目标内容 hash 和配置版本做稳定 hash。重复处理同一候选不能反复追加 edit。
- `revision` 从当前分支已有有效记录递增，不用 wall-clock 排序，不以全 session 最大 revision 作为本分支状态。
- `coveredThroughEntryId` 是覆盖游标，不是“最后看到的消息”。每个 entry 的 disposition 必须另行校验；不能跨过未知未覆盖内容。
- compaction 的 `details` 使用 `{ type: "rolling-context.checkpoint.v1", planId, stateRevision, firstKeptEntryId, summaryHash }`。命令/hook 无法追加 custom 草稿时，可在 details 中附同 schema 的 `stateEnvelope`，供重建消费。
- MVP 固定使用完整 envelope，仅状态实际变化或规划裁剪时追加，限制单条序列化状态为 128 KiB。冷证据搜索索引从 branch 重建，不每回合复制所有原输出。状态过大时停止本次裁剪并报告，不丢约束凑上限。

P2 再引入完整快照 + 有序 delta 的判别联合，在 checkpoint 或每 8 个增量落完整快照；delta 缺环/未知版本回退前一有效状态。先验证正确性，不在 MVP 同时实现两种写入协议。

### 重建顺序

1. 获取当前 branch，校验来源 ID 均在本路径中。
2. 按路径顺序读取完整 envelope，以及本插件 compaction details 中的快照，校验 parentRevision。P2 加入匹配 parentRevision 的 delta 重放；MVP 遇未知 delta 停用它，不猜解码。
3. 读取 `context_note` 工具结果 details，应用尚未覆盖的笔记；工具结果被 compact 收起后仍在 raw branch 中。
4. 用实际 `context_edit` 和 compaction entry 检查每项计划提交情况。缺失 checkpoint 就不能推进 epoch。
5. 对 foreign edits、恢复 omissions、来源缺失、未知 schema 做诊断；失效状态不得成为裁剪依据。
6. 调用 `buildSessionProjection()` 获取实际模型工作集，刷新内存索引。

进程内只缓存 `{ sessionId, leafId, revision, branchIndex, memory }`。leaf 不再是上次 leaf 的后代或 session/cwd 变化时全量重建；正常追加走增量。任何 await 后返回计划前复核 sessionId 和 leaf，变化即放弃，不提交到新会话。

已保存 snapshot 也不能绕过后来的编辑策略：来源被 recovery/foreign omission 排除、被其他插件脱敏或改写后，关联事实须撤销其活跃证据资格并重新核验。裁剪渲染前重查来源授权；无法确认派生笔记是否包含已隐藏内容时停用该次记忆渲染/检查点，沿用宿主当前授权投影，而不是从旧 snapshot 再次泄露内容。

## 4. 任务身份与笔记工具

MVP 每个会话分支维护一个 active task，首次用户 entry 生成 `taskId = "RC-T-" + entryId`。后续 user/steering 默认延续，不凭关键词自动宣布旧任务完成；主题不明时保护旧约束。新独立任务优先使用新会话或 `/tree` 分支，细粒度任务切换留后续实现。状态没有淘汰/LRU：若完整 envelope 超过 128 KiB，整批 planner 写入被拒绝并保留原上下文，不会静默丢用户约束或 pinned 事实。

`context_note` 参数：

```ts
{
  intent: string;
  kind: "plan" | "task-decision" | "focus" | "next-step";
  text: string;                  // 1–2000 字符
  replaces?: string[];           // 只允许当前 task 的 RC MemoryItem ID
  paths?: string[];              // 必要代码依赖，不触发自动读取
}
```

使用 `Type.Object(..., { additionalProperties: false })` 并做运行时校验；禁止 project-level kind、intent 状态修改及 DI ID 替代目标。自然语言可能谈论架构，但无论措辞如何，工具结果都只有 `agent-report`、task-local 权威，不能被状态合并器提升。

工具注册 `executionMode: "sequential"`。执行时验证当前 task、参数长度及替代目标，返回短确认和 `details: { type: "rolling-context.note.v1", noteId, taskId, kind, text, replaces, paths }`。noteId 从 toolCallId 派生；在边界找到持久化结果后再绑定 sourceEntryId。不在工具返回前先修改权威内存 snapshot。

`paths` 用于保守保护精确代码片段；所有笔记来源仍是笔记自身，不凭笔记声称已有成功 edit/test 证据。替代只能修改同任务笔记，不能覆盖用户原文或 tool-evidence。

纯会话工具的 annotations 标明不修改项目文件、不访问网络；这不代表可以省略业务校验。工具返回必须有 `content` 和 `details`；参数非法 throw，或返回明确的 `isError: true`，不能仅给普通结果写“失败”。

## 5. 完整组与消费判定

```ts
interface ExecutionGroup {
  assistantEntryId: string;
  callIds: string[];
  resultEntryIds: string[];
  complete: boolean;
  consumedBy?: string;
  protectedReasons: string[];
}
```

构建算法：按有效 projection 的 source entry 顺序，读取 assistant 内容中的直接 toolCall；用 `toolCallId` 找结果。每个直接调用必须恰有一个有效结果，重复/缺失/name 不符使本组异常并保护。

嵌套 `parentToolCallId` 的执行通知和 `nestedCalls` 只作为外层结果的辅助证据，不构造成独立 transcript 调用。`tool_execution_end` 不是完整组边界，不能据此裁剪并行 sibling 结果。

更早组只有在结果之后存在成功 assistant（`stop` 或 `toolUse`）时可记 consumed。`length/error/aborted/deferred` 不构成成功消费；被 recovery omission 排除的 assistant 也不算。消费是调度条件而非理解证明；存在无法兼容的请求级过滤器时保守停用受影响缩减。

默认保护最近 **3 个完整工具组**、所有不完整组、最新未消费结果、必要精确依赖、所有图片、未知角色/结果和未解决错误。它们可能超过目标预算，保护优先。

读取外部 custom_message、branchSummary 等未知贡献时，保留并阻止跨越它的 checkpoint。已识别的 Design Intent 投影按第 12 节只读处理。

## 6. 证据适配器与失效

适配器输入必须包含原始调用参数、当前授权投影结果和原始 source ID，输出 `{ facts, capsule?, exactDependencies, coverage, diagnostics }`。不读取任意工具 details 里的路径后自动访问磁盘。

| 适配器 | 本仓库可用证据 | MVP 处理 |
| --- | --- | --- |
| `read` | args.path/offset/limit；结果纯文本；permissions 加入的 details.intent | 记录范围与结果 hash，不把片段 hash 当完整文件版本；活跃编辑路径正文保留 |
| `edit` | 成功结果 details.changes 的 path/kind，及 intent；diff 可能截断 | 记录 add/update/delete、改动目的并失效相关观察/测试；不把 diff 作为完整前后文件 |
| `bash` | 命令、isError、输出、截断信息；不总有可靠 exitCode 字段 | 保留未知命令；仅识别白名单格式的搜索或测试摘要；isError=false 本身不证明测试全通过 |
| `context_note` | 本插件 details schema | 作为 task-local agent-report 合并 |
| Design Intent 工具 | 第 12 节版本化 envelope | 只提取引用/短投影，不创建 project decision |

成功 edit 后，对被改路径的观察和相关测试设 stale。未知可能写入的 bash 若无法识别范围，设置 workspace generation dirty，相关验证均待复核；不冒险继续显示通过。

`observedHash` 仅在取得完整、授权的文件内容时使用。片段使用单独的 evidence hash 与 range；两个不同范围 hash 不可用来证明文件没变。MVP 不在每回合直接 fs.readFile 全仓，当前磁盘核验由正常 read/tool 证据补充。重启/分支跳转后的磁盘事实先标待核验。

胶囊从授权原内容和已验证的记忆生成，带来源 ID、历史/当前标签、准确状态及召回方法。已经匹配 replacementHash 就跳过。不从上一版胶囊重新自由总结。

## 7. 规划、保护和覆盖

边界正常路径：

```text
ensureRebuilt → 读取 event.context + inherited entries
→ 关联当前组和更早组 → 抽取/失效/合并笔记
→ 保护集合 → 预算评估 → 批量选择胶囊
→ 若仍超 soft：尝试 checkpoint
→ 模拟 + 协议/语义校验 → 返回状态、edit、可选 compaction
```

observe 模式只输出统计，不写胶囊/compaction；off 停止新自动维护，已落盘投影不还原。显式调用的 note/recall 仍可使用，但不得借此触发隐藏裁剪。

单个候选缩减要求：当前投影纯文本、无 foreign edit 竞争、已消费、非保护内容、存在可用来源与覆盖项，并且有明显收益。首版至少节省 256 估算 tokens 且缩短 50%，减少小输出的缓存抖动。

coverage 不是泛用“已总结”标记：

- `retained`：精确内容仍须出现在保留区，或作为用户原文/必要证据无损写入检查点。
- `extracted`：具体有效 MemoryItem/source 引用已覆盖该语义内容。
- `recall-only`：仅适用于已消费的重复日志、旧广域输出、已替代版本等可明确降为冷证据的内容。

不允许把未知用户约束、未总结的方案论证、未解决错误或未知 custom 内容一律标 recall-only。MVP 没有提取器时，缺少 plan/focus/next-step 或关键语义覆盖就不做 checkpoint，这个回退是预期行为。

## 8. Checkpoint 算法与候选模拟

1. 从保护集合求最早必须保留 entry；向前调整到完整 assistant 组或 user 边界，绝不以 toolResult 开始。
2. 枚举此边界及更早的安全边界，优先选择能满足预算且覆盖充分的候选；只能收起已经消费且不受保护的组。
3. 检查待收起的所有模型贡献与此前检查点：本插件结构化检查点可由工作记忆重建；未知原生/其他扩展摘要不能只靠 RC snapshot 替换，保留它或回退原生 compact。
4. 最新文本用户请求若在收起区，完整原文和仍有效追加要求无损加入新检查点；多模态用户消息不跨越。用户片段的 role/权威标签与历史工具数据区明确分开。
5. 渲染目标、约束、项目观察、相关 intent、task-decision、改动/验证、焦点/下一步和少量证据 ID。stale 项保留状态而不当成功事实。
6. 新 checkpoint 的 `firstKeptEntryId` 必须是当前 branch 中的原始 ID，不能用模拟中新生成 ID。有其他扩展已提出 compaction 时，MVP 不再追加第二个 compaction。
7. 用公开 `SessionManager.inMemory(cwd, undefined, [header, ...branch])` 重放已有草稿及本插件草稿。只在这个独立实例上调用 appendCustomEntry、appendContextEdit、appendCompaction 等公开方法，然后 `buildSessionProjection()`。
8. 校验候选工具配对、系统状态、原文保留、保护结果 content hash、覆盖、当前任务焦点和 token 收益。候选失败就缩减计划或返回无裁剪诊断。

模拟器使用 exhaustive switch 处理四种 SessionBoundaryDraft。宿主新增草稿类型或消息类型不认识时 fail conservative，不自行猜测其行为；不把模拟器当宿主的替代实现。

每个草稿提交前缀都要验证工具配对：状态记录不影响协议；toolResult 只换文本不改 ID/角色/isError；单条 checkpoint 的保留边界已验证完整。因而崩溃不留下半组调用/结果 omission。

## 9. 提交与生命周期处理

| 事件 | 具体工作 |
| --- | --- |
| `session_start/session_tree` | 清空 session scoped 缓存，重建；磁盘相关事实/intent 缓存待核验 |
| `before_agent_start` | 记录新请求将到达，不假定其 entry 已存在；不修改系统文本或宣布旧任务完成 |
| `turn_end` | 提取、规划、返回累积草稿；异常 outcome 仅保存确定性状态，不滚动 |
| `agent_before_settle` | 从修复后投影重建；保存未覆盖状态，避免再次处理同一组；默认不做新激进检查点 |
| `session_before_compact` | 处理第 10 节兼容逻辑，不直接调用 compact 形成递归 |
| `session_compact/session_compact_failed` | 成功重建；失败不推进归档/epoch，清理本次请求标记 |
| `model_select` | 重算窗口和预算；下一安全边界处理，不在此时裸写投影 |
| `context` | 校验和诊断为主，不靠临时过滤实现常规裁剪；不能保证运行于其他扩展之后 |
| `agent_settled` | 记录最终数值指标，无状态提交 |
| `session_shutdown` | 取消可选提取器/清缓存，幂等处理 |

正常草稿顺序为 `custom(state) → context_edit... → compaction?`。handler 返回前不推进 in-memory revision。下一边界/命令读取 raw branch 检查提交结果，避免把宿主后续 handler 撤销的草稿当已完成。

部分提交恢复：

| 实际落盘 | 恢复结果 |
| --- | --- |
| 无新增状态 | 旧状态与旧投影继续 |
| 只有 state | 新证据可用，裁剪未发生；重新规划，不冒称已滚动 |
| state + 部分 edit | 已完成 edit 按 hash 识别，其余候选下次复核；来源仍在 |
| state + edit + checkpoint | 依据匹配的 compaction entry 推进 epoch |

无法确定 edit 来源时禁止还原 raw 内容到模型，并停用受影响裁剪；插件没有跨进程原子 session 写入保证。

## 10. 原生 compact 与用户命令

`session_before_compact` 默认返回 undefined。manual/threshold 仅在 snapshot 覆盖 preparation 的整个收起范围、无图片/未知摘要/未识别 context edit，且粗略预算有净收益时提供自定义 compaction。hook 使用 preparation.tokensBefore 和 branch 中安全的 firstKeptEntryId；只有宿主真正提交 matching compaction 后才标记归档。无法证明安全或有收益时记录诊断并委托原生行为。

用户 `/compact` 带 customInstructions 时，MVP 不猜语义，直接委托原生逻辑。overflow/recovery 始终委托宿主。显式 `/rolling-context checkpoint` 若分支/覆盖或净收益校验失败会取消，避免静默替换为另一种 compact；其他 native compact 校验失败时不拦截宿主。失败、取消和宿主成功均更新 status 诊断。

`/rolling-context checkpoint` 走命令专属流程：

1. `await ctx.waitForIdle()`，重新取 sessionId/leaf；有 pending messages 时拒绝本次操作。
2. 做一次无副作用规划，向用户显示安全/不可行原因。
3. 设置进程内一次性 `manualRequest`（sessionId、leaf、planId），调用 `ctx.compact({ onComplete, onError })`。不直接 appendCompaction，也不通过 sendMessage 触发主 agent。
4. 在本次 `session_before_compact` 中重新校验计划并返回 snapshot 渲染结果；details 携带恢复需要的 envelope。
5. 仅对这个显式 RC 请求，条件变化导致不可行时取消并报告，不能悄悄执行另一种压缩。一次性标记在成功、失败或取消时清除；仅 customInstructions 文本相似不能冒充请求标记。

status/inspect/pin/on/off/observe 命令等 idle 后执行。配置和 pin 保存不进模型上下文的 custom entry；这些用户命令可以调用 `pi.appendEntry`，不伪造边界。off 不撤销已存在 compact，命令应明确告知。

## 11. 预算、cache 与配置

沿用 design 中 A/B/soft/hard 公式。实现拆为 `estimateConversation()`、`estimateSystem()` 和 `computeBudget()`；同一 system/tool 状态只计一次，保留 per-message 开销和非 ASCII/图片误差余量。

公共 `estimateTokens()` 是粗略 heuristic，不等于 provider tokenizer；对未知角色返回 unknown，不把 undefined 当 0。usage 仅校准同类未修改输入，不能用旧 request usage 给新 checkpoint 保证容量。

扩展 context 没有公开 SettingsManager。有效 reserve 优先使用显式配置，或已经观察到的 `preparation.settings`；未知时用公开默认 reserve 保守估算并标明来源，**不宣称已读到模型 override**。用户 override 更大时原生 compact 仍可能先执行；需要精确对齐时显式配置 reserve。所有安全失败仍回退原生管理。

初始配置：

```text
mode=observe                    targetTokens=32768
keepRecentGroups=3              minCheckpointTurns=8
minSavingTokens=256              minBatchSavingTokens=2048
recallMaxTokens=2000             recallMaxEntries=8
extractor=disabled              reserveTokens=未配置
```

用 `registerFlag` 的 string/boolean 类型解析，例如 `--rolling-context-mode`、`--rolling-context-target`、`--rolling-context-reserve`；数值严格解析为有界 safe integer。未知值或负数报错，不静默吞掉。会话命令覆盖保存为 config custom entry，不修改原生 settings。

每次完整边界可以计算，但普通胶囊批次至少间隔 4 个完整回合且达到批量收益；超 soft 时允许提前处理。checkpoint 默认间隔 8 回合，硬容量压力优先安全兜底。epoch 只在 compaction 真正存在时递增。

cache 优化首版是可解释阈值，不建立复杂预测模型：高 cacheRead 比例时提高普通批次门槛；容量余量不足不能仅为了 cache 延迟。分别记录输入/cacheRead/cacheWrite、维护延迟、回退原因和召回成本；P2 提取成本独立列出，不能藏在主 agent usage 中。

## 12. Design Intent 的只读消费

两边约定一份版本化数据形状，字段见 [Design Intent 实现文档](../../design-intent/docs/implementation.md) 的 projection 部分。没有公共包、内部模块互相 import 或必需事件总线。

从已持久化的 `design-intent.projection.v1` custom_message 或 DI query/get 工具 details 中提取 `storePath/storeRevision/sourceHash/id`。只保存 IntentReference 和有限短投影；不复制批准记录/依赖图，也不根据 RC facts 计算 intent 生命周期。

检查点区分相关 intent 与 task-decision。所有投影都带“在该版本观察到，设计敏感操作前 query/get”的标签；恢复旧会话、看到新 hash 或读取失败后标待核验。RC 不直接读项目意图库以刷新真相，也不在 handler 中调用另一插件的工具；agent 通过 query/get 明确刷新。

识别过的入口投影可在 checkpoint 中转为相同版本的短视图和引用；必要 invariant 未展开时保存 must-expand 标记，不伪造完整约束。提案和检查报告只能成为任务证据，不能变成 accepted 项目事实。

DI 不可用与不存在插件不同：已有引用不可解析是任务风险/待核验，不表示约束已经取消。`task-decision.replaces`、状态合并和 pin 均不准以 DI ID 修改项目权威集合。

## 13. Recall 实现与数据授权

参数为 `intent`，以及互斥的 `entryId/itemId/query`，可附 `paths`、分页 cursor 和受限 tokenBudget。默认只检索当前 branch；搜索索引是内存 Map，按 entry ID 保存文本索引，不持久化重复工具全文。

直接 ID 优先，再按精确路径、词项命中排序。工具输出只包含来源、历史/失效标签和文本片段，不序列化 thinking/signatures，不重放 ToolCall 对象。图片 MVP 只返回“有图片证据”的引用，不自动复制大附件。

cursor 包含 sessionId、查询 hash、索引版本和下一位置；leaf/索引变化后拒绝旧 cursor，要求重查，避免跨分支取下一页。

授权原则：原始消息不等于永远可重新暴露。扫描全 branch 的 context_edit，结合本插件已确认 edit 清单判断所有权；任何不明来源编辑、foreign omission、脱敏变化或来源不在本分支时，不能通过 recall 还原原内容。本插件胶囊化且无竞争的来源可以取原文；已被其他扩展改写的来源只取允许的有效内容，或返回 denied/unknown。不能证明兼容的脱敏扩展存在时停用 raw recall，不靠字符串相同就认定有权限。

外部 fullOutputPath 不自动读，返回失效可能性与路径引用。需要当前文件/完整外部输出由 agent 使用 read，通过既有授权流程；RC 不用 fs 旁路当前 permissions。

## 14. 故障与测试计划

诊断使用稳定 code，例如 `INCOMPLETE_TOOL_GROUP`、`UNCOVERED_SEMANTICS`、`FOREIGN_CONTEXT_EDIT`、`STALE_INTENT_REF`、`UNKNOWN_BUDGET`、`PROTECTED_SET_OVER_BUDGET`、`BRANCH_CHANGED`。日志保存 entry ID、数量、hash 和原因，不保存全部文件正文或密钥。

建议测试文件：

| 文件 | 关键场景 |
| --- | --- |
| `rolling-context-state.test.mjs` | 快照、分支回放、缺环、部分草稿、revision 幂等；delta 测试随 P2 加入 |
| `rolling-context-groups.test.mjs` | 并行/嵌套、缺失/重复结果、aborted/length/recovery 不算消费 |
| `rolling-context-planner.test.mjs` | 保护组、精确依赖、覆盖不足、原文/图片、foreign custom、缓存阈值 |
| `rolling-context-projection.test.mjs` | 真实内存 SessionManager 重放每个提交前缀，配对和 compact 保留边界 |
| `rolling-context-recall.test.mjs` | 分页/切分支、foreign 脱敏、不泄露 thinking、外部路径不暗读 |
| `context-intent-integration.test.mjs` | checkpoint 分区、hash 变化、引用非权威、禁止 DI supersede |

单元测试复用仓库 `node --experimental-strip-types --test test/*.test.mjs` 形式；宿主集成测试在测试依赖环境中运行，不使用付费模型做纯逻辑测试。

实现顺序仍按下文分期推进；当前包清单已注册两个入口。后续扩展范围前先补对应 fixture、宿主集成与故障恢复测试，不将“已注册/可加载”描述为全部蓝图均已完成。

## 15. 实现参考

已完整阅读宿主 `docs/extensions.md`、`docs/session-format.md`、`docs/compaction.md` 及 `examples/extensions/todo.ts`、`custom-compaction.ts`、`commands.ts`。精确类型以根 export、`dist/core/extensions/types.d.ts` 和 `dist/core/session-manager.d.ts` 为准。

证据适配以本仓库 `extensions/permissions/index.ts`、`extensions/edit/index.ts` 的实际结果结构为准；工具重注册或宿主版本变化必须重新验收，不能按名称假定结构永远不变。
