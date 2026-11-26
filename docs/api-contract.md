# Windows Demo 接口契约

接口以 `/api/v1` 为前缀。普通 JSON 请求返回 `{ok: true, data: ...}` 或 `{ok: false, error: ...}`，运行事件使用 SSE。儿童界面优先读 `error.messageForChild`，分支判断使用 `error.code`。字段定义可对照[接口模型](../backend/api/dto.py)及[协议文件](../schemas/)。

| 功能 | 入口 |
| --- | --- |
| 启动、积木和课程 | `GET /startup/check`、`GET /blocks/schema`、`GET /course`、`GET /course/{course_id}` |
| 预测、反馈与总结 | `POST /session/prediction`、`POST /session/feedback`、`GET /session/summary` |
| 运行 | `POST /runs`、`GET /runs/{request_id}`、`GET /runs/{request_id}/events`、`POST /runs/{request_id}/cancel` |
| 作品 | `POST /projects/save`、`POST /projects/load` |
| 辅导与诊断 | `POST /tutor/hints`、`GET /matrix`、`GET /diagnostics/logs` |

## 1. `GET /api/v1/startup/check`

关键响应字段

| 字段 | 类型 | 语义 |
|---|---|---|
| `elapsedMs` | int | 实际检查耗时，缓存命中时返回原检查耗时 |
| `cached` | bool | 本次响应是否来自缓存 |
| `courseId` | string | 当前配置课包的标识 |
| `contentVersion` | string | `"x.y.z"` 内容版本，供前端对齐课程与回复包 |
| `runCapability` | object | `{canRun, reasonCode, reasonForChild, workerReady, blockedTaskIds, contentVersion}` |

`runCapability` 是运行门禁的单一真源：`worker` 检查未通过时 `canRun=false`、`reasonCode=RUNNER_UNAVAILABLE`；课程部分受限时 `canRun=true` 但 `blockedTaskIds` 列出受限任务。不能仅用顶层 `status=degraded` 判断可运行性。

## 2. `GET /api/v1/runs/{request_id}`

只读运行摘要，用于前端离开运行上下文时等待终态：

```json
{"ok": true, "data": {"requestId": "run-...", "finished": true, "status": "cancelled", "errorCategory": "cancelled"}}
```

- `status`：`running` 或六种终态之一。
- 标识非法（长度 1–64、`[A-Za-z0-9_-]`）→ `422 RUN_REQUEST_INVALID`。
- 不存在或超过 300 秒保留期 → `404 RUN_NOT_FOUND`。

## 3. `POST /api/v1/runs`

- `requestId` / `cancelToken` 约束：长度 1–64，字符集 `[A-Za-z0-9_-]`；不合法 → `422 RUN_REQUEST_INVALID`。
- 保留期内重复 `requestId` → `409 RUN_ID_CONFLICT`，不覆盖旧记录。
- 受理前完成门禁：`accepted` 收紧为“通过门禁且具备执行条件”。
- 常见受理错误

| 错误码 | HTTP | 含义 |
|---|---|---|
| `RUN_REQUEST_INVALID` | 422 | 标识不合法 |
| `RUN_ID_CONFLICT` | 409 | 保留期内重复标识 |
| `RUNNER_UNAVAILABLE` | 503 | worker 未通过启动检查 |
| `RUN_START_FAILED` | 503 | 后台线程启动失败 |
| `TASK_NOT_RUNNABLE` | 409 | 目标任务受限 |

同一 `requestId` 的 SSE `result` 帧恰好一次；编排异常也会收敛为 `crashed` 终态并释放运行槽。

停止请求携带该次提交的 `cancelToken`。停止响应表示请求得到处理，前端以 SSE 终态或运行摘要的 `finished` 确认结束。摘要用于恢复状态，完整舞台数据取自 SSE 结果。

## 4. `POST /api/v1/tutor/hints`

- `answerLevel` 为 `0|1|2|3`。
  - `0` 表示“未追加提示”，仅用于 `self_try` / `skip`；
  - `0` 不进入提示账本（不提升 `highest_hint`、不写 `hint_usage` 证据）；
  - 界面不得出现“第 0 级提示”。
- `self_try` / `skip` 仍保留动作与回复，但属于互动选择，不是提示等级。
- `mode=model` 时证据字段由 `sourceType/observedFact` 显式映射为 `type/fact`；映射失败、适配异常或输出校验失败一律回落 mock，并在响应中带可选 `fallbackReason`。

## 5. 预测和反馈

- `POST /session/prediction` 接收 `taskId` 与 0–1000 的整数 `value`，成功后返回已记录的值和尝试次数，允许该任务继续通过运行门禁。
- `POST /session/feedback` 的 `skip` 归属由请求中的 `taskId` 决定。前端在发起操作时捕获任务标识。

## 6. 课程与内容

- `GET /course` 返回 `CMK_COURSE_DIR` 配置的活动课包。旧入口 `GET /course/{course_id}` 仍可用，路径 ID 需与活动课包的 `courseId` 一致。
- 响应中的 `entryTaskId` 指向主任务。任务的 `nextTaskId`、`successCriteria`、`programCriteria`、`executionCriteria` 和 `teaching` 来自课包。总结按任务链接推荐首个可运行且尚未完成的关卡。
- 执行条件 `{kind:"motion.turn", inside:"control.if", atSteps:3, only:true}` 校验已执行动作属于指定分支，且发生时累计步数为 3。开启 `only` 时整轮只允许该类动作出现一次。后端用完整事件和舞台终态核对，证据不完整时该条件无法通过。
- 课程加载期对每个任务 `initialProgram` 执行完整程序结构校验：
  - 结构/规模/课程引用错误 → 课程加载失败（既有 `COURSE_VERSION_UNSUPPORTED`，开发者详情含 `task/code/block`）；
  - 含不可运行积木 → 仅该任务 `blocked`，其他任务不受影响。
- `tutor.replies.json` 逐条校验；无效条目被排除并产生诊断，全部无效时课程检查 `failed`，`SAFE_FALLBACK` 始终可用。
- 课程缓存键加入内容指纹（三份内容文件的 `size + mtime_ns`）；同一请求周期内课程、任务与辅导回复使用同一 `CourseBundle`。

## 7. 日志

- `stderrSummary` 最长 160 字符，脱敏后写入开发诊断日志。浏览器的 `result.stderr` 为空字符串。
- 日志仍不记录 `cancelToken`、儿童输入全文与源码全文。

## 8. 当前作品与程序校验

- 重复次数接受 `1–100` 的整数。新放置的「向前走」每次走一步，旧作品的 `steps` 仍接受 `1–100` 的整数。转角接受有限数值，含负数和小数。正方形按归一化后的 `90°` 或 `270°` 验证直角。这些参数在作品格式中也可存放 `value.number` 积木。移走数字积木后恢复字段默认值。
- 循环体按 `body` 数组顺序处理每条语句链，各链自头部沿 `next` 执行。
- 当前作品格式的 `courseRef.version` 必须是正整数。格式不合法时，保存和打开返回 `422 PROGRAM_SCHEMA_INVALID`。课程版本格式合法但本机缺失时，保存返回 `409 COURSE_VERSION_UNSUPPORTED`，打开返回只读结果和原因。
- 旧版作品迁移时可将整数版本字符串转换为整数。无法转换的旧版版本字符串返回 `422 PROGRAM_MIGRATION_FAILED`。
- 允许作品草稿保存空的必填表达式槽。运行时仍要求填满这些槽，语句链和语句体拒绝表达式节点。
- 保存、加载和运行接受作品格式 v1 的单链 `root` 以及 [v2 的 `stacks`](../schemas/program.v2.json)。v2 中每组保存整数坐标 `x`、`y` 和积木树 `root`，积木编号在整个作品内唯一。
- v2 按 `stacks` 顺序执行以 `event.start` 开头的脚本，独立草稿也可保存。由旧作品转换的无开始积木脚本可使用 `legacy: true` 延续原来的运行行为。

## 9. AI 教学增强

当前工作台使用以下可选字段。预测、运行和辅导仍接受旧版请求。

- `learningContext.scope` 包含 `contentVersion`、`workspaceId`，也接受 `courseId`、`taskId`。课程版本变化时复用 `COURSE_VERSION_UNSUPPORTED` 错误，提示刷新课程。
- 预测请求可带 `learningContext.program`，增强响应返回 `predictionId`。运行请求在 `learningContext` 带预测 ID、最近八个已呈现提示 ID 和 `workspaceSource`。程序摘要匹配时，预测才参与错因判断。
- 运行 SSE `result.learning` 包含 `outcome`、`pattern`、`facts`、`predictionMatch`、`traceQuality` 和可空的 `replay`。`replay.actions` 包含积木 ID、动作种类、动作参数、轮次及执行后的舞台状态。正方形和配置了执行条件的任务还返回 `routeMet`、`structureMet`。字段附在浏览器 SSE 结果，运行摘要和作品使用原有格式。
- 辅导请求可带当前 `program`、`runRequestId` 和 `seenHintIds`。增强回复的 `learning` 包含 `pattern`、`runRequestId`、`anchorBlockId`、`nextAction`。定位与回放只使用属于当前工作区的程序和结果。
- 课程总结返回 `nextTaskId`。配置迁移题时还返回带任务标题的 `transfer`，有可引用的观察时补充 `observation`。已验证提示记为 `assisted`。任务工作区明确上报空列表时记为 `none`。缺少帮助证据时记为 `unknown`。
- 可选模型协议仍为 v1。增强请求发送 `teachingDecision`，带动作、级别、错因、可引用事实和下一步意图。校验失败时使用本地回复。

## 10. 网页模型接入与多轮教学

网页模型通过测试和启用后参与本轮辅导。课堂回复的 `mode` 和 `fallbackReason` 表示实际来源。多轮策略受 `CMK_TUTOR_AGENT_ENABLED=1` 控制。

### 10.1 接入方式

浏览器通过本机 FastAPI 调用供应商。连接测试通过后，网页配置及密钥保存到 `model-config.local.json`，随服务启动加载。公开响应、日志、作品和 SSE 只使用非凭据字段。

### 10.2 `GET /api/v1/tutor/model-config`

- 请求：无查询参数。
- 响应 `data` 包含 `effectiveMode(mock|model)`、`source(default|environment|web)`、`revision(int≥0)`、`baseUrl(string|null)`、`model(string|null)`、`apiKeyConfigured(bool)`。存在已保存的待启用配置时，另返回 `testedConfig`，包含 `baseUrl`、`model` 和 `testId`。
- 只校验回环对端与 `Host`，不要求 `Origin`；不写状态、不触网。
- 所有响应带 `Cache-Control: no-store`。

### 10.3 `POST /api/v1/tutor/model-config/test`

- 请求字段为 `expectedRevision(int≥0)`、`baseUrl(≤512, HTTPS)`、`model(≤160)` 和 `apiKey(≤2048)`。同一地址可省略密钥以复用已保存的值。
- 响应：`testId`、`revision`、`model`、`latencyMs`、`expiresAt`（UTC，`Z` 结尾）。
- 通过条件包括同源检查、DTO 检查、地址检查、上游返回非空 JSON 对象及本机文件写入成功。已保存的候选在重启后仍可凭 `testId` 启用，直到被替换或启用。`expiresAt` 为兼容旧版保留。测试期间课堂继续使用当前配置。
- 地址策略：仅公开 HTTPS 域名；拒绝凭据、查询、片段、IP 字面量、私网/回环/链路本地/保留/多播、`..`、超长与已含 `/chat/completions` 的地址。

### 10.4 `POST /api/v1/tutor/model-config/activate`

- 请求包含 `expectedRevision` 和 `testId`。再次启用已暂停的课堂模型时省略 `testId`。
- 配置写入成功后进入 `source=web`、`effectiveMode=model`，递增 `revision`。新候选启用后即被消费。

### 10.5 `POST /api/v1/tutor/model-config/disable`

- 请求：`expectedRevision`。
- 切回 `mock` 并保留已保存的课堂模型和待启用配置。重启后保持演示模式，直到再次启用。已处于 `mock` 且无进行中的测试时，重复停用幂等。

### 10.6 配置错误映射

| 失败类别 | 复用错误码 | HTTP | 说明 |
|---|---|---|---|
| `invalid` | `PROGRAM_SCHEMA_INVALID` | 422 | 地址或参数不合法 |
| `forbidden` | `FORBIDDEN` | 403 | 同源/私网/重定向 |
| `conflict` | `RUN_ID_CONFLICT` | 409 | `expectedRevision` 不符 |
| `expired` | `COURSE_VERSION_UNSUPPORTED` | 409 | 候选过期/被替换/已消费 |
| `auth`、`endpoint`、`rate_limit`、`timeout`、`refusal`、`invalid_response` | `TUTOR_UNAVAILABLE` | 502 | 上游失败，`error.category` 承载细分 |
| `storage` | `TUTOR_UNAVAILABLE` | 500 | 本地配置文件写入失败，当前模式与待启用候选保持有效 |

网页设置使用 `error.category` 映射短提示。课堂的网络错误返回 `mode=mock` 及 `fallbackReason`，以便继续练习。

### 10.7 多轮字段

`learningContext.turnId` 标识一次提交，重复提交相同内容复用已完成结果。`replyToTurnId` 引用同工作区、同程序摘要、同运行及模型配置下当前待答的问题。返回 `learning.turnId` 与 `awaitingAnswer`，定位和回放继续使用已有 `learning` 字段。提交冲突或待答问题失效时返回 409。启动时未启用多轮策略仍可使用网页模型生成经校验的提示文案。

### 10.8 日志事件（白名单）

模型日志使用 `modelSource`、`modelRevision`、`modelCategory` 等已有白名单字段，记录候选测试、配置冲突和课堂回退。密钥、上游正文与问答内容仅用于请求和本机课堂流程。

## 11. AI 老师对话与学生档案

- 启动报告返回 `tutorChatEnabled`。默认启用新对话，`CMK_TUTOR_CHAT_ENABLED=0` 切回旧辅导界面。
- `POST /api/v1/tutor/chat` 接收任务、学生消息、带轮次 ID 的工作区上下文和可选的选中积木 ID。返回 `message`、`action`、`awaitingAnswer`、`supportLevel` 和有版本归属的 `controls`。服务端可能返回本地回复、`TUTOR_TURN_BUSY` 或 `TUTOR_TURN_CONFLICT`。重试需保留轮次 ID 和快照。
- 聊天返回 `action=edit_block` 时附带 `edit`，包含积木 ID、参数名称、新旧值和可用的改前运行计数。每轮只允许改动一个现有的次数、步数或角度参数。浏览器核对提交时的工作区和原值后，通过编辑器应用改动、记入撤销记录，并在同一版积木运行完毕后解释实际结果。
- `GET /api/v1/students` 读取档案，`POST /api/v1/students` 用昵称创建档案。 `GET /api/v1/students/{studentId}/progress` 返回该档案的学习观察。无效档案返回 `STUDENT_NOT_FOUND`，存储不可用返回 `LEARNING_STORE_UNAVAILABLE`。
- 带档案的课堂 JSON 请求使用 `X-CMK-Student-Id`，SSE URL 使用 `studentId`。工作台为临时练习生成标签页标识。旧请求可以省略此标识。学生档案和观察使用 `CMK_LEARNING_DB_PATH`，默认 `data/learning.sqlite3`。返回 `memorySaved=false` 表示本轮课堂可以继续，学习观察暂不可保存。

[首版开发和验收文档](CodeMateKids_AI老师对话与学习记忆开发文档.md)

## 11. AI 老师语音对话（0.8.0，可选能力）

语音能力依赖 4 个 `CMK_SIS_*` 环境变量，未配置时两接口一律返回 503，启动检查 `tutorSpeechEnabled` 为 `false`。 [运行说明](run.md)

### 11.1 `GET /api/v1/startup/check`（扩展）

响应新增可选布尔 `tutorSpeechEnabled`（缺省 `false`），取值 `tutorChatEnabled and SIS 可用性`。既有字段语义与缓存行为不变。

### 11.2 `POST /api/v1/speech/recognize`

| 项 | 值 |
| --- | --- |
| 请求头 | `Content-Type: application/json`；`X-CMK-Student-Id` 可选（缺省临时会话） |
| 请求体 | `{ "audioBase64": string }`；整体请求体 ≤512 KiB（解析前拒绝） |
| 成功 | `{ "ok": true, "data": { "text": string } }`，`Cache-Control: no-store` |
| 停用 | 503 `SPEECH_UNAVAILABLE`「语音小助手还没准备好，可以先打字提问。」 |
| 超限 | 413 `SPEECH_PAYLOAD_TOO_LARGE` |
| 无效音频 | 422 `SPEECH_AUDIO_INVALID`（空串、非法 Base64、解码为空） |
| 上游失败 | 503 `SPEECH_UNAVAILABLE`「没听清这一句，可以再说一次或打字。」；零自动重试 |

转写文字由学生确认后经既有 `POST /tutor/chat` 发送，本接口不建立轮次、不持久化。

### 11.3 `POST /api/v1/speech/synthesize`

| 项 | 值 |
| --- | --- |
| 请求体 | `{ "turnId": string, "scope": { "courseId", "contentVersion", "taskId", "workspaceId" } }` |
| 成功（音频） | 200 `audio/mpeg` + `Cache-Control: no-store`，body 为 MP3 字节 |
| 成功（超长） | 200 `application/json`，`{ "ok": true, "data": { "playable": false, "reasonCode": "SPEECH_TEXT_TOO_LONG" } }`（回复文本 >500 字符；前端按 Content-Type 区分双形态） |
| 轮次未找到 | 404 `RUN_NOT_FOUND`（复用既有码；不存在、过期与跨学生同一口径，无细节泄露） |
| scope 缺项 | 422 `PROGRAM_SCHEMA_INVALID`；版本不符 409 `COURSE_VERSION_UNSUPPORTED` |
| 停用/上游失败 | 503 `SPEECH_UNAVAILABLE` |

播报一次播放一次合成，重播复用前端已取得的音频，零新请求。音频只存在于响应中，服务端不落盘。

### 11.4 错误码与日志

错误码表新增语音命名空间 3 键：`SPEECH_UNAVAILABLE`(503)、`SPEECH_PAYLOAD_TOO_LARGE`(413)、`SPEECH_AUDIO_INVALID`(422)；既有 32 键零变更，语音码不出现在课程/运行/作品/编辑器/模型配置/对话分支。日志白名单新增 `cloudTraceId`（16+1）；语音事件 `speech_recognize`/`speech_synthesize` 只记录耗时、类别与云端追踪 ID，不记录音频、转写原文、回复原文、turnId 与 AK/SK。
