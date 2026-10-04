# Design Intent 设计方案

具体存储格式校验、审批提交、查询投影和检查流程见 [implementation.md](implementation.md)。本文保留总体设计与职责决策。

## 1. 职责与边界

本插件回答「项目为什么应该这样设计」，统一维护：

- 长期 requirements：系统需要满足的能力、行为和非功能要求。
- Architectural invariants：长期不能随意破坏的架构边界或性质。
- 关键设计决策及理由、适用条件和权衡。
- 被否决方案及否决原因，防止以后无依据地重复提出。
- 决策之间的 supersede、conflict、dependency 关系及演化记录。

**Design Intent 是项目级长期真相的维护者；Rolling Context 是当前任务执行记忆的维护者。** 本插件不做会话裁剪、checkpoint、token/cache 调度、工具历史归档或测试状态管理，也不保存 Rolling Context 的工作记忆。

任务里的「先改 parser，再补测试」是 `task-decision`；「所有修改必须经过统一文件队列，以避免并发写入破坏状态」才是可能的项目级 intent。后者也必须经显式批准才能生效，不能因 agent 写了代码或测试通过就自动晋升。

优先采用普通 TypeScript 插件、一个 JSON 项目文件、少量查询工具与命令。不引入图数据库、向量库、独立服务、通用工作流引擎或自动架构推理框架。

## 2. 单一来源与存储

默认项目文件：`<project-root>/.pi/design-intent.json`，可进入 Git，由项目正常评审流程管理。项目根优先显式配置，否则使用受信任的仓库根；非仓库使用明确选定的工作目录。不跨项目自动搜索或合并其他意图库。

- **项目文件是权威来源**，不是 pi session JSONL。每个插件实例都从文件读取当前状态。
- 会话中只保存待审提案、查询结果、检查报告及来源引用；这些都是提案或缓存，不是第二份权威库。
- 原有设计文档可被引用或导入为提案，不默认将整篇文档视为已经批准的 intent。
- 文件缺失表示「尚未建立 Design Intent」，不能声称项目没有要求；读取/解析失败表示「不可用」，不能当作空集合继续宣称无冲突。
- 文件之外的普通项目文档仍保留。被采纳的意图正文进入此文件，外部文档保存证据/详细背景引用，避免两个来源同时维护同一决策状态。

### 最小数据结构

以下为拟议 schema，不是 pi 原生 session entry 类型：

```ts
interface IntentRecord {
  id: string;                  // 项目内唯一，如 DI-0007；不与会话 MemoryItem 共用 ID
  kind: "requirement" | "invariant" | "decision" | "alternative";
  title: string;
  statement: string;           // 必须满足什么 / 采用或拒绝什么
  rationale: string;           // 为什么，含必要权衡；不得为空
  scope: { paths: string[]; tags: string[] }; // paths 为空表示项目全局适用
  status: "accepted" | "rejected" | "superseded";
  supersedes: string[];
  conflictsWith: string[];
  dependsOn: string[];
  sources: Array<{ kind: "user" | "document" | "proposal"; ref: string }>;
  review: { note: string; recordedAt: string }; // 显式批准/否决的记录，不是认证签名
  createdInRevision: number;
}

interface IntentStore {
  schemaVersion: 1;
  revision: number;
  records: IntentRecord[];
}
```

`proposed` 不进入这个权威集合；提案存在当前 session 的工具结果 `details`，包括完整拟议内容、目标关系、理由、源文件路径、基础 revision 和内容哈希，按当前 branch 重建。用户批准或否决后才写入项目记录。

批准后正文、理由和 scope 不原地改写；变更使用新的 ID 和显式 supersedes。旧记录保留正文与来源，状态更新为 superseded；存储 revision 单调增长。关系数组足以表达演化，无须构建新的框架。

## 3. 记录、批准与演化规则

### 3.1 显式入口

1. 用户或 agent 发起提案，写明要求/决策、原因、范围、依赖及可能冲突。
2. 插件做结构与关系检查，展示新增内容、影响记录以及项目文件差异。
3. 用户明确批准或否决。默认只通过用户命令写入权威文件，模型工具没有 accept/supersede 权限。
4. 批准后才成为 accepted；否决后保留 rejected 方案和理由。提案不因任务结束、测试成功或 checkpoint 自动批准。

若内容由用户直接维护在受信任项目文件中，则沿用项目的人工 review/Git 流程。本插件不声称能阻止 bash/edit 绕过命令直接改文件，也不把 JSON 中的 review 字段当成防篡改证明。

### 3.2 Supersede

- 新提案列出将替代的 accepted ID、替代理由及依赖影响。
- 新内容获批时，在同一次文件更新中新增 accepted 记录并将目标设为 superseded。
- 不删除旧记录，也不从「新代码已经这样实现」倒推出旧决策失效。
- 防止自引用、循环 supersedes、引用不存在的 ID，以及默默替代 rejected/已经 superseded 的目标。
- 被旧 intent 依赖的其他记录不会自动迁移到新 intent。将这些依赖标为需复核，并在查询中显示，直到显式提案修正。

### 3.3 Conflict

- `conflictsWith` 是明确记录的语义冲突，不是一次任务中的测试失败。
- 关系按无向对解释：任一端列出即可被双方查询发现；验证器拒绝自引用及不存在的 ID。
- accepted intent 之间的已知未解决冲突必须显式显示，不能静默选择「较新」的记录。
- MVP 不接受一个带已知未解决 active 冲突的新提案；用户须在提案中明确替代/调整相关 intent，或澄清 scope 后重新提交。
- 外部编辑引入的冲突只报告，不自动修复文件。没有声明关系不代表逻辑上不存在冲突；语义判断仍需要人工或有证据的检查。

### 3.4 Dependency

- `dependsOn` 表示一个 intent 的成立依赖另一个 accepted intent。
- 创建时检查目标存在且 accepted，拒绝自引用和循环依赖；小规模数组遍历即可。
- 依赖项被 supersede 后，依赖它的记录仍是历史上的 accepted，但查询有效性显示 `needs-review`，不称其依赖仍满足。
- `needs-review` 是派生诊断，不引入另一套持久化生命周期。解决它必须通过 Design Intent 的显式更新，不由 Rolling Context 改状态。

### 3.5 用户请求与项目约束冲突

项目 intent 是项目约定，不高于系统指令，也不能成为忽略用户的理由。当前请求可能要求改变长期设计：先显示冲突和影响，请用户澄清「遵循现有 intent」还是「明确修改 intent」。后者仍须通过显式批准流程保存。

Rolling Context 可以记录该冲突为任务阻塞，或保存当前任务的执行计划；不能通过更新 `task-decision` 使项目 intent 消失。获批设计也不等于代码已符合该设计。

## 4. 查询与有限上下文投影

### 只读查询

`design_intent_query` 根据当前请求、路径或标签返回相关 accepted 记录：全局约束优先，其次路径匹配与关键词命中，并带必要依赖和冲突提示。MVP 使用普通路径/关键词匹配，不做 embedding。

`design_intent_get` 按 ID 获取完整正文、理由、状态及演化关系，默认从**当前项目文件**读取，不从会话摘要重建。历史 rejected/superseded 项可显式查询，不能冒充当前约束。

查询投影采用一个小数据对象：

```text
storePath、storeRevision、sourceHash
items：id、kind、status、简短 statement/rationale、必要关系及 needs-review
truncated、未展开的 ID、待核验/冲突提示
```

返回内容有条目数和 token 上限。不能为了短而扭曲 invariant；正文太长时给出 ID、范围和「必须展开」标记，后续用 get 读取。相关集合超预算时报告不完整，不宣称已经检查全部约束。

### 与 pi 运行流程结合

- `session_start` 识别项目文件并初始化轻量读取缓存；工厂只注册事件、工具、命令，不创建后台服务。
- `before_agent_start` 可读取项目文件，用 `message` 返回一次带 `customType: "design-intent.projection.v1"` 的小投影，提供全局约束和按当前请求匹配的 intent。不强制替换整个 system prompt。
- 精确路径在任务入口尚不明确时，用 query/get 补充。任务入口注入不证明检索已经完备，agent 在关键改动前仍需查询相关路径。
- `turn_end` 不裁剪历史、不生成 compact，也不改变其他扩展的 continuation。修改后是否检查由显式 check 工具/命令决定，首版不每回合调用额外模型。
- 任务入口、query/get/check 以及生成新检查点前所需的意图刷新，均通过 Design Intent 读取当前文件。无文件变化的投影可复用，变化后重新查询；Rolling Context 不自行重新解释源文件。

查询结果和入口投影是带版本的观察。源文件可能在同一任务中变化，因此执行设计敏感操作前必须重新查询，检查报告也必须说明所用版本。旧 checkpoint/历史工具结果不代表当前 intent。

插件独立运行时这些工具、命令和入口投影照常可用；不依赖 Rolling Context 的加载顺序、内部模块或状态格式。

## 5. 用实际修改检查 intent

拟议 `design_intent_check` 输入：相关路径或选定的变更范围，以及可选 intent ID。工具读取当前 intent 和实际 diff/文件/测试证据；当前任务的修改账本只能帮助选范围，不能代替检查实际文件。

输出按 intent 分列：`violation`（有明确违背证据）、`no-violation-found`（在所检查范围未发现）、`unknown`（证据不足/无法判断），并附当前 source revision/hash、检查范围与代码/测试来源。

- 先用已有测试、显式约束和可确定判断的规则；MVP 也支持 agent 组织证据的手动检查。
- 自然语言 requirement/invariant 不承诺可机械验证。可选模型辅助只能给有证据的报告，不能自动批准、否决或改变 intent。
- 没有相关 intent、选择不完整、测试缺失、diff 获取失败、源文件变化时，都不能输出「项目设计验证通过」。检查期间版本变化则标为过期，重新查询。
- 检查是 advisory，不是安全沙箱或强制架构 gate。自动阻止 edit/bash 不是首版目标。
- 冲突报告交给当前任务处理：修复实现、补充证据或提出意图变更；不会反向把实际代码作为新设计真相。
- 文件和 diff 访问沿用用户授权与已有工具/权限流程，不以检查为理由暗读其他目录或自动运行不可信脚本。

## 6. 拟议接口与写入安全

| 接口 | 行为 |
| --- | --- |
| `design_intent_query` | 只读，按任务/路径/标签提供相关投影 |
| `design_intent_get` | 只读，按 ID 提供完整意图、理由及演化 |
| `design_intent_propose` | 保存当前分支的提案；不写项目权威记录 |
| `design_intent_check` | 用实际改动生成限定范围、带证据的报告 |
| `/design-intent status` / `show <id>` | 文件、版本、有效意图、冲突和待复核依赖 |
| `/design-intent review <proposal-id>` | 显示提案与将写入的差异 |
| `/design-intent accept <proposal-id>` | 用户确认后保存；含显式 supersedes 的提案同样走此入口 |
| `/design-intent reject <proposal-id> <reason>` | 用户明确否决并记录方案与理由 |

写入只修改一个 JSON 文件：先校验 schema/关系，再核对提案的基础 revision 与哈希，确认准确差异后提交。内容已改变则拒绝旧提案，要求重新 review，不尝试自动语义合并。

实现使用工作目录的文件修改队列，在提交时获取短期独占文件锁，锁内重读并验证基础版本，通过同目录临时文件 + rename 写入。锁竞争或无法确认过期锁时失败并请求重试，不抢写。队列只覆盖本进程，锁才用于本插件实例间互斥；这不能防止不遵循锁的外部编辑器改写。

原记录状态变更和新记录写入在同一个文件版本提交，不把 supersede 分散成几次写入。提交点前失败不增长 revision，不先发送成功事件；提交点后的响应/持久性失败需重新对账，不能声称已撤销，详见实现文档。确认是插件的设计审批流程，仍需遵守已有文件权限机制。

有 UI 时，accept/reject 命令展示精确差异并要求确认；非交互环境默认不提交，必须由操作者提供明确的 proposal ID、预期源哈希及确认选项。模型调用工具不能借此获得批准权限。

## 7. 项目分支、会话分支与恢复

- intent 跟随项目文件/Git 分支，不跟随 pi 会话树自动回滚。
- `/tree`、fork、clone 只影响会话提案和任务记录。回到旧会话时，Design Intent 仍读取当前磁盘上的项目真相。
- 切换 Git 分支或更换项目文件会刷新来源哈希和投影；Rolling Context 中旧引用只作为历史参考，不沿用旧批准状态。
- 提案依赖其创建时的项目路径/版本；切换项目或基础内容变更后不得直接批准。
- 进程退出后，accepted/rejected/superseded intent 仍在项目文件；会话提案按 pi 的持久化能力恢复。`--no-session` 下未批准提案退出即丢失。
- Git merge 造成不合法 JSON、重复 ID 或关系冲突时，报告不可用/需人工解决，不自动选择一侧。

## 8. MVP 与验收

建议首版仅有 `index.ts` 和三个小模块：`store.ts`（读写/验证）、`query.ts`（筛选/投影）、`proposals.ts`（当前分支提案与确认）。检查报告可先在工具处理器中实现；有实际复杂度再拆模块。

实现顺序：

1. 只读文件、schema 校验、query/get、任务入口小投影。
2. 会话提案、review/accept/reject、单文件安全写入与关系验证。
3. 显式改动检查、检查点引用集成；模型辅助评估在有需求时再加。

最小验收：

- `task-decision`、`context_note`、测试通过及任务完成均不能直接修改权威文件。
- 批准/否决有理由与来源；supersede 保留历史；拒绝循环、悬空引用和未解决 active 冲突。
- 依赖被替代时显示 needs-review，不自动迁移依赖或声称仍有效。
- 并发审批拒绝过期基础版本；失败或取消不写半个 supersede。
- 旧 session/checkpoint 不恢复旧项目真相；Git 分支变化和损坏文件有明确诊断。
- 检索截断、未知语义、证据不足、检查过程中源版本变化不会误报完全符合设计。
- 两插件可独立加载；Design Intent 不修改 Rolling Context 状态、工具历史、预算或续跑策略。

宿主接口沿用 Rolling Context 已核对的 pi 扩展契约；实现时需复核测试版本的 `before_agent_start` 返回类型、工具 result/details 与命令 context。文件读写和确认逻辑需要遵守现有权限插件，不能仅把“用户批准设计”视作所有文件操作已授权。
