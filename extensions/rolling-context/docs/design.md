# Rolling Context 设计方案

具体落地接口、算法和提交流程见 [implementation.md](implementation.md)。本文保留总体设计与职责决策。

## 1. 目标与核心决策

传统模式把「发生过什么」直接作为「接下来需要知道什么」。工具输出、旧文件版本、重复搜索和已完成的探索不断累积，最终通过一次大规模 compact 丢掉细节；agent 随后可能重新读文件、重跑测试、重新理解项目。

本方案的核心是：**原始会话是审计日志，模型上下文是日志的一份有预算的工作投影，两者不应等同。**

采用三个互补机制，而不是简单保留最后 N 条消息：

1. **渐进缩减**：工具结果被后续 assistant 消费后，按规则替换为短证据胶囊，保留当前工作需要的细节。
2. **增量工作记忆**：持续维护目标、约束、项目事实、改动、验证状态、未完成工作及下一步，每项可以追溯来源和判定失效。
3. **滚动检查点**：当消息骨架也开始占用过多预算时，以工作记忆生成一个小检查点，保留完整的最近执行窗口。不是再次让模型总结全部历史。

不承诺完全消除 compact。pi 的 `compaction` 是一种已有的安全、持久化投影机制，可以用来落地轻量检查点；需要避免的是「高水位才临时总结长日志」及由此导致的状态重建。原生 compact 保留为最后的容量兜底。

### 成功标准

- 长任务中，发送给模型的历史成本趋于一个工作集预算，而非随原始日志线性增长。
- 检查点之后，agent 知道正在修改哪里、哪些验证已执行、哪些结论已失效，以及下一步是什么。
- 不破坏工具调用协议，不改写原始消息、历史展示或已有计费数据。
- 有出处的事实不会被无来源的推断覆盖；无法安全淘汰时宁可保留。
- 重启、分支切换和模型切换不产生跨分支状态污染。

非目标：跨项目永久记忆、默认使用向量数据库、修改 pi 核心、保留或重建模型隐式推理、保证 agent 永远不再读文件。

### 与 Design Intent 的职责边界

Rolling Context 只回答「当前任务怎么继续做」：目标、用户约束、焦点、下一步、文件/项目上下文、临时执行决策，以及修改、测试、错误和验证状态。本文所有工作记忆中的「决策」均指 **task-local execution decision（`task-decision`）**。

项目长期 requirements、architectural invariants、关键设计及理由、被否决方案和决策演化由独立的 [Design Intent](../../design-intent/docs/design.md) 管理。Rolling Context 只保存当前任务需要的 intent 引用或带来源的精简投影，不维护第二份长期设计库，也不自动将任务记录提升为项目事实。除此边界外，渐进缩减、检查点、recall、预算、cache 和 branch 机制保持不变。

## 2. pi 接口可行性与约束

设计参考 pi `0.99.1` 的文档，并核对本仓库实际安装的 `@earendil-works/pi-coding-agent@1.0.0` 类型和实现。未来实现应锁定测试过的宿主版本；根包当前的 `*` peer range 不代表所有历史版本都支持本方案。

| 接口 | 本方案用途 | 注意事项 |
| --- | --- | --- |
| `turn_end` | 每个 assistant/tool 回合结束后规划缩减、保存记忆、必要时滚动检查点 | `messageEntryId`、`toolResultEntryIds` 提供原始 entry ID；完整回合结束后才处理并行结果 |
| `agent_before_settle` | 最终恢复处理后检查状态和保存尚未提交的记忆 | 可行动边界；不为维护记忆额外请求一次主 agent 回答 |
| `agent_settled` | 只记录指标和通知 | 不是写入上下文或请求续跑的时机 |
| 边界 `entries` 草稿 | 返回 `custom`、`context_edit`、`compaction` 等持久化变更 | 新数组必须保留 `event.entries`；这是累积列表，不是仅返回自己的增量 |
| `context_edit` | 缩短工具结果或恢复原内容，仅改变后续模型投影 | `replacement` 是 `{ content: ... }` 或 `null`，不是裸字符串；不能改角色、工具 ID 等元数据 |
| `buildSessionProjection()` | 获取当前有效投影及每条消息的 `sourceEntry` | 已有 compact 和其他扩展的编辑必须生效，不能直接把 raw branch 当成下一次输入 |
| `getBranch()` | 重建当前分支的记忆和原始证据 | 不从所有 `getEntries()` 聚合业务状态 |
| `pi.appendEntry()` / `custom` 草稿 | 保存不进入模型上下文的版本化记忆、配置和审计信息 | 保存了数据不等于模型看到了数据 |
| `context` | 请求级一致性检查；后续版本可做临时召回视图 | 此处变换不能替代持久化缩减，否则 pi 的容量判断仍可能面对大投影 |
| `session_before_compact` | 兼容用户 `/compact` 及原生 threshold/overflow compact | 已确认有足够新鲜的记忆时可提供摘要；否则让原生逻辑执行 |
| `session_start`、`session_tree` | 重新构造状态、清理旧分支内存缓存 | fork、switch、reload 后也按实际生命周期重建，不能只处理首次启动 |
| `ctx.modelRegistry.complete()` / `streamSimple()` | 可选的隔离小模型提取器 | 明确指定模型、预算、超时和取消信号；不是递归启动当前 agent |

实现中通过边界返回草稿，不强转 `ctx.sessionManager` 去调用写方法。它在扩展 context 中是只读接口。

边界草稿会经过预览，但**预览校验不是文件事务，也不保证工具调用配对**。实际提交逐条追加。MVP 因此不对 assistant/tool-result 组做多条 `null` 淘汰，而用保留配对的内容替换，以及单条 `compaction` 检查点收起历史。

`turn_end` 提交后的投影会在下一轮容量检查中使用。这比仅在 `context` 钩子过滤消息更合适；但首次新输入、突发大结果、模型切换仍可能先触发原生检查，不能假设插件总能抢在所有 compact 前执行。

## 3. 四层上下文模型

```text
L0 原始证据库：当前分支 JSONL 原始消息、工具输出、扩展状态
         │ 增量提取 / 来源索引
         ▼
L1 工作记忆：任务约束、事实、task-decision、改动、测试、任务、下一步
         │ 生成检查点；不是不断追加叙事摘要
         ▼
L2 活跃执行窗口：当前用户请求 + 最近完整工具回合 + 未解决细节
         ▲
         │ 限量召回
L3 临时证据：历史摘录 / 必要的旧任务执行决策 / 当前版本文件片段

模型输入 = pi 管理的系统/工具状态 + 最近检查点 + L2 + 本次必要的 L3
```

### L0：原始证据库

- 不删除、不重写 pi 的 session JSONL。`context_edit` 只是追加投影指令。
- MVP 不另存一份全部工具输出；会话原始内容就是证据库。被工具截断、根本没有进入会话的内容不能凭空恢复。
- 外部大输出文件只保存引用、有效性和可用性。临时文件过期后明确标为不可用。
- 当前分支以外的数据默认不可召回，避免未来状态泄漏到过去或混淆不同探索路径。

### L1：工作记忆

不是「第 1 回合做了 A，第 2 回合做了 B」，而是按键更新的状态表：

| 类别 | 需要保存的内容 | 生命周期 |
| --- | --- | --- |
| 目标与约束 | 当前任务、验收标准、用户明确偏好、禁止事项 | 用户撤回/任务结束前保护；重要措辞保留原文 |
| 项目地图 | 相关入口、模块职责、正确命令、必要开发约定 | 只保留与任务相关部分，跟踪依据文件版本 |
| 任务执行决策（task-decision） | 当前任务采用的实现步骤、理由、临时排除的做法及条件 | 仅本任务有效；不得自动晋升为项目架构决策 |
| 相关 Design Intent | 当前任务需要的项目 intent ID、来源版本及精简投影 | 只读引用；由 Design Intent 判定当前有效性，不在本地演化 |
| 改动账本 | 哪些路径被改、目的、当前实现状态 | 已改不等于已验证；不保存全部 diff |
| 验证证据 | 命令、范围、退出码/结果、对应内容版本 | 后续相关改动使验证结果过期 |
| 活跃工作 | 未完成步骤、阻塞、失败签名、需精确使用的片段 | 解决后退为短结论或冷记忆 |
| 连续性锚点 | 当前焦点、最后有效观察、接下来一至三步 | 每次检查点前必须校验 |

约束和必要精确信息不能被评分静默丢掉。如果它们本身大于预算，报告不可压缩工作集，而不是生成虚假的简短替代品。

### L2：活跃执行窗口

按**完整回合/工具依赖组**而不是消息条数保留：

- assistant 消息与其中所有直接 `toolCall` 对应的结果构成一组。
- 一组结果齐全、状态终结，且出现后续成功 assistant 响应后，才视为「已经消费」。只有工具执行完成不足以证明 agent 看过结果。
- 最新用户指令（含图片等结构内容）、最新工具组、未完成或未消费的结果不做有损淘汰。文本请求跨检查点时的精确保留规则见第 7 节。
- 保留近几组之外，还保留精确下一步依赖：要编辑的代码片段、未解决错误、路径与关键数据。
- 用户 steering/follow-up 到达时刷新保护集合；规划不能基于过期的最新用户消息。

主 agent 不一定真的理解了每条结果；「已消费」只是保守的调度条件。淘汰还必须满足证据已保存且可召回。

### L3：临时证据与召回

默认通过只读工具 `context_recall` 按事实 ID、entry ID、路径或关键词检索，分页返回摘录和来源，不自动塞回整个旧历史。

- 一次响应受 token 和条目数上限限制；模型可继续翻页。
- 召回的是数据文本，不重新执行旧工具，不重放旧 assistant 的 tool calls。
- 历史文件内容标明「历史观察」，不当作当前磁盘状态。
- 与当前分支、任务、文件版本不一致的数据不得无标签地混入工作记忆。
- 自动检索优先匹配当前请求、路径、符号和未解决错误；向量索引留待有指标证明必要后再加。

## 4. 记忆结构与事实有效性

下列是拟议的扩展内部结构，不是 pi 原生 entry schema：

```ts
interface MemoryItem {
  id: string;
  key: string;                 // 如 constraint:no-write、file:src/a.ts、test:unit
  kind: "constraint" | "project" | "task-decision" | "change" | "test" | "task" | "focus";
  text: string;
  status: "active" | "resolved" | "superseded" | "stale";
  authority: "user" | "tool-evidence" | "agent-report" | "inference";
  sourceEntryIds: string[];
  taskId: string;
  dependencies: Array<{ path: string; observedHash?: string }>;
  observedAtEntryId: string;
  supersedes?: string[];       // 仅同任务 MemoryItem ID，不能指向 Design Intent ID
  pinned: boolean;
}

interface IntentReference {
  storePath: string;           // Design Intent 的项目文件，不是会话状态库
  storeRevision: number;
  sourceHash: string;          // 检测未递增 revision 的外部文件修改
  id: string;
  projection?: string;         // 可选短摘录，缓存而非项目真相
}

interface MemorySnapshot {
  schemaVersion: 1;
  revision: number;
  coveredThroughEntryId: string;
  items: MemoryItem[];
  intentRefs?: IntentReference[]; // 没有 Design Intent 时为空；不复制其决策演化
  focus: { taskId: string; nextSteps: string[]; openQuestions: string[] };
  coverage: Array<{ sourceEntryId: string; disposition: "retained" | "extracted" | "recall-only" }>;
}
```

持久化用 `customType: "rolling-context.state.v1"` 的 `custom` entry，包含快照及策略信息。完整快照按检查点保存，中间可记录有序增量；冷事实不必每次复制。模型只看到由有效热记忆渲染出的检查点文本，不能把整个状态 JSON 都加入输入。

关键更新规则：

1. **有来源**：提取器只能引用输入中确实存在的 entry ID。无效引用导致该更新被拒绝。
2. **区分报告和观察**：assistant 说「测试通过」只算报告；有成功工具证据才升级为验证事实。不能把「已计划」记成「已完成」。
3. **显式替代**：同一任务内同一键的新版本使旧版本 `superseded`，保留旧来源用于审计，不把矛盾文本并列为当前事实。`task-decision` 不能覆盖或 supersede project-level intent；发现冲突只记录阻塞/待确认问题，项目意图变更须走 Design Intent 的显式流程。
4. **文件新鲜度**：已观察路径修改后，相关旧片段及验证标为 `stale`。分支切换不会回滚磁盘，恢复分支记忆后仍需检查相关文件版本。
5. **不猜解析结果**：成功 patch 可记录修改路径；它不证明测试通过。无法解析的 bash 命令，最多保存命令、退出状态和输出摘录，不推断所有文件影响。
6. **验证范围明确**：局部测试不代表完整 CI，通过结果关联运行时的相关内容指纹。未知写入使相关验证保守失效。
7. **必要时重读是正确行为**：内容变化或证据过期时才重读相关路径，不在每次检查点后重新扫描整个项目。

文件指纹仅计算活跃相关路径，限制大小、数量和频率；不每回合哈希全仓库。不能确定依赖范围时，将相关事实标为「待核验」，而不是默认仍有效。

Intent 引用与文件观察不同：源版本/哈希变化或恢复旧会话后，旧投影只表示「当时参考的 intent」，必须通过 Design Intent 重新查询当前状态。它的刷新由 Design Intent 提供，Rolling Context 不推断 accepted/superseded/conflict，也不从历史 recall 恢复一份项目真相。引用不可解析时标为待核验；预算不足时保留必要引用并请求具体查询，不自由改写架构不变量。最低限度集成见[集成说明](../../design-intent/docs/integration.md)。

## 5. 渐进缩减策略

### 5.1 保护条件优先于收益评分

以下内容在满足解除条件前不参与淘汰：

- 最新用户请求及未撤回的关键约束。
- 未消费的最新工具结果、正在运行/未完成的工具组。
- 未解决错误的必要上下文、当前 patch 的精确匹配片段。
- 显式 pin 的项目事实、凭据以外的必要精确标识、当前图片证据。
- 未知角色、未知工具及无法安全解释的结构内容。

未知工具默认保守保留。工具适配器需要描述可提取字段、错误识别和可缩减方式，不以工具名字推断结果总是安全。

### 5.2 三种表示状态

```text
hot 原始/精确内容
  → warm 短证据胶囊（仍保留原工具结果角色与 ID）
  → cold 只留有效事实和召回引用（在滚动检查点中收起旧组）
```

MVP 中 `hot → warm` 使用 `context_edit`；`warm → cold` 用单条滚动 `compaction`。默认不逐条删除 tool calls，不改写 thinking 或带签名的 assistant 内容。

| 内容 | 可以缩减的时机 | 保留的胶囊 |
| --- | --- | --- |
| 大范围目录/搜索输出 | 后续响应已消费，相关入口已记录 | 查询、范围、关键命中、来源；不保留每行命中 |
| `read` 的旧文件正文 | 已消费，且非下一步精确编辑依赖 | 路径、范围、观察版本、关键符号/结论、召回引用 |
| 成功修改结果 | 修改状态已记录，结果已消费 | 成功状态、路径、改动目的、未验证标记 |
| 成功测试的重复日志 | 验证范围和版本已记录 | 命令、结果、执行版本；精确计数仅在有证据时保留 |
| 失败日志 | 问题已解决或已转存完整必要诊断 | 失败签名、退出状态、关键堆栈、失败/解决关联 |
| 图片、未知结构结果 | MVP 不自动缩减 | 原样保留或由原生 compact 兜底 |

示例胶囊：

```text
[历史证据已缩减；原始来源 entry=7ab31c90]
read src/auth.ts，观察范围 1–180，版本 sha256:…。
相关接口：verifyToken(token)；当时未校验 issuer。
该观察在 entry=8cd42d01 的修改后已失效，不能代表当前文件。
要查看原输出：context_recall(entryId="7ab31c90")。
```

胶囊始终基于原始证据或已验证的事实渲染，**不对上一次胶囊再次进行自由摘要**。已经是同一版本的胶囊就不再写 edit，避免不断追加无意义编辑。

### 5.3 排序与滞回

候选收益近似为：`节省 token /（后续重读风险 + 语义损失风险 + 缓存失效代价）`。首版使用可解释规则：重复成功日志优先，旧广域搜索其次，非活跃文件正文再次，任务执行决策和未解决诊断最后。

用软阈值和回落目标形成滞回；每次处理一批而不是每删几十 token 就刷新记忆。普通回合可以检查，不必每回合改变输入前缀。任务完成、失败解决、工作焦点切换可触发语义检查点，但受最小间隔约束。

当前调度的具体落地（不改变上述分层与职责）：

- aging 每个完整 turn 重新计算；普通 hot→warm 默认至少间隔 **4 turn**，累计候选节省达到 **2048 估算 tokens** 才批量写入。已提交 capsule 不再改写。
- 本轮 usage 的 `cacheRead / (input + cacheRead) >= 80%` 时，普通批次收益门槛翻倍；未知 usage 不推断缓存状态。跨 soft 可以提前处理，但仍至少间隔 2 turn 且达到基础收益门槛的一半，避免高水位下每轮修改一个旧结果。
- 必须先 preview hot→warm 后的 projection，基于 **after-warm tokens** 判断 checkpoint。上一请求 usage、raw history 大小都不是候选投影预算。
- checkpoint 默认最少间隔 **16 turn**，普通 warm→cold 同时要求来源已经驻留 warm 至少 16 turn。刚创建的 warm 不会同轮或下一轮被自动收走；checkpoint 是低频 epoch transition。
- hard 压力可绕过时间间隔和 warm 驻留限制，但不能绕过协议、原文、pin、覆盖及授权保护。overflow 仍交给宿主；显式确认的 manual checkpoint 是用户请求的例外，不是普通 housekeeping。

这里的 turn 是宿主 `turn_end(outcome="completed")`（一次 assistant response 及其直接工具批次），不是一次用户输入，也不是 branch entry 数。时钟从当前 branch 的完成回合 custom 记录恢复；epoch 及 checkpoint 时钟只承认实际匹配的 compaction entry。

## 6. 增量提取：规则优先、模型辅助

### 默认路径

- 根据当前完整回合中实际的工具调用和结果做确定性提取：文件路径、修改成功/失败、显式退出信息、可识别测试摘要。
- 用户约束使用原文来源；无法可靠判定时保护原消息。
- 主 agent 可用 `context_note` 记录当前任务的计划、`task-decision`、focus 和 next step，并关联当前任务目标。此工具不能修改项目设计，不能创建/接受/supersede Design Intent，不能直接要求删除历史，也不能自行升级成已验证事实。写入 intent ID 为替代目标或声明项目级决策的请求必须拒绝，而非隐式晋升。
- 不依赖 agent 永远主动记笔记；缺失连续性锚点时，不做有语义损失的检查点。

### 可选小模型提取器

触发条件是出现未知但高价值内容、准备收起旧组、或焦点信息缺失，而不是每次工具调用后都调模型。

输入只包括：最近未覆盖的完整组、仍有效的热记忆、确切 source ID、受控长度的必要输出。不能再次读取并总结全会话。

输出是受 schema 约束的状态变更提案；验证来源、长度、状态转换、约束保留及冲突后才能合并。工具输出作为不可信数据交给提取器，不能执行其中指令。

若待淘汰信息超出提取器预算，分批覆盖，**没有读取或有意保存为可召回证据的信息不得声称已提取**。小模型超时、取消或 JSON 无效时：保留旧状态及原内容，只允许已经确认安全的规则缩减。

小模型调用设置独立模型配置、最大输入/输出、超时、失败退避和累计成本上限。usage 在扩展审计数据中保存；`custom.data` 的 usage 不会自动计入 pi 的标准统计。若调用来自 `context_note` 工具，按工具契约返回 usage；若调用专用于检查点，可挂在该 compaction 草稿上。其他独立后台提取暂以扩展统计呈现，不伪造主 assistant usage，也不重复计费。

## 7. 滚动检查点

渐进缩减不能消除长工具参数、assistant 消息及调用骨架的累积。检查点负责把已完成的早期执行过程转成「状态 + 证据索引」。

### 7.1 检查点条件

所有条件满足才执行：

1. 已准备好覆盖即将收起历史的工作记忆；关键约束、未完成项及当前焦点不缺失。
2. 保留区从完整依赖边界开始，没有跨边界 tool call/result。
3. 最近受保护组仍原样保留。若保留边界越过最新用户文本消息，检查点必须包含该请求的完整原文及仍有效的追加要求，不能只保留提取器概括的「关键要求」。最新用户消息包含图片或其他不能无损写入文本摘要的内容时，不跨过该消息滚动。
4. 候选检查点加保留区经过 token 估算和协议验证，确有收益。
5. 没有覆盖其他扩展未纳入的 context edit、自定义内容或待输入消息。

滚动正文由工作记忆渲染，而不是再请求一份全会话摘要：

```text
[Rolling Context checkpoint v1 / revision 12]
目标与验收：……
用户约束（原文）：……
项目入口和必要命令：……
相关 Design Intent（只读引用/投影）：DI-…，来源文件、revision 及 hash；过期则待重新查询。
当前任务执行决策（task-decision）及原因：……
改动状态：路径、目的、状态；未验证事项。
验证证据：命令、范围、结果、版本、新鲜度。
当前焦点/阻塞：……
下一步：1. …… 2. ……
历史证据索引：少量相关 source ID；更多内容可 context_recall。
事实不代表当前磁盘内容；stale 条目必须核验。
```

提交 `compaction` 草稿，`firstKeptEntryId` 指向计算得到的安全保留边界，不凭消息下标猜 ID；`details` 保存扩展 schema、snapshot revision 和证据覆盖。MVP 不用 `firstKeptEntryId: null` 丢弃全部历史。

这允许一个长用户任务在完整 assistant 组边界滚动，同时保留准确的任务指令。完整原文也计入检查点预算；如果原文或多模态保护使预算无法满足，承认此次滚动不可行，不截断用户输入。原文放在明确标识的当前请求区，历史工具证据放在另一数据区，避免混淆权威。

新检查点替换之前检查点的模型贡献；原始历史及非模型状态继续保存在分支里。pi 会生成系统/工具 checkpoint，不由本插件重新构造工具声明。

检查点中的 Design Intent 部分是缓存视图，不是新的设计记录。只纳入 Design Intent 已提供的相关引用/投影；不能从本任务的修改、测试成功或临时选择推导出新的项目要求。已有投影版本未知或失效时明确标记，不把历史摘要当作当前批准状态。

### 7.2 对原生 compact 的处理

- 默认保持原生自动压缩开启，不修改用户全局设置，也不无条件返回 `cancel: true`。
- 对 manual、threshold、overflow 分别记录原因。用户 `/compact` 的额外指令必须遵守，不能被固定模板吞掉。
- `session_before_compact` 中，只有当 snapshot 覆盖被收起区、足够新鲜且满足用户指令时才提供状态摘要；使用 preparation 给出的有效保留边界。
- 覆盖不足时回退原生摘要，让它处理当前投影。不能仅返回过期的工作记忆。
- compact 成功后重新读投影；失败后不推进覆盖游标、不标记已经归档。
- overflow 恢复会追加自己的 omission 和 compact；`agent_before_settle` 基于恢复后的投影检查，而不是把失败 attempt 当成正常推进。

## 8. Token 预算与提示缓存

设 `W` 为当前模型上下文窗口，`S` 为 pi 系统与工具声明成本，`R` 为输出预留，`H` 为估算误差和突发结果余量：

```text
A = max(0, W - S - R - H)                 // 会话工作集可用上限
B = min(config.targetTokens, floor(0.65 * A))
soft = min(floor(1.20 * B), floor(0.85 * A))
hard = A
```

`targetTokens` 首轮实验可从 32k 开始。`R` 至少尊重当前模型有效 compaction reserve，并考虑实际输出上限；`H` 可从 `max(2k, 0.05W)` 开始调优。这里的比例是待验证默认值，不是 pi 原生默认设置。

`B` 内的初始分配建议：热记忆/检查点 20%、最近完整执行组 55%、精确工作证据 15%、召回余量 10%。未使用预算可借用；用户原文和协议保护比比例更重要。

- 跨 soft 时批量缩减，回到 B；若胶囊化后仍超预算且允许检查点，则滚动。
- hard 是容量警戒，不是允许截断最新请求的许可。不可压缩工作集超限时，停止激进缩减并走原生恢复/提示用户拆分输入；本扩展不能靠吞掉约束实现硬保证。
- 图片、非 ASCII 文本、工具 schema 的 token 不能简单按字符/4 精确计算。使用宿主估算作为基础，保留安全余量，并用 provider 实际 usage 校准。
- `ctx.getContextUsage()` 可用于遥测，但不能只依赖上一请求的 usage 来评价新投影；边界候选必须重新估算。
- 切换到小窗口模型时立即重算预算，必要时先回退原生 compact，不沿用旧窗口目标。

### 缓存不是免费的

编辑早期工具输出或生成新检查点会破坏后续可缓存前缀。短输入未必比长但高缓存命中的输入便宜。

因此默认采用 epoch：在一个 epoch 内保留稳定检查点和自然追加的活跃窗口；有明确收益时批量胶囊化，达到软阈值或任务里程碑再换检查点。规则检查可以频繁，前缀修改要稀疏。

按 provider 记录 `input/output/cacheRead/cacheWrite` 与总成本；另计提取器成本、维护延迟、召回重读成本。优化目标是任务总成本和延迟，而非单次输入 token 最小。缓存命中高、工作集稳定时可以延迟换 epoch，但不能超过安全容量。

### 当前可观测性与 Graph View

每个完整 turn 追加 `rolling-context.telemetry.v1` custom entry，不进入模型 context，也不改变已有 prompt 前缀。记录原始/有效/候选投影 token 估算、hot/warm/checkpoint/other 分量、批次及 checkpoint 事件、工作 envelope 字节数和可获得的本轮 usage。未知值使用 null，不把未知缓存数据记为 0。

现有 daemon 只读消费当前 branch 的数值：session 页面提供 **Context Graph** 链接，显示 context size、composition、stateBytes 三张图和事件标记。Rolling Context 不导入 daemon，也不要求 daemon 存在才能运行。observe/off 同样记录 metrics；observe 的候选大小不是已提交的有效大小。

图表是宿主估算及已验证边界的测量，不是 provider 精确 tokenizer 或价格预测。manual/native hook 的 compaction 另有事件索引，下一完整 turn 反映其投影及 epoch；foreign compaction 不冒充 Rolling epoch。无持久 session 时 telemetry 随进程消失，不另存 transcript。

## 9. 回合处理流程与持久化

```text
完整 turn_end
  → 读取 event.context 的当前投影及之前扩展的草稿
  → 构造完整工具组，关联原始 entry ID
  → 处理当前组新证据、版本失效、约束与 focus 更新
  → 标记更早且被成功后续响应消费的组
  → 计算保护集合、覆盖范围与候选预算
  → 必要时调用受限提取器；失败则保守保留
  → 校验记忆变化和候选投影
  → 返回继承原草稿的状态记录 + 内容替换 + 可选检查点
  → 下一轮模型使用持久化新投影；不额外触发一次主 agent 回复
```

示意代码（不是实现，也不假定新增 API）：

```ts
pi.on("turn_end", async (event, ctx) => {
  const plan = await planner.plan({
    projected: event.context.contextEntries,
    rawBranch: ctx.sessionManager.getBranch(),
    messageEntryId: event.messageEntryId,
    toolResultEntryIds: event.toolResultEntryIds,
    pendingMessages: event.context.pendingMessages,
    outcome: event.outcome,
    signal: ctx.signal,
  });
  if (!plan.valid || plan.entries.length === 0) return;
  return { entries: [...event.entries, ...plan.entries] };
  // 不设置 continue；维护上下文不应额外续跑，也不能覆盖别的扩展的决定。
});
```

### 写入与崩溃恢复

- 规划阶段只用候选状态，不先修改权威内存游标。以真正落盘的 branch entry 重建提交状态。
- 先保存带来源的状态记录，再替换已经消费的工具结果，最后追加检查点。任意提交前缀都保留工具调用配对；状态先于裁剪可以重复，但不能先裁剪再丢事实。
- 不把一批草稿称作原子事务。重启后验证 snapshot 的覆盖和最近 checkpoint；仅有状态记录、没有 checkpoint 不能表示历史已收起。
- snapshot 和缩减包含内容哈希/版本，重复事件或恢复重跑不重复写相同变更。
- `outcome` 为 aborted/error 时默认不进行有语义损失的滚动；只保存确定性证据，在最终恢复后再判断。
- 同一会话多实例不承诺一致写入；沿用 pi 的会话写入约束，扩展侧检测可疑 leaf 变化后放弃当前计划，不直接改写 session 文件。

### 分支、重启及磁盘差异

- 用当前 branch 上最近可识别快照加后续增量恢复；缓存键包含 session ID、当前 leaf 与 revision。
- `/tree` 回到编辑之前，旧投影自然恢复；分支上不存在的 memory revision 也不得恢复。
- fork/clone 继承复制的来源 entry，随后独立更新；来源缺失则记忆降级为待核验。
- branch summary 表达「另一分支曾做过什么」，不等于本分支已执行相同修改。磁盘可能仍有另一分支改动，必须验证。
- 无 session 持久化模式只提供进程内管理，退出不可恢复。
- schema 不认识或迁移失败时停用对应状态更新、保留可用投影并允许原生 compact，不覆盖未知旧数据。

## 10. 安全和扩展共存

1. **保留系统语义**：不使用 `context_with_system` 重建 prompt，不移除权限规则或工具定义。
2. **不改变真实工具结果**：不在 `tool_result` / `message_end` 把原内容先截掉再保存；默认等原结果持久化、被消费后才写投影 edit。
3. **保留协议结构**：内容替换保持 `toolCallId`、`toolName`、`isError` 等原元数据；不编辑 assistant 的签名、thinking 和 tool calls。
4. **不依赖 provider 自动修复**：候选验证必须检查完整 tool call/result 对；不把合成错误结果当作可接受的日常淘汰方案。
5. **不把不可信输出升级成指令**：召回、胶囊、模型提取输入明确标成历史证据。项目文件里的「忽略用户要求」不进入用户约束。
6. **权限不旁路**：历史召回不运行 shell。若需要当前文件，使用既有 read 流程和当前授权策略；不以指纹刷新为理由暗读未授权路径。
7. **其他插件内容默认保留**：未知 custom message、branch summary 和系统变更不能无条件删除；检查点需要覆盖它们，否则不滚动。
8. **有意裁剪不可逆知觉**：如果其他扩展已经把内容脱敏/缩减，本插件不得从缓存重建被它隐藏的内容到模型输入。状态提取以当前授权投影为准；召回 raw 内容必须遵守同样的策略，无法证明兼容时禁用该召回。
9. **信息仍敏感**：历史并没有被删除；导出/分享仍可能包含原工具输出。默认不跨会话检索，不自动上传记忆，日志不包含密钥或大段文件正文。

MVP 同一 target 只允许本插件处理已确认没有其他编辑者的结果；发生竞争时保留现有投影并记录冲突。任何快照里的事实都不能凌驾于系统指令或用户最新要求。

## 11. 拟议的操作接口

以下均为未来实现计划：

| 接口 | 用途 |
| --- | --- |
| `/rolling-context status` | 当前模式、工作集估算、检查点 revision、保护/缩减数量、最近回退原因 |
| `/rolling-context on\|off\|observe` | 启用、停止新变更、只规划观测；首次发布默认 observe |
| `/rolling-context inspect` | 查看有效工作记忆、来源和 stale 状态 |
| `/rolling-context pin <item-id>` / `unpin` | 固定/解除记忆项；超预算时明确提示 |
| `/rolling-context checkpoint` | 空闲后请求一次受验证检查点，条件不足时解释原因 |
| `context_note` 工具 | agent 提交当前任务计划、task-decision、focus、next step；不写项目设计 |
| `context_recall` 工具 | 按来源/关键词/路径限量读取当前分支历史证据 |

`off` 只停止新裁剪，**不会自动还原已有 `context_edit` 或 compact**；它们属于会话历史，即使卸载插件也仍生效。需要原始状态时，可导航到检查点之前并建立新分支；已收起前缀不能仅靠改回一个结果内容重新加入当前 compact 后的上下文。

配置首版用扩展自有 flag/配置解析，不假定任意新增字段会被 pi 原生 settings 自动传入。核心配置包括目标 token、最小保护组数、检查点最小间隔、允许的工具适配器、提取器模型及费用上限。所有模式下核心逻辑一致，不依赖 TUI 对话框才能继续。

## 12. 建议实现结构与阶段

拟议文件（本次只创建文档，不创建这些实现文件）：

```text
extensions/rolling-context/
  index.ts                 # 事件、命令、工具注册
  lib/
    state.ts               # 分支重建、版本化快照、状态合并
    groups.ts              # 工具组、消费状态、保留边界
    adapters.ts            # read/bash/edit 等安全证据提取
    memory.ts              # 事实、冲突、覆盖、失效规则
    planner.ts             # 保护集合、缩减、epoch 检查点
    budget.ts              # 工作集估算与缓存收益
    recall.ts              # 分支内只读检索、分页与安全约束
    extractor.ts           # 可选受限模型提取
    telemetry.ts           # 成本、维护延迟、回退原因
  docs/design.md
```

### P0：观察模式

- 重建分支、关联 entry ID、统计原始/投影 token、识别完整组和候选。
- 不修改消息，输出为什么会淘汰/为什么必须保护。
- 用实际任务验证宿主版本和事件顺序，再决定默认预算。

### P1：可用 MVP

- 版本化记忆与确定性适配器、`context_note`、分支内 `context_recall`。
- 对已消费的纯文本工具输出做安全胶囊化；保留最新组及精确依赖。
- 在连续性和覆盖验证通过时做单 entry 滚动检查点；覆盖不足时回退原生 compact。
- 保留原生自动压缩。不实现多 entry 的完整工具组 omission，不任意删 thinking，不要求外部数据库。
- 原生阈值仍经常触发时说明策略覆盖不足，不默认关闭它来掩盖问题。

### P2：经过指标验证后的增强

- 可选小模型提取器、更好的主题识别、自动召回、provider 成本感知 epoch。
- 如需多 entry omission，先解决每个崩溃前缀的协议安全和恢复提交，再启用；不能仅声称「同一 turn 返回就原子」。
- 仅在关键词召回明显不足时引入向量索引；外部索引是可重建缓存，不是状态真相。

新增 `index.ts` 后才把它注册进根 `package.json`；现有 permissions/edit/daemon 的注册与行为不在本次变更范围内。

## 13. 测试和验收

### 单元/属性测试

- 完整组保留、并行结果、嵌套调用：嵌套 tool ID 不出现在 transcript 中，不能构造假的直接结果依赖。
- 工具输出必须至少经过一次成功后续响应才有缩减资格。
- 最新用户原文、图片、未知角色、未解决错误、pin 和精确 patch 依赖不被静默裁掉。
- 最新编辑获胜、来源合法、事实冲突、新文件版本使旧测试 stale。
- 所有候选投影满足调用/结果配对和安全保留边界；每个提交前缀也安全。
- 不重复摘要胶囊，不重复处理 revision；损坏/未知 schema、取消、提取超时不推进覆盖。
- 切换到更小模型窗口和不可压缩工作集超预算时正确降级。
- `context_note` 不能写入或 supersede 项目 intent；检查点分开显示相关 intent 和 task-decision；旧 intent 投影不可充当当前项目真相。

### 集成场景

1. 同一长用户任务多轮搜索/read/edit/test，至少发生两次滚动检查点；继续回答不重新做整仓初始调查。
2. 同一路径连续修改和重复测试；旧通过结果不代表新版本通过。
3. 大工具结果后紧接 steering、并行工具完成、取消和重试。
4. 手动 `/compact` 带指令、threshold compact、overflow/length 恢复及失败。
5. 重启、reload、`/tree`、fork/clone、切换 cwd/session，验证分支与磁盘状态不混淆。
6. 至少覆盖 Anthropic 与 OpenAI 风格 provider 的签名/工具协议及缓存行为。
7. 与 permissions/edit/daemon 共存；历史查看继续显示原始结果；新增记忆不触发额外主 agent 续跑。
8. print/JSON/RPC 中不用交互式 UI；`--no-session` 行为有明确边界。

### A/B 衡量

同一任务集、模型、预算和尽可能一致的缓存条件下比较：原生 append+compact 与 Rolling Context。不能只比较某一个漂亮的短 prompt。

记录：任务完成率、用户约束丢失/事实错误、协议错误、总 input/output/cache token、总费用（含提取和召回）、端到端时间、维护延迟、重新 read/重复调查数量、原生 compact 次数。

第一轮验收目标（待测，不是当前效果声明）：

- 协议错误及关键约束丢失为零；重启/分支回放测试全部通过。
- 工具输出主导的长任务中，中位总输入 token 降低至少 30%。
- 总费用和完成时间不因频繁缓存失效或提取开销显著回退；有回退的 provider 进入观察模式重新调参。
- 检查点后重复项目初始调查明显减少；合理的新鲜度重读不计为失败。
- 同步维护以规则路径为主；模型提取只在受限触发点执行，并公开其延迟与费用。

## 14. 待实测决策与参考

需要实现前/观察模式阶段确认：各 provider 的实际缓存收益、保护窗口大小、规则适配器能覆盖的工具结果比例、精确代码依赖识别可靠性，以及没有 agent 笔记时提取器是否足以维护下一步状态。默认目标 32k 和预算比例需按这些数据调整。

设计参考（pi 官方仓库）：

- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Sessions and Context](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)
- [Compaction Reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [Session Format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- [Message Types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/message-types.md)
- [custom-compaction 示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/custom-compaction.ts)
- [todo 状态重建示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/todo.ts)

精确实现契约以测试宿主版本的 `dist/core/extensions/types.d.ts`、`dist/core/session-manager.d.ts` 及对应实现为准；上游 main 文档可能随版本变化。
