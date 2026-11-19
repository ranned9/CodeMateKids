# Windows Demo 运行说明

> 适用范围：当前 Windows Demo 工作区。代码职责与关键流程见 [实现架构](architecture.md)。
> 运行环境：Windows 10/11 64 位 + Python 3.12（本机实测 3.12.9）
> 演示模式：默认 `mock`（演示回复），全程不要求外网。

## 1. 环境准备

1. 安装 Python 3.12，并确认命令输出为 `3.12.x`：

   ```bat
   python --version
   ```

2. 在项目根目录安装依赖：

   ```bat
   python -m pip install -r requirements.txt
   ```

3. 确认没有把 `CMK_MODEL_KEY` 写进任何文件；Demo 默认不需要模型凭据。

## 2. 启动

方式一（推荐）：

```bat
run_demo.cmd
```

方式二：

```bat
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

启动后浏览器打开：

```text
http://127.0.0.1:8000
```

服务只监听回环地址，不提供跨机访问。

## 3. 启动检查

页面顶部会显示：

- `Python 3.12.x（工作进程实测）`：版本来自实际 worker 进程首帧，不是界面或配置声明。
- 课程版本与 schema 版本。
- 辅导模式徽标：`演示回复`（mock）或 `真实模型`（model）。
- 五项门禁：系统、Python、运行小助手、积木清单、课程内容。

`fatal` 时不会进入教学流程；`degraded` 时可以只读浏览课程，但运行入口禁用并显示原因。点“重新检查”会强制重算。

## 4. 配置项

所有配置均可通过环境变量覆盖，默认值安全（详见 `backend/infra/config.py`）：

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `CMK_HOST` / `CMK_PORT` | `127.0.0.1` / `8000` | 仅回环监听 |
| `CMK_EXPECTED_PYTHON` | `3.12` | 只接受精确主次版本 |
| `CMK_RUN_WALL_MS` | `3000` | 单次运行墙钟上限 |
| `CMK_RUN_MEMORY_MB` | `128` | 运行进程内存上限 |
| `CMK_RUN_OUTPUT_BYTES` | `16384` | 可见输出上限 |
| `CMK_RUN_RECURSION_DEPTH` | `200` | 递归深度上限 |
| `CMK_TUTOR_MODE` | `mock` | 凭据缺失时强制 `mock` |
| `CMK_TUTOR_TIMEOUT_MS` | `8000` | 辅导总超时 |
| `CMK_MODEL_ENDPOINT` / `CMK_MODEL_KEY` | 空 | 受保护凭据，只从环境变量注入 |
| `CMK_COURSE_DIR` | `content/demo-loop` | 课程内容包目录 |
| `CMK_LOG_DIR` | `logs` | 脱敏日志目录 |

## 5. 数据与日志

- 学习证据只在进程内存中，关闭服务即清空；总结页注明“仅代表本次会话观察”。
- 项目文件由浏览器下载/上传，只包含结构、课程引用与元信息。
- 开发日志写入 `logs/run.jsonl`，只保留白名单字段（请求标识、版本、类别、耗时、矩阵用例编号等）。
- 不采集真实儿童身份、联系方式、学校班级等信息。

## 6. 测试与验收命令

```bat
python -m pytest tests -q
node tests/js_editor_check.mjs
node tests/js_static_check.mjs
node --check frontend/js/editor/targets.js
```

全量前端纯逻辑检查：

```bat
node tests/js_editor_check.mjs
node tests/js_static_check.mjs
node tests/js_artifact_state_check.mjs
node tests/js_dom_text_check.mjs
node tests/js_project_course_check.mjs
node tests/js_run_session_check.mjs
node tests/js_view_context_check.mjs
```

单端口冒烟（8011，跑完即停）：

```bat
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8011
```

检查项：

- `GET /` 返回 200，包含 `#block-canvas` 与 `#toolbox-list`。
- `GET /assets/css/app.css` 返回 200，包含 `touch-action: none`。
- `GET /assets/js/main.js`、`GET /assets/js/editor/targets.js`、`GET /assets/js/workflows/projects.js` 和 `GET /assets/js/workflows/course.js` 返回 200。
- 课堂网页与静态资源返回 `Cache-Control: no-store`，打开页面时浏览器会向当前服务获取文件。
- `GET /api/v1/startup/check` 的 `data.status` 非 `fatal`，`data.contentVersion` 为 `1.2.0`。
- `GET /api/v1/blocks/schema` 仍包含 `value.number`/`value.calc`。
- `GET /api/v1/course/demo-loop` 的两个任务 `allowedBlockKinds` 均包含 `text.print`、`value.number` 和 `value.calc`。

查看脱敏日志（仅回环可用）：

```text
http://127.0.0.1:8000/api/v1/diagnostics/logs?tail=20
```

查看能力矩阵：

```text
http://127.0.0.1:8000/api/v1/matrix
```

## 7. 常见启动失败处置

| 现象 | 处置 |
|---|---|
| 提示需要 Python 3.12 | 安装 Python 3.12 并确保 `python` 指向它；不要用 3.11 或更低版本 |
| 端口 8000 被占用 | 手动启动 uvicorn 并指定空闲的 `--port`，再用相同端口访问页面 |
| 运行小助手未通过 | 点“重新检查”；检查 Python 是否可正常启动子进程，或安全软件是否拦截 |
| 课程内容打不开 | 检查 `content/demo-loop/` 三个 JSON 是否完整，schema 版本是否匹配 |
| 页面样式/脚本 404 | 确认 `frontend/` 目录完整，服务从项目根目录启动 |
| 模型模式自动变回演示回复 | 这是预期的安全降级：凭据缺失时强制 mock |

## 8. 环境初始化（bootstrap）

推荐在干净环境先执行：

```bat
scriptsootstrap_env.cmd
```

脚本会创建 `.venv` 并按 `requirements.lock.txt` 安装锁定依赖，完成后提示激活命令：

```bat
.venv\Scriptsctivate.bat
```

`requirements.txt` 仍保留版本范围声明；`requirements.lock.txt` 用于可复现安装。

## 9. 依赖缺失处置

`run_demo.cmd` 在解释器校验后会执行 `scripts/check_env.py`：

- 依赖齐全：正常启动 `uvicorn backend.app:app --host 127.0.0.1 --port 8000`。
- 依赖缺失：输出缺失项与安装命令，退出码 `2`，**不输出 Python 回溯**。
- 解释器不是 3.12：退出码 `1`。

也可手动执行预检：

```bat
python scripts\check_env.py
```

退出码语义：`0` 正常、`1` 解释器不符、`2` 依赖缺失。

## 10. 本次修复的契约要点

详见 `docs/api-contract.md`，简要记忆：

- `elapsedMs` 现在只表示**本次**启动检查耗时；缓存命中时 `cached=true`，仍显示原始耗时。
- 新增只读接口 `GET /api/v1/runs/{request_id}`，供前端离开运行上下文时等待终态。
- `POST /runs` 的 `accepted` 语义收紧：通过门禁且具备执行条件。
- `answerLevel=0` 表示“未追加提示”，仅用于“我想自己试 / 跳过”。
- 运行标识限制为 1–64 位 `[A-Za-z0-9_-]`；重复标识返回 `RUN_ID_CONFLICT`。
- 只允许回环监听；**不得把 `--host` 改为 `0.0.0.0` 或对外暴露**。
## 11. 0.2.0 编辑器拖放修复要点

- 两个任务的 `allowedBlockKinds` 收窄为 5 个有合法落点的语句积木，移除 `value.number`/`value.calc`；schema 中的值积木定义保留，供未来课程使用。
- `contentVersion` 由 `1.0.0` 递增为 `1.1.0`；`courseRef.version` 保持 `1`（程序格式未变）。
- 表达式字段归属只由父节点 `inputs[fieldName]` 表示，节点不再携带 `fieldName`；后端节点白名单未放宽。
- 放置目标使用稳定 ID（`root@start`、`root@after:<blockId>`、`body:<owner>@start`、`body:<owner>@after:<child>`），命中为矩形带 + 附近吸附，预览与提交共用同一解析结果。
- `run_demo.cmd` 仍使用 8000 端口，核对结论：无需修改。
## 12. 0.3.0 交互恢复要点（部分完成）

- 松手提交改为以 `pointerup` 最终坐标重新命中，预览与提交使用同一结果；提交段由 `try/finally` 保证清理。
- 删除成功拖动后的 `void definition;` 未定义引用；新增 `node tests/js_static_check.mjs` 静态扫描。
- 修复根链放置目标矩形 `rect.x` 为 `undefined` 的缺陷（此前根位/链间释放会被判为画布外）。
- 捕获改为在拖动源元素上（工具箱按钮 / canvas），失败时保留 window 监听兜底；可拖动项显示 `grab/grabbing`。
- 点击一下添加、`DEBUG_DND` 诊断、浏览器探针、缩放矩阵分别等待 Q-3/Q-4/Q-1/Q-6 拍板，尚未实现。
- 浏览器手工拖放尚未验收；Node 断言与冒烟通过不得替代浏览器结论。
