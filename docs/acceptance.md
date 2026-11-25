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

## 13. P1、P2 修复与前端分层回归

作品与课程流程分别迁入 `frontend/js/workflows/projects.js` 和 `frontend/js/workflows/course.js`。页面入口装配这些模块，关键流程见 [实现架构](architecture.md)。

| 检查 | 结果 |
|---|---|
| 后端 pytest 全量 | 203 项通过，包含多条循环体语句链的 Worker 执行、重复次数校验、作品课程版本与旧版迁移 |
| 前端 Node 回归 | 7 个脚本通过，包含运行终态后拖放、SSE 断线恢复、延迟及乱序保存响应、课程刷新重试、从文件选择入口打开作品 |
| 前端语法 | 28 个模块通过 `node --check` |

前端交互回归使用模拟 DOM 和 API。真实浏览器手工验收仍按 [检查表](manual-checklist.md) 执行。

## 14. 课程 1.2.0 积木交互

- Windows 内置浏览器实测点击添加“显示结果”，再用鼠标把“算一算”拖到数值槽，逐层添加后运行得到 `3`。运行后继续拖入一个“向前走”到循环体，第二次运行仍输出 `3`，累计走了 4 步并达到主任务目标。
- 后端 207 项通过，覆盖空槽草稿保存、嵌套算式保存／载入及 Worker 运行、非法端口拒绝。
- 7 个 Node 回归脚本和 28 个前端模块语法检查通过，覆盖点击与拖放互斥、点选积木、表达式布局与撤销重做。

## 15. 0.4.0 UI/UX 改造（自动化结论与未验证项）

### 15.1 改造前后自动化基线

| 命令 | 改造前 | 改造后 | 说明 |
|---|---|---|---|
| `node tests/js_static_check.mjs` 等 7 个既有脚本 | 全部通过 | 全部通过 | 新增 53 个关键 `id` 存在性/唯一性断言后仍通过 |
| `node tests/js_ux_panels_check.mjs` | 不存在 | 通过 | 断点映射、面板默认策略、互斥、焦点域、主操作唯一性、阈值同源、token 与减动 |
| `node tests/js_ux_ownership_check.mjs` | 不存在 | 通过 | 会话/页面/程序三层归属，含“改后又撤回”恢复 current |
| `node tests/js_ux_result_summary_check.mjs` | 不存在 | 通过 | 目标派生、两句话取值、缺 moves 不补零、保存四态、刻度、课堂状态、总结三段 |
| `python -m pytest tests -q` | 212 passed / 1 failed | 212 passed / 1 failed（同上） | 失败项为 `test_worker_never_outputs` 的 2.8s 时序断言（实测 3.06s），改造前已存在，属环境抖动，不计入本轮回归结论 |
| `node --check` 全部前端模块 | 28 个通过 | 41 个通过 | 含新增 `frontend/js/ux/` 模块 |

### 15.2 已落地的可观察增量（代码事实，非浏览器验收）

- 顶部只保留品牌、保存状态、任务/总结/保存/打开/系统信息入口；Python/schema/模式/运行状态芯片迁入系统信息面板，`id` 全部保留。
- 当前任务区只渲染当前任务；学习目标、其他任务、后续主题进入受控子面板。
- 代码预览、启动明细、辅导更多帮助/自由提问/依据默认收起。
- 结果区首屏给出“预测对照”和“目标达成”两句话；程序修改后结果标记为“上次运行 · 积木已修改”，不再直接隐藏对照。
- 保存状态持续显示未保存/保存中/已保存/失败，保存期间的新修改保持未保存。
- 断点收敛为 1366×760 / 1200–1365 / 1024–1199 / <1024 四档 + 低高度压缩，阈值在 `ux/layoutMode.js` 与 `app.css` 同源。

### 15.3 未执行 / 未验证（不得计为通过）

- 真实浏览器三区同屏、低高度滚动、125%/150% 缩放命中、抽屉焦点进入与返回、面板切换抖动、拖放视觉反馈、减少动态效果、真实 SSE 时序下的归属、保存下载/打开往返。
- 上述各项未在 Chrome/Edge 实机执行，结论一律为“未验证”。
- 课程文案未改动，`contentVersion` 保持 1.2.0；Q-8“说一句话”维持现状。

### 15.4 门禁状态

- G-0：按 `design-uiux-0.4.0.md` 2.5 建议值执行，用户批准进入执行阶段且未逐项书面否决；改选影响见 `decisions-uiux-0.4.0.md`。
- G-1：D-01～D-05 全部接受，无否决项。

## 16. 工作台教学闭环复验

按[综合开发方案](CodeMateKids_UI_UX_综合改造方案.md)复验课程内容 `1.2.1`。环境为 Windows 11 家庭中文版、Python 3.12.9、Chrome 160.0.8157.0 和 Edge 157.0.4341.60。浏览器使用无头模式、自动化鼠标与键盘，连接本机 Demo 和实际 Python Worker，辅导使用 mock。

### 16.1 浏览器结果

| 场景 | 两个浏览器的实测结果 |
| --- | --- |
| 1280×720、1024×768，DPR 1 | 主任务预测 0 次后首次运行，读出实际次数与差距；打开求助、回到画布、改重复次数、保留上次结果并重跑；保存下载后重新打开；取消变式切换时保留未保存修改；完成变式并主动查看小结。两尺寸的页面截图见 [1280×720](qa/ux-1280x720.png) 和 [1024×768](qa/ux-1024x768.png) |
| 1440×900、1366×768、900×700，DPR 1 | 宽栏或简化模式按预期选中，页面未出现横向溢出 |
| 1280×720 / DPR 1、1024×576 / DPR 1.25、853×480 / DPR 1.5 | 用等效 CSS 视口和设备像素比验证，鼠标将前进积木嵌入循环，数字控件加一、撤销及重做均成功。后两档开启减弱动态效果 |
| 模拟 SSE 连接中断 | 页面提示本轮完整结果缺失，确认终态后可以重新运行并取得完整结果 |

主任务运行 4 步时保留「走到目标」反馈，循环内前进至少执行两次的反馈来自此轮真实 Worker 事件。变式实测预测 2 次、实际动 3 次、累计走 6 步；结果仍显示步数达标。结束语作为可选加练。

### 16.2 编辑响应

在 1280×720、DPR 1 和示例循环程序下，从指针或点击事件到第二个动画帧回调计时。各浏览器记录 29 次拖动预览、21 次撤销、20 次重做。该数据用于本机回归比较。

| 浏览器 | 拖动预览 P95 | 撤销 P95 | 重做 P95 |
| --- | ---: | ---: | ---: |
| Chrome | 17.3 ms | 31.1 ms | 30.7 ms |
| Edge | 17.3 ms | 30.9 ms | 30.9 ms |

### 16.3 回归与未完成项

- 10 个 Node 回归脚本与 44 个前端模块语法检查通过。覆盖运行前取消、重复预测门禁、结果归属、循环事件去重和撤销事务等。
- Python 全量为 212 通过、1 失败。已知的 `test_worker_never_outputs` 未通过 2.8 秒时限，实测约 3.05 秒；终态和错误码断言通过。最终课程和回复调整后的 19 个针对性测试通过。
- 浏览器原生 125% 和 150% 页面缩放、真实儿童试用及现场回滚演练仍待执行。回滚参考为本轮之前的应用与课程组合，仓库已提交基线为 `a465df6`。复验应包含启动、打开旧作品、预测、运行与停止。

## 17. 维护整理回归

| 层次 | 本轮结果 |
| --- | --- |
| Python | 220 项通过，含既有 Worker 无输出、半行输出握手测试，以及新增启动前取消用例。握手预算从启动前开始计时 |
| 前端 | 10 项 Node 检查和 47 个模块的语法检查通过。覆盖终态未确认时保留作品、再次停止后恢复、切换请求失效、跳过反馈失败重试 |
| 浏览器 | Windows 上以 Chrome 160.0.8157.0 无头模式、1024×768 视口复验预测、运行、求助、取消任务切换和保存后重新打开 |

运行入口和排错见[运行说明](run.md)。工作区替换与扩展入口见[架构](architecture.md)。

## 18. AI 教学增强阶段 0（历史记录）

> 本轮只执行 `tasks-ai-teaching-0.5.0.md` 1.9 节白名单：不依赖 Q-AI-01～13 与 design 2.9 的未定取值。**阶段 1 条件性任务、阶段 3、阶段 4 均未执行**。

### 16.1 门禁状态

- G-0：**未放行**。Q-AI-01～13 全部未确认，见 `decisions-ai-teaching-0.5.0.md`。
- G-0b：**未放行**。design 2.9 的 7 项未确认；迁移题/双维舞台/模型模式均未启用。
- G-1：**放行**。AT-CP-01～09 按 spec 8.2 处置，0.4.0 决策文件未修改。
- 阶段 0 实际落盘 `contentVersion`：仍为 `1.2.1`，**未落盘 1.3.0**。

### 16.2 已交付（代码事实）

- 枚举单一真源 `backend/tutor/enums.py`（教学 10 + 非教学 4）与前端镜像 `frontend/js/ux/enums.js`；`content_validation.ERROR_PATTERNS` 改为引用真源。
- DTO 可选字段：`LearningScope/LearningContext` 加入预测、运行、辅导三个请求；响应模型增加 `predictionId/learning/transfer/nextTaskId/observation`；旧请求体字段集合不变。
- Schema：`course.v1.json` 补 `otherThemes/nextTaskId/teaching/programCriteria`；`tutor_protocol.v1.json` 增可选 `teachingDecision/factIdsUsed`，主版本仍为 v1。
- 程序摘要 `backend/service/program_digest.py`：键排序、剔除 `metadata` 与 `stacks[*].x/y`、数组保序、SHA-256。
- 结构判定 `backend/tutor/square.py`：单一循环、循环内 move+turn、90/270、数字积木、循环外无害动作；**未接 `success` 门控**。
- 事实/错因 `backend/tutor/diagnosis.py`：9 类 pattern 优先级；T04 按 `prediction_mismatch` 建议值实现并标注待定稿。
- 回放 `backend/tutor/replay.py`：事件配对、轮次识别、末态核对、上限与降级；**默认 12 动作与“前两轮”未启用**。
- 会话索引 `backend/session/teaching_store.py`：按 scope 隔离、有界 256、提示去重上限 8。
- 编排 `backend/service/teaching.py`：learning 六键（outcome/pattern/facts/predictionMatch/traceQuality/replay），异常 fail-open 返回 `None`。
- 辅导决策优先 `backend/tutor/engine.py`（`decide_with_facts`）与 `backend/tutor/mock.py`（最终 action/level 取决策）。
- 前端 `ux/learningContext.js`、`ux/replayPlayer.js`；`views/artifact.js` 在安装点时生成新的 `workspaceId`；`core/viewContext.js` 新增五项归属快照判定。

### 16.3 自动化结论

| 检查 | 结果 |
|---|---|
| `python -m pytest tests -q` | **276 passed**（含新增 56 项） |
| `node tests/js_ai_teaching_check.mjs` | 通过（枚举镜像、workspaceId、seenHints 上限、回放状态机） |
| 其余 Node 检查（10 个） | 全部通过 |
| R1 真实运行 | 正方形 28 事件、4 轮、末态 `(0,0,0,8)`、moves=4；简单重复 12 事件、2 轮 |
| 回放降级矩阵 | 空/乱序/配对失败/超限/坐标不符/`truncated` 无因果/裁剪 hasMore 均通过 |

### 16.4 未执行 / 未验证（不得计为通过）

- `learning` 附加尚未接入 `service/run.py` 与 SSE `result`；`learningContext` 尚未由前端请求携带。
- 辅导 `learning` 附加、回放入口与分步控件、二维舞台、第三任务、推荐链、`transfer` 聚合均未实现。
- Q-AI-05 的默认 12 动作与“前两轮”、Q-AI-06 的“已呈现”时点、Q-AI-07 的范围参数、Q-AI-08 的 `edit_trace` 均未启用。
- 浏览器项、真实模型端点、真实教学成效、性能指标全部**未验证**。
- T01/T02/T03/T04 的端到端断言只在纯函数层通过，未通过 HTTP/SSE 全链路。

## 19. 循环教学工作台，课程内容 1.3.0

| 检查 | 结果 |
| --- | --- |
| Python 3.12 全量回归 | 281 项通过 |
| Node 前端回归 | 11 个脚本通过 |
| HTTP/SSE 教学流程 | 区分重复次数、动作位置、前进步长；复验后用新程序判断；旧提示定位与回放受当前运行约束 |
| 正方形迁移 | 手工展开路线需要继续改成循环；循环解法完成后生成二维轨迹数据，并区分有提示和无提示的运行 |
| 可选模型 | 模拟端点验证采用本地教学动作、拒绝无依据的数值以及回到本地回复 |

真实模型和新界面的浏览器手工检查留待演示机验证。自动化用例和现场操作见[开发文档](CodeMateKids_AI教学增强开发文档.md)及[演示脚本](demo-script.md)。

## 20. 网页模型接入骨架（历史记录）

> 本轮只执行 `tasks-web-model-agent-0.6.0.md` 1.10 节白名单。G-0、G-0b、G-P **均未放行**；P2 未开工。

### 20.1 骨架交付范围

- `backend/tutor/model_config.py`：`source/effectiveMode/adapter/失败类别/allowedActions/targetRef` 单一真源；进程内状态机（`revision`、单候选 600s、最新测试胜出、原子启用/停用、幂等停用、密钥不泄漏）。
- `frontend/js/ux/modelConfigState.js` + `tests/fixtures/model-config-expected.json`：前端镜像与表单纯逻辑。
- `backend/api/dto.py`：`ModelConfigTestRequest/Activate/Disable`，以及 `LearningContext.turnId/replyToTurnId` 可选字段（仅声明）。
- `backend/infra/logging.py`：白名单新增 `modelSource/modelRevision/modelCategory`。
- `backend/api/security.py`：回环 + `Host` + `Origin` + JSON 类型校验；`diagnostics` 复用共享回环常量。
- `backend/infra/net_policy.py`：七步地址校验、DNS 复验、禁代理、3xx 立即失败、`chat_url` 拼接。
- `backend/tutor/chat_adapter.py`：Chat Completions 6 键构造、单跳发送、解析与失败分类。
- `backend/api/routers/model_config.py`：四个配置入口、`no-store`、零新增错误码（`category` 承载细分）、`cfg-<12hex>` 仅入日志。
- `tests/test_model_config.py`、`tests/test_net_policy.py`、`tests/test_model_legacy_payload.py`、`tests/test_model_dto_compat.py`、`tests/test_model_logging.py`、`tests/js_model_config_check.mjs`。

### 20.2 骨架自动化结论

| 检查 | 结果 |
|---|---|
| 0.6.0 契约/安全/既有锚点定向回归 | **101 passed** |
| 全部 `tests/js_*.mjs` | 全部通过 |
| 旧网关载荷 | 顶层恰好 9 键；`tutor_protocol.v1.json` 未改 |
| 错误码 | `ERROR_SPECS` 无 `MODEL_*` 键，键集合零新增 |
| 配置接口 | GET/POST 同源拒绝、`no-store`、四入口流程通过（假探针） |
| 地址策略 | 13 类拒绝样例、公网 HTTPS 通过、DNS 复验 2 次、代理禁用 |

### 20.3 骨架阶段剩余工作

- `factspeak` 占位符展开、`guard` 增量、`candidate` 统一管道、`tutor.py` 网页分流、`/startup/check` 投影（S2 剩余）未执行。
- 前端 `#model-config` 区域、表单版本化、来源标识、停用失效（S3）未执行；P1 交付点未勾选。
- S4 多轮、S5 动作选择、S6 开关与观测、P2 全部未执行。
- 真实后端、真实浏览器、真实模型端点全部**未验证**；不得宣称“模型已接入课堂”。

## 21. 网页模型配置与多轮教学

| 检查 | 结果 |
| --- | --- |
| Python 全量回归 | 330 项通过 |
| Node 前端回归 | 12 个脚本通过 |
| 出站地址和重定向 | 新增探针通过。连接到已验证的 IP，使用原域名验证证书，遇到重定向时停止 |
| 网页配置和课堂联调 | 模拟传输验证连接测试、启用、课堂引用实际步数和动作次数、无效回复和限流回退、配置更新后丢弃旧模型结果 |
| 多轮教学 | 模拟传输验证同一运行下，根据两种孩子回答分别给回放或定位，重试复用同一轮，过期追问返回冲突 |

真实模型端点和浏览器手工操作按[运行说明](run.md)及[浏览器检查表](manual-checklist.md)复验。
## 22. AI 老师对话与学习记忆 0.7.0（记录骨架）

> **本轮状态**：仅建立记录骨架，**全部条目为“未验证”**。G-TM-0 判定为“未放行”，只执行 `tasks-ai-teacher-memory-0.7.0.md` 1.11 节白名单。
> **禁止**：预填“通过”、以“代码已写”或“A 类通过”替代 B/C/D 结论。

### 22.1 A 类（可自动化）

| 编号 | 结论 | 证据 | 执行人 | 日期 |
|---|---|---|---|---|
| TM-AC-02/03/08/10～12/14/15/17～19/21/22/24～83（纯逻辑/契约/夹具/假传输） | 未验证 | — | — | — |
| TM-RG-01～15（回归） | 未验证 | — | — | — |

### 22.2 B 类（真实后端）

| 编号 | 结论 | 证据 | 执行人 | 日期 |
|---|---|---|---|---|
| TM-AC-23/27/68/81/82/84 后端链路（真实 uvicorn + 真实 Worker） | 未验证 | — | — | — |

### 22.3 C 类（真实浏览器）

| 编号 | 结论 | 证据 | 执行人 | 日期 |
|---|---|---|---|---|
| TM-AC-01～07/09～14/16/20/33/41（Chrome/Edge，1280×720 与 1024×768，含键盘与输入法） | 未验证 | — | — | — |

### 22.4 D 类（真实模型端点）

| 编号 | 结论 | 证据 | 执行人 | 日期 |
|---|---|---|---|---|
| TM-AC-47/48/57 真实分支、来源 8.2 第 2/5/6 步模型表现 | 未验证（本期不宣称） | — | — | — |

### 22.5 标注规则

1. D 类未执行、真实模型未连通：一律写“**未验证**”。
2. 性能未实测：写“**未实测**”，不计入通过。
3. 9 项门禁后置项（原文出站、`stop_guidance`、`knowledgePointIds/1.4.0`、长期持久化、4 个错误码、2 个配置、运行归属、常驻输入框、模型观察建议）：写“**门禁后置（未验证）**”。
4. 上游未放行依赖（`Q-AI-05/06/09`、`WQ-07/09/10/12/14`）：写“**条件性·上游未放行**”。

### 22.6 不可宣称（强制，七条）

1. 真实模型端点的连通性、时延、配额与表达质量：**未验证**。
2. “学习记忆提升理解力/学习效果”：**未验证**，不得由观察条目数量推断。
3. 观察条目的教育解释效力：**未验证**，只承诺“记录可追溯、可按学生隔离”。
4. 浏览器实测（输入法、连续消息、低高度、缩放、焦点）：**未验证**，需按 `docs/manual-checklist.md` 执行后另行记录。
5. 性能指标（4.1 全部）：**未实测**，不得计入通过。
6. 多设备/多浏览器标签页同步：**未设计**，不得宣称可用。
7. 学生档案的安全性（防篡改/防伪造）：**不承诺**，首版信任本机同源操作者。

## 23. AI 老师对话与学习记忆首版验收

本轮按首版开发文档执行，使用合成学生档案、示例积木程序和本机验收数据库。 [首版开发文档](CodeMateKids_AI老师对话与学习记忆开发文档.md)

| 验收项 | 实测结果 |
| --- | --- |
| 后端和前端回归 | 359 项 Python 测试和 12 个 Node 检查脚本通过。首版课堂专项覆盖澄清、重试、切换程序、实际 Worker、存储故障和迁移题。 |
| 浏览器交互 | 在 1280×720 的本机工作台验证自然提问、澄清、改积木后继续回答、创建档案，以及运行后逐步回放。运行结果较长时输入框和发送键仍可使用。 |
| 学生隔离与重启 | 使用两个档案和同名工作区。预测门禁和运行详情按学生归属，重启应用后 SQLite 仍提供各自的学习记录。同一句「这个要怎么算」分别触发核对步数和自主预测。 |
| 正方形迁移题 | 展开的前进与转弯通过路线判定，但仍需调整循环结构。改用一个循环后，运行和老师回复均确认达标。 |
| 已配置的模型 | 用合成问题验证积木解释和澄清两类模型回复。也观察到个别结构不合格的模型回复，接口按预期返回本地教学回复。 |

课堂回归使用模拟模型传输和实际 Runner。浏览器手工验收使用本地教学回复，模型连通性用独立的合成请求验证。 [课堂测试](../tests/test_classroom_chat.py) · [前端教学检查](../tests/js_ai_teaching_check.mjs)

## 24. AI 老师语音对话（0.8.0）验收

本轮按语音对话开发文档执行：SIS 语音识别与语音合成、按住说话录音、转写确认与回复播报。[语音对话开发文档](CodeMateKids_AI老师语音对话开发文档.md)

### 24.1 P0 配置与开关（代码已交付、能力未验收）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 全量回归 | 381 项 Python 测试通过（含 0.8.0 红线基线 32 键码表、16 字段日志白名单）；`js_static_check.mjs` 通过 | `tests/` |
| 红线零变更 | 运行器、`run_protocol.v1.json`、`tutor_protocol.v1.json`、程序模型 `git diff` 为空 | 执行记录 |
| 依赖增量 | 仅 `huaweicloudsdksis==3.1.223`（D-01 放行），两份 requirements 同步 | `requirements*.txt` |
| 配置矩阵 | 全缺/部分凭证/坏区域/齐备/构造失败五组合启动正常，`tutorSpeechEnabled` 投影正确，`disabled_reason` 不含凭证值 | `tests/test_speech_config.py` |
| 真实 SIS | 未验证（需使用者提供 AK/SK 并配置 4 个环境变量） | — |

### 24.2 P1 语音接口（代码已交付、真实 SIS 未验收）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 全量回归 | 418 项 Python 测试通过；码表 32+3、白名单 16+1 基线断言通过 | `tests/test_redline_baseline_0_8_0.py` |
| `/tutor/chat` 零改动 | `git diff -- backend/api/routers/tutor.py` 为空 | 执行记录 |
| 语音接口 | 识别校验链（停用 503→413→422）、合成 peek 归属与双形态响应、no-store 均有替身断言；`peek` 只读性四断言通过 | `tests/test_speech_recognize.py` `tests/test_speech_synthesize.py` `tests/test_speech_peek.py` |
| 真实 SIS | 未验证（需 AK/SK 环境变量与 P4 联调） | — |

### 24.3 P2 录音与转写确认（代码已交付、浏览器行为待人工验收）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| Node 断言 | 新增 `js_speech_check.mjs` 13 项断言全绿（状态机矩阵、15 秒定时、授权时序、取消矩阵、迟到丢弃、草稿四分支、能力检测、出口唯一） | `tests/js_speech_check.mjs` |
| 全部检查脚本 | 12 个既有脚本 + 新增脚本逐个执行全绿（SV-RG-08：语音停用状态下 AI 教学检查无退化） | 执行记录 |
| composer 红线 | `maxlength=300` 与既有 5 个 composer 元素零改动（仅追加 note/按钮两行）；`send()` 提交出口唯一（requestSubmit 仅既有 1 处） | `git diff` |
| 浏览器行为 | C 类待执行（权限弹窗、真实录音、切换清理、aria 播报） | — |

### 24.4 P3 回复播报（代码已交付、浏览器行为待人工验收）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 播报断言 | `js_speech_check.mjs` 扩展 6 项全绿（状态矩阵、重播零新请求、单路互斥、切换清理三动作、文字先行、双形态分流） | `tests/js_speech_check.mjs` |
| 后端零改动 | P3 阶段 `git diff -- backend/` 无新增（全部 diff 均为 P0/P1 计划内增量） | 执行记录 |
| 全量回归 | 418 项 pytest + 13 个 mjs 全绿 | 执行记录 |
| 浏览器行为 | C 类待执行（真实 Audio 播放、自动播放拦截兜底 R-05、切换清理） | — |

### 24.5 P4 端到端与发布核对（部分验证）

| 类别 | 项 | 结论 | 证据 |
| --- | --- | --- | --- |
| B 类（真实后端，无凭证） | 启动检查投影 `tutorSpeechEnabled=false`、`tutorChatEnabled=true` | 通过 | uvicorn 127.0.0.1:8011 实测 |
| B 类（真实后端，无凭证） | 识别/合成接口停用语义 503 + 儿童文案「还没准备好，可以先打字提问」 | 通过 | curl 实测 |
| B 类（真实后端，无凭证） | 打字链路 200（ok=true/action=hint/mode=mock）、静态资源与 `speechRecorder.js` 200 | 通过 | curl 实测 |
| B 类（真实后端，有凭证） | `tutorSpeechEnabled=true`、语音全链路 | 未验证（需使用者配置 AK/SK） | — |
| C 类 | Chrome/Edge 浏览器人工验收（S1～S14） | 未验证（需人工执行 [manual-checklist](manual-checklist.md)） | — |
| D 类 | 真实 SIS 联调与 WebM/Opus 格式实测（开-2）、性能指标 | 未验证（需已开通 SIS 的凭证） | — |

**D 类联调步骤（使用者执行）**：①SIS 控制台确认已开通一句话识别与语音合成；②在线体验页先用成人录音与短句分别验证识别、合成（凭证有效性前置确认）；③设置 4 个 `CMK_SIS_*` 环境变量重启；④按住说话 → 转写 → 修改 → 发送 → 回复 → 播报全链路；⑤记录 15 秒录音 Base64 体积样本（若逼近 512 KiB 先调录音码率）；⑥若 SIS 拒绝 WebM/Opus → 按降级路径处理并在此登记；⑦回填本表与 `known_limitations.md`。

### 24.6 不可宣称（0.8.0 强制口径）

1. 真实 SIS 的识别/合成质量、时延与格式兼容（开-2）：**未验证**。
2. 性能指标（识别 ≤10 秒、录音启动 ≤1 秒、合成 ≤8 秒、512 KiB 体积余量）：**未实测**，不计入通过。
3. 浏览器人工验收（录音权限、自动播放拦截、切换清理、aria 播报）：**未验证**，需按 `manual-checklist.md` S1～S14 执行。
4. 儿童录音的合规性：系统内已交付首次告知与不留存；家长同意流程**不在本期**，不宣称合规完备。
## 25. 积木拿起与收回体验（0.9.0）验收

本轮按 [block-drag-pickup-and-removal](block-drag-pickup-and-removal.md) 需求来源与规格 `spec-editor-pickup-0.9.0.md`、设计 `design-editor-pickup-0.9.0.md`、任务 `tasks-editor-pickup-0.9.0.md` 执行：视口拖动浮层（拿起 150ms 放大 / 收回 180ms 缩小淡出）、统一抓取偏移公式（D-04 替代固定 90/20 与 `{16,16}` 的对外行为）、画布绘制收敛（D-03 画布来源拖动统一隐藏原位层、删除积木幽灵）、移除预览与删除前快照、`pointerup` 提交前显式复核（D-07 双防线）、rAF 合并重绘（D-06）。改动面：新增 `frontend/js/editor/drag-overlay.js`，扩展 `model.js`/`render.js`/`dnd.js`/`toolbox.js`/`app.css` 与 `tests/js_editor_check.mjs`。

### 25.1 自动化结论（T-EP-21）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 语法检查 | `node --check` 逐文件通过（`model.js`/`render.js`/`dnd.js`/`drag-overlay.js`/`toolbox.js`/`js_editor_check.mjs`） | 执行记录 |
| Node 断言 | `node tests/js_editor_check.mjs` 全绿；既有回归（序列化契约、事务、会话生命周期、phase 门禁、移除命中、单次提交、取消清理、快速松手、多指针忽略、teardown 幂等）零回归 | `tests/js_editor_check.mjs` |
| EP-AC-02 | 浮层生命周期：创建后在 body、提交替换后移除、取消清理后移除、重复 `destroy()` 幂等、任一路径后 `document.body` 零残留 | `tests/js_editor_check.mjs` |
| EP-AC-03 | 抓取公式：缩略图中心（ratio 0.5）与边缘（ratio 1）两方向自由落点均按 `point − ratio × 画面布局尺寸` 换算；`{16,16}` 兜底仅保留为异常路径断言（stub 未提供 grabInfo）并单独标注；源码无 `PREVIEW_OFFSET` 残留 | `tests/js_editor_check.mjs` |
| EP-AC-04 | 移除范围：`removalScopeIds()` 输出与 `detachBlock()` 实删语义对照一致（链中块 `{repeat, move}` 不含后续 `print`、多层嵌套容器全后代、不存在 id 返回空集合）；画布来源拖容器进入移除区时 `removalScope` 一致、离开恢复整组、边界往返一致 | `tests/js_editor_check.mjs` |
| EP-AC-05 | `pointerup` 复核：会话进行中变只读/运行态后松手——不提交、零事务、无动画、浮层清除（双防线之二） | `tests/js_editor_check.mjs` |
| EP-AC-06 | reduce 立即路径：拿起 0ms 立即到位（无插值中间态、无动画 rAF 调度）、删除后 0ms 收回立即清除；`LIFT_MS=150`/`SETTLE_MS=180` 参数核对通过；非 reduce 时动画 rAF 确认被调度 | `tests/js_editor_check.mjs` |
| 守卫补强 | 新增会话字段（`grabRatio`/`overlayPhase`/`startSize`/`targetSize`）不入程序序列化（spec 9.2 第 1 条）；连续 move 下画布重绘调度 ≤ 每帧一次且 teardown 取消挂起帧（T-EP-10 行为固化） | `tests/js_editor_check.mjs` |
| rAF 适配 | `lastResult` 更新移入帧回调后，测试 stub 改为「记录挂起 + flushFrames() 手动驱动」；既有断言语义不变，仅适配执行时机 | `tests/js_editor_check.mjs` |
| 红线 | 本轮改动面仅限上列 7 个文件；工作区中 `backend/**`、`schemas/**`、`content/**` 的未提交 diff 均为 0.7.0/0.8.0 遗留，本轮零接触；连接语义（`resolveDropTarget()`/`canConnectToTarget()`）、删除范围（`detachBlock()`）、事务路径（`commitDrop()`/`deleteBlock()`/`history.record()`）零改动 | 执行记录 |

### 25.2 手工验收（EP-AC-07～18）

| 用例 | 结论 |
| --- | --- |
| EP-AC-07～EP-AC-18（12 条浏览器用例：缩略图抓取、跨区域可见、四场景放置、容器删除收回、移除预览往返、快速松手、取消路径、无效位置、连续拖放、点击/键盘添加、reduce、双浏览器双分辨率） | 未执行（本轮无浏览器环境；需按 `spec-editor-pickup-0.9.0.md` 第 10.2 节手工验收表执行并回填） |

### 25.3 不可宣称（0.9.0 强制口径）

1. 动画手感（150/180ms 观感）：**未验证**。
2. 真机触屏/触笔、高 DPI 清晰度、Firefox/Safari：**未验证**。
3. rAF 合并后的帧率数值结论：**未实测**，不计入通过。
4. 整组浮层超视口可用性（D-05 推荐值「溢出不缩放」）：**未验证**；不可接受时按回退口径压缩呈现（仅改 `drag-overlay.js` 呈现策略，范围计算不动）。
5. 工具箱来源目标连接模式下仅靠插入线/目标框提示落点的可读性（T-EP-09 视觉回退点）：**未验证**；不可接受时按回退口径增强提示视觉权重（不恢复画布幽灵）。
