# Daemon 重构方案：代理 Pi 本地 UI，而不是接入插件业务

状态：**结构化 UI 第一阶段已实现，兼容性适配路线已验证；完整 CLI/browser smoke 仍待完成**。依据用户明确指定的边界重新设计；本方案
取代“给各插件提供公共远程审批客户端”的方向。当前没有项目 Design Intent 存储，
不在本轮自动创建或写入意图文件。

## 1. 目标边界

> 插件只调用 Pi 的本地 UI；daemon 代理同一个 UI 请求到网页。

```text
Permissions / Design Intent / Rolling Context / 任意扩展
                         │
                         │ ctx.ui.select / confirm / input / editor / notify
                         ▼
              Pi UI boundary / prompt broker（Pi 进程内）
                │                                │
                ▼                                ▼
           原有本地 TUI                  通用 UI transport adapter
                │                                │
                │                          daemon ⇄ session 网页
                └───────── 同一个 UI 请求 ────────┘
                         │ 首个有效响应完成原 UI Promise，一次且仅一次
                         ▼
                 原调用者继续执行自己的业务
```

- 插件不导入 daemon，也不发 `pi-remote:*approval*` 事件。
- daemon 不知道什么是 permission mode、Design Intent candidate、Reject 理由或
  Rolling checkpoint，只知道通用 UI 方法及其参数/返回值。
- 请求、取消及 Promise 的权威状态由 Pi UI 层持有；daemon 只缓存显示副本。
- 代理不启动原 UI 没有发起的审批，也不根据标题推断动作。
- daemon、浏览器离线不得变成插件的 Deny、Cancel 或授权响应。本地 TUI 继续正常工作。
- 人工提示没有代理默认超时、TTL、自动拒绝或自动批准。

## 2. 重构前实现审查

| 位置 | 重构前行为 | 问题与迁移方向 |
| --- | --- | --- |
| `extensions/daemon/index.ts` | 监听四种插件审批事件，抽取插件字段，调用插件 `respond` 回调 | 实际是业务审批适配器；改为只订阅 Pi UI 请求/结束/通知并返回通用 UI 响应 |
| `extensions/daemon/daemon/registry.js` | 根据 `kind` 保存 proposal/read/checkpoint 字段，校验专属选项及 Reject 理由；未知 kind 降为 permission | daemon 承担业务规则；改为校验 UI method 的形状，未知版本/方法明确拒绝 |
| `extensions/daemon/daemon/main.js` | `/approvals` 固定接受 Allow/Auto/Deny/Accept/Reject 等选项 | 无法代理任意 `select`；改为通用 `/ui/responses`，实际选择由原请求决定 |
| `extensions/daemon/web/index.html` | 按插件种类渲染 DI diff、Reject textarea 和专属按钮 | 应按 `select/confirm/input/editor` 渲染；内容来自原始 UI 参数，不能有插件名分支 |
| `extensions/permissions/index.ts` | 本地选择与远程回调竞争；本地响应可能等 daemon 回送；已送达请求断线时 daemon 调用 `respond('Deny')` | 远程故障影响本地决定；移除插件侧远程竞争，只等待原 `ctx.ui.select` |
| `extensions/design-intent/index.ts` | propose 自动创建网页专用审查，独立 `applyRemoteReview`；本地 accept/reject 使用另一条 confirm 流程 | 网页与 TUI 不是同一交互，业务执行路径重复；删除网页专用执行入口，代理本地命令的确认流程 |
| `extensions/design-intent/index.ts`、`extensions/rolling-context/index.ts` | 读取授权/checkpoint 各复制一套可用性 Promise、prompt queue、远程响应及取消 | 不应该由插件维护 transport 可用性；恢复普通 `ctx.ui` 调用 |
| `extensions/daemon/index.ts` | `permissions` 命令专属结果 FIFO；读取 fast-mode 全局 statusline Map | 插件知识越过 UI 边界；命令通知走通用 notify/status；无宿主公共数据时保留 unknown |
| daemon 注册与断线 | 断线清除审批副本；重连没有重新同步仍存在的本地弹窗 | 副本被误当作请求本体；应从 Pi UI broker 重新获取 pending snapshot |

已有可保留部分：session/instance registry、网络连接、事件流、只读历史、消息输入、
网页导航、显式无审批超时。Context Graph 是旁路只读 telemetry 视图，不属于审批机制；
不借这次 UI 重构改变 Rolling Context 的状态算法。

## 3. 核实到的 Pi 能力与限制

已阅读当前安装版本的扩展、SDK、RPC UI 文档及宿主实现：

1. `ExtensionUIContext` 已有 `select`、`confirm`、`input`、`editor`、`notify` 等
   通用方法。TUI selector/input 只使用调用者传入的 `opts.timeout`，不自带默认超时。
2. `ui_prompt_start/end` 事件仅含 `kind/title`，没有完整 options/message、请求 ID、
   返回值或 response handle。宿主还会合并嵌套提示的 start/end。
   **仅订阅这些事件不能实现可响应的完整弹窗代理。** 它们只能辅助显示 waiting 状态。
3. RPC 模式已有 `extension_ui_request/extension_ui_response`，具备通用字段和 ID；
   但这是 RPC 子进程模式的协议，并非任意运行中 TUI 自动开放的接口。
4. SDK 可在 host 层通过 `AgentSession.bindExtensions({uiContext})` 注入 UI；现有
   CLI InteractiveMode 创建自己的 UI context。普通扩展没有文档化的全局 UI interceptor。
5. `custom()` 是任意终端组件，RPC 本身也不支持通用序列化。核心 TUI 的一些选择器
   直接调用 InteractiveMode 方法，未必经过扩展 UI context。

因此不能宣称“现在只改 daemon 订阅一个事件就可以代理全部 TUI”。需要 UI 边界的
真实桥接；不解析终端文字，不按插件标题识别审批，也不把内部 runner 当公共契约。

### 桥接实现选择

**首选：宿主层的通用 UI broker / 公共 UI interceptor。**

在 Pi 的 UI binding 层包裹原有 `ExtensionUIContext`，提供完整请求、响应/关闭
能力及 pending snapshot；TUI 和远程 adapter 都连接同一个 broker。这需要 host
集成或 Pi 上游新增公共接口，不能在本仓库假定它已经存在。

**临时可行性验证：隔离的 `ctx.ui` 方法 decorator。**

可以在 runtime/UI 就绪后尝试包裹当前共享 UI 对象，保持原本地方法与 `this`，
合并 AbortSignal，统一处理网页/local 竞争。但“修改共享 `ctx.ui` 方法”不是已承诺
的公共拦截 API。必须先通过真实 TUI 生命周期测试，限定支持的 host 版本；确认
reload、session 切换、其他 UI 装饰器、editor 关闭等行为。不能作为无条件可靠方案，
也不能在不兼容时回退到插件专用审批事件。

**RPC 备选：** 适合独立的 RPC/headless host；复用其 UI wire schema。
若用 RPC 替代现有 CLI TUI，必须另外提供本地 TUI client，是产品/运行方式的变化，
不能悄悄作为“代理已有 TUI”的实现。

实施前置 gate：确定宿主桥接路线。普通 daemon 扩展自身若拿不到完整 UI request
和安全关闭本地弹窗的句柄，应标记 UI proxy unavailable，同时保留本地 TUI；不得伪装成功。

## 4. 通用协议与权威状态

采用通用 UI 方法/返回类型，已实现协议位于 `daemon/ui-protocol.js`：

```ts
type UIRequest =
  | {id:string; method:"select"; title:string; options:string[]; timeout?:number}
  | {id:string; method:"confirm"; title:string; message:string; timeout?:number}
  | {id:string; method:"input"; title:string; placeholder?:string; timeout?:number}
  | {id:string; method:"local-only"; title:string; kind:"custom"|"editor"|"oversized"};
interface UISnapshotEnvelope {
  version: 1;
  type: "ui_snapshot";
  uiEpoch: string;     // 不随 daemon TCP 重连变化
  revision: number;
  pending: UIRequest[]; // 当前可显示请求；标准 dialog 串行，最多一个
  status: Record<string,string>;
}
// UI response: {version:1, type:"ui_response", uiEpoch, response}
// response: {id,value} | {id,confirmed} | {id,cancelled:true}
// ack: {version:1, type:"ui_response_ack", uiEpoch, id, accepted:boolean}
// 网页 snapshot/ack 由 daemon 添加已注册的 sessionId/instanceId。
```

实现通过 revisioned snapshot 发布/关闭提示，没有额外的 `ui_request/ui_closed`
事件。`pending:[]` 或新的 epoch 清除旧显示。原方案的 request/closed envelope 是
设计草案，不是当前 wire API。协议不包含 proposalId、action、candidateHash、
permission mode 或 plugin callback。select 值必须属于 options，confirm 为 boolean，
input 校验字符串及大小；业务含义由原调用者解释。

- Pi 进程内 broker 保存实际 pending 请求、原 Promise、取消句柄和 UI 队列。
- daemon 按已注册连接绑定 origin；浏览器不能自行指定 PID、另一个 instance 或 callback。
- 响应校验 UI epoch/ID 和 writable instance，拒绝错误类型、重复及已结束请求。
- 同时多个提示需明确 host 展示队列与 active ID，不能让两个异步调用替换 TUI 控件后
  留下无主 Promise，也不能用现有 outer-only `ui_prompt_start/end` 推断队列。
- wire 版本不兼容只关闭代理能力，不改变插件业务决定。
- 文本使用安全的纯文本渲染；长提示分页/展开或明确拒绝代理，不静默截断确认内容。
  不根据文本识别“密码/审批”；未来敏感 input 需要宿主明确的可代理属性。

## 5. 本地与网页竞争响应

```text
pending → answered / cancelled / invalidated
```

网络连接状态与上面的提示状态独立，断线不触发上述终态。

1. 创建请求时先进入 broker registry，再同时展示 TUI、发布网页副本。
2. 首个有效响应在 **Pi broker** 原子地把 pending 改为终态。
3. 完成原 UI Promise 恰好一次，并关闭另一个界面的显示。
4. 网页胜出时关闭本地弹窗不能再产生一个独立 cancel/Deny 返回值。
   不能简单 `Promise.race` 后遗留原 selector/input；editor 也需要安全关闭能力。
5. 本地胜出时立即继续原调用者，daemon 不在线也不等待远程回送。
6. 浏览器 POST 只说明提交响应；broker acknowledgement 才说明该响应被原 UI 接受。
   UI accepted 不是业务已执行。业务执行结果来自后续原 `notify`/tool/message 事件，
   daemon 不调用插件完成回调，也不自行宣布“设计已提交”。

取消仅来自原调用者的 AbortSignal、用户明确取消、host runtime 失效或对应的
session/tree 生命周期取消策略。不要因普通 JSONL leaf 推进或网络 generation 改变
就取消一个仍然有效的 UI 请求；领域源版本变化仍由插件执行前复核。

## 6. 无超时、导航、断线和重启

| 场景 | 行为 |
| --- | --- |
| 页面不在目标 session / 浏览器尚未打开 | Pi broker 保留 pending；进入该 session 时获取权威 snapshot 并弹出 |
| 浏览器刷新/断网 | 不完成/取消原 UI Promise；重连获取 snapshot，去掉已被本地完成的旧显示 |
| daemon 断开/重启 | TUI 完全可用，pending 留在 Pi；重连注册后发送当前 snapshot，而非旧授权日志 |
| 本地已经回应，daemon 没收到 close | 重连 snapshot 不包含该提示；浏览器旧响应收到 stale/closed |
| Pi 进程退出 / runtime 被替换 | 原 UI 生命周期结束，旧 epoch 失效；不把旧提示或响应用于新实例 |
| 同 session 多 Pi instance | 按 registry 的可写 origin 路由；冲突不可广播响应给所有实例 |

broker/daemon 不提供默认 decision timeout。网络探活、连接重试可以有时间间隔，但
不能把探活失败转换成 UI 默认返回值。对现有人工审批不传 `timeout`。
若第三方调用者显式使用 timeout，那是其原本的 UI 语义；代理不得自行增加、删除
或延长它，应注明是调用者取消。不要为了“无代理超时”悄悄改动第三方 TUI 行为。

无需在 daemon 持久化 pending Promise，也不支持 Pi 退出后恢复已失效的 UI。只要
Pi 仍活着，daemon 的内存缓存丢失不应影响等待状态。

## 7. 插件迁移：恢复一个本地流程

- **Permissions**：保留 intent、路径、自动 reviewer 和执行阶段复核，只删除远程
  availability/cancel/respond 分支；manual 只调用普通 `ctx.ui.select`。
- **Design Intent 读取**：按后续读取策略更新，受信任当前 workspace 的固定 JSON 默认直接读取；没有人工读取确认或网页专用 grant 入口。显式关闭读取、未受信任或越界时不可用。
- **Design Intent accept/reject**：保留当前本地命令的候选 diff、确认、锁定提交和
  branch/source/hash 复核，删除 `remoteReviews/applyRemoteReview`。Reject 理由来自
  原命令参数，或由本地 `ctx.ui.input` 请求；网页只是代理同样的文本输入。
- **propose 自动网页审批**：删除其远程独有路径。propose 仍保存会话提案并用本地
  notify 告知用户如何 review/accept/reject。网页可以提交相同命令，代理随后产生
  的 confirm。若以后要“提案产生即弹审批框”，必须先把它定义成同样在 TUI 出现
  的本地交互，不能恢复隐藏的远程审批业务入口。
- **Rolling checkpoint**：保留 idle/branch/state 安全检查，只调用本地确认。
- **命令与通知**：统一代理 `notify/setStatus`，不再要求插件额外发送 command-result。
  远程命令派发回执不等于执行成功；可靠宿主 command ID 存在时才做完成关联。
- **无 UI 模式**：维持原本 headless 的拒绝/显式确认 token 行为；仅 daemon socket
  存在不能伪造 `hasUI=true`。RPC-only UI 是另一种由 host 显式绑定的受支持模式。

## 8. 分阶段实施与验收

### Phase 0 — 宿主桥接可行性（P0，阻塞后续）

使用不含 Permissions/DI/RC 的测试扩展，调用 `select/confirm/input/editor/notify`。
验证完整参数捕获、远程响应、真实 TUI 关闭、无默认超时、reload 和 session 更换。
优先确定公共 host hook；decorator 路线必须说明兼容限制，不能只靠 mock。

### Phase 1 — Pi UI broker 与通用 wire（P0）

定义 request/response/snapshot/closed 的 schema；实现一次完成、取消句柄、local
失败不受远程影响、跨 reconnect 的 UI identity。测试并发和 duplicate/late response。

### Phase 2 — daemon registry / HTTP / 网页（P1）

仅识别 UI method，添加 snapshot 同步、通用渲染及 Pi acknowledgement；删除插件
字段、固定选择列表、Reject 理由校验。用任意第三方测试扩展证明零插件配置可代理。
变更 wire 协议时明确 host/daemon version 协商，不默默降级为旧业务协议。

### Phase 3 — 逐个删除插件远程路径（P1）

迁移 Permissions → DI read/accept/reject → RC checkpoint。每步保持真实 TUI 单独
使用、网页代理使用和执行前安全校验通过；保留用户原有未提交 reviewer/bash 改动。
不可同时启用新 broker 和旧业务审批事件，避免一次动作出现两套决定。

### Phase 4 — 删除其余业务探测并做整体 smoke（P1/P2）

删除 permissions 结果 FIFO、fast 全局 Map 探测（无法从公共 UI 得到时显示 unknown）。
测试真实 Pi：页面在首页/其他 session 时产生提示，晚进入、刷新、daemon 重启、
离线本地回答、并发本地/网页回答、session/tree/reload、Pi 退出及多实例冲突。

### 必须达到的验收条件

1. 各业务插件不依赖 daemon event/client，daemon 无任何插件审批字段和选项分支。
2. 本地和网页看到同一请求、同一内容/选项，只完成同一个 Promise 一次。
3. 模拟时钟大幅推进后，未传 timeout 的 pending 不变；代理没有 decision timer。
4. daemon 不在、断线或重启不取消本地提示，不影响本地决定，也不授权任何动作。
5. 网页晚进入 session 正确显示当前提示；本地完成的旧提示不会被重放。
6. 未知方法/版本、错误 instance/epoch、重复和迟到响应不能执行任何业务。
7. DI reject/commit 与 edit permission 的安全检查只发生在原插件执行路径。
8. `custom()` 和尚未桥接的核心 TUI 提示明确标记 local-only，不声称“所有界面已代理”。

## 9. 当前实施与验证边界

后续读取策略更新：`design-intent-read` 默认 true，已删除读取确认及 session grant；
读取只限受信任当前 workspace 的固定 JSON。本文重构前审查中的 read-grant 行为
是历史背景，不是当前运行时入口。提案即时弹出人工审查符合核心显式批准原则，
但现有 MVP 的 command-only 审批与 proposal-only 工具契约尚未调整，当前仍由命令审批。

- 公共 host interceptor 仍不存在。本轮采用隔离的共享 `ctx.ui` compatibility
  decorator，运行时仅安装于 `tui && hasUI`；可用 `--remote-ui-proxy false` 禁用。
  安装失败回滚并报告警告；恢复只覆盖仍由自己持有的方法，避免破坏其他 decorator。
- 在 Pi 0.99.1 的真实 loader/runner/native selector/input 上验证网页回答后清理、
  本地回答、AbortSignal、显式 timeout、无 timeout 的长等待、串行标准提示和 epoch
  失效；真实 daemon 扩展 + HTTP/WS + native UI 闭环验证重启重同步、tree rebinding
  和离线本地完成。不把内部 host 类当作插件 runtime import；私有路径仅用于测试。
- `editor()` 没有原生取消句柄；`custom()` 是任意组件。两者仅观察并标记 local-only，
  原调用立即运行，不加入标准 dialog 队列，以免其嵌套 UI 死锁。超大/不可表示提示
  也 local-only，保留完整本地内容，不静默截断。
- daemon/browser 通用 snapshot/response/ack、所有插件普通 UI 调用及旧业务事件
  删除已实施。DI 只有 accept/reject 命令执行路径，保留队列内信任/branch/hash 复核；
  项目提交后 receipt 失败仍明确报告已提交，COMMIT_UNCERTAIN 提示检查 store 后重试。
- 仍需完整 interactive CLI session-switch/reload、真实浏览器点击/刷新/多页面 smoke，
  clean-install 和更多其他 decorator 共存验证。未经过 `ctx.ui` 的核心 TUI 不在覆盖内；
  支持范围不能称作“所有人工界面均能网页操作”。通知是瞬时镜像，不保证离线重放。
- TODO 是本地工作文件，由 `.git/info/exclude` 忽略，不进入提交；没有自动创建或写入
  项目 Design Intent 存储。
