# 时空任务编排器产品方案

本文是第二阶段编码前门禁。新增能力进入实现前，必须先补齐本文件对应的小节：目标、非目标、数据结构、运行语义、风险边界、验收证据和回滚策略。当前源码以 `docs/workflow-model.md` 描述的 schema v9 为准，前端 runner 已切到带预算的指令指针模型。

## 真实目标

把应用做成用户可自定义、可编排、可组合的后台自动化工作台：

- 用户可以维护独立任务，例如“家园活力”“每日福利”“帮派签到”。
- 每个任务由步骤组成，支持添加、复制、排序、启用/禁用、延迟、超时、重试、失败处理。
- 步骤覆盖快捷键、按键组合、左键、右键、双击、文本输入、OCR、图片识别、图片识别后点击、坐标点击、窗口截图、等待、条件分支、循环、失败恢复和任务跳转。
- 同一素材目标可被多个任务复用，图片绑定应尽量低操作量：选中步骤或目标后直接 `Ctrl+V`。
- 多个游戏窗口可并行运行，各窗口内部串行消费自己的队列，所有输入必须定向到对应 hwnd。

## 非目标

- 不抢占前台鼠标键盘，不移动真实鼠标，不用 `SendInput`、`SetCursorPos`、`mouse_event` 或 `keybd_event`。
- 不在权限不足时尝试绕过 Windows 完整性级别；目标窗口高权限而控制器非管理员时只提示和失败。
- 不把 Maa 的隐式 `JumpBack`、全局状态文件、固定 1280x720 ROI 或识别 hook 里直接执行动作的模式照搬进来。
- 控制流步骤必须先有 runner 语义、readiness 和测试再暴露；`loop` 只作为有限 no-input 循环开放，旧 `branch` 仍不回到下拉框。

## 当前基线

- 已有实体：`Workflow`、`Step`、`Target`、`WindowAssignment`、`RunSession`、`runHistory`。
- 已有运行：观察运行、后台运行 beta、每 hwnd 互斥、不同 hwnd 并行、队列错峰和任务后间隔。
- 已有后台动作：`hotkey`、`text_input`、`click`、`double_click`、`image_click`、`wait_image`、`detect_page`、`ocr_assert`、`snapshot`、`delay`、`retry_until` 的视觉目标等待。
- 已有 quick-step 快捷动作区：通过同一套 `createStep` / `createStepBlock` 插入快捷键、坐标点击、识图点击链、OCR 判断、文本输入、右键物品、条件检查、失败恢复和 10 步任务骨架，并继续复用目标库占位和 `Step.params` 同步。
- 已有报告：运行面板会从 `runHistory` 提取失败/停止报告，显示失败原因、失败步骤、窗口身份、最近步骤轨迹和控制流摘要，并支持展开查看队列计划、队列事件、统一运行时间线、暂停/继续、控制流和最近步骤证据，或定位步骤与复制单条报告 JSON。
- 已有就绪分类：待补全项会保存稳定 `category`、聚焦控件和下一步动作，覆盖缺图片素材、缺坐标、缺 OCR 文本、目标丢失、窗口/权限、计划态语义、恢复入口、任务跳转和循环控制。
- 已知缺口：默认恢复片段还需要真实窗口 live 验收和更多场景模板，恢复策略还需要真实窗口回归样例，后端事件流和管理员环境下的双击 live 验收尚未完成；计划态 `restore` 步骤自身仍不发送后台输入。
- 当前安全语义：`unsupported` 和 `error` 强制停止；识图/OCR/缺素材类失败在重试耗尽后默认停止，只有 `onFail=skip` 才继续。
- 当前 readiness 会校验 v9 同任务跳转、有限 `loop`、失败恢复入口、恢复后重试上限和任务跳转引用；`loop` 必须指向当前任务内更早的步骤并设置 `maxIterations`，恢复后 `retry` 也必须设置 `maxIterations`，跳回当前任务的 `task_jump` 也必须有 `maxIterations`；跨任务环内任意未设上限的 `task_jump` 会阻塞后台运行，直到该跳转补上最大循环次数。`restore` 步骤本身仍标记为计划态，避免误报成完整返航动作。

## 数据方案

schema v9 继续使用结构化 JSON + 原子写入：

- `workflows[]`: 任务定义，步骤仍保留兼容字段 `target/command/expect`，并保存 `targetStepId/elseTargetStepId/recoveryStepId/jumpWorkflowId/maxIterations/recoveryAction` 这些控制流字段。
- `steps[].params`: v8 引入、v9 继续保留的前端结构化参数镜像，用于减少 UI 对 `command` 字符串的直接耦合；保存、导入、复制、目标绑定和运行前仍会投影回 `target/command/expect`。当前 Rust IPC 仍读取旧字段，`params` 不是后端原生执行协议。
- `targets[]`: 共享目标库，保存图片 data URL、ROI、阈值、点击默认值、OCR 文本和备注。
- `assignments[]`: 窗口队列，保存 hwnd 与 `windowIdentity` 快照，以及队列项顺序、启用状态和等待参数。
- `runHistory[]`: 运行报告，保存队列计划、暂停/继续事件、统一 `runEvents` 时间线、控制流 transition、步骤结果、失败原因、暂停次数/时长、开始/结束窗口身份。

当前 v9 边界：

- `normalizeStep` 保留控制流字段和 `steps[].params`，旧工作区载入时从 `target/command/expect` 回填兼容参数；v8+ 工作区载入时以 `params` 为准再投影回旧字段。
- 编辑旧字段会刷新已知 params 键，但保留未来版本写入的未知 params 键，避免降级/升级来回编辑时丢扩展参数。
- 复制任务时重映射同任务内 step id 引用，避免跳到原任务步骤。
- 单步复制会清空控制流引用，避免插入步骤带着旧上下文跳转。
- 导入会保留并规范化控制流字段；后台 readiness 会校验跳转目标存在、未停用、非自环；同任务 `targetStepId/elseTargetStepId` 会被指令指针 runner 执行，后向跳转必须设置 `maxIterations`。
- 保存仍使用临时文件 + rename，并保留最近一次 `workspace.json.bak`；损坏 JSON 应保留错误提示，不自动覆盖用户数据。载入和导入会显示迁移审计，覆盖 schema v9 规范化、旧 assets 迁移、运行记录裁剪和失效队列过滤。

## 运行器方案

已落地的 v9 子集：

- `delay`、pre/post delay、队列等待都必须可取消。
- 暂停/继续属于运行会话状态，不修改 `Workflow`、`assignments` 或持久化队列 schema；当前全局按钮会暂停/继续所有正在运行的窗口会话。暂停请求在步骤边界、队列错峰、任务后间隔、步骤前后等待、`delay` 和重试等待点生效；暂停期间不截图、不 OCR、不投递 hwnd 输入，并且等待剩余时间会冻结。已经进入 Rust 后端执行的单步不能被前端暂停中断，会先返回并在下一处暂停门闸停住。paused session 仍占用同 hwnd 互斥锁；继续后从同一窗口队列和同一运行会话恢复，停止请求优先级高于暂停，可打断暂停等待。
- `retry_until` 只对图片、ROI 或坐标目标做等待循环；纯状态目标阻止后台运行。
- 使用 `pc` 指令指针执行，而不是 `for...of`。
- 设置全局 `MAX_CONTROL_FLOW_STEPS`，并用后向跳转、任务跳回当前任务，以及跨任务环内每条参与循环的 `task_jump` 的 `maxIterations` 防止无限循环。
- `condition` 根据结构化 guard 和上一步/会话状态决定 true/false 目标。
- 普通成功步骤可用 `targetStepId` 跳到同一 workflow 内已启用步骤；后向跳转必须有次数上限。
- `loop` 是一等有限循环步骤，只在当前 workflow 内跳到更早的 `targetStepId`，必须设置 `maxIterations`；执行时返回 no-input 结果，不投递后台鼠标键盘消息，达到上限后顺序进入下一步。
- `onFail=restore` 可在可恢复失败后跳到同任务 `recoveryStepId`；默认恢复片段模板会展开为普通可执行步骤，并在正常成功路径跳过；恢复分支遇到计划态 `restore` 边界或执行到末尾后按 `recoveryAction` 处理：默认 `stop` 会停止当前窗口队列并在失败报告中保留原失败点，`retry` 会在 `maxIterations` 上限内回到原失败步骤，`continue` 会回到原失败步骤后的正常路径。
- `task_jump` / `jumpWorkflowId` 可在当前 hwnd 会话内插入目标 workflow；插入项只进入本次 `RunSession.queuePlan`，不改写持久化窗口队列，并受 `MAX_WORKFLOW_JUMPS` 与可选 `maxIterations` 保护；一旦多个任务互跳形成环，环内没有上限的跳转会被后台 readiness 阻止。
- 每次控制流决策会写入 `runHistory[].controlFlowTransitions[]`，记录 taken/skipped/fallthrough、guard 结果、目标步骤、后向跳转次数和跳过原因。
- 每次暂停/继续会写入 `runHistory[].queueEvents[]` 的 `pause/resume` 事件，并汇总 `pauseCount` 与 `pausedDurationMs`，用于证明任务中断、暂停/继续和长时间等待期间没有额外输入。
- 每次会话启动、任务开始/结束、步骤开始/结束、控制流、任务跳转、暂停/继续、停止请求和最终结束都会追加到 `runHistory[].runEvents[]`，作为复制报告时可按顺序审计的统一证据链；它不替代 `queueEvents/controlFlowTransitions/stepResults`，只补足跨表排序和验收叙事。

未落地的 v9 边界：

- 默认恢复片段模板已覆盖 `ESC`、等待、页面确认和截图记录；计划态 `restore` 步骤自身仍不发送后台输入，真实返航还需要素材采样、页面确认和 live 验收。
- 恢复后 `retry/continue` 已有前端 runner 语义和静态门禁，但仍需要真实窗口素材、恢复片段样例和 live 验收来证明能稳定回到主界面。

## 双击方案

`double_click` 已按 v6 原子输入动作进入 Rust；后续只在真实游戏验收后微调消息兼容模式：

- 坐标/ROI 双击复用 `click` 的 hwnd、客户区坐标、鼠标键和权限校验。
- 图片双击复用 `image_click` 的严格截图路径，匹配后、投递前再次校验 `expectedWindow`。
- 后端只通过 hwnd `PostMessageW` 投递消息；不新增真实鼠标 API。
- 测试覆盖按钮解析、双击消息序列、非法坐标、权限不足和窗口身份漂移。

## UI 工作台

目标界面应是任务编排工作台，而不是配置表单：

- 左侧：窗口列表和窗口队列，显示 hwnd、标题、PID、权限、队列数量和运行状态。
- 中部：任务库和步骤时间线，支持新增、复制、排序、禁用、校验和演练。
- 右侧：步骤参数、素材/目标库、预览验证和失败报告；运行区应能直接定位失败步骤，展开诊断证据，并复制报告 JSON。
- 顶部：后台就绪状态，按任务和步骤提示缺图片、缺坐标、缺 OCR 文本、缺窗口、权限不足、计划态步骤和可执行提醒。
- 就绪提示必须保留结构化分类，不允许只靠文案正则决定 UI 聚焦和统计；后续改中文提示时，`category` 仍应稳定驱动“下一步动作”和审计门。
- 常用动作少步骤完成：粘贴图片、采点、绑定目标、quick-step 插入步骤/片段、分配窗口、观察运行、后台运行。快捷动作只能复用已有步骤模型和片段模型，不允许绕过 normalize、目标库占位、readiness 或 `Step.params` 投影。

## 多窗口安全

- 每个 hwnd 同时只能有一个 active session。
- 每步执行前后端都必须比对启动时 `windowIdentity`。
- 标题必须匹配目标游戏窗口，当前只允许标题包含 `梦幻西游：时空` 的目标。
- 权限不足时必须失败并提示管理员提升路径，不允许静默降级。
- 队列复制只复制任务顺序和队列参数，不复制目标窗口身份。
- 运行结束必须记录最终窗口身份，便于排查 hwnd 复用、窗口关闭和权限变化。

## 素材策略

- `targets[]` 是长期共享素材库；步骤只引用 `targetId`。
- `Ctrl+V` 导入图片时，如果当前步骤支持图片目标就绑定当前步骤，否则在下方插入可执行图像步骤。
- 目标应支持 ROI、默认点击点、offset、阈值、OCR 文本和备注。
- 目标库应能独立导出/导入：`mhxy-target-library` JSON 包只携带 `targets[]`，导入时新增不存在的目标，并只补齐已有目标的缺失字段，不覆盖用户手工采样。
- 内置素材模板只能补齐空目标，不覆盖用户采样。
- 后续文件化模板需要 manifest：目标 id、来源、分辨率、适用窗口尺寸、阈值、版本、冲突策略。

## 验收门禁

每个稳定切片至少运行：

```powershell
node --check src\main.js
npm run test:step-params
npm run test:workspace-migration
npm run test:control-flow
npm run test:target-library
npm run audit:step-params
npm run audit:quick-steps
npm run audit:workspace-migration
npm run audit:input-safety
npm run audit:control-flow-schema
npm run audit:workflow-readiness
npm run audit:readiness-taxonomy
npm run audit:queue-readiness
npm run build
cd src-tauri
cargo fmt --check
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
```

涉及 Tauri 打包、权限、真实输入或资源绑定时，还要运行必要的 `npm run tauri:build` 和 live 验收。

真实游戏窗口验收应记录：

- 枚举到的窗口数量、标题、hwnd、PID、权限状态。
- 每个窗口的队列计划和运行报告。
- 是否因权限不足跳过或失败。
- 是否验证后台输入不抢焦点、不移动真实鼠标。
- 失败场景：缺图片、OCR 不匹配、窗口丢失、权限不足、任务中断、暂停/继续。

## 实施顺序

1. 继续修 v9 安全和 readiness，确保不会把计划态或失败态当成功。
2. 用管理员环境补 `double_click` 真实游戏窗口验收，确认游戏对后台双击消息的响应。
3. 继续完善 schema v9 控制流的 UI 演练证据，尤其是有限 loop、任务跳转和恢复后策略的报告证据。
4. 继续完善前端 runner，把恢复后策略扩展到更细的“重试前重采样/继续后队列策略”。
5. 扩展可执行恢复片段模板的场景覆盖，并补失败分析导出、截图证据和真实恢复验收。
6. 将 runner 逐步迁到 Rust 事件流，前端只订阅状态和渲染报告。

## 回滚策略

- 每个切片保持单独 commit。
- 新 schema 发布前保留旧 workspace 导入兼容。
- 控制流功能未通过门禁时不暴露为可后台运行；最多显示为计划态提醒。
- 真实输入测试只在用户确认的安全窗口和管理员环境中运行。
