# 接口契约补充（0.1.0 缺陷修复）

> 本文只记录本次修复新增或语义变化的契约；既有字段名与成功响应结构保持不变。

## 1. `GET /api/v1/startup/check`

新增字段（只增不改）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `elapsedMs` | int | **语义修正**：仅覆盖本次实际检查过程；缓存命中时为原始检查耗时 |
| `cached` | bool | 本次响应是否来自缓存 |
| `contentVersion` | string | `"x.y.z"` 内容版本，供前端对齐课程与回复包 |
| `runCapability` | object | `{canRun, reasonCode, reasonForChild, workerReady, blockedTaskIds, contentVersion}` |

`runCapability` 是运行门禁的单一真源：`worker` 检查未通过时 `canRun=false`、`reasonCode=RUNNER_UNAVAILABLE`；课程部分受限时 `canRun=true` 但 `blockedTaskIds` 列出受限任务。不能仅用顶层 `status=degraded` 判断可运行性。

## 2. 新增 `GET /api/v1/runs/{request_id}`

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
- 新增错误码：

| 错误码 | HTTP | 含义 |
|---|---|---|
| `RUN_REQUEST_INVALID` | 422 | 标识不合法 |
| `RUN_ID_CONFLICT` | 409 | 保留期内重复标识 |
| `RUNNER_UNAVAILABLE` | 503 | worker 未通过启动检查 |
| `RUN_START_FAILED` | 503 | 后台线程启动失败 |
| `TASK_NOT_RUNNABLE` | 409 | 目标任务受限 |

同一 `requestId` 的 SSE `result` 帧恰好一次；编排异常也会收敛为 `crashed` 终态并释放运行槽。

## 4. `POST /api/v1/tutor/hints`

- `answerLevel` 扩展为 `0|1|2|3`：
  - `0` 表示“未追加提示”，仅用于 `self_try` / `skip`；
  - `0` 不进入提示账本（不提升 `highest_hint`、不写 `hint_usage` 证据）；
  - 界面不得出现“第 0 级提示”。
- `self_try` / `skip` 仍保留动作与回复，但属于互动选择，不是提示等级。
- `mode=model` 时证据字段由 `sourceType/observedFact` 显式映射为 `type/fact`；映射失败、适配异常或输出校验失败一律回落 mock，并在响应中带可选 `fallbackReason`。

## 5. `POST /api/v1/session/feedback`

- 结构与字段不变；`skip` 的归属完全由请求中的 `taskId` 决定，前端必须传发起选择时捕获的任务标识，不读切换后的当前任务。

## 6. 课程与内容

- 课程加载期对每个任务 `initialProgram` 执行完整程序结构校验：
  - 结构/规模/课程引用错误 → 课程加载失败（既有 `COURSE_VERSION_UNSUPPORTED`，开发者详情含 `task/code/block`）；
  - 含不可运行积木 → 仅该任务 `blocked`，其他任务不受影响。
- `tutor.replies.json` 逐条校验；无效条目被排除并产生诊断，全部无效时课程检查 `failed`，`SAFE_FALLBACK` 始终可用。
- 课程缓存键加入内容指纹（三份内容文件的 `size + mtime_ns`）；同一请求周期内课程、任务与辅导回复使用同一 `CourseBundle`。

## 7. 日志

- 白名单新增 `stderrSummary`（长度 ≤160，脱敏后仅进入开发诊断日志；`result.stderr` 仍为空字符串，前端不可见）。
- 日志仍不记录 `cancelToken`、儿童输入全文与源码全文。

## 8. 当前作品与程序校验

- 重复次数、向前步数和转弯角度可直接填写，也可存放 `value.number` 积木。次数和步数接受 `1–100` 的整数，角度接受 `90`、`180`、`270`。移走数字积木后恢复相应字段的默认值。
- 循环体按 `body` 数组顺序处理每条语句链，各链自头部沿 `next` 执行。
- 当前作品格式的 `courseRef.version` 必须是正整数。格式不合法时，保存和打开返回 `422 PROGRAM_SCHEMA_INVALID`。课程版本格式合法但本机缺失时，保存返回 `409 COURSE_VERSION_UNSUPPORTED`，打开返回只读结果和原因。
- 旧版作品迁移时可将整数版本字符串转换为整数。无法转换的旧版版本字符串返回 `422 PROGRAM_MIGRATION_FAILED`。
- 允许作品草稿保存空的必填表达式槽。运行时仍要求填满这些槽，语句链和语句体拒绝表达式节点。
- 保存、加载和运行接受作品格式 v1 的单链 `root` 以及 [v2 的 `stacks`](../schemas/program.v2.json)。v2 中每组保存整数坐标 `x`、`y` 和积木树 `root`，积木编号在整个作品内唯一。
- v2 按 `stacks` 顺序执行以 `event.start` 开头的脚本，独立草稿也可保存。由旧作品转换的无开始积木脚本可使用 `legacy: true` 延续原来的运行行为。
