# 积木拖放仍不可用：交互恢复与嵌套改造方案

> 复核日期：2026-11-18  
> 范围：当前前端代码静态复核及拖放失败处理方案。真实浏览器交互尚未在本次复核中验证。

## 先说结论

旧版指南记录的一些问题已经有代码改动：当前实现包含放置目标解析、拖入空程序/顺序链/循环体的目标、容器和子块分层绘制、按嵌套深度命中、失败时对副本执行拖放事务，以及 `pointercancel` 清理。因此现在不应再把“完全没有拖放监听”或“父块必然盖住子块”当成已确认根因。

但是 Node 内核测试不等于用户在浏览器里确实能拖动。当前代码还缺少从工具箱按下、跨面板移动、画布命中到松手提交的真实浏览器回归；拖放结束使用最后一次 `pointermove` 的命中结果而不是松手坐标；成功提交之后还有一个对未定义变量 `definition` 的引用，会在每次成功拖动后抛出运行时异常。鼠标不移动直接松开时，当前行为也只是取消，没有“点击添加”备用方式。应先把真实交互跑通，再完善 Scratch 式外观。

## 当前代码状态

| 能力 | 当前状态 | 说明 |
|---|---|---|
| 工具箱按类别筛选 | 已实现 | `views/toolbox.js` 已有类别按钮 |
| 当前树的插入目标 | 已实现逻辑 | `targets.js` 建立根位置、语句之间、循环体内目标；需在浏览器确认视觉目标与 pointer 命中一致 |
| 循环内容显示/命中 | 已实现分层方案 | `layout.js` 生成 draw order，`render.js` 分层画外壳和积木，`pickNode()` 优先最深节点；仍需用真实嵌套程序检查外形和命中 |
| 拖动取消清理 | 已实现基础处理 | 有 pointer ID、`pointercancel`、窗口失焦和 lost capture 清理；工具箱发起时的 capture 行为仍应实测 |
| 表达式块 | 暂不支持 | `EXPR_SLOTS_ENABLED = false`；当前不应显示成可以正常拖入的积木。要么保持明确禁用，要么单独实现递归表达式 UI 后再开放 |
| 浏览器端完整拖放测试 | 缺失 | `tests/js_editor_check.mjs` 只跑 Node 逻辑 stub；它没有验证浏览器真实 pointer 事件和 Canvas 命中 |

## 仍需修改的关键点

### 1. 松手时必须以 pointerup 最终位置重新命中

位置：[dnd.js](../frontend/js/editor/dnd.js#L208)

`onUp()` 当前直接读取 `session.lastResult`。如果最后一次 `pointermove` 与 `pointerup` 坐标不一致，预览显示的位置和实际提交目标可能不同；若松手事件是最后一个到达的事件，代码也没有用松手坐标重新计算目标。

修改方案：在 `onUp(event)` 中先检查 `pointerId`，再以 `editor.pointFromEvent(event)` 计算最终画布坐标，调用 `buildPreview(finalPoint, session)` 得到唯一提交结果。预览和 commit 必须使用这个同一结果。释放在画布外应取消；释放在无效槽位应回滚并显示具体原因；释放到有效槽位时才调用 `commitDrop()`。

### 2. 清除成功放置后的未定义变量异常

位置：[dnd.js](../frontend/js/editor/dnd.js#L230)

`onUp()` 已经调用 `commitDrop()`，随后执行 `void definition;`；本作用域没有声明 `definition`。因此每次成功放置之后都会产生 `ReferenceError`，即使树已经更新，浏览器控制台也会报错，干扰定位并可能打断后续改动。

修改方案：删除这条无效引用。把完成拖动的 teardown 放在明确的 `try/finally` 或保证所有分支调用统一清理方法；提交抛错时显示可读失败提示，并保持 drag session、预览、事件监听器都已清除。

验收标准：成功放置后控制台无未捕获异常，继续拖动第二块仍正常；提交失败也不会留住旧拖动状态。

### 3. 让指针捕获路径可观测且有回退

位置：[dnd.js](../frontend/js/editor/dnd.js#L118)、[dnd.js](../frontend/js/editor/dnd.js#L141)

工具箱 pointerdown 会在 `begin()` 中尝试对画布调用 `setPointerCapture()`；调用失败被静默吞掉。需要在支持的目标浏览器中确认从工具箱启动的活动 pointer 能否稳定把后续 move/up 送到窗口监听器。捕获失败并不必然导致拖动失败，但目前没有诊断信息和针对该路径的浏览器测试。

修改方案：记录拖动源元素和 pointer ID；优先在当前 pointerdown 的源元素上捕获（工具箱按钮发起时捕获工具箱按钮，画布块发起时捕获 canvas），同时保留 document/window 级 move/up/cancel 监听作为回退。只有同一 pointer ID 能更新当前 drag session。开发模式可用 `DEBUG_DND` 输出按下源、client 坐标、canvas 坐标、命中目标 ID、有效性和最终 commit 结果；默认关闭，不将调试内容写入儿童可见界面。

同时给可拖动工具箱项增加 `cursor: grab/grabbing`、`user-select: none`；触屏支持目标需给工具箱拖动源也设置合适的 `touch-action`，不让页面滚动手势抢走拖动。`pointercancel` 仍走统一取消清理。

### 4. 增加不会误触发重复提交的“点一下添加”路径

位置：[toolbox.js](../frontend/js/views/toolbox.js#L128)、[canvas.js](../frontend/js/views/canvas.js#L215)

当前工具箱主要靠按下并拖动；pointerdown 中调用了 `preventDefault()`。用户点了一下但没有移动时，拖动会被取消，且没有明确的鼠标备用入口。键盘 Enter 虽然可以添加，但多数用户不会知道。

修改方案：在 DnD session 保存起点，使用约 5–8 CSS px 的移动阈值区分点击和拖动。工具箱按下后若未超过阈值并松开，则调用一次默认插入；超过阈值才显示拖动预览并按落点提交。默认插入规则要清楚：空画布插根节点；选择了普通语句就在同一语句链中插到其后；选择循环标题时把动作插到循环体；选择循环内动作时插到该动作后。表达式块不可用时点击也必须解释“当前课程暂不支持”，不生成非法程序。

另保留工具箱按钮 Enter/Space 操作。点击和拖动只能由同一个 pointer session 决定其一，不能再额外绑定 click 添加导致一次手势插入两块。

### 5. 先把“嵌套可见可操作”验收通过，再做 Scratch 式拼接造型

位置：[layout.js](../frontend/js/editor/layout.js#L42)、[render.js](../frontend/js/editor/render.js#L90)、[layout.js](../frontend/js/editor/layout.js#L300)

当前代码有容器 shell 和最深层命中方案，但普通语句仍以圆角矩形绘制；只有颜色和位置变化时，不一定能让孩子直觉理解“接在下面”和“放进循环里”的区别。

修改方案：

- 先用真实嵌套树检查：循环标题、循环体、内部动作和后续动作都可见，点击各自区域会选中正确节点。
- 普通动作的顶部/底部加入自有的拼接舌/槽轮廓；循环使用清楚的 C/U 形容器、左侧壁和底部收口；插入线应落在预计的前/后顺序位置。新轮廓由项目自行设计，不照搬 TurboWarp/Scratch 的精确外形、颜色、图标或布局。
- 无效目标显示简短原因，目标形状与端口类型一致。命中测试使用同一份布局几何，但容器标题和容器内部孩子采用分区命中：标题选容器，孩子区域选最深层孩子，空槽选择容器放置目标。
- Canvas 的绘制预览、滚动坐标和 pointer 坐标使用同一逻辑坐标系；在不同缩放/DPR 和有滚动的长程序上都验证。

表达式积木继续隐藏或明确标为暂不可用，直到递归渲染、子插槽命中、表达式替换及后端校验完整实现。不要为了“看起来像 Scratch”而提前开放一个无法编辑或运行的积木。

## 推荐实施顺序

1. 删除 `void definition` 并让 pointerup 最终位置重新命中。
2. 加入浏览器端拖放测试，先定位 pointerdown、pointermove、target resolve、pointerup、commit 哪一步没有发生。
3. 修复实测发现的 pointer capture/窗口失焦问题，补 capture 失败回退；加入点一下添加的备用路径。
4. 浏览器验收循环内外层的可见性、独立命中和插入位置。
5. 最后改积木连接外形、吸附动画、类别和缩放的视觉细节。

不要只改 CSS 后就判定修复完成；要验证从工具箱开始的一整次真实用户手势，最后确实改变程序树且运行成功。

## 浏览器调试步骤

每次操作用唯一 `pointerId` 追踪以下阶段。调试模式应显示/记录每个阶段是否执行，首个缺失阶段就是修复入口：

1. 工具箱 item 收到 `pointerdown`，源 kind 正确，`dnd.session` 建立。
2. `pointermove` 收到相同 ID，client 坐标移动；转成 Canvas 坐标后落在可视区域。
3. `resolveDropTarget()` 返回稳定的 target ID；有效槽应为 `valid=true`，预览高亮与当前鼠标位置吻合。
4. `pointerup` 收到相同 ID，以最终坐标重新解析 target。
5. `commitDrop()` 成功，程序树节点数增加/移动，预览和 session 清零。
6. 控制台没有未捕获异常；新增积木可再次选中、拖动并运行。

若第 1 步没发生，检查工具箱按钮是否被遮挡、disabled 或监听器未绑定；第 1 步发生但第 2 步没有，检查 pointer capture 和浏览器手势取消；第 2 步有但第 3 步失败，检查 client-to-canvas/DPR/scroll 换算和 target 可见区；第 3 步有效但第 5 步失败，检查 pointerup 最终目标、target ID 存活校验和 `planDrop()` 返回值。

## 验收清单

- 在真实 Chrome/Edge 桌面浏览器中，从工具箱拖“向前走”到空画布，出现根程序；拖另一个动作插入现有语句链，顺序符合预览。
- 从工具箱拖动作进循环空语句体；再拖一个动作插到循环内两个动作之间；所有块完整显示。
- 点击循环标题、循环内动作和循环后的动作，选中/拖动的是对应节点。
- 测试指针只小幅移动后松开：新增恰好一个默认位置积木；拖动超过阈值后松开：只按高亮目标提交。
- 分别测试有效槽、无效槽、画布外、pointercancel、窗口失焦、pointer capture 失败；树不会损坏，拖动状态和监听器都会清理。
- 连续插入、移动、撤销、重做各 20 次；树结构正确，之后仍能拖动。
- 页面无拖放相关 console error；运行新增程序成功。
- 在 100%/125% 浏览器缩放、滚动画布后，以及 1024×768、1280×720 窗口重复拖放与嵌套测试。
- `node tests/js_editor_check.mjs`、前端 `node --check` 与后端 `python -m pytest tests -q` 通过；浏览器自动化/手工结果单独记录，不能用 Node 内核通过替代。
