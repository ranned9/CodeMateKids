# CodeMateKids 0.1.0 首版 Bug 审查与修改建议

> 审查日期：2026-11-14  
> 范围：后端运行编排、受限运行器、启动与课程校验、前端项目载入与辅导错误显示、运行/安装/测试入口。  
> 本文是代码审查记录；本次只新增报告，没有修改业务代码。

## 结论

首版主流程已有较完整的后端测试和编辑器内核检查，但仍有几处会影响运行恢复、错误显示和项目载入状态的缺陷。建议先处理 P1，再解决部署范围与内容校验问题；真实浏览器验收和完整 Python 测试需要在依赖齐全的环境重跑。

本次记录 **6 项 P1、11 项 P2、3 项需按部署/发布条件处理的风险或验证缺口**。优先级说明：P1 是会造成流程卡死、运行控制失效或任务状态串用的问题；P2 是数据正确性、边界校验、潜在安全风险或用户体验问题。条件项不全部属于当前单机演示范围内的 Bug，但扩大部署或发布前需要处理或验证。

证据说明：问题依据当前源码控制流检查确认；文中的触发步骤和故障注入场景也是后续回归用例，并不表示均已在真实浏览器中复现。已执行检查及环境限制见文末。尤其 P2-8 只确认不安全的 HTML 渲染方式，未确认当前后端存在可被外部输入利用的攻击链。

## P1：优先修复

### P1-1 运行线程异常退出时不会释放运行状态

位置：[backend/service/run.py](../backend/service/run.py#L141)

`RunManager._execute()` 只在正常执行路径末尾调用 `context.finish()` 并清空 `_active_id`。`run_program()`、成功标准评估或证据记录发生未捕获异常时，线程直接退出，`finished` 仍为 false，后续运行会一直被拒绝为 `RUN_IN_PROGRESS`。评估前异常会让客户端收不到 `result`；证据记录位于 `result` 发布之后，可能出现界面已经显示完成、下一次运行却始终被拒绝的情况。当前日志函数已吞掉文件系统 `OSError`，普通日志目录不可写不能直接作为本问题的复现条件。

修改建议：将整个后台执行流程包在 `try/except/finally` 中。尚未发布结果时，异常应构造统一的 `RUNNER_CRASHED` 结果并发布 `result` 和 `error`；结果已经发布时，后续证据或日志错误只记录诊断，不再发第二个互相矛盾的结果。`finally` 必须完成上下文、通知等待者，并在锁内仅当当前上下文匹配时释放 `_active_id`。提交路径还应处理 `thread.start()` 失败，回滚已经注册的运行状态。

验收标准：分别注入 `run_program`、`evaluate_criteria`、证据存储、日志函数非预期异常及线程启动失败；已接受的运行只产生一个终态结果，状态最终完成，随后提交的新运行能够正常开始。

### P1-2 worker 握手的超时不能打断阻塞读取

位置：[backend/runner/supervisor.py](../backend/runner/supervisor.py#L178)

`_drain_ready()` 虽然计算了 2 秒 deadline，但 `process.stdout.readline()` 是阻塞调用。worker 未输出换行或卡在启动阶段时，循环无法返回检查 deadline，调用方的启动超时实际失效。

修改建议：用独立 reader 线程向有界队列传递行和 EOF，主线程用 `Queue.get(timeout=...)` 等待；或改用可超时的非阻塞读取。握手超时后终止整个 worker 进程树、关闭管道并返回明确的启动失败。

验收标准：测试 worker 永不输出、输出半行后挂起、提前退出三种情况；每种情况都在规定时间内返回，且不遗留进程或线程。

### P1-3 连续运行会覆盖当前运行的停止凭据

位置：[frontend/js/views/runner.js](../frontend/js/views/runner.js#L42)、[frontend/js/views/runner.js](../frontend/js/views/runner.js#L61)

`updateControls()` 只在 `running` 阶段禁用运行按钮，提交请求等待期间却处于 `validating`，按钮仍可点击；`run()` 本身也没有运行中或提交中的重入保护。第二次调用会立刻覆盖 `state.runRequestId` 和 `cancelToken`。即使后端拒绝第二次请求，第一轮运行仍在继续，而前端可能进入错误状态，停止按钮失效，或使用第二轮不存在的 ID 发起取消。

触发步骤：在网络延迟下快速双击运行；或运行未结束时通过运行快捷键、上一轮结果区的“再试一次”再次调用 `run()`。

修改建议：在 `run()` 入口同步设置提交占用标志，覆盖 `validating/running/cancelling` 全过程；按钮、快捷键和重试入口统一调用该保护。使用不可变的运行上下文保存 ID/token，只有当前请求才能更新 phase、打开 SSE 或解除占用；重复调用直接返回，不能改写现有凭据。

验收标准：延迟提交响应，连续点击、按快捷键并点击旧结果的重试按钮；只发送一份提交请求，停止请求始终使用已接受运行的凭据，第一轮完成后才能再次运行。

### P1-4 打开项目只切换任务 ID，没有重置任务运行状态

位置：[frontend/js/main.js](../frontend/js/main.js#L266)

`openProject()` 直接写入 `state.activeTaskId` 并替换编辑器内容，没有走统一的任务状态重置流程。上一个任务的运行结果、运行阶段、对象动画位置和辅导等级可能仍留在界面，显示的作品与结果不匹配。`editor.setProgram()` 已清除选中积木、错误积木和撤销历史，因此这些不属于本项遗漏。另外，打开文件前没有检查 `state.dirty`，已有未保存编辑会被直接覆盖。

修改建议：增加统一的“载入作品/切换任务”状态转换函数。先完成文件与任务引用校验，对未保存修改提供保存或放弃选择；与 P1-6 一起处理未完成运行，再设置课程任务，清除上一轮结果、运行事件、辅导等级、动画和预测对照，装入项目树，最后按 `runnable` 设置只读状态并刷新视图。打开无效任务引用的作品时，要显示明确的只读状态，不沿用旧任务标题/状态。

验收标准：先运行主任务，再打开变式任务作品和只读旧版本作品；结果面板、预测对照、角色位置、工具箱、任务标题和运行按钮均对应当前作品。存在未保存编辑时取消打开操作，原编辑和撤销历史均保留。

### P1-5 API 在 worker 探测失败的 `degraded` 状态仍接受运行

位置：[backend/service/run.py](../backend/service/run.py#L81)

提交接口只拒绝 `fatal`。worker 探测失败会得到 `degraded`，此时后端仍接受运行请求，之后才在监督器启动失败时返回崩溃。前端另有 worker 门禁，但 API 本身没有保持同一规则。

修改建议：把启动检查状态映射为明确的运行能力条件：worker 未通过时 API 直接拒绝运行并返回稳定错误码；课程部分受限时仍可按具体任务能力决定是否可运行。将门禁逻辑封装到服务层并让前端与后端复用同一状态定义。

验收标准：模拟 worker 不可启动及课程部分 blocked，分别验证 API 返回可解释错误或只允许可运行任务；不能出现“已 accepted 后必定崩溃”。

### P1-6 运行中切换任务会串结果，重置后后台运行仍未停止

位置：[frontend/js/main.js](../frontend/js/main.js#L123)、[frontend/js/main.js](../frontend/js/main.js#L160)、[frontend/js/views/runner.js](../frontend/js/views/runner.js#L123)、[frontend/js/views/runner.js](../frontend/js/views/runner.js#L229)

任务卡片允许在运行中切换任务。`loadTask()` 将页面改成新任务并设为 `editing`，但没有取消旧运行或关闭旧 SSE；旧回调也没有核对当前任务、请求 ID 或页面版本。旧任务的输出、错误、结果和角色状态会写入新任务页面，预测对照甚至会使用新任务的预测与旧结果比较。`reset()` 虽关闭 SSE，却未调用取消接口，后台仍占用运行槽；用户立即重新运行会收到 `RUN_IN_PROGRESS`。这些问题同样可能发生在提交请求尚未返回时。

触发步骤：让主任务运行稍久，立即进入变式任务，观察旧输出或结果随后出现；另一次运行中点击重置，再立即运行，观察后台占用导致的拒绝。打开项目和总结页进入变式的入口也需覆盖。

修改建议：给 runner 增加统一的离开当前运行流程，供切换任务、打开项目和重置调用。第一步递增页面/运行版本，使旧回调立即失效；保留旧 ID/token，取消运行并等待其终态，再关闭事件流并释放运行占用。提交响应尚未返回时，待其返回后也必须取消已接受的旧运行，不能再打开旧页面的事件流。所有提交、SSE、错误与完成回调都核对其捕获的任务 ID、requestId 和页面版本；取消失败时保留恢复入口，不能直接假装后端空闲。首版若暂不支持该流程，可在提交和运行期间统一禁用切换、打开和重置入口。

验收标准：在提交等待、运行中、取消中和结果即将返回时执行任务切换、打开、重置；新任务不出现旧输出或旧预测对照，不被旧回调改变 phase，后台运行能结束并恢复运行能力。返回同一 taskId 也不能接收上一轮页面的过期回调。

## P2：建议在下一轮修复

### P2-1 启动检查耗时不是本次检查的耗时

位置：[backend/service/startup.py](../backend/service/startup.py#L20)、[backend/service/startup.py](../backend/service/startup.py#L206)

`started_at` 使用模块导入时的 `PROCESS_START`，因此 `elapsedMs` 表示进程启动以来的时间；进程运行越久数值越大，缓存结果也可能携带旧耗时。

修改建议：每次实际执行 `check_startup()` 时在函数内取 `time.perf_counter()`，用该时间计算检查耗时。缓存命中时明确返回缓存标志或原始检查耗时，不伪装成本次测量值。

验收标准：进程启动后等待一段时间再检查，`elapsedMs` 仍只覆盖检查本身；重复强制刷新时数值随实际检查耗时变化。

### P2-2 运行 ID 缺少长度和重复值校验

位置：[backend/api/dto.py](../backend/api/dto.py#L85)、[backend/service/run.py](../backend/service/run.py#L74)

`requestId` 和 `cancelToken` 是未设长度上限的字符串；运行完成后重用相同 `requestId` 会覆盖 `_runs` 旧上下文，导致已存在或重连的 SSE 客户端取到错误运行记录。大量超长 ID 也会增加内存与日志负担。

修改建议：在 DTO 中设置合理长度和字符集约束，例如 requestId 限制为 1–64 个字母、数字、下划线或短横线；提交时在注册上下文的同一把锁内拒绝仍在保留期的重复 ID。也可改为完全由服务端生成并返回。对 cancel token 设置与生成方式一致的长度及字符约束，并避免把 token 写入日志。

验收标准：空值、过长值、非法字符和重复 ID 均收到稳定 4xx 错误；重复提交不能覆盖旧运行的结果或 SSE 事件。

### P2-3 worker 的 stderr 管道没有持续读取

位置：[backend/runner/supervisor.py](../backend/runner/supervisor.py#L235)、[backend/runner/worker.py](../backend/runner/worker.py#L279)

监督器将 `stderr` 接到 PIPE，但没有 reader 消费它；worker 异常路径会输出 traceback。若错误输出填满操作系统管道缓冲区，worker 可能阻塞，监督器就会将其误判为超时或卡死。

修改建议：为 stderr 配置独立 reader，持续 drain 但不把 traceback 暴露给儿童界面；开发日志只保留长度受限、脱敏后的摘要。也可在不需要 stderr 时重定向到受控文件或 `DEVNULL`，但保留排障能力。

验收标准：让 worker 连续写入超过管道缓冲区大小的 stderr，运行仍能在超时/崩溃路径收敛；前端看不到堆栈或本机路径。

### P2-4 课程更新后缓存与前端任务快照可能不一致

位置：[backend/service/course.py](../backend/service/course.py#L58)、[backend/service/startup.py](../backend/service/startup.py#L167)、[frontend/js/main.js](../frontend/js/main.js#L206)

课程缓存只以目录路径为 key。服务运行期间更新内容后，普通课程和 tutor 请求继续读取旧对象，直到显式 refresh 或进程重启。更直接的问题是：点击“重新检查”会刷新后端课程缓存，但前端 `refreshStartup()` 仅更新启动状态，没有重新加载 `state.course` 和 `state.tasks`；此时界面目标和初始程序可能仍是旧版，后端评估标准与辅导回复却已经切换到新版。仅“不自动热更新”可以是设计选择，刷新后两端版本不一致则需要处理。

修改建议：先统一内容版本切换机制：重新检查发现内容版本变化时，前端重新请求课程并重建任务映射，按 P1-4/P1-6 保护现有编辑和运行；已经开始的运行使用其提交时的课程快照。开发模式可按文件 mtime/内容 hash 失效缓存；生产模式使用显式内容版本和原子替换。启动检查、课程 API、辅导回复应使用一致版本。

验收标准：更新任一课程文件后，按开发刷新流程可立即观察到版本变化；同一请求周期内课程元信息和回复包来自同一版本。

### P2-5 辅导回复包只校验顶层 `replies` 是数组

位置：[backend/service/course.py](../backend/service/course.py#L86)、[backend/tutor/mock.py](../backend/tutor/mock.py#L19)

回复项的 `level`、动作、字段类型和必填字段没有加载时校验。`_pick_reply()` 会对 level 执行 `int(...)`；内容包误填字符串可能让 tutor 接口抛 500，而不是回落安全默认回复。

修改建议：为每条回复建立严格 schema，加载时校验任务 ID、动作枚举、等级范围、消息长度和字段类型；无效包应在启动检查中明确失败或跳过单条并记录开发日志，不能在儿童请求路径上抛出未捕获异常。

验收标准：缺字段、无效 level、未知动作、错误类型的课程夹具均得到可预期启动诊断或安全兜底，tutor API 不返回未处理 500。

### P2-6 课程初始程序没有经过完整程序结构校验

位置：[backend/service/course.py](../backend/service/course.py#L190)

课程校验检查了程序格式、版本、目标和部分字段，但没有直接将每个 `initialProgram` 交给 `validate_program()` 做完整节点、字段、深度、规模和课程引用校验。结构错误可能通过启动检查，到前端编辑或首次运行才失败。

修改建议：课程加载时对每个任务的 `initialProgram` 调用完整校验，并传入预期 `taskId`；校验失败应在 startup/course 阶段定位到具体任务，避免把坏内容交给前端。

验收标准：对缺 root、非法节点/字段、错误 taskId、超深结构和不可运行积木构造课程夹具，启动检查均明确失败或将对应任务标记 blocked，不得出现前端初始化异常。

### P2-7 小窗口仍有横向溢出

位置：[frontend/css/app.css](../frontend/css/app.css#L22)、[frontend/css/app.css](../frontend/css/app.css#L315)

主体最小宽度为 1180px，媒体查询虽降至 980px，但工作区三列最小宽度合计仍约 1040px（另有间距和内边距），较窄窗口会出现横向滚动和操作区被挤出。

修改建议：按可用宽度调整网格，允许侧栏折叠或改为两列/单列；如暂不支持低分辨率，明确显示建议的最低窗口尺寸，不要在半支持宽度下溢出。

验收标准：在 1024×768 和 1280×720 下完成课程切换、积木编辑、运行和求助操作；页面无非预期横向溢出。

### P2-8 辅导错误文案直接进入 `innerHTML`

位置：[frontend/js/views/tutor.js](../frontend/js/views/tutor.js#L47)

请求失败时，`error.messageForChild` 被直接插入 HTML；该值来自 API 错误对象。若错误文本含 HTML 标记，浏览器会将其解析为节点。当前审查没有证明本机后端的错误文案可被外部输入控制，因此这是已确认的不安全渲染方式及潜在 XSS 风险，不能直接等同于已复现的远程攻击漏洞。

修改建议：用 `createElement()` 构建错误容器，以 `textContent` 设置错误文案和下一步提示。动态 API 文本统一按纯文本呈现。

验收标准：用包含 `<img src=x onerror=...>` 和 HTML 标签的模拟错误响应触发失败路径；页面只显示文字，不创建对应图片节点、不执行事件处理器。

### P2-9 预测和辅导请求返回后使用了已经切换的任务 ID

位置：[frontend/js/main.js](../frontend/js/main.js#L171)、[frontend/js/views/tutor.js](../frontend/js/views/tutor.js#L27)

`submitPrediction()` 发送时读取当前任务 ID，等待返回后再次读取 `state.activeTaskId` 写入预测。若中间切换任务，服务端记录主任务预测，前端却将变式任务标为已预测，运行时又被服务端以 `PREDICTION_REQUIRED` 拒绝。辅导请求也会在切换后把旧回复写入新任务；选择“跳过”时，`await hint()` 后的 `feedback(state.activeTaskId, "skip")` 还会把新任务错误标成跳过。

触发步骤：为预测或辅导接口增加延迟，发起主任务请求后立即进入变式任务；检查预测显示、辅导内容及总结中的跳过记录。

修改建议：请求开始时捕获不可变的 taskId 和页面版本；所有后续接口调用始终使用捕获的 taskId，预测缓存按原任务 ID 写入。只有页面版本仍匹配时才更新当前 DOM、辅导等级或按钮；辅导同时加请求序号，防止同任务内较旧回复覆盖新回复。跳过记录应归属用户当时选择的任务，并避免重复提交。

验收标准：在延迟、乱序和跨任务返回场景下，前后端预测归属一致，旧辅导不覆盖新任务，跳过记录不会落到未操作的任务。

### P2-10 “自己试试/跳过”会被错误记录为一级提示

位置：[content/demo-loop/tutor.replies.json](../content/demo-loop/tutor.replies.json#L97)、[backend/tutor/mock.py](../backend/tutor/mock.py#L66)、[backend/api/routers/tutor.py](../backend/api/routers/tutor.py#L113)

课程包明确把 `self_try` 和 `skip` 的回复等级设为 `0`，表示没有追加提示。但 mock 回复在生成 `answerLevel` 时无条件执行 `min(3, max(1, level))`，随后路由无条件调用 `note_hint()` 并写入 `hint_usage`。因此孩子选择先自己尝试或暂时跳过后，`highest_hint` 会被升到 1；即使之后独立完成，`record_attempt()` 也会将其判为非 `independent`，总结数据失真。

修改建议：把“提示等级”和“互动选择”分开建模。`self_try`、`skip` 保留 `answerLevel=0`，不更新 `hint_levels`，也不写入提示使用证据；如需统计选择行为，新增独立的 `learner_choice`/`self_feedback` 记录。模型回复也必须经过同一规则归一化，不能把 0 强制抬高为 1。

验收标准：连续选择 `self_try`、`skip` 后完成任务，最高提示等级仍为 0 且总结显示独立完成；选择真正的 `hint` 后才记录对应提示等级。重复点击和模型/ mock 两种模式的结果一致。

### P2-11 模型辅导模式读取了错误的证据字段

位置：[backend/tutor/model.py](../backend/tutor/model.py#L36)、[backend/session/store.py](../backend/session/store.py#L96)、[backend/api/routers/tutor.py](../backend/api/routers/tutor.py#L37)

会话证据对象使用 `sourceType` 和 `observedFact` 字段，辅导路由也按 `sourceType` 读取；但模型请求构造器却读取 `item["type"]` 和 `item.get("fact")`。当会话已有非空证据时，模型模式会在构造请求阶段抛出 `KeyError`，路由只捕获 `ModelUnavailable`，最终向客户端返回未处理的 500。

修改建议：定义统一的证据 DTO 或映射函数，明确把 `sourceType`/`observedFact` 转换为模型协议的 `type`/`fact`；对缺字段或异常证据做安全降级并记录诊断，不能让单条坏证据穿透到 HTTP 500。补充“有运行记录、有提示记录和空证据”三种模型模式测试，并验证失败时仍回落 mock 回复。

验收标准：模型模式下存在任意正常会话证据时，辅导接口仍返回结构化回复；字段缺失、类型错误或模型不可用时均进入可观测的安全兜底，不出现未处理异常。

## 条件性风险与发布验证

### R-1 会话与运行锁是进程全局的（多人部署前阻断）

位置：[backend/app.py](../backend/app.py#L30)、[backend/service/run.py](../backend/service/run.py#L55)

单个应用实例共用一个 `SessionStore` 和一个 active run。若把服务从当前 loopback 单机演示扩展到多个浏览器/用户，学习证据会共享，且用户之间会互相阻塞运行。当前 `docs/run.md` 声明只监听回环地址，因此这是扩展部署风险，不是当前演示承诺下的缺陷。

修改建议：开放多人使用前引入经服务端校验的会话身份（cookie/session ID），按会话存储预测、证据与运行状态；运行并发限制改为每会话或有明确队列策略。增加跨会话隔离测试。

### R-2 启动脚本没有依赖预检，测试环境无法复现记录

位置：[run_demo.cmd](../run_demo.cmd)、[requirements.txt](../requirements.txt)、[docs/acceptance.md](acceptance.md)

启动脚本只检查 Python 主次版本，不检查 FastAPI/Uvicorn 等依赖是否安装；缺依赖时会直接看到 Python traceback。本次执行 `python -m pytest tests -q` 失败，原因是当前解释器未安装 pytest（`No module named pytest`）。现有验收文档记录此前 `116 passed`，本次未能复现该数字。

修改建议：增加一次性环境初始化脚本（创建虚拟环境、安装依赖），启动前检查依赖并打印清楚的安装命令；锁定可复现依赖版本。验收记录标明执行环境和日期，历史通过结果与本次未复现结果分开。

发布验收：在干净 Python 3.12 环境安装后运行完整 pytest；确认报告记录与 CI 结果一致。

### R-3 浏览器与整机稳定性尚未完成端到端验收

现有 [docs/known_limitations.md](known_limitations.md) 和 [docs/acceptance.md](acceptance.md) 已标出未完成项。本次 `python -m compileall -q backend`、`node tests/js_editor_check.mjs` 和 `node --check` 遍历前端 JS 均通过；其中后两项只覆盖编辑器内核断言和语法，不等价于浏览器端完整回归。

发布前按 [docs/manual-checklist.md](manual-checklist.md) 补做浏览器全流程，并验证断网运行、取消/崩溃恢复、低分辨率布局、60 分钟连续运行和峰值内存。真实模型与 HarmonyOS 构建仍按已有验收文档作为独立未验证项处理。

## 建议修复顺序

1. **第一批：运行可靠性与状态隔离** — P1-1 运行收尾保护、P1-2 握手超时、P1-3 连续运行重入保护、P1-5 API 运行门禁、P1-6 切换/重置时取消旧运行。
2. **第二批：项目与内容正确性** — P1-4 项目载入状态重置、P2-1 耗时测量、P2-2 ID 校验、P2-5/P2-6 课程内容严格校验、P2-10 提示等级语义、P2-11 模型证据映射。
3. **第三批：健壮性、安全与发布体验** — P2-3 stderr drain、P2-4 缓存失效、P2-7 响应式处理、P2-8 DOM 安全渲染、P2-9 异步任务归属、R-2 环境初始化与完整回归。
4. **扩大用户范围前** — 完成 R-1 会话隔离和并发策略，再评审网络暴露与运行沙箱边界。

## 回归验收清单

- 运行正常完成、标准错误、运行超时、用户取消、worker 启动失败和编排层异常后，SSE 都有终态，后续运行能恢复。
- worker 握手的无输出/半行/提前退出测试均有确定超时，进程、管道和线程可回收。
- 前端 API 错误文案按纯文本呈现；加载跨任务、只读和旧版本项目后，运行结果和当前作品不串状态。
- 启动状态和 API 运行门禁一致；worker 不可用时不会先接受任务再崩溃。
- 延迟或乱序的旧 SSE、预测和辅导响应在切换任务、打开项目或重置后均被丢弃，不会改变当前页面状态。
- `self_try`/`skip` 不增加提示等级；有证据时模型辅导请求字段映射正确，异常证据会安全回落。
- 课程包坏数据在启动/加载阶段被发现；有效课程更新后缓存按约定刷新。
- 在干净环境重跑完整 pytest、JS 内核断言、JS 语法检查和浏览器端手工清单；更新验收文档中的结果与限制。
