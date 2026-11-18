# Python 3.12 能力矩阵快照

> 生成时间：2026-11-14（本地）
> 规则：仅当正向、负向、运行语义与安全测试全部通过才可标记 tested；本期没有条目达到 tested。

- 条目总数：19
- implemented：3
- limited：1
- not_started：13
- rejected_by_policy：2
- blocked：0
- tested：0

| 能力标识 | 类别 | 目标语法 | 对应积木 | 语法 | 运行 | 安全分类 | 状态 | 已知限制 |
|---|---|---|---|---|---|---|---|---|
| lit.basic | literal_types | None/bool/int/float/str/list/tuple/dict/set | value.number | 是 | 是 | allowed | implemented | 循环主题仅暴露数值字面量积木 |
| name.container_access | container_access | 名称加载/赋值、下标、切片、解包 | — | 否 | 否 | limited | not_started | 未提供对应积木 |
| operators.expression | operators | 算术/比较/布尔/条件表达式 | value.calc | 是 | 是 | allowed | implemented | 仅提供四则运算积木 |
| assignment.statement | assignment | 简单/链式/增强赋值、解包、del、海象 | — | 否 | 否 | limited | not_started | 未提供对应积木 |
| control_flow.loop | control_flow | for/while/break/continue | control.repeat | 是 | 是 | allowed | implemented | 仅固定次数循环，不含 while |
| comprehension.expression | comprehension | 列表/集合/字典推导式、生成器表达式 | — | 否 | 否 | limited | not_started | 未提供对应积木 |
| function.definition | function | def/return/递归/全部参数形式 | — | 否 | 否 | limited | not_started | 运行器设置递归深度 200 上限 |
| lambda.closure | lambda_closure | lambda、闭包、nonlocal | — | 否 | 否 | limited | not_started | 未提供对应积木 |
| decorator.syntax | decorator | 函数装饰器与多装饰器 | — | 否 | 否 | limited | not_started | 未提供对应积木 |
| generator.iterator | generator_iterator | yield/yield from/next/iter | — | 否 | 否 | limited | not_started | 未提供对应积木 |
| async.syntax | async_syntax | async def/await/async for | — | 否 | 否 | limited | not_started | 无事件循环与网络能力 |
| pattern.matching | pattern_matching | match/case 各模式 | — | 否 | 否 | limited | not_started | pattern 端口仅预留 |
| exception.try | exception | try/except/else/finally/raise/except* | — | 否 | 否 | limited | not_started | handler 端口仅预留 |
| context.with | context_manager | with/async with | — | 否 | 否 | limited | not_started | 不暴露文件/系统资源对象 |
| scope.declaration | scope_declaration | global/nonlocal | — | 否 | 否 | limited | not_started | 未提供对应积木 |
| annotation.type_alias | annotation | 注解、type Alias、类型参数 | — | 否 | 否 | limited | not_started | 类型能力不依赖类 |
| builtin.whitelist | builtin_types | 内置函数与内置类型 | text.print | 是 | 是 | limited | limited | 仅注入 print/len/range/str/int/float/abs/min/max/sum 等白名单，其余未提供 |
| rejected.class | rejected_class | class/继承/方法/属性描述符 | — | 否 | 否 | rejected | rejected_by_policy | 稳定错误码 PYTHON_FEATURE_BLOCKED |
| rejected.import | rejected_import | import/from ... import .../依赖模块 | — | 否 | 否 | rejected | rejected_by_policy | 稳定错误码 PYTHON_FEATURE_BLOCKED |

## 未完成与受限说明

- 未开始条目均没有对应积木与运行路径，不能宣称支持。
- 受限条目只开放受控白名单能力，文件、网络、进程与动态执行能力未开放。
- 类定义与导入相关能力为策略拒绝，稳定错误码 `PYTHON_FEATURE_BLOCKED`。
