# 时空任务编排模型

本文档记录当前重构方向：先把宏任务做成可保存、可排队、可观察运行的工作区模型，再逐步接入图片识别、OCR 和后台 hwnd 输入执行器。

## 结论

用户提出的方向是对的：任务不应该写成一串彼此复制的图片点击脚本，而应该抽象成“任务库 + 步骤定义 + 识别目标 + 窗口分配 + 运行会话”。

当前阶段已经落到 schema v4：

1. 一个工作区可以保存多个 `Workflow`。
2. 每个窗口 hwnd 都有独立任务队列，队列内串行，不同窗口并行。
3. 每个 hwnd 的运行会话独立，且同 hwnd 同时只允许一个 active session。
4. `Target` 目标库承接粘贴图片、ROI、默认阈值和默认点击点；旧 `assets` 会在载入时迁移。
5. 后台运行 beta 已接入 `PostMessageW` 点击/热键和轻量图像匹配；OCR 仍是明确占位。
6. 后台运行会在每步执行前校验窗口身份快照，防止 hwnd 漂移、进程重启或窗口尺寸变化后继续投递输入。

## 参考模式

这些成熟系统给出的共同方向：

- Temporal 把工作流和活动分开，工作流负责编排，活动负责具体副作用；重试、超时、状态恢复是显式概念。
- UiPath 的 Retry Scope 把“要执行的动作”和“成功条件”分开，只有成功条件满足才算通过。
- Microsoft Power Automate Desktop 将 UI 元素作为可复用资产，而不是把每一步都写死成屏幕坐标。
- Playwright / Selenium 推荐 locator/page object，把页面元素抽象出来，减少重复和脆弱选择器。
- Robot Framework 用 keyword 组合业务流程，底层动作可复用。
- XState 这类状态机模型强调 state、guard、action、transition，适合表达“当前页面不对就恢复到初始界面”。

参考链接：

- Temporal Workflows: https://docs.temporal.io/workflows
- UiPath Retry Scope: https://docs.uipath.com/activities/other/latest/workflow/retry-scope
- Power Automate desktop UI elements: https://learn.microsoft.com/en-us/power-automate/desktop-flows/ui-elements
- Playwright locators: https://playwright.dev/docs/locators
- Playwright page object models: https://playwright.dev/docs/pom
- Selenium page object models: https://www.selenium.dev/documentation/test_practices/encouraged/page_object_models/
- Robot Framework User Guide: https://robotframework.org/robotframework/latest/RobotFrameworkUserGuide.html
- XState states and transitions: https://stately.ai/docs/states

## 工作区 schema v4

```json
{
  "schemaVersion": 4,
  "activeWorkflowId": "wf-daily-welfare",
  "workflows": [],
  "assignments": {
    "123456": {
      "hwnd": 123456,
      "title": "梦幻西游：时空",
      "processId": 1000,
      "processName": "MyGame_x64r",
      "clientWidth": 1264,
      "clientHeight": 720,
      "elevated": true,
      "display": "梦幻西游：时空 #1",
      "windowIdentity": {
        "hwnd": 123456,
        "title": "梦幻西游：时空",
        "processId": 1000,
        "processName": "MyGame_x64r",
        "clientWidth": 1264,
        "clientHeight": 720,
        "elevated": true
      },
      "queue": [
        {
          "id": "queue-daily",
          "workflowId": "wf-daily-welfare",
          "enabled": true,
          "order": 1,
          "addedAt": "2026-07-09T00:00:00.000Z"
        }
      ],
      "assignedAt": "2026-07-09T00:00:00.000Z",
      "updatedAt": "2026-07-09T00:00:00.000Z"
    }
  },
  "targets": [],
  "runHistory": []
}
```

字段含义：

- `workflows`: 用户创建和导入的任务库。
- `assignments`: 窗口 hwnd 到任务队列的分配表。旧版 `workflowId` 会在载入时迁移成单项 `queue`。
- `targets`: 粘贴图片、ROI、后续模板图和 OCR 文本等可复用识别目标。旧版 `assets` 会在载入时迁移成 `targets`。
- `runHistory`: 观察运行或真实运行的最近结果摘要。

当前保存位置是 Tauri AppData 下的 `workspace.json`。第一阶段不用 SQLite，是为了让格式可读、易迁移、好调试；等任务历史、资产索引、运行日志变多后再迁移数据库。

## WindowAssignment

`assignments[hwnd].queue[]` 是窗口自己的任务队列。`queue[].enabled=false` 表示这个窗口暂时跳过该任务，不影响同一个 `Workflow` 在其它窗口里的启用状态。队列项可以追加、删除、上移、下移；运行时每个 hwnd 按自己的启用队列 FIFO 串行执行。

`windowIdentity` 是分配任务时的窗口身份快照。后台运行窗口队列前，前端会先把 assignment 快照和当前窗口列表里的 live 快照做一次比对；如果 hwnd、标题、PID、进程名、client 尺寸或权限状态不匹配，就拒绝启动该窗口队列，要求重新刷新并分配。

## Workflow

```json
{
  "schemaVersion": 4,
  "id": "wf-daily-welfare",
  "name": "每日福利领取",
  "category": "日常",
  "description": "从主界面进入活动与福利页，领取可见奖励后恢复首页。",
  "tags": ["日常", "示例"],
  "initialCheck": "page.home.ready",
  "restorePolicy": "restore_home",
  "targetPolicy": {
    "titleNeedle": "梦幻西游：时空",
    "inputMode": "hwnd-message",
    "concurrency": "per-window-exclusive"
  },
  "steps": []
}
```

关键策略：

- `targetPolicy.inputMode` 固定表达“目标设计是 hwnd 后台消息”。观察运行不发送输入，后台运行 beta 只投递 hwnd 消息。
- `targetPolicy.concurrency=per-window-exclusive` 表示同 hwnd 只有一个 active session；窗口内任务队列串行消费，不同 hwnd 可并行。
- `restorePolicy` 后续会引用共享恢复流程。

## Step

```json
{
  "id": "daily-04",
  "type": "image_click",
  "name": "进入福利页",
  "target": "button.welfare",
  "command": "button=left; point=center",
  "expect": "welfare.visible",
  "timeoutMs": 2600,
  "retry": 1,
  "onFail": "retry",
  "enabled": true,
  "targetId": "button.welfare",
  "notes": ""
}
```

当前前端支持的步骤类型：

- `detect_page`: 检测页面或状态。
- `wait_image`: 等待图像出现。
- `image_click`: 图像识别后点击；当前 beta 使用模板匹配后点击中心点。
- `ocr_assert`: OCR 文本确认；后台运行会截图、按 ROI 或 `roi=top/panel/dialog` 裁剪后调用 Windows OCR，不发送鼠标或键盘输入。
- `click`: 后台点击动作。
- `hotkey`: 快捷键动作。
- `delay`: 延迟等待。
- `condition`: 条件判断。
- `retry_until`: 重试直到成功。
- `snapshot`: 截图记录占位。
- `restore`: 恢复到稳定页面。

Ctrl+V 粘贴图片是目标库入口，不是运行时步骤。粘贴后会生成 `Target` 并绑定到当前步骤；如果当前步骤不是可接收图片的图像类步骤，会在当前步骤下方自动创建 `image_click`，避免误改原步骤语义，并同步目标默认阈值、点击键和点击点。文本输入框、JSON 文本框和其它可编辑控件内的粘贴不会被拦截，避免误创建目标。

旧版 `branch` 失败/成功分支字段未接入运行器，编辑器不再生成；后续如果要做状态机，应以显式 `targetStepId` 和 guard 表达式重新设计。
成功路径当前固定进入下一启用步骤；旧版 `onSuccess` 字段未接入运行器，已不再由编辑器生成。

`steps[].enabled=false` 表示该步骤不参与校验、观察运行和后台执行；运行进度的 `totalSteps` 只统计启用步骤。这样用户可以临时关闭某个点击或识图环节来调试任务。

前端步骤编辑器已经把高频字段拆成“常用参数”控件，并继续同步到旧的 `target/command` 字符串字段，保证旧 workspace 和当前 Rust IPC 仍可读取。当前控件覆盖：

- `hotkey`: 快捷键输入，同步到 `target`。
- `click`: X/Y、左键/右键，同步为 `x=...,y=...` 和 `button=...`。
- `image_click` / `wait_image` / `detect_page`: 识别目标名、阈值，`image_click` 额外有点击键和固定“模板中心”点位。
- `delay`: 等待时长和原因。
- `condition`: 状态目标和 guard。
- `retry_until`: 等待目标和重试间隔。

原始 `target/command/expect` 仍保留为兼容入口；旧 `assetId` 会在载入时迁移为 `targetId`。后续迁移到结构化 `params` 时应继续保证旧字段可导入。

## Target

当前 `targets` 先接两类内容：

- `image`: 用户 Ctrl+V 粘贴的图片，直接保存为 data URL，并带默认 `match.threshold` 与 `click`。
- `roi`: 用户从预览图框选的区域，保存 ROI 坐标、来源窗口、裁剪后的 data URL、默认阈值和 ROI 中心点击点。

当前目标结构：

```json
{
  "id": "button.confirm",
  "name": "确认按钮",
  "kind": "image",
  "dataUrl": "data:image/png;base64,...",
  "roi": { "x": 0, "y": 0, "w": 1280, "h": 720 },
  "match": {
    "threshold": 0.86,
    "scope": "window"
  },
  "click": {
    "button": "left",
    "point": "center"
  },
  "texts": ["确定", "确认"],
  "source": {
    "type": "window",
    "hwnd": 123456,
    "display": "梦幻西游：时空 #1"
  }
}
```

这样多个任务可以引用同一个 `button.confirm`、`page.home.ready`，而不是每个任务复制一份图片和点击逻辑。当前仍把模板图片内联为 data URL；后续目标库需要扩展重命名、删除、分类、使用位置、文件化模板、模板多尺度和 OCR 文本。

## 样例任务

首次启动生成 5 个样例任务，每个任务 10 步以上：

- `每日福利领取`
- `组队活动准备`
- `藏宝图处理`
- `帮派签到`
- `秘境材料准备`

这些样例覆盖 hotkey、图像等待、图像点击、OCR 确认、后台点击、延迟、条件、重试、截图记录、恢复状态。它们用于验证模型覆盖面和 UI 操作流，不代表已经可以真实接管游戏。

## 运行策略

当前有两种运行策略：

- 用户把当前任务追加到已选窗口的任务队列。
- 点击观察运行后，每个已选窗口读取自己的启用队列，并生成独立 `RunSession`。
- 如果某个窗口没有任何队列项，运行按钮会回退到当前 active workflow，便于快速调试单任务；如果已有队列但全部停用，则跳过该窗口。
- 同一个 hwnd 如果已有 active session，会拒绝第二个 session，保持互斥。
- 不同 hwnd 的会话并行推进，各自串行消费自己的队列、步骤进度和日志。
- 观察运行结束后写入 `runHistory`，并保存工作区。
- 观察运行不截图、不点击、不发快捷键、不启动客户端、不请求管理员重启。
- 点击后台运行 beta 后，每个窗口同样按自己的队列生成独立 `RunSession`。
- 如果窗口有已分配队列，运行开始前会先比对 `WindowAssignment.windowIdentity` 和当前 live 窗口身份，防止旧队列落到复用后的 hwnd 上。
- 后台运行会做更严格的前端校验：缺 OCR 目标文本、缺图片目标的图像步骤、缺坐标/ROI 的点击步骤、丢失 `targetId` 的步骤会阻止执行；观察运行仍允许这些抽象样例通过日志演练。
- `RunSession.windowIdentity` 保存启动时窗口快照：`title/processId/processName/clientWidth/clientHeight/elevated`。每个后台步骤调用 Rust 时都会传入该快照。
- Rust 在 `execute_workflow_step` 开头重新读取当前 hwnd 的窗口记录，并逐项比对标题、PID、进程名、client 尺寸和权限状态；不一致时返回错误并停止该窗口会话。
- `hotkey` 通过 hwnd 投递 `WM_KEYDOWN/WM_KEYUP` 或 `WM_SYSKEYDOWN/WM_SYSKEYUP`。
- `click` 通过 hwnd 投递 `WM_MOUSEMOVE`、`WM_LBUTTONDOWN/UP` 或 `WM_RBUTTONDOWN/UP`。
- `image_click` 会截图、匹配模板图，达到阈值后按目标/步骤的点击点点击；当前点位为模板中心。
- `ocr_assert` 使用 `target.texts`、步骤目标、`expect` 或 `command` 里的 `text=/contains=` 作为期望文本；识别命中返回 `matched`，未命中返回 `text_miss`，系统 OCR/语言包不可用返回 `ocr_unavailable`，不会把未识别当成功。

`runHistory[]` 保存完成后的摘要：`mode/source/hwnd/display/workflowIds/workflowNames/queueLength/status/totalSteps/windowIdentity/startedAt/endedAt`。运行中的 `state.sessions` 仍是内存态，后续 Rust 后端 runner 接管后再扩展为事件流。

后续真实执行层还需要把身份校验结果、初始/最终窗口快照和逐步失败原因写入更完整的运行报告；当前 `runHistory` 只保存摘要和启动时身份快照。

## 输入安全原则

默认运行路径必须满足：

- 不调用 `SendInput`、`SetCursorPos`、`mouse_event`、`keybd_event`。
- 不为了任务执行调用 `SetForegroundWindow` 或 `BringWindowToTop`。
- 观察运行不发送任何游戏输入。
- 鼠标和键盘输入只能走目标 hwnd 的后台消息。
- 同一个 hwnd 只能运行一个任务；不同 hwnd 可以并行。
- 所有任务报告必须记录 hwnd、初始窗口身份、最终窗口身份、截图来源和失败原因。

只有用户明确要求查看或调试时，才考虑临时前台操作；默认应用界面不提供抢前台入口。
