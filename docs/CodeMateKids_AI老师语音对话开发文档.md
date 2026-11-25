# CodeMateKids AI 老师语音对话开发文档

## 1. 首版目标

在 Windows 本机 Web Demo 的「AI 小老师」面板中，学生按住麦克风说话，松手后看到转写文字，确认或修改后发送。发送时复用现有对话接口，带上该学生的当前任务、选中积木、程序和运行快照。老师的文字回复先显示，语音随后播放。

华为云 SIS 负责语音识别和合成，回复内容由现有老师服务生成，本地教学回复也可以播报。SIS 凭证由使用者通过后端环境变量提供。凭证未配置时，Demo 正常启动，学生照常打字聊天。 [对话与学习记忆设计](CodeMateKids_AI老师对话与学习记忆开发文档.md) · [现有聊天接口](api-contract.md)

## 2. 华为云和本地配置

1. 用已实名认证的华为云账号进入 SIS 控制台，切换到**华北-北京四**。在「服务介绍 → 开通管理」分别开通「一句话识别」和「语音合成」。新用户完成开通后可按需调用。已有华东-上海一项目时也可使用该区域。 [SIS 开通指南](https://support.huaweicloud.com/usermanual-sis/sis_09_0028.html) · [计费说明](https://support.huaweicloud.com/productdesc-sis/sis_01_0020.html)
2. 在「我的凭证 → API 凭证」记录同一区域的项目 ID。建议为 Demo 使用专用 IAM 用户，在该区域项目授予 SIS 权限，并在「开通管理」确认该用户可以使用这两项服务。再通过「我的凭证 → 访问密钥」获取该用户的 AK/SK。 [项目 ID](https://support.huaweicloud.com/api-sis/sis_03_0008.html) · [SIS 权限管理](https://support.huaweicloud.com/usermanual-sis/sis_09_0016.html) · [获取 AK/SK](https://support.huaweicloud.com/helppanel-iam/iam_help_second_0017.html)
3. 先在 SIS 在线体验页用一段成人录音和一条简短教学提示分别试识别、合成，再在 API Explorer 中选择目标项目验证两个接口。实际浏览器录音格式留到本地端到端联调确认。 [SIS 在线体验](https://console.huaweicloud.com/sis/#/sis/service-experience) · [API Explorer](https://apiexplorer.developer.huaweicloud.com/)

实现完成后，在启动 `run_demo.cmd` 的终端或进程中设置下列环境变量，更换配置后重新启动 Demo。AK/SK 仅保存在后端运行环境。 [本机运行方式](run.md)

| 环境变量 | 值 |
| --- | --- |
| `CMK_SIS_REGION` | 默认 `cn-north-4`，也支持 `cn-east-3` |
| `CMK_SIS_PROJECT_ID` | 已开通 SIS 的区域项目 ID |
| `CMK_SIS_AK` | 专用 IAM 用户的 Access Key ID |
| `CMK_SIS_SK` | 同一访问密钥对的 Secret Access Key |

服务端按区域映射固定 HTTPS 终端节点。北京四使用 `sis-ext.cn-north-4.myhuaweicloud.com`，上海一使用 `sis-ext.cn-east-3.myhuaweicloud.com`。SDK 使用 AK/SK 签名。 [区域和终端节点](https://support.huaweicloud.com/api-sis/sis_03_0004.html) · [SIS 鉴权方式](https://support.huaweicloud.com/api-sis/sis_03_0058.html)

## 3. 后端改动

| 位置 | 改动 |
| --- | --- |
| [backend/infra/config.py](../backend/infra/config.py)、[backend/app.py](../backend/app.py) | 加载 SIS 设置，按配置初始化客户端。缺少项目 ID 或密钥、区域不受支持、客户端初始化失败时，语音功能停用，应用继续启动。 |
| [backend/api/routers/startup.py](../backend/api/routers/startup.py) | 在启动检查响应中增加 `tutorSpeechEnabled`。仅在 AI 老师聊天启用且 SIS 客户端可用时返回 `true`。该字段只反映本地配置与初始化状态，启动时无需访问华为云。 |
| 新增 `backend/service/speech.py` | 封装一句话识别和语音合成，设置有限的连接与读取超时，把 SDK 结果和错误转换为应用可用的数据。 |
| 新增 `backend/api/routers/speech.py`、[路由入口](../backend/api/routers/__init__.py) | 注册语音接口。沿用回环、同源、JSON 请求和学生会话校验。读取识别请求时限制请求体大小，再调用 SIS。 |
| [backend/session/conversations.py](../backend/session/conversations.py) | 增加已完成回复的只读查询，沿用对话缓存的工作区归属和有效期。合成请求通过该查询取回复。 |
| [requirements.txt](../requirements.txt)、[requirements.lock.txt](../requirements.lock.txt) | 加入新版 Python SDK `huaweicloudsdksis`，同步锁定文件以供 Demo 安装。 |

### 3.1 本地接口

两个语音接口均使用 `Content-Type: application/json`，沿用聊天的 `X-CMK-Student-Id` 约定及临时会话行为。语音接口的错误响应沿用项目的 JSON 错误包封。 [本机同源检查](../backend/api/security.py) · [学生会话解析](../backend/api/student_context.py)

| 方法和路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/speech/recognize` | `{audioBase64}`，仅传音频的 Base64 字符串 | `{"ok":true,"data":{"text":"为什么只走了一步？"}}` |
| `POST /api/v1/tutor/chat` | 确认后的文字、当前选中积木和现有的学习上下文 | 现有聊天响应，包含 `turnId`、`message` 及教学操作 |
| `POST /api/v1/speech/synthesize` | `{turnId, scope}`，使用原聊天轮次 ID 和 `learningContext.scope` | `200`，响应体为 MP3 字节，`Content-Type: audio/mpeg` |

合成接口用当前学生和 `scope` 解析同一个课堂对话范围，再按 `turnId` 读取服务端已完成的 `message`。`scope` 包含 `courseId`、`contentVersion`、`taskId` 和 `workspaceId`。轮次过期或归属不符时返回 `404`，文字气泡仍可阅读。 [聊天处理](../backend/api/routers/tutor.py) · [工作区归属计算](../backend/service/teaching.py)

### 3.2 SIS 请求和失败处理

| 操作 | SIS 参数和结果 |
| --- | --- |
| 一句话识别 `RecognizeShortAudio` | 调用 `POST /v1/{project_id}/asr/short-audio`。首版用 `audio_format=auto`、`property=chinese_16k_general`、`add_punc=yes`，读取 `result.text`。SIS 文档列出 WebM 支持，需用目标 Chrome 或 Edge 实际录制的 WebM/Opus 验证。 |
| 语音合成 `RunTts` | 调用 `POST /v1/{project_id}/tts`。使用小燕 `chinese_xiaoyan_common`、`audio_format=mp3`、`sample_rate="16000"`。从 `result.data` 解码音频。SIS 每次允许最多 500 字符，超限回复保留文字并提示暂时无法播报。 |

[华为云新版 SDK](https://support.huaweicloud.com/sdkreference-sis/sis_05_0006.html) · [一句话识别参数](https://support.huaweicloud.com/api-sis/sis_03_0094.html) · [语音合成参数](https://support.huaweicloud.com/api-sis/sis_03_0111.html)

- 浏览器每段最多录制 **15 秒**。后端将识别请求的 JSON 请求体上限设为 **512 KiB**，读取时执行上限，严格检查 Base64 并拒绝空音频。同步 SDK 调用放到工作线程，连接和读取超时建议分别为 **3 秒**和 **8 秒**。由用户决定是否重试计费请求。
- 直接调用已停用的语音接口返回 `503`，请求体过大返回 `413`，空音频或编码无效返回 `422`。上游超时或失败给学生显示可理解的提示。识别结果为空时提示重录或打字，合成失败只影响对应气泡的播放。
- 语音响应使用 `Cache-Control: no-store`。原始录音和合成音频在应用中按请求处理，前端只在当前页面内存中保留播放用音频。日志记录操作、耗时、错误码和可用的云端追踪 ID。首次录音时告知学生，松手后录音会发往华为云做转写。

## 4. 前端改动

| 位置 | 改动 |
| --- | --- |
| [frontend/index.html](../frontend/index.html)、[frontend/css/app.css](../frontend/css/app.css) | 在输入框旁放置「按住说话」按钮，显示录音、识别及可编辑的确认提示。按钮可通过鼠标、触摸和键盘使用，状态变更可被辅助技术读出。 |
| [frontend/js/main.js](../frontend/js/main.js) | 将启动检查中的 `tutorSpeechEnabled` 和语音控件传给 AI 老师面板。语音不可用时隐藏语音入口，保留可直接使用的输入框和发送按钮。 |
| [frontend/js/api.js](../frontend/js/api.js) | 新增识别和合成方法，传递发起时的学生 ID 与取消信号。识别成功走 JSON 解包，合成成功读 `Blob`，两者复用 JSON 错误处理。 |
| [frontend/js/views/tutorChat.js](../frontend/js/views/tutorChat.js) | 在现有聊天视图中管理录音、草稿确认和播放。确认发送时复用表单提交，回复渲染后按原轮次请求音频。 |

### 4.1 按住说话和转写确认

1. 学生按住按钮后，用 `getUserMedia` 申请或打开麦克风，并用 `MediaRecorder` 录音。先检测 `audio/webm;codecs=opus` 的支持情况。首次权限弹窗结束时，若按住动作已结束，释放麦克风并提示再按一次。
2. 松手或达到 15 秒时结束录音，等待最终音频数据，再释放音轨并发送识别。触摸取消、失焦、切换学生或工作区时取消当前录音与请求，迟到结果按原学生、任务和工作区检查后丢弃。
3. 把识别结果插入输入框，保留已有草稿，并提示「看看文字对不对，再点发送」。沿用现有 300 字限制。插入后会超长时保留原草稿并提示先缩短内容。学生确认发送时才创建聊天轮次并采集当时的积木和运行上下文。

浏览器演示入口沿用 Windows 本机回环地址。权限被拒、设备不可用或识别失败时，学生可以从输入框继续提问。 [浏览器安全上下文规范](https://www.w3.org/TR/secure-contexts/) · [浏览器录音规范](https://www.w3.org/TR/mediastream-recording/)

### 4.2 播报回复

先渲染文字和教学操作。由语音转写发出的提问收到回复后，尝试自动播放。打字发送的回复可点「播放」听取。浏览器拦截自动播放时，通过同一个「播放」按钮继续。提供「停止」和「重播」，重播使用已经取得的音频。

一次只播一条。开始录音时停止播报，避免把老师的声音录进下一轮。切换学生、任务或工作区时停止播放、取消待完成的合成请求并释放音频对象 URL。合成失败时保留文字和教学操作。 [Chrome 自动播放规则](https://developer.chrome.com/blog/autoplay/)

## 5. 实现顺序与验收

先接通可注入测试替身的 SIS 服务和语音路由，再接浏览器录音与文字确认，最后接播报与页面切换清理。用测试替身跑通错误分支和文字聊天回归，再用真实 SIS 凭证做一次端到端录音验证。

| 场景 | 验收结果 |
| --- | --- |
| 没有 SIS 凭证或只配了一部分 | 本机启动正常。学生能打字、多轮追问。文字聊天不发出 SIS 请求。 |
| 真实 SIS 识别 | 在 Chrome 或 Edge 按住说一段短句，松手后显示可编辑文字。修改后点击发送，聊天收到的是修改后的文字。 |
| 教学上下文 | 选中「重复」积木后用语音问「为什么只走了一步」，发送时同现有打字提问一样带上选中积木和工作区快照。老师的定位或回放操作可正常使用。 |
| 播放与重播 | 老师文字先显示。语音提问的回复可以听到。自动播放受限时可手动播放，停止后重播复用原音频。 |
| 异常与切换 | 拒绝麦克风权限、空录音、识别超时或合成失败时，文字聊天可继续。录音、识别或播放期间换人、换题，原工作区的内容不会出现在新面板。 |
| 请求边界 | 超限请求在送往 SIS 前被拒绝，错误学生或工作区无法读取该轮次音频。日志中只有诊断字段。 |

后端回归可运行 `python -m pytest tests -q`，前端复跑 AI 教学及静态检查，录音权限和自动播放使用真实浏览器验收。 [后端聊天测试](../tests/test_classroom_chat.py) · [前端 AI 教学检查](../tests/js_ai_teaching_check.mjs) · [前端静态检查](../tests/js_static_check.mjs)
