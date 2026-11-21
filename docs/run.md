# Windows Demo 运行说明

在 Windows 10 或 11 的 64 位环境使用 Python 3.12。默认使用本地 `mock` 辅导，启动和练习可离线进行。 [实现架构](architecture.md)

## 环境准备和启动

在仓库根目录运行。新环境使用锁定依赖安装。

```powershell
python --version
python -m pip install -r requirements.lock.txt
.\run_demo.cmd
```

也可以执行 `.\scripts\bootstrap_env.cmd`，由脚本创建 `.venv` 并安装锁定依赖。随后在命令提示符执行 `.venv\Scripts\activate.bat`，或在 PowerShell 中直接使用 `.\.venv\Scripts\python.exe`。 [初始化脚本](../scripts/bootstrap_env.cmd)

打开 [本机课堂](http://127.0.0.1:8000)。如需换端口，手动启动并使用相同端口访问。

```powershell
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8011
```

`run_demo.cmd` 会运行环境预检，`0` 表示通过，`1` 表示 Python 版本不符，`2` 表示缺少依赖。课堂「系统信息」可查看 Worker 实测版本、课程和积木定义版本、辅导模式与各项检查。处于受限状态时，运行能力取决于 `runCapability` 及当前任务。点击「重新检查」可刷新报告。 [启动和运行契约](api-contract.md)

## 常用配置

在启动服务的终端设置环境变量。手动运行 Uvicorn 时，监听地址与端口以命令行的 `--host` 和 `--port` 为准。Demo 仅在本机回环地址使用。 [配置代码](../backend/infra/config.py)

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `CMK_HOST`、`CMK_PORT` | `127.0.0.1`、`8000` | Demo 默认运行地址与端口 |
| `CMK_EXPECTED_PYTHON` | `3.12` | 运行 Worker 的 Python 主次版本 |
| `CMK_RUN_WALL_MS` | `3000` | 单次运行墙钟上限 |
| `CMK_RUN_MEMORY_MB` | `128` | 运行进程内存上限 |
| `CMK_RUN_OUTPUT_BYTES` | `16384` | 可见输出字节上限 |
| `CMK_RUN_RECURSION_DEPTH` | `200` | 执行递归深度上限 |
| `CMK_TUTOR_MODE`、`CMK_TUTOR_TIMEOUT_MS` | `mock`、`8000` | 辅导模式与超时 |
| `CMK_MODEL_ENDPOINT`、`CMK_MODEL_KEY` | 空 | 模型连接与凭据，运行时注入环境变量 |
| `CMK_TUTOR_AGENT_ENABLED` | 未设置 | 设为 `1` 后，网页模型可在本题内追问、定位积木或展示回放 |
| `CMK_COURSE_DIR`、`CMK_LOG_DIR` | `content/demo-loop`、`logs` | 课程包和脱敏日志目录 |

### 网页接入真实模型

在回环地址打开 Demo，进入「系统信息 → 模型接入」。输入服务商给出的 HTTPS API 基础地址、模型名和 API 密钥。后端会拼接 `/chat/completions`。通用适配器使用 JSON 模式和 `max_completion_tokens`。 [Chat Completions 接口文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

使用 DeepSeek 官方服务时，基础地址填 `https://api.deepseek.com`，模型名可填 `deepseek-flash`。适配器为官方域名使用 `max_tokens` 并关闭思考模式。当本地 DNS 只返回代理虚拟地址时，项目通过 Cloudflare 公共 DNS 查找 IPv4 公网地址，再按原域名验证 TLS 证书。 [DeepSeek 官方接入](https://api-docs.deepseek.com/) · [DeepSeek 请求参数](https://api-docs.deepseek.com/api/create-chat-completion/)

点「测试连接」，通过后点「启用模型」。连接测试只验证模型返回可解析的 JSON，课堂回复另外核对事实及教学动作。进入「小海龟走六步」，让角色实际动 2 次、走 4 步，再点轻提示。该条回复应显示「真实模型」，并引用本次运行的事实。

「测试连接」通过后，地址、模型名和密钥自动保存到 `logs/model-config.local.json`，网页提示「密钥已保存」。即使还没点「启用模型」，重启后也能直接启用。已启用的模型会在重启后继续使用，切回「使用演示回复」也会保留配置。同一 API 地址重新测试时，密钥栏可留空以复用已保存的密钥。该文件存的是明文，Git 已忽略。使用 `CMK_LOG_DIR` 时，文件位于指定目录中。

要试多轮教学，在启动终端设置 `$env:CMK_TUTOR_AGENT_ENABLED = "1"` 后启动服务，再在网页启用模型。可用同一道题中的两种虚构回答检查教法变化。 [网页模型与教学 Agent 开发文档](CodeMateKids_网页模型接入与教学Agent开发文档.md)

作品通过浏览器保存或打开 JSON。学习证据保存在服务进程内存中，随进程关闭清空。开发诊断见 [本机日志接口](http://127.0.0.1:8000/api/v1/diagnostics/logs?tail=20)，支持的积木见 [能力矩阵](matrix.md)。

## 测试与验收

Python 测试覆盖 API、作品兼容性和真实 Worker。前端检查使用 Node.js 运行，以下脚本会自动包含新增的 `js_*_check.mjs`。

```powershell
python -m pytest tests -q
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

foreach ($check in Get-ChildItem -LiteralPath tests -Filter 'js_*_check.mjs' | Sort-Object Name) {
    node $check.FullName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

本机冒烟检查可使用独立端口 `8011`。访问课堂首页，确认「系统信息」中运行小助手可用、当前内容版本与课程包一致，再走一遍预测、编辑、运行、保存、打开。课堂页和静态资产以 `Cache-Control: no-store` 返回。尺寸、拖放、焦点及异常流程按[浏览器检查表](manual-checklist.md)验证，历次结论见[验收记录](acceptance.md)。

## 排错

| 现象 | 处理 |
| --- | --- |
| Python 版本或依赖错误 | 用 `python --version`、`python scripts/check_env.py` 确认当前解释器及依赖 |
| 端口占用 | 更换回环监听端口，沿用相同端口访问网页 |
| Worker 检查失败 | 查看系统信息并重新检查，确认 Python 可创建子进程 |
| 课程加载失败 | 检查课程目录的 JSON 文件是否齐全，确认积木定义和课程引用匹配 |
| 样式或脚本 404 | 确认从仓库根目录启动，且 `frontend/` 完整 |
| 模型回复回到演示模式 | 查看环境变量和系统信息。凭据缺失或模型回复失败时使用本地回复 |

当前限制及待验收项目见[已知限制](known_limitations.md)。历史修复见[验收记录](acceptance.md)及[版本设计与任务](../.codeartsdoer/specs/kids_coding_demo/)。
