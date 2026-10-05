# Rolling Context / Design Intent 实现 TODO

本文以 `docs/design.md` 和 `docs/implementation.md` 为验收基准，逐项记录当前受限 MVP 的差距、实现状态、限制和实现过程中的决策。完成项需有测试或明确验证；未实现能力不得仅因入口已注册而标记完成。

状态：**正在推进**。每次只把当前项标为进行中；完成后更新本文件，再开始下一项。遇到宿主 API 或安全模型限制时，记录证据、保守行为和后续选项。

## 执行顺序

### A. Rolling Context 安全裁剪基础

- [x] **RC-01：建立裁剪保护集合。** 保留最近 3 个完整工具组；未消费、不完整、错误、未知工具默认保护；`pinned` 项和 `context_note.paths` 精确依赖能阻止相关来源缩减。只对明确安全的 `read`、仓库 `edit` 和只读搜索/测试结果启用胶囊；胶囊携带调用参数/路径、来源和召回方式。添加每条规则的 planner 测试。
- [x] **RC-02：完成 observe 诊断。** observe 只规划、不写任何 state/edit/compact 草稿；报告候选数量、保护原因、预算和拒绝原因。验证状态不改变。
- [x] **RC-03：校验状态与已提交投影。** 恢复时依据 branch 中真实的 context edit/compaction 对账；未提交、被覆盖或不匹配的编辑/检查点不得作为已成功归档。已测 state-only、重复规划、外部覆盖、compaction 前后及 `/tree` 切支。
- [x] **RC-04：强化 recall。** 支持路径/来源/关键词筛选及受限分页；cursor 绑定 session、leaf、查询和投影版本；结果标明历史、stale、截断或拒绝状态。只返回当前授权投影，不通过旧状态绕过脱敏。
- [x] **RC-05：收敛预算安全边界。** 读取宿主模型窗口与 usage；usage 缺失时显示 heuristic。动态扣除输出 reserve 和保守 headroom；候选必须有估算净收益；持久状态超过 128 KiB 时整批放弃。token 估算仍不是 provider 精确 tokenizer。
- [x] **RC-06：补齐 compact 生命周期。** manual/threshold 仅在分支覆盖完整、无图片/未知摘要/外部编辑且估算有净收益时提供结构化检查点；显式 checkpoint 不安全时取消。用户 custom instructions、overflow recovery、覆盖未知或无净收益时委托原生 compact。失败/取消不推进 checkpoint，并记入 status。真实宿主 lifecycle 仍待 INT-02。
- [x] **RC-07：任务/事实生命周期与测试。** 验证用户约束、单分支 task scope、pin/unpin、路径编辑失效、无范围测试结果的保守失效、assistant/tool evidence 权威差异、图片/未知扩展内容对 checkpoint 的保护，以及超过 128 KiB 整批拒绝。细粒度任务切换不支持：新任务应开 session 或显式换 branch。
- [~] **RC-08：缓存与批量调度（P2，暂缓）。** `ContextUsage` 仅公开 tokens/contextWindow/percent；assistant message 虽可能含 cacheRead/cacheWrite，但只有最近一次 provider 调用数据，不足以校准下一批上下文维护成本/缓存命中。暂不据此调整 epoch 或批次，避免把单次 usage 当稳定信号。

### B. Design Intent 完整查询与写入边界

- [x] **DI-01：完成 query/get 契约。** get 返回完整记录字段、关系、scope、source/review/revision；query 返回必要 dependency/conflict endpoints；opaque cursor 绑定规范化 query、store path/hash 和预算，失配返回 stale 诊断。预算/字段有输出 schema 和逻辑测试。
- [x] **DI-02：提案关系与演化校验。** 提案阶段校验所有关系目标存在且 accepted；批准再次核对目标并验证全局冲突/依赖；diff 显示因 supersede 新增 needs-review 的传递影响；拒绝不应用关系。覆盖共享依赖 DAG、重复提交幂等和未知/非 accepted 目标拒绝。
- [x] **DI-03：加强文件读取/提交安全（受限完成）。** bounded no-follow file-handle read；拒绝 store/parent symlink；temp/store mode 0600；token 校验 lock 清理；已有锁拒绝；同基线并发提交只允许一个成功；rename 后验证保留 `COMMIT_UNCERTAIN`。未做真实进程崩溃注入；Node 当前路径 API 无 openat/目录句柄相对 rename，父目录替换与非协作写入 TOCTOU 无法完全 CAS，明确保留限制。
- [x] **DI-04：项目根策略。** 明确以 `ctx.cwd` realpath 作为唯一 workspace root，不向父级扫描 Git 或 `.pi`，不支持显式 root 覆盖；子目录和 symlink cwd 测试证明不会静默读取父级存储。用户需从仓库/worktree 根启动 Pi 才使用该根的 `.pi/design-intent.json`。
- [x] **DI-05：实现受限 check 证据。** 只读取用户选择且 scope 匹配的 workspace 相对路径；处理 read 拒绝/截断/意图源版本变化并返回 hash 证据。当前所有语义结果一律 `unknown`；`complete` 仅指证据采集完整，不代表合规。Git diff、staged/untracked 覆盖和确定性规则检测明确留后续，不自动宣称 pass/violation。

### C. 双扩展集成与交付

- [x] **INT-01：验证单一来源边界。** Rolling Context 从 Design Intent 查询结果提取只读 `{storePath, revision, sourceHash, id, projection}` 引用；task-decision 和 checkpoint 仍留在分支 state。集成测试确认 `.pi/design-intent.json` 字节不变；Design Intent 扩展不导入/读取 RC state。
- [x] **INT-02：SessionManager/扩展回调集成（受限完成）。** 验证 turn-boundary 草稿回放/工具配对、observe 无写入、compact 提交后 checkpoint 恢复、customInstructions 保留、`/tree` 模式和状态恢复、双扩展注册及 DI 单一来源边界。使用真实内存 SessionManager，但 Pi API 是测试 double；真实 AgentSession/TUI 时序仍未覆盖。
- [ ] **INT-03：静态类型及交付验证（进行中）。** 完整 Node tests、Pi CLI 扩展发现、esbuild 和 `git diff --check`；若没有 TypeScript 编译器则明确 blocked，不以 esbuild 代替 typecheck。

## 已完成的前置核对

- [x] 已审阅两个总体设计和实现蓝图，确认当前交付是受限 MVP。
- [x] 已修复默认 observe 启动后通过 `/rolling-context on` 无法启用维护的问题（提交 `45175b6`）。
- [x] 受限 MVP 初始基线 24 项 Node 测试通过；本轮累计 **50 项**测试通过。Pi CLI 曾确认能发现两个入口；本轮两个入口均 esbuild bundle 通过，`git diff --check` 通过。当前环境无 `tsc`，正式 typecheck 未完成。

## 决策与限制记录

| 日期 | 任务 | 记录 |
| --- | --- | --- |
| 2026-04-15 | 初始化 | 先处理可能导致错误裁剪/越权重读的保护和状态对账，再扩展查询功能；遇到无法证明安全的情况保留原生 compact 或返回 unknown。 |
| 2026-04-15 | RC-01 | 默认保护最近 3 个完整组；胶囊白名单限定为 read、带 changes 的 edit、白名单只读 bash/测试命令。未知/错误/含 shell 组合的结果不胶囊；任务 note 路径和 pin 会保护来源。 |
| 2026-04-15 | RC-02 | observe 复用 planner 和内存 projection 验证，但 handler 不返回草稿；status 报告候选 edits、checkpoint、保护原因和 writes=0。真实 SessionManager 测试确认 branch 未变化。 |
| 2026-04-15 | RC-03 | `rebuild()` 只把 branch 中最新且哈希匹配的 context edit 认作已提交；checkpoint 同时匹配实际 compaction、保留边界与摘要哈希。增加 state-only、edit 覆盖、重复规划及 compaction 前后状态测试；现已用真实 SessionManager 覆盖 `/tree` 分支状态恢复，Pi TUI 事件时序仍待 INT-02。 |
| 2026-04-15 | RC-04 | Recall cursor 为 base64url 编码的版本化游标，逐项核对 session/leaf/query/projection hash；不是授权凭据。检索逐次扫描当前 branch 投影，不建立磁盘索引；单条内容按 budget 限长，命中隐藏/空投影 entry ID 时仅返回 withheld 诊断。 |
| 2026-04-15 | RC-05 | 使用 `ctx.model.contextWindow` / `getContextUsage()`（usage 无值时回退启发式）；动态扣除 output reserve 和 5%/2k headroom；单条 envelope 上限 128 KiB，超限整批不提交。cacheRead 感知、epoch/hysteresis、minBatchSaving 归入 RC-08。 |
| 2026-04-15 | RC-06 | 对安全的 manual/threshold 使用 `session_before_compact` 的 firstKept boundary、coverage 和估算净收益校验；保留用户 instructions，overflow 委托宿主。生命周期回调记录成功/失败/取消诊断；集成测试以真实 SessionManager 验证自定义 compaction draft、外部 edit 回退和用户指令委托。宿主端完整提交/失败时序仍归 INT-02。 |
| 2026-04-15 | RC-07 | 当前 branch 是一个 task scope：steering/后续用户消息不会触发关键词猜测式切换；新任务应使用新 session 或 `/tree` 分支。user constraints pinned；未知/图片贡献阻止 checkpoint；测试证据不代表覆盖所有文件，任意后续编辑会使无路径 scope 的 test stale。128 KiB 是硬拒绝而非 LRU 丢弃，并由超限测试验证。 |
| 2026-04-15 | DI-03 | Store 使用 `O_NOFOLLOW` fd 读取和 64 KiB bounded chunks，最多读取 1 MiB+1；temp exclusive create 0600，测试确认 lock/temp 清理及已有锁不被误删。同基线并发测试保证只有一个候选提交。未做真实进程崩溃注入；Node path API 无 openat/renameat directory-handle CAS，恶意父目录替换和非协作写入仍有窄竞态。 |
| 2026-04-15 | DI-04 | `findProject(cwd)` 只 realpath 当前 cwd；启动于 nested workspace 时使用该目录且不读取上级 `.pi`；cwd symlink 解析至目标目录。Worktree 同理由用户启动路径确定，不由 Git metadata 推断 common root。 |
| 2026-04-15 | DI-05 | Check 只用授权 `ctx.executeTool("read")` 获取调用者选定且适用的相对路径，拒绝 traversal/absolute；report 有证据 hash 和 truncation，复读 store 后检测 source hash stale。自然语言没有可执行规则，所有状态保持 `unknown`；`complete` 表示证据完整，不是合规结论。Git diff/staged/untracked 范围未实现。 |
| 2026-04-15 | INT-01 | 真实 SessionManager 中将 DI 查询 projection toolResult 输入 RC turn planner，检查状态只加入 source-hash 绑定引用和 task-decision；前后比较 DI 文件 bytes 完全相同。依赖单向为 RC 读取 DI projection；DI index 无 RC imports。 |
| 2026-04-15 | INT-02 | `session_tree` 真实 SessionManager 测试发现 mode 变量会从旧分支泄漏到无配置分支；`restoreMode()` 现先重置为注册默认值，再应用所选 branch 中最后一条配置。测试同时确认另一分支 task note 不进入新分支状态。Pi CLI/TUI 生命周期未模拟。 |
| 2026-04-15 | INT-02 | 使用真实内存 SessionManager 应用 on-mode turn drafts 并重建 projection，工具 call/result 配对保持完整；compact hook 结果追加为实际 compaction 后才恢复 checkpoint。扩展注册/回调通过 mock API 驱动，不能等同真实 AgentSession 或 TUI e2e。 |
| 2026-04-15 | INT-03 | 最终 Node 测试 50/50 通过；Rolling Context 与 Design Intent 两入口 esbuild 均通过，`git diff --check` 无误。运行环境未发现 `tsc`，因此正式 TypeScript 检查以及真实 Pi AgentSession/TUI e2e 保持未完成。
| 2026-04-15 | RC-07 | 增加测试确认旧任务不会因后续用户消息被自动改名；缺乏 test path scope 的测试证据在任何编辑后 stale；图片/未知扩展贡献不跨 checkpoint；pin/unpin 写入完整 state envelope。超过 128 KiB 已有整批 planner 拒绝测试。任务内淘汰/LRU 未实现，安全但可能停止自动维护。 |
| 2026-04-15 | RC-08 | 检查 pi 1.0.0 类型：`ContextUsage` 仅含 tokens/contextWindow/percent；cacheRead/cacheWrite 只在单条 assistant usage 中可见，缺少稳定的 provider 缓存代价信号。P2 暂缓，不用单次 cache hit 调整批次/epoch。 |
| 2026-04-15 | DI-01 | get 现在投影完整记录（含 sources/review/scope/全部关系/createdInRevision）；query 补页内记录的直接 dependsOn/conflictsWith 端点，并标 `relatedTo`。cursor 用 base64url 版本 token，绑定 storePath/sourceHash/filters/limit/char budget；不透明且 source/query 不同即 `STALE_QUERY_CURSOR`。关系端点若预算放不下会列 omitted ID 并给 warning，而不会静默假称完整。 |
| 2026-04-15 | DI-02 | `makeProposal()` 现在读取提案基线并拒绝 unknown/non-accepted 关系目标；批准继续做完整 candidate 校验。`storeDiff()` 明示已有 accepted 记录因关系传递新进入 needs-review 的影响。依赖遍历修正为 recursion-stack，避免 DAG 共享祖先误判环。reject 保留关系说明但不应用关系，提交按 proposal source 幂等。 |

