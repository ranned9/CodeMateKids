# 验收记录（Windows Demo）

> 版本：CodeMateKids 0.1.0
> 记录日期：2026-11-14
> 环境：Windows 11 Home China，Python 3.12.9，Node 24.21.0（仅用于前端内核断言）
> 原则：只记录实际执行结果；未执行项明确标注“未验证”，不并入通过计数。

## 1. 结论摘要

- **Windows Demo 功能闭环**：后端 116 项自动化测试全部通过；前端编辑内核（模型、端口、布局、撤销）Node 断言通过；真实 uvicorn 单端口静态与 API 冒烟通过。
- **教学闭环**：预测前置、受限运行、分层辅导、变式任务、学习总结均有自动化覆盖；浏览器端手工走查尚未执行（见未验证项）。
- **能力声明**：仅循环主题积木子集可用；矩阵 19 条中 `implemented` 3、`limited` 1、`not_started` 13、`rejected_by_policy` 2、`tested` 0。未宣称完整支持 Python 3.12。
- **鸿蒙支线**：ArkTS/ArkUI 示例源码已交付；本机无 DevEco Studio/HarmonyOS SDK，未完成构建，结论与 Windows Demo **分列**。

## 2. 验证命令与结果

| 验证项 | 命令 | 结果 |
|---|---|---|
| 后端自动化 | `python -m pytest tests -q` | `116 passed`（约 14–17 秒） |
| 前端编辑内核 | `node tests/js_editor_check.mjs` | `JS-EDITOR-CHECK PASSED` |
| 前端模块语法 | `node --check` 遍历 `frontend/js` | 全部通过 |
| 真实服务器冒烟 | uvicorn `backend.app:app`（127.0.0.1:8011） | 首页、CSS、JS、startup/schema/course 接口均 200 |
| 启动状态 | `GET /api/v1/startup/check` | `ready`，Python 3.12.9，来源 `worker_probe`，模式 `mock` |

## 3. 实测数据

| 指标 | 实测值 | 结论 |
|---|---|---|
| 启动检查 API 耗时 | 378–455ms（API 层，含 worker 实测） | 满足 ≤10s 的 API 部分 |
| 单次简单运行端到端 | 236ms（正常启动）/ 1126ms（本机进程启动抖动） | 正常环境下在预算内 |
| 3000ms 超时用例端到端 | 3482ms | 满足 ≤3500ms |
| 输出截断 | 64B 注入用例截断正确；生产上限 16384B | 通过 |
| 递归超限 | 映射 `RUN_RESOURCE_LIMIT` | 通过 |
| 取消后立即再运行 | 状态 `cancelled`，下次运行 `completed` | 通过 |
| 崩溃后恢复 | 状态 `crashed`，恢复后运行 `completed` | 通过 |
| 项目保存 / 载入（Demo 文件） | 8ms / 4ms | 远低于 2s |
| 布局计算 | 2000 次 2.76ms（平均 0.0014ms/次） | 内核预算充足 |
| 内存限制模式 | `job_object` 生效 | 通过（降级路径未触发） |
| 日志字段 | 仅白名单字段，传入 `childInput`/`sourceCode` 被丢弃 | 通过 |

> 说明：本机 Python 解释器冷启动在 0.24–1.13 秒间抖动（裸 `python -c` 同样抖动），运行器已把启动与终止开销纳入 500ms 余量。

## 4. spec 4.x DFX 逐条结论

| 条款 | 结论 | 证据/说明 |
|---|---|---|
| 4.1.1 启动 ≤10s | 部分验证 | API 就绪 378–455ms；浏览器可交互时刻未自动采样，见手工清单 #1 |
| 4.1.2 编辑/撤销/重做 ≤100ms | 部分验证 | 内核布局 0.0014ms/次；浏览器 P95 待手工测量 |
| 4.1.3 运行 ≤3000ms | 通过 | 超时端到端 3482ms ≤3500ms |
| 4.1.4 资源上限 | 通过 | 输出截断、递归上限、Job Object 内存上限均有自动化或实测 |
| 4.1.5 运行反馈 ≤时限+500ms | 通过 | 3482ms |
| 4.1.6 辅导 ≤8s，首条 ≤3s | 部分验证 | `mock` 即时返回；`model` 分支未验证 |
| 4.1.7 项目载入 ≤2s | 通过（Demo 文件） | 4ms；2MB 边界未实测，超限拒绝逻辑已测 |
| 4.1.8 常驻内存 ≤800MB | 未验证 | 未采样浏览器与后端峰值 |
| 4.2.1 离线可用 | 部分验证 | 全部依赖本地，`mock` 无外网调用；未物理断网演练 |
| 4.2.2 故障恢复 | 通过 | 崩溃、取消、超时后均可再次运行 |
| 4.2.3 证据一致性 | 通过 | 两次运行证据 requestId 不串用 |
| 4.2.4 60 分钟连续 | 未验证 | 未执行 10 次 × 60 分钟观察 |
| 4.2.5 数据可恢复 | 通过 | 保存→加载→再保存结构一致；未知块保留 |
| 4.3.1 结构化输入 | 通过 | 无源码文本字段；含 `sourceCode` 的请求/文件被 422 拒绝 |
| 4.3.2 拒绝类/导入 | 通过 | `ClassDef`/`Import`/`ImportFrom` 返回 `PYTHON_FEATURE_BLOCKED` 并带 blockId |
| 4.3.3 进程约束 | 通过 | 最小环境变量、独立临时目录、整树终止；密钥不进入 worker |
| 4.3.4 数据最小化 | 通过 | 无真实身份字段；日志不记录输入全文 |
| 4.3.5 密钥管理 | 通过 | 只从环境变量读取；缺失强制 mock；日志/响应不回显 |
| 4.3.6 不可信项目文件 | 通过 | 2MB/深度/节点/课程引用校验；不接受客户端路径 |
| 4.3.7 儿童可见文本 | 通过 | 全部错误码文案扫描，无堆栈/路径/主机名 |
| 4.3.8 审计 | 通过 | 启动、运行、策略拒绝、超时、崩溃、兜底均有日志写入点 |
| 4.4.1 错误分类 | 通过 | 12 类必需类别互不相同，另有独立扩展类别 |
| 4.4.2–4.4.3 日志规范/脱敏 | 通过 | 白名单投影测试 |
| 4.4.4 能力透明 | 通过 | `/matrix` 返回未完成/受限/拒绝计数 |
| 4.4.5 版本可追溯 | 通过 | 启动页展示客户端/课程/schema/解释器四版本 |
| 4.5.1 仅 3.12 | 通过 | 精确比较 `(3, 12)`；无兼容分支 |
| 4.5.2 平台范围 | 通过 | 非 Windows 判定 `fatal`（测试注入验证） |
| 4.5.3 格式版本 | 通过 | 项目/运行/辅导/课程独立版本 |
| 4.5.4 旧作品保护 | 通过 | v0 迁移保留结构；未知块保留 |
| 4.5.5 内容协同 | 通过 | 引用未登记/不可运行积木时任务 blocked |
| 4.5.6 工具链解耦 | 通过 | 后端无鸿蒙/云 SDK 依赖；`harmony/` 不参与启动 |

## 5. spec 5.x 能力逐条结论

| 能力 | 结论 | 说明 |
|---|---|---|
| 5.1 课程引导与预测 | 通过（后端）/部分（浏览器） | 单主题、预测前置、对照、无代做入口均有接口与测试；界面手工走查待做 |
| 5.2 积木编辑工作区 | 通过（内核）/部分（浏览器） | 端口矩阵 30 格、非法回滚、事务撤销、键盘添加/删除/运行均有测试；拖放 P95 待手工 |
| 5.3 模型校验与目标转换 | 通过 | 格式/类型/规模/版本/优先级/双层策略均测试 |
| 5.4 受限运行与反馈 | 通过（后端） | 超时、截断、取消、崩溃、复现性、事件高亮来源 |
| 5.5 AI 分层辅导 | 通过（mock） | 九动作枚举、同错换表征、选择优先、四重校验、兜底 |
| 5.6 变式与总结 | 通过 | 变式先预测、独立完成度、无分数总结、空态完整 |
| 5.7 保存与恢复 | 通过 | 往返一致、迁移、未知块、禁止字段、超限拒绝 |
| 5.8 能力覆盖声明 | 通过 | 矩阵状态诚实，`tested` 为 0，计数公开 |
| 5.9 启动校验与模式标识 | 通过 | 五项门禁、fatal/degraded、worker 实测版本、凭据降级 |
| 5.10 鸿蒙示例 | 部分（源码交付，构建未验证） | 见第 7 节分列结论 |

## 6. spec 6.x 数据约束结论

课程、任务、积木定义、程序模型、运行请求/结果/事件、辅导请求/响应、学习证据、矩阵条目均有必填校验或测试覆盖；10 个领域对象的约束由 schema 文件、Pydantic `extra="forbid"`、`validate_program` 与 `SessionStore.add_evidence` 落实。事实与解释分字段、证据有效期与会话区间、`correctionOf` 保留原记录均已实现。

## 7. 鸿蒙支线结论（与 Windows Demo 分列，不合并计数）

- 已交付：`harmony/` ArkTS/ArkUI 基础示例（变量与类型、表达式、条件、循环、函数、数组/对象、简单页面交互）。
- 未完成：DevEco Studio + HarmonyOS SDK 构建与运行验证；本机无 SDK，未取得构建日志。
- 阻断原因：环境缺失，不是代码缺陷；所需版本建议 HarmonyOS SDK 5.0+ 与 DevEco Studio 5.0+。
- 不影响 Windows Demo：`harmony/` 不在启动链路，后端无相关 import。

## 8. 未验证项与跟进

| 未验证项 | 跟进措施 | 负责人 |
|---|---|---|
| 浏览器首屏可交互时延、编辑 P95、内存峰值 | 按 `docs/manual-checklist.md` 在演示机记录 | 客户端工程 |
| 物理断网全流程 | 演示前断网彩排一次 | 测试 |
| 60 分钟连续 10 次主流程 | 演示前稳定性观察 | 测试 |
| 真实模型模式 | 账号/网络就绪后按固定回归集验证 | AI 工程 |
| 鸿蒙构建/模拟器运行 | 安装 DevEco 与 SDK 后构建记录 | 鸿蒙工程 |
| 2MB 边界文件载入耗时 | 生成边界文件实测 | 客户端工程 |
| 演示彩排 ≥2 遍与验收人签字 | 第 7 天彩排 | 项目负责人 |

## 9. 交付物核对（开发文档 13.3）

- [x] Windows Demo 启动步骤与 Python 3.12 检查说明（`docs/run.md`）
- [x] 自研编辑器说明、积木 schema、项目格式与迁移（`schemas/`、`docs/run.md`）
- [x] Python 3.12 能力矩阵逐项状态（`docs/matrix.md`、`/api/v1/matrix`）
- [x] 主课程配置、主任务/变式、提示阶梯与成功标准（`content/demo-loop/course.json`）
- [x] Tutor 协议、模拟模式说明、固定回归用例（`schemas/tutor_protocol.v1.json`、`tests/test_tutor_guard.py`）
- [x] 测试报告与已知问题（本文件、`docs/known_limitations.md`）
- [x] 鸿蒙示例工程与阻断记录（`harmony/README.md`）
- [x] 安全边界与数据说明（`docs/known_limitations.md`）

## 10. 本次复核（2026-11-14 缺陷修复后）

> 本节与第 2 节的历史“116 passed”**分列**，不合并计数。历史结论来自修复前环境；本次结论在本机当前解释器执行。

### 10.1 执行环境与结果

| 项目 | 本次结果 |
|---|---|
| 环境 | Windows 11，Python 3.12.9，Node 24.21.0 |
| 后端测试 | `python -m pytest tests -q` → **180 passed** |
| 前端内核断言 | `js_editor_check`、`js_run_session_check`、`js_view_context_check`、`js_artifact_state_check`、`js_dom_text_check` → 全部 PASSED |
| JS 语法 | `node --check` 遍历 `frontend/js` → 全部通过 |
| 环境预检 | `python scripts/check_env.py` → 退出码 0，输出依赖版本 |
| 启动检查 | API 251ms，`elapsedMs=229`，`cached=false`，`contentVersion=1.0.0`，`runCapability.canRun=true` |
| 运行超时 | 3000ms 墙钟用例端到端 **3480ms**（≤3500ms） |
| 简单运行 | `completed`，12 个事件，内存限制模式 `job_object` |

历史结论：修复前曾记录“116 passed”（见第 2 节）；本次为新增用例与修复后的 180 passed。两者环境相同但版本不同，禁止混用。

### 10.2 P1 修复结论

| 项 | 结论 | 证据 |
|---|---|---|
| P1-1 终态收敛与槽释放 | 通过（自动化） | `tests/test_run_recovery.py`：六类注入均只产生一个 `result`，`GET /runs/{id}` 最终 finished，随后可再运行；线程启动失败回滚 |
| P1-2 握手可打断 | 通过（自动化） | `tests/test_supervisor_handshake.py`：零输出/半行/提前退出 ≤2.8s 收敛，无 reader 线程残留；正常路径首事件 seq=1 |
| P1-3 提交重入保护 | 通过（纯逻辑） | `tests/js_run_session_check.mjs`：连续三次 `tryBegin()` 仅一次成功，凭据不可改写；浏览器手工 RG-03 未执行 |
| P1-4 载入统一状态 | 通过（纯逻辑） | `tests/js_artifact_state_check.mjs`：派生状态复位、只读分支、快照副本；浏览器手工 RG-04 未执行 |
| P1-5 门禁单一真源 | 通过（自动化） | `tests/test_run_gate.py`：worker 不可用 503 且无残留；受限任务 409、另一任务放行；`runCapability` 与门禁一致 |
| P1-6 离开运行上下文 | 部分（代码+纯逻辑） | 后端 `GET /runs/{id}` 有测试；前端页面版本/归属断言通过；浏览器四时点手工 RG-06 未执行 |

### 10.3 P2 修复结论

| 项 | 结论 | 证据 |
|---|---|---|
| P2-1 检查耗时语义 | 通过 | `tests/test_startup_elapsed.py`；源码无 `PROCESS_START` |
| P2-2 标识约束与重复拒绝 | 通过 | `tests/test_run_ids.py`；日志无 cancelToken |
| P2-3 stderr 持续消费 | 通过 | `tests/test_supervisor_stderr.py`：1MB stderr 下 ≤4s 收敛，摘要 ≤160 且脱敏 |
| P2-4 内容版本一致刷新 | 通过（后端） | `tests/test_course_refresh.py`：指纹失效、同请求同 Bundle、运行任务快照隔离；浏览器 RG-10 未执行 |
| P2-5 回复包逐条校验 | 通过 | `tests/test_content_validation.py`：七类坏条目、诊断定位、tutor 不返回 500 |
| P2-6 初始程序完整校验 | 通过 | `tests/test_course_initial_program.py`：五类整体失败、不可运行积木仅该任务 blocked |
| P2-7 小窗口布局 | 代码完成，未验收 | 三段断点与提示条已实现；1024×768/1280×720 手工 RG-13 未执行 |
| P2-8 动态文案纯文本 | 通过（纯逻辑） | `tests/js_dom_text_check.mjs`；真实浏览器 RG-14 未执行 |
| P2-9 异步归属 | 通过（纯逻辑） | `tests/js_view_context_check.mjs`；浏览器 RG-15 未执行 |
| P2-10 提示等级 0 | 通过 | `tests/test_tutor_level_zero.py`：0 级不记账、独立完成判定正确、model/mock 一致 |
| P2-11 模型证据映射 | 通过 | `tests/test_tutor_model_evidence.py`：四类证据映射、坏证据降级、适配异常回落 |

### 10.4 条件项与验证项

| 编号 | 判定 | 本次状态 |
|---|---|---|
| R-1 会话/运行进程级共享 | 条件修复，当前不修复 | 已在 `docs/known_limitations.md` 与 `docs/run.md` 登记；代码未改；不宣称会话隔离 |
| R-2 环境预检 | 条件修复 | `scripts/check_env.py`、`scripts/bootstrap_env.cmd`、`requirements.lock.txt` 已交付；干净虚拟环境复现未执行 |
| R-3 浏览器端到端 | 不修复，转验证 | `docs/manual-checklist.md` 已补 RG-03/04/06/10/13/14/15/18 与稳定性项；尚未执行 |

### 10.5 未验证项（不得计为通过）

- 浏览器手工 RG-03、RG-04、RG-06、RG-10、RG-13、RG-14、RG-15、RG-18。
- 物理断网全流程、60 分钟连续 10 次主流程、客户端内存峰值、2MB 边界载入。
- 真实浏览器 SSE 时序与拖放交互。
- 干净虚拟环境 `bootstrap_env.cmd` 与锁定依赖复现。
- 真实模型端点可用性、HarmonyOS 构建。

### 10.6 不宣称事项

本次修复**不产生** OS 级沙箱、**不产生**多人会话隔离、**不产生**浏览器端到端验收结论，也**未验证**真实模型可用性。界面与文档不得暗示上述能力已具备。
## 11. 0.2.0 编辑器拖放与嵌套修复

> 执行日期：2026-11-17（本机 Windows 11 / Python 3.12.9 / Node 24.21.0）
> 依据：`.codeartsdoer/specs/kids_coding_demo/spec-editor-dnd-0.2.0.md`（ED-AC-01～20）

### 11.1 自动化结论（实际执行）

| 检查 | 结论 | 证据 |
|---|---|---|
| Node 语法检查 | 通过 | `frontend/js/editor/{layout,targets,dnd,model,render,connector}.js`、`frontend/js/views/{canvas,toolbox}.js`、`frontend/js/main.js`、`frontend/js/util/a11y.js`、`frontend/js/editor/{undo,keyboard}.js` 均 `node --check` 退出码 0 |
| 前端模型/几何/目标/事务/会话断言 | 通过 | `node tests/js_editor_check.mjs` 输出 `JS-EDITOR-CHECK PASSED`（含新增 INV-1～INV-4、pickNode、目标 ID、planDrop 零变更、fieldName、会话清理断言） |
| 其余前端纯逻辑检查 | 通过 | `js_artifact_state_check.mjs`、`js_dom_text_check.mjs`、`js_run_session_check.mjs`、`js_view_context_check.mjs` 全部 PASSED |
| 新增后端表达式契约 | 通过 | `python -m pytest tests/test_program_expression.py -q`：5 项通过（含“无 fieldName 通过、有 fieldName 被拒、现状缺口记录”） |
| 新增课程收窄契约 | 通过 | `python -m pytest tests/test_course_dnd_0_2_0.py -q`：4 项通过 |
| 全量后端回归 | 188 passed / 1 基线时序失败 | 首次全量 189 passed；随后两次全量均 `tests/test_supervisor_handshake.py::test_worker_never_outputs` 耗时 3.04s 超过 2.8s 阈值；该用例单独连续 3 次通过（2.17–2.39s）。本轮未修改 runner 代码，判定为演示机时序抖动，未调整阈值 |
| 单端口冒烟（8011） | 通过 | `/`、`/css/app.css`、`/js/main.js`、`/js/editor/targets.js` 均 200；`/api/v1/startup/check` status=ready、contentVersion=1.1.0；`/api/v1/blocks/schema` 仍含两个值积木；`/api/v1/course/demo-loop` 两任务均为 5 项且不含 `value.*` |

### 11.2 手工验收（未执行）

ED-AC-01～ED-AC-20 的真实浏览器操作尚未执行，状态统一为“未执行”。清单见 `docs/manual-checklist.md` 的 RG-ED 系列；结论不得由自动化结果替代。

### 11.3 未验证项（不得计为通过）

- 真机触屏、真机触笔（仅计划浏览器模拟）。
- Firefox、Safari（不纳入本轮范围）。
- ED-05 未经课程 UI 路径验证（仅模型层 Node 断言与后端 pytest）。
- 100ms 预览/提交时限未实测；无 Canvas 像素级视觉回归。
- 1024×768、1280×720 下的手工操作矩阵未执行。
- 读屏播报实际效果未验证。
## 12. 0.3.0 交互恢复（部分执行）

> 执行日期：2026-11-18（本机 Windows 11 / Python 3.12.9 / Node 24.21.0）
> 依据：`.codeartsdoer/specs/kids_coding_demo/spec-interactive-blocks-0.3.0.md`、`design-interactive-blocks-0.3.0.md`、`tasks-interactive-blocks-0.3.0.md`

### 12.1 自动化结论（实际执行）

| 检查 | 结论 | 证据 |
|---|---|---|
| 静态扫描 | 通过 | `node tests/js_static_check.mjs`：`JS-STATIC-CHECK PASSED`，`void <标识符>;` 零命中 |
| 前端内核断言 | 通过 | `node tests/js_editor_check.mjs`：`JS-EDITOR-CHECK PASSED`；新增最终坐标命中、目标存活、提交异常/返回 false、捕获失败、清理幂等、目标矩形有限性断言 |
| 前端全量脚本 | 通过 | 6 个 `tests/*.mjs` 全部 PASSED |
| 后端全量 | 188 passed + 1 基线时序失败 | `test_worker_never_outputs` 全量超 2.8s；单测 2.26s 通过，未改阈值 |
| 8011 冒烟 | 通过 | 根页/CSS/`dnd.js`/`targets.js`/`canvas.js` 200；startup ready、`contentVersion=1.1.0`；schema 保留值积木；两任务 5 项；子进程已正常终止 |

### 12.2 本轮修复的缺陷

1. 删除 `frontend/js/editor/dnd.js` 中成功拖动后的 `void definition;` 未定义引用。
2. `pointerup` 改为以最终坐标重新命中，预览与提交使用同一结果。
3. 修复 `frontend/js/editor/targets.js` 的 `bandRect()`：根链目标 `rect.x` 原为 `undefined`，导致根位/链间释放被判为 `OUTSIDE_CANVAS`。
4. 提交路径改为 `try/finally`，提交异常与失败均不残留会话、预览与监听。

### 12.3 未执行（受 Q-1～Q-6 未拍板阻塞）

- 点击一下添加、阈值仲裁、默认落点（Q-3）。
- `DEBUG_DND` 与阶段诊断（Q-4）。
- DevTools/Playwright 浏览器探针、六阶段定位、第二指针与连点注入（Q-1/Q-6）。
- 缩放/滚动/1024×768/1280×720 手工矩阵（Q-6）。
- 拼接外形改造（Q-2，本轮未做）。

### 12.4 未验证项（不得计为通过）

真实浏览器拖放全链路、真机触屏/触笔、Firefox/Safari、100ms 时限、Canvas 像素级视觉回归、读屏播报、`void definition` 修复后的浏览器控制台无异常、捕获回退的真实浏览器行为。
