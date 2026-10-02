# Pi Remote Daemon 设计文档

## 1. 目标

为本机运行的多个 Pi 实例提供统一的远程 Web 入口。

核心目标：

- Pi 仍然在本机终端中正常运行。
- 每个 Pi 实例启动后自动连接本机 daemon。
- daemon 只监听一个 HTTP 端口。
- 多个 Pi session 通过不同 endpoint 区分，而不是每个实例占用独立端口。
- 手机通过 Tailscale 访问 daemon 页面。
- Web 页面可以查看当前运行中的 Pi session。
- Web 页面可以实时看到 Pi 输出。
- Web 页面可以向指定 Pi session 发送消息。
- 同一个 session 同一时刻只允许一个可写 Pi instance。
- 第一版不追求完整远程 IDE，只解决“查看当前 Pi，并继续对话”。

整体原则：

> Pi 是实际运行主体，daemon 只是 session registry、消息转发和 Web UI。

---

## 2. 非目标

第一版暂不实现：

- 浏览器文件管理器
- 浏览器终端
- Git 管理
- 项目编辑器
- 远程 shell
- 自动创建新 Pi session
- 自动恢复离线 session
- 多用户权限系统
- 公网认证系统
- 云端 relay
- 跨主机 Pi 聚合

这些功能后续可以扩展，但不要为了未来功能把第一版架构做复杂。

---

## 3. 总体架构

```text
┌─────────────────────┐
│ Pi process A        │
│ session A           │
│ extension           │
└──────────┬──────────┘
           │
           │ persistent connection
           │
┌──────────▼──────────┐
│                     │
│ Pi Remote Daemon    │
│                     │
│ Session Registry    │
│ Event Router        │
│ HTTP API            │
│ WebSocket API       │
│ Web UI              │
│                     │
└──────────┬──────────┘
           │
           │ 127.0.0.1:<port>
           │
     Tailscale Serve
           │
           ▼
      Mobile Browser
```

多个 Pi 实例全部连接同一个 daemon：

```text
Pi A ─┐
Pi B ─┼────> daemon :4317
Pi C ─┘
```

daemon 是唯一监听 HTTP/TCP 端口的服务。

Pi extension 不需要为每个实例单独启动 HTTP server。

---

## 4. 组件划分

建议目录：

```text
pi-remote/
├── extension/
│   ├── index.ts
│   ├── client.ts
│   └── adapter.ts
│
├── daemon/
│   ├── main.ts
│   ├── server.ts
│   ├── registry.ts
│   ├── router.ts
│   └── protocol.ts
│
├── web/
│   ├── index.html
│   ├── app.ts
│   ├── session-list.ts
│   └── session-view.ts
│
└── shared/
    ├── types.ts
    └── protocol.ts
```

不要求严格使用该目录结构，但职责必须保持清晰。

---

# 5. Pi Extension

## 5.1 职责

Pi extension 负责：

1. 获取当前 Pi instance 信息。
2. 建立到 daemon 的持久连接。
3. 注册当前 instance / session。
4. 将 Pi 中发生的事件实时发送给 daemon。
5. 接收 daemon 发来的用户输入。
6. 将这些输入注入当前 Pi session。
7. Pi 退出时注销连接。

extension 不负责：

- 提供 Web 页面
- 管理其他 Pi
- 管理历史 session
- 对外监听端口

---

## 5.2 daemon 自动启动

Pi extension 启动时：

```text
连接 daemon
    │
    ├─ 成功
    │    └─ 注册当前 instance
    │
    └─ 失败
         ├─ 尝试启动 daemon
         ├─ 等待 daemon 可用
         └─ 再次连接
```

必须避免多个 Pi 同时启动 daemon 导致重复进程。

可选实现：

- lock file
- Unix socket
- PID file
- bind 端口作为互斥
- OS-level file lock

实现方式由 agent 决定。

---

# 6. Daemon

## 6.1 生命周期

daemon 应独立于任意单个 Pi 实例。

推荐行为：

- 第一个 Pi 可以自动启动 daemon。
- Pi 全部退出后 daemon 不立即退出。
- daemon 可以作为常驻本地服务存在。
- 用户也可以手动启动 daemon。

例如：

```bash
pi-remote daemon
```

或由 extension 自动 spawn。

---

## 6.2 网络绑定

默认：

```text
127.0.0.1:4317
```

daemon 默认禁止监听：

```text
0.0.0.0
```

除非用户显式配置。

推荐远程暴露方式：

```bash
tailscale serve http://127.0.0.1:4317
```

daemon 本身默认假设：

> 网络访问控制由 localhost + Tailscale 完成。

第一版不实现复杂登录系统。

---

# 7. Session 与 Instance

这两个概念必须明确区分。

## 7.1 Session

对应 Pi 的持久 session。

例如：

```text
sessionId = 01KABCDE...
```

session 可以跨多个 Pi 进程继续存在。

---

## 7.2 Instance

对应当前正在运行的一个 Pi process。

例如：

```text
instanceId = 18231-01KXYZ
```

instance 生命周期与 Pi process 相同。

推荐字段：

```ts
interface PiInstance {
  instanceId: string
  sessionId: string

  pid: number
  cwd: string

  model?: string
  startedAt: number

  status: "idle" | "running" | "waiting" | "error"

  writable: boolean
}
```

---

## 7.3 一个 session 对多个 instance

理论上可能出现：

```text
session A
├── instance 1234
└── instance 5678
```

daemon 必须检测这种情况。

默认规则：

> 一个 session 同一时间最多允许一个 writable instance。

如果检测到重复：

```text
session A
⚠ multiple live instances
```

daemon 不应自动向所有 instance 广播用户输入。

可以：

- 保留最先注册的 instance 为 writable
- 后注册的标记为 conflict

或者全部禁止写入，要求用户处理。

具体策略可以由实现者选择，但必须避免同时写多个相同 session。

---

# 8. Pi ↔ Daemon 通信

推荐使用持久双向连接。

可以使用：

- WebSocket
- Unix socket + 自定义 framing
- localhost TCP

第一版推荐 WebSocket，因为实现简单并且调试方便。

例如：

```text
ws://127.0.0.1:4317/internal
```

---

# 9. 注册协议

连接成功后，Pi 必须首先发送注册消息。

例如：

```json
{
  "type": "register",
  "instance": {
    "instanceId": "18231-01KXYZ",
    "sessionId": "01KABCDE",
    "pid": 18231,
    "cwd": "/home/user/Projects/Prism",
    "model": "gpt-5.6-sol",
    "startedAt": 1790930000000
  }
}
```

daemon 返回：

```json
{
  "type": "registered",
  "instanceId": "18231-01KXYZ",
  "writable": true
}
```

---

# 10. 心跳

必须处理 Pi 被 kill、终端崩溃、网络连接断开等情况。

可以依赖 WebSocket disconnect，也推荐增加 heartbeat。

例如：

```json
{
  "type": "heartbeat",
  "timestamp": 1790930000000
}
```

daemon 超过一定时间没有收到心跳后：

```text
instance -> offline
```

不要永久保留僵尸 live instance。

---

# 11. Pi Event

Pi extension 应尽可能直接转发 Pi 自身事件，而不是重新解析终端文本。

推荐统一事件格式：

```ts
interface SessionEvent {
  sessionId: string
  instanceId: string

  seq: number
  timestamp: number

  type: string
  payload: unknown
}
```

例如：

```json
{
  "type": "event",
  "sessionId": "01KABCDE",
  "instanceId": "18231-01KXYZ",
  "seq": 81,
  "timestamp": 1790930000000,
  "event": {
    "type": "assistant_message_delta",
    "text": "继续修改"
  }
}
```

---

# 12. Event 顺序

必须保证单 instance 内事件顺序稳定。

推荐每个 instance 使用递增：

```text
seq
```

例如：

```text
1
2
3
4
...
```

Web 客户端可以根据 seq 检测：

- 重复事件
- 丢失事件
- 重连后的断点

第一版不一定需要实现完整 replay，但协议应保留 seq。

---

# 13. 手机发送消息

浏览器输入消息后：

```text
Browser
  ↓
daemon
  ↓
对应 writable Pi instance
  ↓
Pi session
```

不要直接修改 session JSONL。

必须通过正在运行的 Pi API / extension API 注入。

推荐消息：

```json
{
  "type": "user_message",
  "requestId": "uuid",
  "sessionId": "01KABCDE",
  "text": "继续刚才的修改"
}
```

Pi 执行后返回：

```json
{
  "type": "request_ack",
  "requestId": "uuid"
}
```

或者：

```json
{
  "type": "request_error",
  "requestId": "uuid",
  "error": "..."
}
```

---

# 14. HTTP API

daemon 对浏览器暴露 REST API。

推荐：

```text
GET /api/sessions
```

返回所有已知 session。

例如：

```json
[
  {
    "sessionId": "01KABC",
    "cwd": "/home/user/Projects/Prism",
    "model": "gpt-5.6-sol",
    "status": "running",
    "live": true,
    "writable": true
  }
]
```

推荐：

```text
GET /api/sessions/:sessionId
```

返回单 session 详情。

推荐：

```text
POST /api/sessions/:sessionId/messages
```

body：

```json
{
  "text": "继续"
}
```

---

# 15. Browser 实时连接

浏览器实时事件推荐：

```text
/ws/sessions/:sessionId
```

或者 SSE：

```text
/api/sessions/:sessionId/events
```

两者都可以。

如果发送消息继续走 REST，那么 SSE 已经足够。

如果希望所有通信都统一，则使用 WebSocket。

实现者可自行决定。

---

# 16. Web 页面

## 16.1 首页

```text
/
```

显示当前已知 session。

示意：

```text
Pi Remote

● Prism
  ~/Projects/Prism
  GPT-5.6 Sol
  running

● Moneko
  ~/Projects/Moneko
  GPT-5.6 Luna
  idle

○ old-project
  ~/Projects/old-project
  offline
```

排序建议：

1. waiting
2. running
3. idle
4. offline

同等级按最近活动时间排序。

---

# 17. Session 页面

路径：

```text
/s/:sessionId
```

显示：

- cwd
- model
- instance 状态
- session 状态
- 对话历史
- 当前实时输出
- tool call
- tool result
- error
- 用户输入框

页面不要求完全复制 Pi TUI。

重点是：

> 手机上能清楚看懂当前 Pi 在做什么。

---

# 18. Tool Call 展示

tool call 不要直接塞一整块 JSON。

建议：

```text
Bash
$ pnpm test

✓ finished
```

或者：

```text
Edit
src/foo.ts

+ 12
- 4
```

但第一版如果 Pi API 提供的事件复杂，可以先采用简单折叠：

```text
▶ bash
▶ edit
▶ read
```

点击后看详细 payload。

---

# 19. 历史消息

第一版有两种可接受方案。

## 方案 A

daemon 只保存连接以来的事件。

优点：

- 简单

缺点：

- 手机打开晚了看不到之前消息

## 方案 B

进入 session 页面时，从 Pi session 文件读取历史消息，再拼接实时事件。

推荐最终采用方案 B。

但是：

> 历史 session 文件只能用于读取历史，不允许 daemon 直接写入。

所有新消息仍然必须经过 live Pi instance。

---

# 20. Offline Session

daemon 可以识别：

```text
live = false
```

的 session。

第一版：

- 可以查看历史
- 输入框 disabled

显示：

```text
This session is not currently running.
```

不要自动 resume。

---

# 21. Resume

第二阶段可以加入：

```text
Resume
```

功能。

daemon 启动：

```bash
pi --session <id>
```

但第一版明确不要求。

这样可以避免一开始处理：

- cwd 恢复
- 环境变量
- terminal
- model 参数
- duplicate instance
- credential 环境

---

# 22. Daemon Registry

daemon 内部维护：

```ts
Map<sessionId, SessionState>
```

SessionState 可以包含：

```ts
interface SessionState {
  sessionId: string

  cwd?: string
  model?: string

  instances: Map<string, InstanceConnection>

  activeInstanceId?: string

  lastActivityAt: number
}
```

---

# 23. 不需要持久化所有 runtime 状态

daemon 重启以后可以：

1. 当前运行中的 Pi 自动 reconnect。
2. 历史 session 可以重新扫描 session 目录。

所以 registry 本身不需要复杂数据库。

第一版优先使用：

```text
in-memory registry
```

如需轻量 metadata，可存：

```text
~/.pi/remote/state.json
```

但不要为了这个项目引入 SQLite，除非实现中确实有明显收益。

---

# 24. Daemon Discovery

extension 需要知道 daemon 地址。

默认：

```text
http://127.0.0.1:4317
```

允许：

```text
PI_REMOTE_PORT
PI_REMOTE_HOST
```

例如：

```bash
PI_REMOTE_PORT=4318 pi
```

但正常情况下用户不应该需要设置。

---

# 25. Tailscale

项目只负责 localhost Web 服务。

推荐文档提供：

```bash
tailscale serve http://127.0.0.1:4317
```

具体 Tailscale 配置不进入 daemon 核心逻辑。

不要强耦合 Tailscale API。

这样未来用户也可以选择：

- SSH tunnel
- Cloudflare Tunnel
- reverse proxy

---

# 26. 安全边界

默认假设：

```text
daemon == local trusted service
```

但仍需注意以下问题。

### 不允许任意 command API

不要设计：

```text
POST /api/bash
```

daemon 只能操作 Pi session。

### 不允许浏览器指定 arbitrary instance

消息必须通过：

```text
sessionId -> active writable instance
```

映射。

不能让客户端直接传：

```text
pid
socket path
```

控制其他进程。

### 不读取凭据

daemon 不需要获取：

- OpenAI API key
- Pi credential
- shell credential

credential 仍然存在 Pi process 环境中。

### 不直接修改 session 文件

daemon 对 session JSONL：

```text
read only
```

新消息必须发送给 live Pi。

---

# 27. 浏览器权限

第一版不需要复杂权限系统。

但是 Web server 默认：

```text
127.0.0.1
```

文档明确说明：

> 不要直接暴露到公网。

推荐：

```text
Tailscale Serve
```

---

# 28. 重连

Pi extension 连接 daemon 失败时必须自动重连。

建议：

```text
1s
2s
5s
10s
30s
```

最大 backoff 30 秒。

daemon 重启不应该导致 Pi session 受到影响。

即：

```text
daemon crash
```

只能影响远程 UI，不能影响 Pi 正常工作。

---

# 29. Web 客户端重连

手机浏览器断网 / 锁屏后：

```text
WebSocket disconnected
```

应自动重连。

重新连接后：

1. 获取最新 session 状态。
2. 重新订阅。
3. 如可能，根据 seq 补事件。

第一版如果没有 replay，可以简单重新加载最近历史。

---

# 30. Session 标题

首页最好不要只展示 session ID。

标题优先级建议：

1. Pi session 自身 title，如果存在
2. 当前 cwd basename
3. session ID

例如：

```text
Prism

/home/user/Projects/Prism
01KABC...
```

---

# 31. 状态

统一状态：

```text
idle
running
waiting
error
offline
conflict
```

含义：

### idle

Pi 在线，目前没有生成。

### running

Agent 正在运行。

### waiting

Agent 等待用户输入或确认。

### error

最近发生未恢复错误。

### offline

没有 live instance。

### conflict

同 session 存在多个 live instance。

---

# 32. UI 原则

主要目标设备：

- 手机
- 平板
- 桌面浏览器

因此：

- mobile first
- 不依赖 hover
- 按钮尺寸适合触摸
- 输入框固定在底部
- 对话区支持自动滚动
- 长 tool output 默认折叠

不需要复杂视觉效果。

---

# 33. 第一版 MVP

第一版只要求完成以下闭环：

```text
启动 Pi
   ↓
extension 自动连接 daemon
   ↓
daemon 首页出现该 session
   ↓
手机打开网页
   ↓
点击 session
   ↓
实时看到 Pi 输出
   ↓
手机发送一条消息
   ↓
Pi 收到消息
   ↓
继续运行
   ↓
手机继续实时看到输出
```

如果这个闭环可靠，就算第一版完成。

---

# 34. 建议开发阶段

## Phase 1：daemon 基础

实现：

- daemon HTTP server
- `/health`
- registry
- internal connection
- register / disconnect

测试：

同时启动多个 mock Pi client。

## Phase 2：Pi Extension

实现：

- extension 生命周期
- 自动启动 daemon
- register
- reconnect
- heartbeat

## Phase 3：事件转发

实现：

```text
Pi -> daemon
```

手机可以看到实时 event stream。

## Phase 4：Web UI

实现：

```text
/
```

session list。

实现：

```text
/s/:id
```

session view。

## Phase 5：浏览器发送消息

实现：

```text
Browser
-> daemon
-> Pi
```

确保只发送给 writable active instance。

## Phase 6：历史 session

读取 Pi session 文件。

支持：

```text
offline session view
```

---

# 35. 测试

至少需要测试：

### Registry

- 单实例注册
- 多实例注册
- instance disconnect
- 同 session 重复 instance
- writable selection

### Protocol

- malformed register
- unknown message
- duplicate request
- disconnect

### Routing

确保：

```text
session A message
```

不会发到：

```text
session B
```

### Reconnect

- daemon restart
- Pi reconnect
- browser reconnect

---

# 36. 日志

daemon 日志建议：

```text
[daemon] listening on 127.0.0.1:4317

[instance]
+ 18231
session=01KABC
cwd=/home/user/Projects/Prism

[instance]
- 18231

[session]
conflict 01KABC
```

不要默认输出每个 token delta，避免刷屏。

---

# 37. CLI

如果需要 CLI，保持非常简单。

例如：

```bash
pi-remote daemon
```

查看 daemon：

```bash
pi-remote status
```

可能输出：

```text
daemon: running
address: 127.0.0.1:4317

sessions:
3 live
8 offline
```

第一版甚至可以不做复杂 CLI。

---

# 38. 配置

推荐：

```text
~/.pi/remote/config.json
```

例如：

```json
{
  "host": "127.0.0.1",
  "port": 4317,
  "showOfflineSessions": true
}
```

不要设计过多配置项。

---

# 39. 故障原则

这个项目必须满足：

> Remote 功能出问题不能破坏 Pi 本身。

例如：

- daemon 没启动
- daemon 崩溃
- socket 断开
- Web UI 出错
- Tailscale 不可用

都不应该：

- 中止 Pi session
- 阻止 Pi 输入
- 导致 Pi crash
- 修改损坏 session 数据

Remote extension 必须是 optional / fail-open 的辅助能力。

---

# 40. 最终架构原则

请实现时保持以下几点：

1. 一个 daemon。
2. 一个 HTTP port。
3. 多 session 使用 endpoint 区分。
4. Pi 主动连接 daemon。
5. Pi extension 不监听独立端口。
6. session 与 process instance 分离。
7. 一个 session 最多一个 writable live instance。
8. daemon 不直接修改 Pi session 文件。
9. 所有实时输入通过 live Pi API 注入。
10. daemon 崩溃不能影响 Pi。
11. 默认只监听 localhost。
12. 远程访问交给 Tailscale。
13. 第一版只做 session 列表、查看、实时更新、发送消息。
14. 不提前实现完整远程 IDE。

最终目标不是替代 Pi TUI，而是提供一个：

> 可以随时从手机查看并继续当前 Pi 会话的轻量远程入口。
