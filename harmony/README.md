# 鸿蒙基础语言示例（独立支线）

本目录是一个使用 ArkTS / ArkUI 编写的基础语言示例工程，覆盖：

- 变量与类型（`string` / `number` / `boolean`）
- 表达式与运算
- 条件判断（`if / else`）
- 循环（`for`）
- 函数定义与调用
- 数组与对象基础
- 简单页面交互（按钮 + 状态）

## 范围限制

- 不含应用框架深入内容、复杂组件、网络请求与设备联动。
- 不作为 Windows Demo 的启动或运行依赖；缺失本目录不影响 Windows Demo 全部教学步骤。

## 构建验证记录

- 验证结果：**未完成构建验证**
- 阻断原因：本机未安装 DevEco Studio 与 HarmonyOS SDK，缺少 `hvigor` 工具链。
- 所需环境（建议）：DevEco Studio 5.0+、HarmonyOS SDK 5.0+、`ohpm`/`hvigor` 可用。
- 构建步骤（环境就绪后执行）：

  ```text
  用 DevEco Studio 打开 harmony/ 目录
  Sync Project → Build Hap(s)/APP(s)
  记录 SDK 版本、构建日志与模拟器运行结果到 docs/acceptance.md 第 7 节
  ```

## 解耦校验

后端不 import 任何鸿蒙/云 SDK；`harmony/` 不进入 `backend/`、`content/`、`schemas/` 启动链路。可执行以下命令复核：

```bat
findstr /S /I /C:"harmony" backend\*.py
```

预期：无业务引用（仅本文档与前端无关路径除外）。