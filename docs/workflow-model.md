# 时空任务编排模型

本文档记录当前重构方向：先把宏任务做成可保存、可分配、可 dry-run 的工作区模型，再逐步接入图片识别、OCR 和后台 hwnd 输入执行器。

## 结论

用户提出的方向是对的：任务不应该写成一串彼此复制的图片点击脚本，而应该抽象成“任务库 + 步骤定义 + 识别目标 + 窗口分配 + 运行会话”。

当前阶段已经落到 schema v2：

1. 一个工作区可以保存多个 `Workflow`。
2. 每个窗口 hwnd 可以分配不同任务。
3. 每个 hwnd 的 dry-run 会话独立，且同 hwnd 互斥。
4. `Asset` 先承接粘贴图片和 ROI 目标，后续升级成完整 `Target` 识别库。
5. 后台运行 beta 已接入 `PostMessageW` 点击/热键和轻量图像匹配；OCR 仍是明确占位。

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

## 工作区 schema v2

```json
{
  "schemaVersion": 2,
  "activeWorkflowId": "wf-daily-welfare",
  "workflows": [],
  "assignments": {
    "123456": {
      "workflowId": "wf-daily-welfare",
      "hwnd": 123456,
      "title": "梦幻西游：时空",
      "processId": 1000,
      "display": "梦幻西游：时空 #1",
      "assignedAt": "2026-07-09T00:00:00.000Z"
    }
  },
  "assets": [],
  "runHistory": []
}
```

字段含义：

- `workflows`: 用户创建和导入的任务库。
- `assignments`: 窗口 hwnd 到任务的分配表。
- `assets`: 粘贴图片、ROI、后续模板图等识别资产。
- `runHistory`: dry-run 或真实运行的最近结果摘要。

当前保存位置是 Tauri AppData 下的 `workspace.json`。第一阶段不用 SQLite，是为了让格式可读、易迁移、好调试；等任务历史、资产索引、运行日志变多后再迁移数据库。

## Workflow

```json
{
  "schemaVersion": 2,
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

- `targetPolicy.inputMode` 固定表达“目标设计是 hwnd 后台消息”。dry-run 不发送输入，后台运行 beta 只投递 hwnd 消息。
- `targetPolicy.concurrency=per-window-exclusive` 表示同 hwnd 互斥，不同 hwnd 可并行。
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
  "onSuccess": "next",
  "enabled": true,
  "assetId": "",
  "notes": ""
}
```

当前前端支持的步骤类型：

- `detect_page`: 检测页面或状态。
- `wait_image`: 等待图像出现。
- `image_click`: 图像识别后点击；当前 beta 使用模板匹配后点击中心点。
- `ocr_assert`: OCR 文本确认；当前运行时返回未实现。
- `click`: 后台点击动作。
- `hotkey`: 快捷键动作。
- `delay`: 延迟等待。
- `condition`: 条件判断。
- `retry_until`: 重试直到成功。
- `paste_image`: 编辑器里通过 Ctrl+V 创建并绑定图片资产。
- `snapshot`: 截图记录占位。
- `restore`: 恢复到稳定页面。

`branch` 目前仍是枚举占位，后续需要补 `targetStepId` 和 guard 表达式，才能成为完整状态机。

## Asset 与 Target

当前 `assets` 先接两类内容：

- `clipboard-image`: 用户 Ctrl+V 粘贴的图片，直接保存为 data URL。
- `roi`: 用户从预览图框选的区域，保存 ROI 坐标、来源窗口和裁剪后的 data URL。

后续应升级为 `targets`：

```json
{
  "id": "button.confirm",
  "name": "确认按钮",
  "kind": "image_or_ocr",
  "roi": [0, 0, 1280, 720],
  "templates": ["common/confirm.png"],
  "texts": ["确定", "确认"],
  "threshold": 0.86,
  "click": "center"
}
```

这样多个任务可以引用同一个 `button.confirm`、`page.home.ready`，而不是每个任务复制一份图片和点击逻辑。

## 样例任务

首次启动生成 5 个样例任务，每个任务 10 步以上：

- `每日福利领取`
- `组队活动准备`
- `藏宝图处理`
- `帮派签到`
- `秘境材料准备`

这些样例覆盖 hotkey、图像等待、图像点击、OCR 确认、后台点击、延迟、条件、重试、粘贴图片、截图记录、恢复状态。它们用于验证模型覆盖面和 UI 操作流，不代表已经可以真实接管游戏。

## 运行策略

当前有两种运行策略：

- 用户把任务分配给已选窗口。
- 点击 dry-run 后，每个窗口生成独立 `RunSession`。
- 同一个 hwnd 如果已有运行会话，会拒绝第二个 dry-run，保持互斥。
- 不同 hwnd 的会话并行推进，各自记录步骤进度和日志。
- dry-run 结束后写入 `runHistory`，并保存工作区。
- dry-run 不截图、不点击、不发快捷键、不启动客户端、不请求管理员重启。
- 点击后台运行 beta 后，每个窗口同样生成独立 `RunSession`。
- `hotkey` 通过 hwnd 投递 `WM_KEYDOWN/WM_KEYUP` 或 `WM_SYSKEYDOWN/WM_SYSKEYUP`。
- `click` 通过 hwnd 投递 `WM_MOUSEMOVE`、`WM_LBUTTONDOWN/UP` 或 `WM_RBUTTONDOWN/UP`。
- `image_click` 会截图、匹配模板图，达到阈值后点击匹配矩形中心。
- `ocr_assert` 会明确记录 unsupported，不会把未识别当成功。

后续真实执行层必须在每一步执行前重新校验 hwnd、标题、pid 和窗口尺寸，发现漂移就安全失败并记录日志。

## 输入安全原则

默认运行路径必须满足：

- 不调用 `SendInput`、`SetCursorPos`、`mouse_event`、`keybd_event`。
- 不为了任务执行调用 `SetForegroundWindow` 或 `BringWindowToTop`。
- dry-run 不发送任何游戏输入。
- 鼠标和键盘输入只能走目标 hwnd 的后台消息。
- 同一个 hwnd 只能运行一个任务；不同 hwnd 可以并行。
- 所有任务报告必须记录 hwnd、初始窗口身份、最终窗口身份、截图来源和失败原因。

只有用户明确要求查看或调试时，才考虑临时前台操作；默认应用界面不提供抢前台入口。
