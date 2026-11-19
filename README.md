# CodeMateKids

面向小学三年级及以上儿童的 **AI 少儿编程教学平台**（Windows Demo）。孩子用自研积木工作区搭程序，在受约束的 Python 3.12 运行器里运行，AI 教师根据预测、运行结果和修改给出分层提示，而不是直接给答案。

> 当前工作区包含 0.3.0 的部分交互改动及后续修复。应用版本标识为 `0.1.0`，课程内容版本为 `1.2.0`。默认使用本地 `mock` 演示回复。

## 主要特性

- **积木可视化编程**：拖放或点击添加积木，在循环中插入动作，把数字和算式放入输入槽，再修改、撤销、保存和运行。
- **受约束运行器**：Python 3.12 + 白名单 API，限制墙钟时间、内存、输出字节与递归深度，结构化结果回传给教学模块。
- **分层教学辅导**：提问 → 轻提示 → 定位线索 → 局部示例 → 拆步骤，只在教学确有必要时给完整讲解。
- **教学证据链**：预测、回答、操作、运行结果与修改记录构成会话内存态证据，总结页注明“仅代表本次会话观察”。
- **安全默认值**：服务只监听回环地址；脱敏日志只保留白名单字段；模型凭据只从环境变量注入，缺失时自动降级为演示回复。

## 目录结构

| 路径 | 说明 |
|---|---|
| `backend/` | FastAPI 服务：`api/` 路由、`domain/` 程序模型、`runner/` 受限运行器、`service/` 课程与校验、`infra/` 配置与日志 |
| `frontend/` | 原生 JS 前端。`js/main.js` 装配页面，`js/workflows/` 负责作品和课程流程，`js/editor/` 与 `js/views/` 负责编辑器和交互界面 |
| `content/demo-loop/` | 演示课程内容包（课程、积木清单、辅导回复） |
| `schemas/` | 积木、课程、程序、运行协议与辅导协议 JSON Schema |
| `tests/` | pytest 后端测试与 Node 前端纯逻辑检查 |
| `scripts/` | 环境检查与初始化脚本 |
| `docs/` | 当前架构、运行说明、验收记录、能力矩阵和已知限制 |
| `harmony/` | HarmonyOS / ArkTS 示例，用 DevEco Studio 单独验证，不是 Demo 运行依赖 |
| `开发文档.md`、`项目计划.md` | 开发基线与项目计划 |

## 快速开始

要求：Windows 10/11 64 位 + **Python 3.12**（精确主次版本）。

```bat
python -m pip install -r requirements.txt
run_demo.cmd
```

然后打开 <http://127.0.0.1:8000> 开始学习。

也可以手动启动：

```bat
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

配置项和端口参数见 [运行说明](docs/run.md)。模型配置通过 `CMK_TUTOR_MODE`、`CMK_MODEL_ENDPOINT` 和 `CMK_MODEL_KEY` 等环境变量提供。

## 测试

```bat
python -m pytest tests -q
for %f in (tests\js_*_check.mjs) do @node "%f"
```

完整的检查项清单、单端口冒烟与常见启动失败处置见 [docs/run.md](docs/run.md)。

## 文档导航

- **实现与接口**　[当前架构](docs/architecture.md) · [接口契约](docs/api-contract.md) · [Python 能力矩阵](docs/matrix.md)
- **运行与验证**　[运行与排错](docs/run.md) · [演示脚本](docs/demo-script.md) · [验收记录](docs/acceptance.md) · [手工检查表](docs/manual-checklist.md) · [已知限制](docs/known_limitations.md)
- **计划与历史设计**　[项目计划](项目计划.md) · [开发基线](开发文档.md) · [分版本规格、设计与任务](.codeartsdoer/specs/kids_coding_demo/)
- **鸿蒙示例**　[工程说明与构建状态](harmony/README.md)

## 范围与限制

本项目是演示闭环，不是生产系统：仅本地单机、无真实儿童账号与长期学习档案、学习证据只在进程内存中、Python 语言支持限定在演示子集。详见 [docs/known_limitations.md](docs/known_limitations.md)。
