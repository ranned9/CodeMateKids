# 拾阶（CodeMateKids）

**拾阶**，取“拾级而上”之意：海龟一步一步走，提示一级一级加。工程代号仍为 CodeMateKids。

面向小学三年级及以上儿童的 **AI 少儿编程教学平台**（Windows Demo）。孩子在自研积木工作区预测、编程、运行和修改。受约束的 Python 3.12 运行器返回结果，辅导界面用分层提示引导下一步。

> 默认课包内容版本为 `1.4.2`，依次包含走四步、走六步、画正方形和「走到路口再转弯」。应用版本标识为 `0.1.0`，默认使用本地 `mock` 演示回复。

## 主要特性

- **积木可视化编程**。拖放或点击添加积木，在循环和条件分支中插入动作。重复次数和转角可直接编辑，转角菜单提供常用值。
- **受约束运行器**：Python 3.12 + 白名单 API，限制墙钟时间、内存、输出字节与递归深度，结构化结果回传给教学模块。
- **分层教学辅导**：根据本轮观察区分重复次数、动作位置和前进步长。提示可定位积木或回放运行，让孩子改一处后重新预测和运行。
- **循环与分支练习**。画正方形同时检查路线与循环结构，作用等同的直角按同一规则判定。路口练习同时检查终点和条件分支实际执行转弯的时机。
- **可配置课包**。课包声明任务链接、舞台目标、执行条件和分层提示。设置 `CMK_COURSE_DIR` 后重启服务即可载入指定课包。[课包扩展说明](docs/architecture.md#如何扩展)
- **学习记录**。课堂总结使用本次会话的证据。选用本机学生档案时，部分结构化学习观察会保存到 SQLite，课堂草稿保存在浏览器中。
- **本机运行**。启动脚本监听回环地址，脱敏日志只保留白名单字段。模型可通过环境变量或网页设置；网页测试通过后会把配置和凭据保存在本机。模型不可用时回退到演示回复。[数据位置与模型配置](docs/run.md)

## 目录结构

| 路径 | 说明 |
|---|---|
| `backend/` | FastAPI 服务：`api/` 路由、`domain/` 程序模型、`runner/` 受限运行器、`service/` 课程与校验、`infra/` 配置与日志 |
| `frontend/` | 原生 JS 与 Canvas。`js/main.js` 装配页面，`js/workflows/` 管理工作区切换和预测，`js/editor/` 实现积木结构与拖放，`js/ux/` 和 `js/views/` 管理界面 |
| `content/demo-loop/` | 默认课包（任务、判题和展示配置、积木清单、辅导回复） |
| `schemas/` | 积木、课程、程序、运行协议与辅导协议 JSON Schema |
| `tests/` | pytest 后端测试与 Node 前端纯逻辑检查 |
| `scripts/` | 环境检查与初始化脚本 |
| `docs/` | 当前架构、运行说明、验收记录、能力矩阵和已知限制 |
| `harmony/` | HarmonyOS / ArkTS 示例，用 DevEco Studio 单独验证，不是 Demo 运行依赖 |
| `开发文档.md`、`项目计划.md` | 开发基线与项目计划 |

## 快速开始

要求：Windows 10/11 64 位 + **Python 3.12**（精确主次版本）。

```powershell
python -m pip install -r requirements.lock.txt
.\run_demo.cmd
```

然后打开 <http://127.0.0.1:8000> 开始学习。

虚拟环境、手动换端口、模型配置和排错见 [运行说明](docs/run.md)。

## 测试

```powershell
python -m pytest tests -q
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($check in Get-ChildItem -LiteralPath tests -Filter 'js_*_check.mjs' | Sort-Object Name) {
    node $check.FullName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

完整的检查项清单、单端口冒烟与常见启动失败处置见 [docs/run.md](docs/run.md)。

## 文档导航

- **维护与扩展**　[当前架构和扩展入口](docs/architecture.md) · [接口契约](docs/api-contract.md) · [Python 能力矩阵](docs/matrix.md)
- **运行与验证**　[运行与排错](docs/run.md) · [演示脚本](docs/demo-script.md) · [验收记录](docs/acceptance.md) · [手工检查表](docs/manual-checklist.md) · [已知限制](docs/known_limitations.md)
- **计划与历史设计**　[工作台开发方案](docs/CodeMateKids_UI_UX_综合改造方案.md) · [初版项目计划](项目计划.md) · [初版开发基线](开发文档.md) · [分版本设计与任务](.codeartsdoer/specs/kids_coding_demo/)
- **鸿蒙示例**　[工程说明与构建状态](harmony/README.md)

## 范围与限制

当前交付面向本机单人练习。学生档案用来归属本机学习观察，课堂总结的范围仍是本次会话。Python 支持范围以演示积木和能力矩阵为准。[已知限制](docs/known_limitations.md)
