# Design Intent 实现细节设计

状态：本文是实现蓝图；当前代码为已接入包清单的**受限 MVP**，具备版本化存储/查询/提案/显式审批、哈希复核、文件锁及原子替换。模块集中于 `index.ts`、`lib.ts`，不是本文所有建议能力均已交付。上层决策见 [design.md](design.md)，职责边界见 [integration.md](integration.md)。

当前限制：项目根固定为受信任的 `ctx.cwd`，不扫描仓库父目录；文件检查只读取用户选定路径并返回 `unknown`，不会生成 Git diff 或自动判定 pass/violation；审批 UI 显示候选记录/关系的变更说明，非交互审批使用 `--design-intent-confirm PROPOSAL:ACTION:SOURCE_HASH:CANDIDATE_HASH` 精确绑定参数。Store 读取使用 no-follow fd 和 1 MiB bounded read；但 Node 的 path-based rename API 不提供 openat/renameat 目录句柄 CAS，父目录被恶意并发替换及非协作写入仍有窄竞态。目录 fsync、外部写入 CAS 和多进程崩溃恢复仍受普通文件系统约束。

## 1. MVP 的固定选择

- 使用单一项目文件 `.pi/design-intent.json`；项目真相不写入 Rolling Context 的状态库。
- accepted/rejected/superseded 记录、理由和关系在同一 JSON 中维护；proposed 只存在当前会话分支。
- 普通 TypeScript 函数、TypeBox 校验、数组/Map 检索；不引入数据库、服务或通用决策框架。
- 模型只能 query/get/propose/check；审批只能由用户命令显式完成。
- `task-decision` 不自动导入、批准或替代 intent。实际代码和测试只能作为检查证据。
- 初始支持并测试 pi `1.0.0`。根 export 和真实结果类型为准，不调用宿主私有 API。

## 2. 文件布局和模块职责

```text
index.ts                 # 薄注册层：事件、四个工具、一个命令入口
lib/store.ts             # schema、项目身份、读取、hash、诊断、安全提交
lib/query.ts             # 关系诊断、筛选、投影与分页、有限检查报告
lib/proposals.ts         # 提案校验、分支重建、候选变更、review/accept/reject
```

类型/schema 可先留在 store.ts；检查变复杂后再拆 check.ts，不预建 repository/service/controller 多层架构。

关键函数：

```ts
resolveProject(ctx: ExtensionContext, config: Config): ProjectIdentity
loadStore(project: ProjectIdentity, grant: ReadGrant): Promise<LoadedStore>
validateStore(store: IntentStore): StoreDiagnostic[]
deriveValidity(store: IntentStore): Map<string, IntentValidity>
query(store: LoadedStore, request: QueryRequest): IntentProjection
rebuildProposals(branch: SessionEntry[]): ProposalIndex
buildCandidate(store: LoadedStore, proposal: Proposal, action: ReviewAction): Candidate
commit(candidate: Candidate, approval: Approval, signal?: AbortSignal): Promise<CommitOutcome>
```

load/commit 是 I/O 边界；关系、查询和候选变更是纯函数。每次提交在锁内重新构造 candidate，而不是直接保存 review 时缓存的对象。

## 3. 项目身份、路径与访问授权

`ProjectIdentity` 包含 canonicalRoot、canonicalStorePath 和 cwd。解析顺序：操作者指定 root → 当前受信任仓库根 → 非仓库明确选择的 cwd。用 `.git` 目录或 worktree `.git` 文件判断仓库位置，不执行 shell 脚本；解析结果必须经过读取授权。

路径使用 `realpath`/父目录解析和 `lstat`，不能靠字符串 startsWith 判断归属。MVP 拒绝把存储文件或 `.pi` 目录写到符号链接目标；路径变化时在提交前重验。非标准 root、仓库父目录在 cwd 之外时不自动读取。

### 不能假定 permissions 自动保护扩展 I/O

当前 `extensions/permissions/index.ts` 的工具 hooks 不会拦截生命周期/命令中的 `fs.readFile`、`rename` 或直接 subprocess。Design Intent 必须有自己的**限定文件访问检查**，不能仅声明工具 readOnlyHint 就视为授权。

- 受信任、位于当前 workspace 内的固定意图库，可以按已启用的项目读取配置获得 read grant；grant 只覆盖该 JSON 文件，不覆盖 sources 指向的外部文档。
- 无明确 grant 时，工具/用户命令可询问“读取这个准确路径”；没有 UI 默认不读。提供操作者专用 `--design-intent-read` 显式允许当前所选固定文件；它不是网络或全目录授权。
- 自动 `before_agent_start` 注入只使用已经获得的 read grant，不在每个新请求里弹框。未授权返回清楚的 unavailable 提示，让用户主动配置。
- outside-cwd 的 root 不靠 read flag 默默放行。MVP 要求操作者在项目根运行，或显式确认该准确文件的额外授权；不能借项目根发现暗读上级目录。
- accept/reject 的确认包含目标文件、可能创建的 `.pi` 目录、临时文件和 lock 副作用。模型提案不是写授权；auto permission review 也不等同项目设计批准。
- 检查实际代码/diff 在工具 context 中通过 `ctx.executeTool("read"/"bash", { intent, ... })` 执行，经过现有工具参数校验和权限流程。没有该工具或被拒绝则 unknown，不降级为私有 fs/exec 绕过。

这里的 grant 是本插件内部的一份限定授权记录，不新建公共权限框架，也不改变 permissions 的模式。无法与现有授权约定兼容时禁用对应自动访问，而不是宣称已经统一授权。

## 4. 权威文件 schema 与读取

沿用 design 中 `IntentStore/IntentRecord`。实现 schema 明确：

- `schemaVersion` 必须为 1，revision 为非负 safe integer；record 数组上限初始 1000。
- ID 采用 `DI-[0-9]{4,}`，唯一；kind/status 仅允许已有枚举。
- title、statement、rationale 非空，长度分别上限 200、8000、8000 字符。
- paths/tags/关系数组去重，数量有上限；source/ref/review.note 有长度限制，不自动执行 ref 内容。
- scope.paths 使用项目相对 POSIX 路径；拒绝绝对路径、`..` 和 NUL。MVP 支持确切文件/目录前缀，不实现任意 glob。空数组意味着项目全局适用。
- createdInRevision 必须在当前 revision 范围内；历史正文不可在审批路径中原地改写。
- 拒绝未知 schema 版本与不合法字段，输出定位到 record ID/字段的错误，不用空库替代损坏库。

读取上限初始 **1 MiB 原始字节**。StoreIO 先限制读取大小，再解码 UTF-8、解析、校验；超限报告 store-too-large，不能用截断 JSON 继续运行。

`sourceHash = sha256(rawFileBytes)`，用于检测外部编辑、空白改变及未递增 revision 的修改。投影/提案引用 raw hash，不仅靠 revision。写出为固定字段顺序、缩进 2 空格、末尾换行，减少 Git 噪声；不因查询重新格式化文件。

`LoadedStore` 是判别联合：

```ts
type LoadedStore =
  | { state: "ready"; storePath: string; store: IntentStore; sourceHash: string; diagnostics: StoreDiagnostic[] }
  | { state: "missing"; storePath: string }
  | { state: "unavailable"; storePath: string; code: string; message: string };
```

missing 用于首次建立提案，baseRevision=0、baseHash="missing"；磁盘后来出现任何文件就使该提案过期。读取失败、权限拒绝、损坏 JSON、重复 ID、悬空引用是 unavailable，不能初始化新空库覆盖它。

缓存按 canonicalStorePath + sourceHash 建立。每次 query/get/check/入口注入执行有界读取与 hash 检查，不只依赖 mtime/size；相同内容复用解析/索引。不使用 watcher 或后台轮询；缺失、拒绝和损坏不能沿用旧缓存冒充当前来源。

## 5. 关系校验与有效性

使用 `Map<id, record>`，正向依赖和反向影响索引；DFS 三色标记验证 dependency/supersede DAG。没有数据库层。

### 两种校验结果

- **结构性错误**：schema、重复 ID、悬空关系、自引用、循环或历史状态不自洽；文件不可作为当前有效集合。
- **可展示的项目诊断**：accepted 项之间已声明的冲突，或 accepted 项依赖 superseded/rejected/needs-review 项；文件仍可读，但必须显示 conflict/needs-review，不能输出完整有效。

派生状态不写回文件：

```ts
interface IntentValidity {
  usable: boolean;
  needsReview: boolean;
  conflicts: string[];
  dependencyProblems: string[];
}
```

accepted 的有效依赖问题向上游传播，不能因直接依赖仍是 accepted 就忽略其更深层失效。superseded/rejected 不进入当前约束候选；显式 get 仍能返回历史。

Conflict 对按无向边处理；仅两个 accepted 端点构成 active conflict。scope 不同也不自动取消已经显式声明的冲突，必须通过新提案澄清关系/范围。

### 候选批准的额外规则

- 新依赖必须指向候选提交后仍 accepted 且无已知依赖问题的记录。
- supersedes 只能指向当前 accepted 目标；候选中新记录保持正文，新旧状态一并验证。
- 拒绝新增未解决 active conflict；允许把冲突目标明确 supersede 后解决这条 active 冲突。
- 已有依赖项被新记录 supersede 时，旧依赖者显示 needs-review，不自动改 dependsOn。
- 结构无错不代表已经发现全部语义冲突；工具报告和 UI 必须保留此限定。

## 6. 查询、投影与 Rolling Context 数据契约

工具参数都要求短 `intent`，TypeBox `additionalProperties:false`，并在运行时限制数组和字符串长度。

```text
design_intent_query: text?, paths?, tags?, cursor?, maxTokens?
design_intent_get:   id, cursor?, maxTokens?
```

query 稳定排序：全局 requirement/invariant → 路径命中 → 标签/词项命中 → 必要依赖和冲突端点；同优先级按 ID 排序。查询不会因记录新就忽略旧 accepted requirement。

拒绝 arbitrary expression/regex 输入。中文关键词初版按规范化词项和直接子串匹配，结果可解释；精确 ID 与路径查询是必要补充，不假装这是完备的语义检索。

### 版本化投影 envelope

```ts
interface IntentProjection {
  type: "design-intent.projection.v1";
  availability: "ready" | "missing" | "unavailable";
  storePath: string;
  storeRevision?: number;       // 仅 ready 有效
  sourceHash?: string;
  items: Array<{
    id: string;
    kind: IntentRecord["kind"];
    status: IntentRecord["status"];
    statement: string;
    rationale: string;
    needsReview: boolean;
    mustExpand: boolean;
  }>;
  diagnostics: Array<{ code: string; ids: string[]; message: string }>;
  omittedIds: string[];
  truncated: boolean;
  nextCursor?: string;
}
```

工具返回 `content` 中的可读投影、同 schema 的 `structuredContent`，以及 `details: { type: "design-intent.query-result.v1", projection }`。query 项包含来源/关系摘要，并在当前页补直接 dependency/conflict endpoint；get 返回完整单条 record（包括历史 status、scope、关系、sources、review、revision），不把 superseded statement 混入当前约束区。

入口 custom_message 使用 `customType: "design-intent.projection.v1"`、content 为人类可读视图、details 为该 envelope。Rolling Context 只识别这一小契约，不 import store/query 模块。

默认 query 1500、入口投影 1000、get 3000 估算 tokens。声明过长时用**原文摘录**与 mustExpand 标记，不用自由摘要改写 invariant；所有省略、未展开 dependency/conflict 和 token 不足必须列诊断。尤其全局约束无法全部纳入时，truncated=true，不宣称“相关约束已完整提供”。

opaque cursor 编码查询参数 hash、canonical storePath、raw sourceHash、预算和下一页 offset。文件内容、查询条件或预算变化后旧 cursor 失效，返回 `STALE_QUERY_CURSOR`，要求重新 query；cursor 不作为授权凭据。get 是完整单记录读取，不分页。

## 7. 提案持久化与分支恢复

`design_intent_propose` 参数是 draft record（kind/title/statement/rationale/scope/关系/source），不含 status、review、正式 DI ID。创建提案时对当前 source revision 校验所有关系端点存在且 accepted；批准时锁内重新验证候选与冲突/依赖，再展示会受 supersede 影响而进入 needs-review 的既有记录。固定权限仅为“生成提案”。

```ts
interface Proposal {
  type: "design-intent.proposal.v1";
  proposalId: string;
  storePath: string;
  baseRevision: number;
  baseHash: string;
  draft: IntentDraft;
  proposalHash: string;
}
```

proposalId 由首次创建的 session ID 与 toolCallId 派生；fork/clone 复制已有提案时保持该 ID，不改来源身份。工具设 sequential，返回 content 提示“尚未批准”和 `details: Proposal`，不先写入权威文件。

工具的声明与实际变更必须匹配：提案是会话状态写入，不是项目文件写入。返回前验证 kind 与关系，不从 context_note 偷取内容隐式建立提案；agent 若要长期化，必须显式调用 propose 并说明理由。

重建从当前 `getBranch()` 的该工具结果及本插件命令 custom entry 扫描。nested propose 不产生直接结果 entry，不能指望父工具总会保留 details；MVP 为该工具设 `exposure:"model-only"`，避免通过 codemode 嵌套调用丢失提案持久化。query/get/check 保持可调用。

批准后写入 `sources` 的 proposal ref（含 proposalId/proposalHash），用于权威文件中幂等查找；另可 `pi.appendEntry("design-intent.review.v1", receipt)` 记录会话回执。回执失败或切换到旧分支，不能使已经写入项目文件的批准倒退。

重复审批先在当前项目文件查同 proposal ref 和 hash：已提交则返回原 record/action；不同动作或不同 hash 报冲突，不再新增记录。session 回执不是检查是否已批准的唯一依据。

## 8. 候选变更与用户 review

用户命令 grammar：

```text
/design-intent status
/design-intent show DI-0007
/design-intent review <proposal-id>
/design-intent accept <proposal-id>
/design-intent reject <proposal-id> <reason>
```

accept/reject 默认 `await ctx.waitForIdle()`，然后重新取项目/session/branch，不在旧 context 上继续操作。命令没有 executeTool，不能假装通过它调用另一工具。等待/确认后 session、项目或 proposal 改变就终止本次审批。

review 是纯预览：检查基线，按当前记录最大数字 ID + 1 分配候选 DI ID，构造下一个 revision，生成准确 JSON diff、影响列表和 candidateHash。真正分配以锁内同基线重建为准；基线相同必须得到相同候选。

accept：新增 accepted；明确 supersedes 的目标一并设 superseded。只更改批准所允许的状态，不改历史正文/理由/scope。

reject：新增 rejected 记录与用户否决理由，**不执行 draft 中拟议的 supersedes**。实际 supersedes 字段置空；拟替代的目标和未采纳理由明确保留在记录理由/来源中，并纳入给用户确认的差异，避免 rejected 提案真的替代旧设计。

若需要修改 approved 内容/依赖，必须用新提案和 supersedes。MVP 不提供任意 patch accepted record 的模型工具，也不自动修复语义关系。

UI 审批展示：完整 statement/rationale、源版本、关系影响、受影响依赖、文件差异及 file/lock/temp 副作用；随后 confirm。不能仅确认一句“是否接受？”而不展示关键差异。超长内容先 review/分页，未展示的内容不自动批准。

无 UI 默认不提交。当前非交互入口要求 `--design-intent-confirm=<proposal-id>:<accept|reject>:<source-hash|missing>:<candidate-hash>`；该值必须逐字匹配当前预览候选，陈旧 hash 会失败。command/RPC 被视为用户控制通道，但不是认证防篡改机制；不得宣称可以阻止恶意 shell 直接改文件。

## 9. 单文件提交、并发与崩溃

审批确认在锁外完成，不能持锁等待人类。确认绑定 proposalHash、baseHash/revision、candidateHash、canonicalStorePath 与准确写入副作用。

提交步骤：

```text
确认完成，复核 session/project/proposal
→ withFileMutationQueue(ctx.cwd, ...)
→ 验证路径和写授权，必要时创建已批准的 .pi 目录
→ open .pi/design-intent.json.lock，wx 独占
→ 锁内重新读 raw bytes/hash/schema/关系
→ 比较 expected base，检查重复提交
→ 重建 candidate 并比较已确认 candidateHash
→ 写同目录唯一 .tmp 文件，flush/fsync 并关闭
→ 再核对源 hash/路径；取消则在 commit point 前退出
→ rename(tmp, store)                 // commit point
→ 能支持时 fsync 目录，重读核验结果
→ 释放自身 lock，更新缓存/回执并报告
```

当前 edit 插件用 `withFileMutationQueue(ctx.cwd)`，所以这里先沿用相同键，减少同一 cwd 的冲突。宿主队列实际上按传入路径 realpath 串行化，不是自动“所有文件写入队列”；别的 cwd 或不同键仍可能并行，因此 canonical store lock 和 expected hash 必不可少。

lock 记录随机 token、PID 和创建时间，仅删除自己拥有且 token/inode 一致的 lock。已有 lock 时立即 busy，不等待到 UI 超时，也不因年龄大就自动抢锁。崩溃遗留 lock 交由用户确认进程已退出后人工处理；MVP 不实现复杂 lease。

临时文件使用独占创建，只清理本次拥有的文件。保留已有文件权限，默认新文件权限限制为项目所需；不扫描删除所有 `.tmp`。symlink/父目录归属在持锁时再次核验。

### 提交结果不是简单成功/失败二分

```ts
type CommitOutcome =
  | { state: "not-committed"; code: string }
  | { state: "committed"; revision: number; sourceHash: string; recordId: string; warnings: string[] }
  | { state: "uncertain"; proposalId: string; message: string };
```

rename 前失败/取消：不增长磁盘 revision，不改变旧状态。rename 后取消、目录 fsync/回执失败：不能报告“已撤销”，也不能盲目再生成一个 DI ID；以重读文件和 proposal ref 对账，报告 committed-with-warning 或 uncertain。下一次同提案审批先幂等核对。

这是原设计“失败不增长 revision”的具体边界：保证覆盖提交点前失败；提交点后需报告可确定的新状态或不确定状态。电源故障持久性取决于平台/文件系统，不能把 rename 说成跨平台完整事务。

多个遵循本插件锁的实例不会覆盖过期基线；不遵循锁的编辑器仍可能在最后核验与 rename 间写入，普通文件系统没有通用 CAS。文档和审批 UI 不宣称消除了这种外部竞争，工作流要求提交期间避免外部编辑。Git merge 冲突不做自动语义合并。

## 10. 实际修改检查

当前实现的 `design_intent_check` 参数只有 intent、paths、可选 intentIds；不支持 `working-tree/index/base-commit` 范围。它仅逐文件调用授权 `read` 工具，不执行 git/bash，也不推断 staged/untracked/完整变更集。拒绝绝对路径、NUL 和 `..`；只读取所选 accepted intent 覆盖的 project-relative path。

当前所有语义结论均为 `unknown`。输出的 `complete` 只表示所选文件证据完整收集（非拒绝、非截断且 intent source 未变化），**不**表示意图符合。拒绝/缺失/截断证据不会给通过；检查前后 raw source hash 不同会把本次结果标 stale 并要求重试。未发现适用 intent、未授权或 ID 缺失也保持 unknown。

以下 Git diff/index/untracked 覆盖步骤仍是后续蓝图，当前未实现：

工具流程：

1. 读取当前意图库，确定 relevant 集合及依赖/冲突；未建立/不可读/选择截断留下 unknown。
2. 通过 `ctx.executeTool` 调用授权 bash/read。Git 查询选用固定的只读形式（如 `git --no-pager diff --no-ext-diff --no-textconv ... -- <paths>`），转义参数并让实际命令仍接受权限检查；不执行项目自定义脚本。
3. 覆盖 staged/unstaged 与未跟踪文件时明确逐项记录；普通 `git diff` 不包含 untracked，不能称它覆盖所有实际改动。非 Git 项目可检查指定当前文件，但不声称有完整 diff。
4. 保存已取得证据的 hash、路径/范围、输出是否截断及测试来源。read 无完整字节/范围时只记录片段证据，不冒称当前整个文件指纹。
5. 规则/人工证据形成每个 intent 的限定报告；提交前再次检查意图库 sourceHash，变化则标 stale，不混用两版状态。

路径参数先规范化为项目相对路径，拒绝 traversal、NUL 和未知选项；sources.ref 不直接作为 shell/path 输入。报告只证明所记录证据快照中的限定观察；检查中无法证明代码稳定时记录非一致快照/待复核，后续修改后的报告不能继续当当前验证结果。

不从文本 rationale 自动生成可执行规则。MVP 无可靠机器 checker 的自然语言条目返回 unknown；agent 可组织来源和说明，但其判断标为 agent assessment，而非已证明的 invariant。可选模型评估留 P2。

报告 schema：

```text
type=design-intent.check.v1
storePath/storeRevision/sourceHash，选择与证据范围，truncated/stale
results：intentId、violation/no-violation-found/unknown、reason、evidenceRefs
```

no-violation-found 只允许在指定条目/范围和有证据的规则下输出；不是项目合规证书。确定 violation 必须引用明确代码/测试证据；scope 不全、拒绝访问、测试未执行、diff 截断或语义不明不能给“通过”。

工具默认不自动执行测试。现有测试输出可作为有时间/版本限定的证据；若用户要求实际跑测试，走既有 bash 授权流程，并区分它可能写缓存/产物。检查结果不改意图文件，可被 Rolling Context 保存为当前任务证据。

## 11. 生命周期与失效规则

| 事件/入口 | 工作 |
| --- | --- |
| 工厂 | 注册工具、命令和 flags；不读项目文件或启动 watcher |
| `session_start/session_tree` | 清会话缓存、恢复当前分支提案，按当前项目重新定位文件 |
| `before_agent_start` | 有 grant 才重新读源并返回有限入口投影；只用 message 返回，不替换系统 prompt |
| query/get/check | 每次核对 raw hash，变更时重算；失败不能用旧缓存充当当前真相 |
| propose | 读取基础版本、返回会话提案 details；不写项目文件 |
| accept/reject command | 等 idle、准确确认、锁内提交；不启动主 agent 回复 |
| `turn_end/agent_before_settle` | 不提交 context_edit/compaction，不改变 continue；可省略 handler |
| `session_shutdown` | 取消本次未提交读取/检查，清缓存，幂等释放本实例资源 |

Git 分支与 pi `/tree` 不同：pi 树只决定提案/任务历史，当前意图始终取当前磁盘文件。proposals 不随项目文件切换自动 rebase；已有源 hash 改变必须重新 propose/review。

历史 checkpoint、tool result 与 custom message 仅表示“当时的项目观察”。本插件提供新版本，不全局编辑别人的旧工具结果或 checkpoint；RC 恢复旧引用后须标待核验并由 agent query/get。任务入口的有限自动投影不替代关键改动前的查询。

## 12. 错误、输出、配置

稳定错误 code：`STORE_MISSING`、`READ_NOT_AUTHORIZED`、`INVALID_STORE`、`STORE_TOO_LARGE`、`STALE_PROPOSAL`、`ACTIVE_CONFLICT`、`DEPENDENCY_NEEDS_REVIEW`、`LOCK_BUSY`、`PROJECT_CHANGED`、`COMMIT_UNCERTAIN`。

工具业务失败用 throw 或 `isError:true`，不要仅在普通文本里写“失败”。声明 outputSchema 时每个正常结果必须有 structuredContent；错误结果也使用明确诊断 envelope。model-facing 文本不泄露密钥、完整 session 或无关项目内容。

UI 用标准 notify/confirm，不需要自定义 TUI。无 UI 的命令结果保存为本插件 custom entry 并供宿主事件/会话读取，不向 stdout 乱写 console.log 污染 JSON/RPC。若使用 `sendMessage` 显示回执，必须 `triggerTurn:false`，且不作为重新审批的权威依据。

flags 初始只需 root、read-enable、入口注入开关和输出预算。原生 registerFlag 仅 string/boolean，数值自行严格解析；project 内任意 settings 字段不会自动传入扩展。默认不启用辅助模型，不自动导入设计文档、不自动推送长期化建议。

## 13. 测试与交付顺序

| 测试文件 | 必测内容 |
| --- | --- |
| `design-intent-store.test.mjs` | missing/损坏/超限/未知版本、raw hash 与 revision 区别、路径/符号链接授权 |
| `design-intent-relations.test.mjs` | DAG、自引用/悬空、双向 conflict、依赖失效传播、reject 不执行 supersede |
| `design-intent-query.test.mjs` | 全局约束优先、路径前缀、原文投影/mustExpand、截断、cursor 源变化 |
| `design-intent-proposals.test.mjs` | 当前 branch 回放、model-only 提案、旧基线拒绝、旧会话不回滚项目真相 |
| `design-intent-commit.test.mjs` | 多进程 lock、两个同基线审批、取消/崩溃的每个提交阶段、rename 后对账/幂等 |
| `design-intent-check.test.mjs` | 权限拒绝不旁路、Git untracked/截断/非仓库、证据不足、源变更标 stale |
| `context-intent-integration.test.mjs` | intent 引用契约、RC 禁止晋升、独立加载、无隐式续跑 |

纯逻辑用 fixtures、临时文件和仓库现有 Node 测试形式；并发/故障用注入的 StoreIO 和子进程验证，不依赖付费模型。文件提交测试明确区分进程崩溃与电源故障，不能用单一 happy path 声称事务安全。

后续交付：完整投影分页与查询诊断 → 更强故障注入/跨进程提交恢复 → 有限检查证据与 diff 覆盖 → RC 交叉集成。未实现能力必须明确 unknown/unavailable，不返回假的成功。

## 14. 宿主和仓库参考

API 基于已读的 pi `docs/extensions.md`、`docs/session-format.md`、`docs/compaction.md`，以及 todo/commands 示例；before_agent_start 返回 message、工具 result/details、sequential 和 model-only 使用已核对的 `dist/core/extensions/types.d.ts`。

本仓库 permissions 只对已注册工具调用做审查；edit 使用 cwd 队列并返回 changes/intent/diff。实现必须据这些真实边界做授权和证据适配，不能把工具 annotations、Git 文件或 review.note 当成防篡改安全认证。
