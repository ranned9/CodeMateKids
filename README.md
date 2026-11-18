# CodeMateKids

面向小学三年级及以上儿童的 **AI 少儿编程教学平台**（Windows Demo）。孩子用自研积木工作区搭程序，在受约束的 Python 3.12 运行器里运行，AI 教师根据预测、运行结果和修改给出分层提示，而不是直接给答案。

> 当前状态：Demo 版本（0.1.0，含 0.2.0 编辑器拖放与嵌套修复）。默认使用 `mock` 演示回复，全程不需要外网和模型凭据。

## 主要特性

- **积木可视化编程**：选择、拖放、合法连接、嵌套、参数编辑、运行、重置、错误反馈与执行高亮。
- **受约束运行器**：Python 3.12 + 白名单 API，限制墙钟时间、内存、输出字节与递归深度，结构化结果回传给教学模块。
- **分层教学辅导**：提问 → 轻提示 → 定位线索 → 局部示例 → 拆步骤，只在教学确有必要时给完整讲解。
- **教学证据链**：预测、回答、操作、运行结果与修改记录构成会话内存态证据，总结页注明“仅代表本次会话观察”。
- **安全默认值**：服务只监听回环地址；脱敏日志只保留白名单字段；模型凭据只从环境变量注入，缺失时自动降级为演示回复。

## 目录结构

| 路径 | 说明 |
|---|---|
| `backend/` | FastAPI 服务：`api/` 路由、`domain/` 程序模型、`runner/` 受限运行器、`service/` 课程与校验、`infra/` 配置与日志 |
| `frontend/` | 原生 JS 前端：课程、画布、工具箱、运行反馈、辅导与总结视图 |
| `content/demo-loop/` | 演示课程内容包（课程、积木清单、辅导回复） |
| `schemas/` | 积木、课程、程序、运行协议与辅导协议 JSON Schema |
| `tests/` | pytest 后端测试与 Node 前端纯逻辑检查 |
| `scripts/` | 环境检查与初始化脚本 |
| `docs/` | 运行说明、验收记录、能力矩阵、已知限制等 |
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

配置项全部可用 `CMK_*` 环境变量覆盖（默认值见 `backend/infra/config.py`），例如 `CMK_PORT`、`CMK_TUTOR_MODE`、`CMK_MODEL_ENDPOINT` / `CMK_MODEL_KEY`。**不要把任何凭据写进仓库文件。**

## 测试

```bat
python -m pytest tests -q
node tests/js_editor_check.mjs
node tests/js_static_check.mjs
```

完整的检查项清单、单端口冒烟与常见启动失败处置见 [docs/run.md](docs/run.md)。

## 文档

- [docs/run.md](docs/run.md)：运行、启动检查、配置、测试与排错
- [docs/acceptance.md](docs/acceptance.md)：验收记录
- [docs/matrix.md](docs/matrix.md)：能力矩阵
- [docs/known_limitations.md](docs/known_limitations.md)：已知限制
- [开发文档.md](开发文档.md)：架构、范围与接口设计基线

## 范围与限制

本项目是演示闭环，不是生产系统：仅本地单机、无真实儿童账号与长期学习档案、学习证据只在进程内存中、Python 语言支持限定在演示子集。详见 [docs/known_limitations.md](docs/known_limitations.md)。
