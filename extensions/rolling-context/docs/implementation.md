# Rolling Context projection v2

默认入口 `index.ts` 注册 session lifecycle、context/context_with_system、turn_end、recall 和正常命令。v1 的 `planTurn / checkpointSafe / target / blocker` 全部隔离到 `legacy/v1.ts`，旧 shell 保留在 `legacy/index.ts` 供兼容回归。新 runtime 不使用 checkpoint drafts。

## 请求与提交

```text
raw branch → host-authorized session projection → evidence registry
                     ↓
        per-source committed representation
                     ↓
    context hook → chronological model projection
                     ↓
      Pi restores prompt and tool declarations
                     ↓
 context_with_system → actual hook-output snapshot
                     ↓
              normal Pi provider runtime
```

每次请求从宿主授权 projection 开始，不从 raw branch 恢复被其他扩展隐藏的消息。`context` 只修改 Pi runner 的 structuredClone 中的 content，保留 message identity，使该 fork 的 `restoreSystemMessages` 不会把未改变的 chronological system/tool deltas 全部折叠到开头。Raw SessionManager entries 不会被修改。

`turn_end(outcome=completed)` 从包含前序扩展 drafts 的 boundary preview ingest、更新 aging、生成候选、估算经济性，返回继承 drafts + representation delta + telemetry。任何 await 后复核 session ID/leaf；旧分支不提交。下一次 hook 从实际 branch rebuild，未落盘 drafts 不推进 generation。新 evidence 使请求接近容量时，context hook 也可做一次 capacity preflight commit。Normal aging 不产生 `context_edit / compaction / continue`。

Native/manual/overflow compaction 保留。Native threshold 若只是 raw log 大而 v2 projection 可容纳，则取消该次 threshold compact；真实容量不可行、manual 或 overflow 委托宿主。Normal generation 不是 checkpoint。

## Evidence 和 representation

`projection/evidence.ts` 保存进程内 registry：session/source IDs、宿主授权 message hash、raw token estimate、original source entry、message index、born/last-use turn、paths/entities、tool call 与 pinned/reducible flags。Registry 从 branch/host projection 重建，不落盘第二份原始 transcript。

`RepresentationState`：

```ts
{
  sourceId, sourceHash,
  desiredRepresentation: 'EXACT' | 'CAPSULE' | 'COLD',
  committedRepresentation: 'EXACT' | 'CAPSULE' | 'COLD',
  capsule?: { text, semanticRisk, compressionTokens, coldSafe, reducer },
  reason, generation, changedTurn, lastUseTurn, retryTurn?
}
```

Raw hash 不匹配时旧 capsule 不再适用。User、system、Design Intent authority 精确保留。工具调用骨架精确保留；图片、混合非文本、未解决 tool error 只保护自身。未知 tool 名称不会生成 blocker。

Aging 根据每个 source 的 age/last use、coldSafe 和 occupancy 独立设置 desired。默认 exact age=3，cold age=16；它们是 source relevance 启发式，不是 checkpoint cadence 或 warm 驻留 gate。高 occupancy 提前 exact/cold eligibility。最近 agent/user 自然文本中的 source/path 引用也刷新 last-use；同一路径只刷新最新 observation，旧版本继续独立 aging。Recall 写轻量 last-use entry，可重新使 cold source 的 capsule 成为 desired resident。desired=CAPSULE/committed=EXACT 与 desired=COLD/committed=CAPSULE 都是合法常态。

Committed COLD 不驻留 evidence 正文，只留短 ref，保留 tool call/result 配对。Capsule、cold source、user 与 assistant 仍在原 chronological 位置，前面没有每轮动态 focus/full summary。

`rolling-context.representation.v2` 只记录 changes。同一个 capsule 在后续 desired/generation metadata 更新中省略，replay 从前一状态继承；generation 仅在实际 representation commit 时增加。切 branch、session restart、native compact 后从所选 parent chain rebuild。

## Reducer

`projection/reducer.ts` 的 deterministic reducers 为 read/edit/bash/test 添加 invocation、paths、历史标签、事实、unresolved 状态与 recall ref。重复 line/phrase 只压缩相邻 runs，保留不同事实的顺序，不依赖 shell 白名单。

Generic extractive reducer 对 unknown/MCP/custom/assistant 文本采用相同语义 envelope，保留 unique output。无法取得足够节省时使用 generic semantic reducer：通过公开 `ctx.modelRegistry.streamSimple`，只传这一个 evidence 和 invocation，输出 whatHappened/facts/unresolved/entities/semanticRisk/coldSafe JSON。它不依赖 tool schema，不发送整个 session，不调用主 agent。输入不截断：超过 32k chars 保持 exact。最多两次辅助请求/turn，输出 1,200 tokens，8 秒 timeout，失败/invalid JSON/risk>0.2/insufficient saving 都保留 source exact。失败后 source 独立 backoff。

模型声称的 semanticRisk 不是正确性证明；真实工程内容的 loss 风险需长 session 评估。Code/复杂论证通常会依赖语义 reducer或继续 exact；deterministic repetition 不声称识别所有程序语义。

## Planner / KV economics

`projection/materialize.ts` 在当前 committed chronological projection 上记录每项候选的 source、current/desired、token position、raw/projected tokens、saving/request、semanticRisk、futureRequests、compressionTokens 和 recallRisk。

`projection/planner.ts` 对每个候选 frontier 比较它及其后正收益 changes：

```text
benefit = Σ saving × (estimated future requests + attention weight + occupancy urgency)
cost    = projected tokens - earliest mutation position
          + Σ semantic-risk penalty + compression tokens + recall/reread risk
```

Suffix KV invalidation 只计算一次。早位置收益小的候选可以保持 pending，而后面的大收益和 capsule→cold 可以合并。低 occupancy 要求净收益与 batch saving；接近 available capacity 时优先容纳下一次 request，不以任何固定 target 为目标。break-even=(suffix + risk/compression costs)/saving，都是保守宿主估算，不是 provider 价格模型。

Available capacity = model contextWindow（未知时 272000）- reserve（默认16384）- max(2048,5%window)。`BUDGET_INFEASIBLE` 仅表示当前 required/resident projection 超过容量，不出现 checkpointBlocked episode。

## Recall 和 legacy

`recall.ts` 使用当前 session branch ownership + 宿主/legacy redaction projection 授权，不检查 v2 resident visibility。v2 COLD raw 仍在宿主 log，因此可 recall。foreign omission、foreign/native compact、redaction 仍然权威；own v1 checkpoint 只在 append-order/hash ownership 校验通过时撤销其归档影响以取 evidence。不会打开 fullOutputPath、读取当前项目文件或绕过工具授权。

保留 legacy note/item/path filter、stale 标签、bounded text、cursor 和 thinking/image omission。查询检索完整授权文本，再返回命中 excerpt；entryId 支持 offset/nextOffset 分页，cold 原文尾部也可访问。明确跨 branch/不存在的 source 不会返回原文。Recall usage 只记 source IDs。

v1 config `{mode}` 是旧命令实际写入的明确选择，继续尊重 off/observe。没有 config entry 的旧默认 observe 迁移为 on；带 explicit=false 或 origin=default 的旧 default entry 忽略。v2 commands 保存 schemaVersion=2/explicit=true。

## Graph / Projection View

Telemetry transport 与 daemon API 不变：同一路 `context-telemetry` 读取 v1/v2 metrics，v1 UI 仅用于旧数据，v2 显示 projected/window、raw/reduction、exact/capsule/cold equivalent/frame/pinned composition、pending gain、saving/request、frontier、one-suffix invalidation、break-even、cacheRead/uncached input、state bytes、generation/changes。W/C/G/F/R 事件与 Turn 0/completed timeline、Event Log、All turns、inspector 保留。Provider usage 对应真实请求，after-turn generation 影响之后请求的 cache association，不宣称精确因果归因。

`context-projection?requestId=...` 读取 `rolling-context.projection-snapshot.v2`：

- request/turn/generation、outputHash、messageCount、totals；
- source→representation/raw/projected tokens/hash/reason/bounded preview/born/last-use/generation mapping；
- `prefixRequestId + segments` 复用前一 snapshot 的任意未改变 mapping run，避免动态开头或 generation 变化复制所有 rows；
- source 原文从对应 raw/host projection 取，capsule 从该 generation 的 representation delta 取；
- 未关联 raw source 的 prompt/extension fragments 按 hash 落一次 content object，超过128KiB显示 unavailable。

共享 `snapshot-codec.js` 只回放 mapping changes，不执行 planner。Daemon 重建 messages 后校验每项 projectedHash 与总 outputHash；当前授权若已修改/隐藏 source，则内容与旧 preview 都 withheld。Rendered 展示完整文本、toolCall、thinking、system sections/tool declarations；图片显示 actual-input placeholder，不展示 binary payload。Mapping / Diff 比较 raw 与 committed/desired，显示 saving、reason、age、last-use 和 generation。Recall raw 按当前授权读取，正文默认使用既有 bounded history 上限。

记录点是本插件 `context_with_system` 输出，默认插件清单中 Rolling 最后运行。第三方后续 context_with_system 或宿主 forced-prompt/hidden-tool/provider wire transforms 仍可能进一步修改请求；快照明确记录 hook 名称，不能宣称已观察到未知后续 wire payload。

## 验证与风险

`test/rolling-context-v2.test.mjs` 覆盖默认模式、无维护工具、真实 Pi ExtensionRunner、raw immutability、specialized/generic success/failure、images 保留、desired/committed 解耦、frontier batching/一次suffix成本、chronology/protocol、capacity urgency、state delta/restart/branch、actual snapshot replay、动态 prompt 段复用、legacy restore、cold/foreign recall 和120-turn zero-cooperation。旧 v1 regression 继续独立运行。

Fixture 使用模拟 provider usage 和可重复输出，因此验证生命周期与可观测性，不能证明真实 provider 收益或所有任意任务的语义完整性。当前仍使用宿主 heuristic tokenizer、有限 semantic jobs、全 branch rebuild/按需 snapshot chain replay；非常长 session 的 CPU/索引规模及真实 cache amortization 还需现场测试。Pinned/unsupported resident 超出容量时会委托宿主，而不是丢掉 required evidence。
