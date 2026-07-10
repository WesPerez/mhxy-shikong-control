# 时空任务编排模型

本文档记录当前重构方向：先把宏任务做成可保存、可排队、可观察运行的工作区模型，再逐步接入图片识别、OCR 和后台 hwnd 输入执行器。

## 结论

用户提出的方向是对的：任务不应该写成一串彼此复制的图片点击脚本，而应该抽象成“任务库 + 步骤定义 + 识别目标 + 窗口分配 + 运行会话”。

当前阶段已经落到 schema v9：

1. 一个工作区可以保存多个 `Workflow`。
2. 每个窗口 hwnd 都有独立任务队列，队列内串行，不同窗口并行。
3. 每个 hwnd 的运行会话独立，且同 hwnd 同时只允许一个 active session。
4. `Target` 目标库承接粘贴图片、ROI、默认阈值和默认点击点；旧 `assets` 会在载入时迁移。
5. 后台运行 beta 已接入 `PostMessageW` 点击/热键、轻量图像匹配和 Windows OCR 文本确认。
6. 后台运行会在每步执行前校验窗口身份快照，防止 hwnd 漂移、进程重启或窗口尺寸变化后继续投递输入。
7. 队列项支持窗口错峰 `startDelayMs` 和任务后间隔 `afterDelayMs`，用于多窗口并行时减少同一瞬间操作。
8. 步骤自身支持 `preDelay` / `postDelay` 和图像点击 `point + offsetX/offsetY`，用于把动画等待、点击落点微调固化到任务定义里。

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

## 工作区 schema v9

```json
{
  "schemaVersion": 9,
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
          "startDelayMs": 0,
          "afterDelayMs": 800,
          "addedAt": "2026-07-09T00:00:00.000Z"
        }
      ],
      "assignedAt": "2026-07-09T00:00:00.000Z",
      "updatedAt": "2026-07-09T00:00:00.000Z"
    }
  },
  "targets": [],
  "runHistory": [
    {
      "id": "run-1",
      "mode": "background",
      "status": "failed",
      "completedSteps": 8,
      "totalSteps": 12,
      "pauseCount": 1,
      "pausedDurationMs": 2500,
      "failureReason": "best score 0.512 below threshold",
      "windowIdentity": {},
      "endedWindowIdentity": {},
      "queuePlan": [],
      "queueEvents": [],
      "pauseEvents": [],
      "runEvents": [],
      "controlFlowTransitions": [],
      "stepResults": []
    }
  ]
}
```

字段含义：

- `workflows`: 用户创建和导入的任务库。
- `assignments`: 窗口 hwnd 到任务队列的分配表。旧版 `workflowId` 会在载入时迁移成单项 `queue`。
- `targets`: 粘贴图片、ROI、后续模板图和 OCR 文本等可复用识别目标。旧版 `assets` 会在载入时迁移成 `targets`。
- `runHistory`: 观察运行或真实运行的最近报告，包含每步结果、控制流跳转、暂停/继续事件、失败点、耗时和结束窗口身份。失败证据包不新增 schema 字段，而是从单条报告派生导出。

当前保存位置是 Tauri AppData 下的 `workspace.json`。保存使用临时文件写入、flush 后替换原文件，并在覆盖前保留上一版 `workspace.json.bak`。前端载入和 JSON 导入会显示迁移审计摘要：schema v9 规范化、旧 `assets` 合并到 `targets`、`runHistory` 裁剪到最近 80 条、失效队列项/空窗口队列过滤以及最近备份路径都会出现在工作区状态区。第一阶段不用 SQLite，是为了让格式可读、易迁移、好调试；等任务历史、资产索引、运行日志变多后再迁移数据库。

## WindowAssignment

`assignments[hwnd].queue[]` 是窗口自己的任务队列。`queue[].enabled=false` 表示这个窗口暂时跳过该任务，不影响同一个 `Workflow` 在其它窗口里的启用状态。队列项可以追加、删除、上移、下移；运行时每个 hwnd 按自己的启用队列 FIFO 串行执行。

`queue[].startDelayMs` 是该窗口执行这个队列项前的等待时间，批量追加时可按窗口顺序自动写入错峰。`queue[].afterDelayMs` 是该队列项执行完后的任务间隔。两个字段都属于具体窗口队列项，复制队列会复制数值但重新生成 queue id；编辑某个窗口的等待不会影响其它窗口或原始 `Workflow`。

`windowIdentity` 是分配任务时的窗口身份快照。后台运行窗口队列前，前端会先把 assignment 快照和当前窗口列表里的 live 快照做一次比对；如果 hwnd、标题、PID、进程名、client 尺寸或权限状态不匹配，就拒绝启动该窗口队列，要求重新刷新并分配。

队列列表本身也会显示这类运行环境问题。`queueReadinessSummary` 会同时汇总队列里的任务定义问题和 `WindowAssignment` 对应的 live 窗口问题：目标窗口不在当前窗口列表、身份快照不完整、身份漂移、管理员权限不足都会让队列行进入阻塞态。

批量队列操作是编辑工作区配置，不是运行任务。追加当前任务、追加所选任务、复制当前窗口队列和清空已选窗口队列都只改 `assignments[hwnd].queue[]`，不会截图、点击、发送快捷键或接管前台输入。

复制队列时保留每个目标窗口自己的 `windowIdentity`，只复制队列项里的 `workflowId` 顺序、启用状态和等待配置，并重新生成 `queue[].id`。清空队列属于本地破坏性操作，需要用户确认；清空后如果窗口没有队列项，可以删除对应 assignment，后续重新分配时再按当前窗口建立身份快照。

## Workflow

```json
{
  "schemaVersion": 9,
  "id": "wf-daily-welfare",
  "name": "每日福利领取",
  "category": "日常",
  "description": "从主界面进入活动与福利页，领取可见奖励后恢复首页。",
  "tags": ["日常", "示例"],
  "initialCheck": "page.home.ready",
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
- 恢复动作应通过显式恢复入口表达；可执行恢复优先由模板展开为普通步骤，旧版 `restorePolicy` 未接入运行器，编辑器不再生成。

## WorkflowBlueprint

蓝图是新建任务时的模板层，不是运行时状态，也不会写入 workspace schema。蓝图负责把常见任务结构展开成普通 `Workflow.steps[]`，例如家园活力、福利签到、背包物品、组队准备、帮派签到、邮件领取、宠物照料、摊位搜索、任务链检查和材料整理。

任务库里的“导入示例包”只补齐内置 10 个示例任务中当前 workspace 缺失的固定 `workflow.id`，并同步生成识别目标占位；它不会覆盖同 id 已存在的用户任务，也不会修改窗口队列。

从蓝图新建任务时，前端会保留用户可读的 `target` 文本，并为图像、页面、点击和 OCR 目标写入带任务命名空间的 `targetId`，避免多个任务共享同一份待采样素材。生成后立即调用目标占位生成逻辑，把需要采样的步骤接入 `Target` 目标库，随后刷新待补全清单，并自动定位到第一个缺图片、缺 ROI 或缺坐标的步骤。这样用户只需要 Ctrl+V 图片、框选 ROI 或补少量 OCR 文本，就能把蓝图草稿变成可执行任务。

“演练套件”是蓝图层上的组合动作，不引入新的 schema：它一次生成家园活力、福利签到、背包物品、组队准备、帮派签到、邮件领取、宠物照料、摊位搜索、任务链检查和材料整理 10 个普通 `Workflow`，再按已选窗口写入不等长 `assignments[hwnd].queue[]`。默认队列长度按窗口顺序采用 `2/5/7/3/9/4/6/8/1/10` 循环，并沿用当前批量队列的窗口错峰和任务间隔设置，用于复现多窗口各自运行不同数量任务的验收场景。

复制任务时也会复制该任务引用到的 `Target` 资产，并把副本步骤重定向到新 `targetId`。同一任务内部原本共享同一个目标的多个步骤，在副本里仍共享同一个新目标；但原任务和副本之间不再共用图片、ROI、OCR 文本或点击默认值，后续编辑不会串改另一份任务。

## Step

```json
{
  "id": "daily-04",
  "type": "image_click",
  "name": "进入福利页",
  "target": "button.welfare",
  "command": "button=left; point=center; offsetX=0; offsetY=0; preDelay=300ms; postDelay=500ms",
  "expect": "welfare.visible",
  "params": {
    "imageTarget": "button.welfare",
    "button": "left",
    "point": "center",
    "offsetX": 0,
    "offsetY": 0,
    "preDelayMs": 300,
    "postDelayMs": 500
  },
  "timeoutMs": 2600,
  "retry": 1,
  "onFail": "retry",
  "enabled": true,
  "targetId": "button.welfare",
  "targetStepId": "",
  "elseTargetStepId": "",
  "recoveryStepId": "",
  "jumpWorkflowId": "",
  "maxIterations": 0,
  "notes": ""
}
```

当前前端支持的步骤类型：

- `detect_page`: 检测页面或状态。
- `wait_image`: 等待图像出现。
- `image_click`: 图像识别后点击；当前 beta 使用模板匹配后点击中心、四角或偏移后的目标点。
- `double_click`: 后台双击动作；可用坐标/ROI，也可复用图像匹配后的目标点。
- `ocr_assert`: OCR 文本确认；后台运行会截图、按 ROI 或 `roi=top/panel/dialog` 裁剪后调用 Windows OCR，不发送鼠标或键盘输入。
- `click`: 后台点击动作。
- `hotkey`: 快捷键动作。
- `text_input`: 后台文本输入；通过目标 hwnd 投递 `WM_CHAR`，不抢占前台焦点。
- `delay`: 延迟等待。
- `condition`: 条件判断；schema v9 会保存 true/false 跳转目标，前端指令指针 runner 会按 guard 选择同任务内下一步。
- `loop`: 有限循环；只在当前任务内跳到更早的 `targetStepId`，必须设置 `maxIterations`，执行时不发送后台输入，达到上限后顺序进入下一步。
- `retry_until`: 重试直到成功；后台模式必须绑定图片、ROI 或坐标目标，纯状态目标会被校验为不可执行。
- `snapshot`: 截图记录占位。
- `task_jump`: 任务跳转；前端 runner 会在当前 hwnd 会话内插入目标任务，不改写持久化窗口队列。
- `restore`: 恢复到稳定页面的计划步骤；计划态 restore 类型本身仍不投递后台输入，真实恢复应由 `recoveryStepId` 指向模板生成或用户配置的可执行恢复片段。

Ctrl+V 粘贴图片是目标库入口，不是运行时步骤。粘贴后会生成 `Target` 并绑定到当前步骤；如果当前步骤不是可接收图片的图像类步骤，会在当前步骤下方自动创建 `image_click`，避免误改原步骤语义，并同步目标默认阈值、点击键和点击点。文本输入框、JSON 文本框和其它可编辑控件内的粘贴不会被拦截，避免误创建目标。如果 WebView 的粘贴事件没有带图片文件，前端会调用 Rust 后端读取 Windows 剪贴板里的 DIB/DIBV5 位图，再按同一套目标绑定流程导入。

步骤时间线提供 quick-step 快捷动作区，作为 `createStep` 和 `createStepBlock` 的低操作量入口。快捷动作覆盖单步快捷键、坐标点击、OCR 判断，以及识图点击链、文本输入、右键物品、条件检查、失败恢复和 10 步任务骨架这些常用片段；插入后仍走同一套 normalize、目标库占位、`Step.params` 同步和首个待采样图像步骤定位逻辑，不引入第二套步骤模型。

schema v9 继续保留 v7 的控制流定义态字段：`targetStepId`、`elseTargetStepId`、`recoveryStepId`、`jumpWorkflowId` 和 `maxIterations`，并新增 `recoveryAction` 表达恢复分支完成后的保守动作。导入、保存和复制任务会保留这些字段；复制任务时同任务内 step 引用会重映射到副本步骤，单步复制会清空控制流引用，避免复制出的步骤意外跳到旧上下文。当前前端 runner 使用指令指针执行同任务 `targetStepId/elseTargetStepId`，并用 `MAX_CONTROL_FLOW_STEPS` 和 `maxIterations` 限制后向跳转；一等 `loop` 复用这套字段，但要求目标步骤位于当前步骤之前且 `maxIterations > 0`。跨任务 `task_jump` 如果形成任务环，环内每条未设上限的跳转都会在 readiness 中要求设置 `maxIterations`，避免只靠全局任务跳转预算兜底。执行结果会写入 `runHistory[].controlFlowTransitions[]`。`onFail=restore` 会在可恢复失败后跳到同任务 `recoveryStepId`，恢复入口可以指向由模板生成的普通可执行步骤；默认片段包含 `ESC`、等待、页面确认和截图记录，正常成功路径会跳过带默认标记的恢复片段。恢复分支完成后默认 `recoveryAction=stop`，保留原失败并停止当前窗口队列；也可以显式选择恢复后重试原失败步骤或恢复后继续原失败步骤后的正常路径，其中恢复后重试必须设置 `maxIterations`。`jumpWorkflowId`/`task_jump` 会在当前 hwnd 会话内插入目标任务，不改写持久化窗口队列。`loop` 本身是 no-input 控制步骤；计划态 restore 类型自身的后台输入仍未落地。

旧版 `branch` 失败/成功分支字段未接入运行器，编辑器不再生成；后续如果要做状态机，应以显式 `targetStepId` 和 guard 表达式重新设计。
成功路径默认进入下一启用步骤；如果步骤设置了 `targetStepId` 且执行结果不是失败/停止状态，会跳转到同任务目标步骤。旧版 `onSuccess` 字段已不再由编辑器生成。

`steps[].enabled=false` 表示该步骤不参与校验、观察运行和后台执行；运行进度的 `totalSteps` 只统计启用步骤。这样用户可以临时关闭某个点击或识图环节来调试任务。

前端步骤编辑器已经把高频字段拆成“常用参数”控件。schema v9 继续保存 v8 引入的 `steps[].params`，即每个 `Step.params` 的前端结构化参数镜像；保存、导入、复制、目标绑定和运行前都会继续同步/投影到旧的 `target/command/expect` 字符串字段，保证旧 workspace 和当前 Rust IPC 仍可读取。`Step.params` 不是后端原生执行协议，Rust `WorkflowStepInput` 当前仍只接收旧字段。当前控件覆盖：

- `hotkey`: 快捷键输入，同步到 `target`。
- `text_input`: 文本内容，同步到 `target`，后端最多接收 500 个字符。
- `click` / `double_click`: X/Y、左键/右键，同步为 `x=...,y=...` 和 `button=...`。
- `image_click` / `double_click` / `wait_image` / `detect_page`: 识别目标名、阈值，`image_click` 和 `double_click` 额外有点击键、模板中心/四角点位和 `offsetX/offsetY` 像素偏移。
- `delay`: 等待时长和原因。
- `condition`: 条件标签、guard、true/false 跳转步骤；guard 支持 `true/false`、`last.matched`、`last.status=...`、`last.action=...`、`last.score>=0.86` 这类轻量表达。条件标签里的 `state.*` 当前只是语义标识，guard 不会读取通用状态对象；未知表达式不会默认当作 true，后台运行会在 readiness 阶段阻止。
- `loop`: 循环入口和最大循环次数；入口必须是当前任务内更早的启用步骤，`maxIterations` 控制这条回跳边最多被 taken 几次。
- `retry_until`: 等待目标和重试间隔；绑定图片、ROI 或坐标后才会在后台轮询，否则阻止后台运行。
- `task_jump`: 目标任务选择器；执行时只改本次 `RunSession` 的待跑计划，不覆盖窗口队列配置。
- 失败恢复入口：所有步骤可设置 `recoveryStepId`；只有 `onFail=restore` 时会在可恢复失败后进入该分支。`recoveryAction` 决定恢复分支完成后的动作：`stop` 保留失败并停止，`retry` 在 `maxIterations` 上限内重试原失败步骤，`continue` 继续原失败步骤后的正常路径。编辑器提供默认恢复片段模板，片段步骤只在恢复上下文中执行。
- 所有步骤都可以设置 `preDelay` 和 `postDelay`，分别表示该步骤执行前/后等待；这些参数会写入 `steps[].params`，并继续投影回 `command` 字符串。

原始 `target/command/expect` 仍保留为兼容入口；旧 `assetId` 会在载入时迁移为 `targetId`。v8 的 `steps[].params` 先作为前端结构化参数镜像落盘：导入旧工作区时从旧字段回填，编辑旧字段时刷新已知 params 键，并保留未来版本可能写入的未知 params 键。

## Target

当前 `targets` 先接三类内容：

- `image`: 用户 Ctrl+V 粘贴的图片，直接保存为 data URL，并带默认 `match.threshold` 与 `click`。
- `roi`: 用户从预览图框选的区域，保存 ROI 坐标、来源窗口、裁剪后的 data URL、默认阈值和 ROI 中心点击点。
- `builtin-template`: 蓝图/示例任务中的常见逻辑目标会按 `assets/resource/ShiKong/template_mapping.json` 自动接入现有模板图；手动“接入内置素材”只补空目标，不覆盖用户粘贴图片或 ROI。

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

这样多个任务可以引用同一个 `button.confirm`、`page.home.ready`，而不是每个任务复制一份图片和点击逻辑。当前仍把模板图片内联为 data URL；内置模板接入后会记录 `source.type = "builtin-template"`、模板 key、替换路径和来源 ROI。后续目标库需要扩展文件化模板、模板多尺度和 OCR 文本。

目标库可以独立导出为便携 JSON 包，格式固定为：

```json
{
  "kind": "mhxy-target-library",
  "schemaVersion": 9,
  "exportedAt": "2026-07-10T00:00:00.000Z",
  "targetCount": 0,
  "targets": []
}
```

导入目标库时也接受完整 workspace JSON，只读取其中 `targets[]`。合并策略必须保守：不存在的目标直接新增；已有目标只补齐缺失的图片、ROI、OCR 文本、来源和尺寸；仅当已有目标仍是空占位时同步导入的匹配/点击参数；已有用户采样和手工备注不被覆盖。这个策略用于支持“通用素材包 + 用户采样覆盖”的后续资源 overlay，而不是替代完整 workspace 导入。

## 样例任务

首次启动生成 10 个样例任务，每个任务 10 步以上：

- `每日福利领取`
- `组队活动准备`
- `藏宝图处理`
- `帮派签到`
- `秘境材料准备`
- `邮件领取`
- `宠物照料`
- `摊位搜索`
- `任务链检查`
- `材料整理`

这些样例覆盖 hotkey、图像等待、图像点击、OCR 确认、后台点击、后台文本输入、延迟、条件、有限 loop、重试、截图记录、任务跳转和失败恢复片段。新生成的样例会把 `onFail=restore` 步骤指向本任务的默认恢复片段入口，用于演练失败恢复报告；计划态 restore 类型本身仍是 no-input，不代表已经有真实返航输入序列。`材料整理` 包含一个 `loop` 回查步骤和一个 `task_jump` 演练步骤：前者在当前任务内有限回跳，后者会在当前 hwnd 会话内插入 `每日福利领取`，用于回归 `jumpWorkflowId` 不改写持久化队列的语义。`摊位搜索` 包含 `text_input` 步骤，用于验证 hwnd 定向文本输入链路；其它样例不会默认向聊天框或输入框发送文字。它们用于验证模型覆盖面和 UI 操作流，不代表已经可以直接执行未采样素材的真实游戏任务。

## 运行策略

当前有两种运行策略：

- 用户把当前任务追加到已选窗口的任务队列。
- 点击观察运行后，每个已选窗口读取自己的启用队列，并生成独立 `RunSession`。
- 如果某个窗口没有任何队列项，运行按钮会回退到当前 active workflow，便于快速调试单任务；如果已有队列但全部停用，则跳过该窗口。
- 同一个 hwnd 如果已有 active session，会拒绝第二个 session，保持互斥。
- 不同 hwnd 的会话并行推进，各自串行消费自己的队列、步骤进度和日志。
- 观察运行和后台运行结束后写入 `runHistory` 报告，并保存工作区；保存成功后 UI 会保留最近一次 `workspace.json.bak` 路径。
- 观察运行不截图、不点击、不发快捷键、不启动客户端、不请求管理员重启。
- 点击后台运行 beta 后，每个窗口同样按自己的队列生成独立 `RunSession`。
- 如果队列项设置了 `startDelayMs`，该窗口会在对应任务开始前等待；如果设置了 `afterDelayMs`，该任务结束后会等待再进入下一个队列项。等待过程只改运行会话状态，不截图、不 OCR、不投递任何输入，并且可以响应停止请求。
- 如果步骤设置了 `preDelay` 或 `postDelay`，运行器会在该步骤前/后执行可取消等待，并把等待写入单步耗时和详情；失败停止时不会强制继续后置等待。
- 暂停/继续是 `RunSession` 的内存态控制，不改 `Workflow`、`Step`、`Target`、窗口队列或 workspace schema。当前全局按钮会暂停/继续所有正在运行的窗口会话；paused session 仍占用同 hwnd 互斥锁，不能在暂停期间对同窗口启动第二条队列。暂停请求会在步骤边界、队列等待、步骤等待、`delay` 步骤和重试等待处生效；如果单个后台 IPC 已进入 Rust 执行，则该单步先返回，再停在下一处暂停门闸。暂停期间不截图、不 OCR、不投递 hwnd 输入，也不占用前台鼠标键盘。继续后同一 hwnd 会话从原队列继续；停止请求会打断暂停等待并把会话记为 stopped。
- 如果窗口有已分配队列，运行开始前会先比对 `WindowAssignment.windowIdentity` 和当前 live 窗口身份，防止旧队列落到复用后的 hwnd 上。
- 后台运行会做更严格的前端校验：缺 OCR 目标文本、缺图片目标的图像步骤、缺坐标/ROI/图片目标的点击或双击步骤、丢失 `targetId` 的步骤会阻止执行；观察运行仍允许这些抽象样例通过日志演练。
- `audit:readiness-taxonomy` 会锁住缺素材、缺坐标、OCR 文本、ROI 提醒、计划态、恢复计划、队列摘要、目标库状态、窗口身份和权限提示这些 readiness 分类，避免 UI、队列和运行门禁各说各话。
- `retry_until` 如果没有图片、ROI 或坐标目标，会以缺少可验证目标处理，不再把 Rust 后端的计划态 `no_input` 当成功。`condition` 和 `loop` 会通过前端 runner 改变同任务执行路径；后向跳转没有 `maxIterations` 会阻止后台运行。
- `task_jump` 或带 `jumpWorkflowId` 的成功步骤会在当前 hwnd 会话中插入目标任务；该插入只写入本次 `queuePlan/queueEvents` 和 `controlFlowTransitions`，不会改写持久化窗口队列。任务跳回当前任务必须设置 `maxIterations`；跨任务形成 A -> B -> A 这类任务环时，环内任意未设上限的跳转都会被后台 readiness 阻塞，直到该跳转设置 `maxIterations`；整个会话仍受 `MAX_WORKFLOW_JUMPS` 保护。
- `onFail=restore` 只对识图/OCR/缺素材这类可恢复失败生效；`error/unsupported`、窗口身份漂移、权限不足、用户停止不会进入恢复分支。恢复入口不能只指向计划态 restore，默认恢复片段只在恢复分支执行；恢复分支完成后按 `recoveryAction` 停止、重试或继续，`retry` 必须有 `maxIterations` 上限，`runHistory` 保留原失败点、恢复 transition 和恢复完成策略。
- readiness 会把已执行的条件分支、任务跳转、失败恢复分支和仍计划态的 `restore` 步骤分开显示。任务没有缺图片、缺坐标或缺 OCR 文本时，仍可能因为 `restore` 步骤显示计划态提醒；这表示输入链路可演练，但该恢复步骤本身没有后台输入动作。
- 后台运行启动前还会调用 Rust `current_window_identity` 重新读取一次 hwnd 的实时身份；该只读复核通过后，`RunSession.windowIdentity` 才保存为启动时窗口快照：`hwnd/title/processId/processName/clientWidth/clientHeight/elevated`。前端 runner 在每个后台步骤执行前都会再做一次只读身份复核，因此 `delay`、`condition`、`task_jump` 这类无后端输入步骤也不会在 hwnd 漂移后继续推进。每个后台输入/OCR/截图步骤调用 Rust 时还会传入该快照，且 `expectedWindow.hwnd` 必须存在并等于命令入参。
- Rust 在 `execute_workflow_step` 开头重新读取当前 hwnd 的窗口记录，并逐项比对标题、PID、进程名、client 尺寸和权限状态；不一致时返回错误并停止该窗口会话。`image_click` 在模板匹配或 ROI 解析后、真正投递鼠标消息前会再校验一次窗口身份，避免识图过程中 hwnd 被复用后误点其它窗口。
- `hotkey` 通过 hwnd 投递 `WM_KEYDOWN/WM_KEYUP` 或 `WM_SYSKEYDOWN/WM_SYSKEYUP`。
- `text_input` 通过 hwnd 投递 `WM_CHAR`，文本来源优先取 `command` 里的 `text=` / `value=`，没有时取步骤 `target`；后端限制单步最多 500 个字符。
- `click` 通过 hwnd 投递 `WM_MOUSEMOVE`、`WM_LBUTTONDOWN/UP` 或 `WM_RBUTTONDOWN/UP`。
- `double_click` 通过 hwnd 投递 `WM_MOUSEMOVE`、首击 down/up、`WM_LBUTTONDBLCLK` 或 `WM_RBUTTONDBLCLK`、最终 up；不移动真实鼠标。
- `image_click` 和 `double_click` 会截图、匹配模板图，达到阈值后按目标/步骤的点击点点击或双击；点位支持模板中心和四角，并可用 `offsetX/offsetY` 做像素级微调。没有模板但有 ROI/坐标时，点击 fallback 也会应用同一组偏移。
- `ocr_assert` 使用 `target.texts`、步骤目标、`expect` 或 `command` 里的 `text=/contains=` 作为期望文本；识别命中返回 `matched`，未命中返回 `text_miss`，系统 OCR/语言包不可用返回 `ocr_unavailable`，不会把未识别当成功。
- 后台步骤返回 `error` 或 `unsupported` 时一律停止窗口会话。`missing_asset`、`below_threshold`、`text_miss`、`ocr_unavailable`、`missing_expect` 等失败状态在重试耗尽后默认停止，只有步骤显式设置 `onFail=skip` 才会继续下一步。
- `onFail=restore` 会跳到显式 `recoveryStepId`，但只作为失败恢复分支调度；默认 `recoveryAction=stop` 不会把原失败任务改判为成功，也不会继续消费后续队列。用户显式选择 `retry` 或 `continue` 后，runner 会在恢复边界返回原失败步骤或返回正常下一步；`retry` 必须设置 `maxIterations`，避免恢复后无限重跑。要真正返回主界面，需要用户把恢复入口配置为可执行的热键、识图点击、等待和确认步骤；默认模板已提供低风险 `ESC + 等待 + 页面确认 + 截图记录` 片段，但真实返航仍依赖用户素材采样、窗口身份稳定和 live 验收。单独的 `restore` 类型仍只记录计划语义。

`runHistory[]` 保存完成后的报告：`mode/source/hwnd/display/workflowIds/workflowNames/queueLength/status/completedSteps/totalSteps/durationMs/pauseCount/pausedDurationMs/failureReason/windowIdentity/endedWindowIdentity/queuePlan/queueEvents/pauseEvents/runEvents/controlFlowTransitions/stepResults/startedAt/endedAt`。运行面板会从这些记录中提取失败/停止报告，展示失败原因、失败步骤、最近步骤轨迹、窗口身份、事件数量和控制流摘要；展开详情后会列出队列计划、队列事件、暂停/继续事件、统一运行时间线、控制流 transition 和最近步骤结果，作为验收和排障证据。如果对应任务和步骤仍在当前任务库中，用户可以直接定位回步骤编辑器，也可以复制单条报告 JSON 或复制证据包。失败证据包会保留 `fullReport`，同时裁剪最近 `runEvents`、`controlFlowTransitions`、队列事件、暂停事件和步骤结果，便于排障时既能快速读摘要，也能回到完整原始报告。运行中的 `state.sessions` 仍是内存态，后续 Rust 后端 runner 接管后再扩展为可持久化事件流。

每条 `controlFlowTransitions[]` 会记录来源步骤、目标步骤或目标任务、guard 结果、跳转原因、状态 `taken/skipped/fallthrough`、后向跳转次数、任务跳转次数和跳过原因。它用于解释一次运行为什么跳到某一步、为什么插入了另一个任务，或为什么没有跳；它不是任务定义的一部分，也不会跨运行复用。

每条 `queueEvents[]` 会记录队列项启动前错峰、任务后间隔、暂停和继续的 phase、delayMs、状态和耗时。暂停事件使用 `phase=pause`，继续事件使用 `phase=resume`，并汇总到 `pauseCount/pausedDurationMs`。每条 `stepResults[]` 会记录 workflow、step、状态、动作、详情、是否发送输入、匹配分数、坐标和耗时；如果步骤有前/后等待，详情中会带 `timing preDelay=... postDelay=...`。运行结束时前端会通过只读 `current_window_identity` 再读取一次 hwnd 身份，写入 `endedWindowIdentity` 或 `endedWindowIdentityError`，便于排查长时间多窗口运行后的 hwnd 漂移、窗口关闭和权限变化。

每条 `runEvents[]` 是按 `order` 追加的统一时间线，串起 `session_start/workflow_start/step_start/step_result/control_flow/task_jump/pause/resume/queue_event/stop_request/session_failure/session_end` 等事件。它不替代 `queueEvents`、`controlFlowTransitions` 或 `stepResults`，而是把这些来源的关键字段扁平化到同一条审计链，便于复制报告后按时间顺序证明暂停期间没有额外输入、失败前最后一步是什么、任务跳转何时插入，以及停止请求发生在什么位置。当前前端最多保留每个会话最近 800 条 `runEvents`，避免长循环报告无限增长。

后台就绪 UI 中的待补全项会保留结构化 `category`，而不是只靠中文提示字符串归类。当前分类覆盖 `missing_asset`、`missing_coordinate`、`missing_ocr_text`、`missing_target`、`roi_warning`、`planned_semantic`、`restore_plan`、`missing_window`、`permission`、`task_jump`、`loop_control`、`recovery_entry` 等；每个分类同时提供用户可读动作、默认聚焦控件和状态提示。这样任务级统计、目标库状态、下一步定位和审计脚本可以共享同一套语义，后续调整文案时不应改变 readiness 判断结果。

## 输入安全原则

默认运行路径必须满足：

- 不调用 `SendInput`、`SetCursorPos`、`mouse_event`、`keybd_event`。
- 不为了任务执行调用 `SetForegroundWindow` 或 `BringWindowToTop`。
- 观察运行不发送任何游戏输入。
- 鼠标和键盘输入只能走目标 hwnd 的后台消息。
- 同一个 hwnd 只能运行一个任务；不同 hwnd 可以并行。
- 所有任务报告必须记录 hwnd、初始窗口身份、最终窗口身份、截图来源和失败原因。

只有用户明确要求查看或调试时，才考虑临时前台操作；默认应用界面不提供抢前台入口。
