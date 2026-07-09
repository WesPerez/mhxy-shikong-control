# 时空任务编排器产品方案

本文是第二阶段编码前门禁。新增能力进入实现前，必须先补齐本文件对应的小节：目标、非目标、数据结构、运行语义、风险边界、验收证据和回滚策略。当前源码以 `docs/workflow-model.md` 描述的 schema v7 为准，前端 runner 已切到带预算的指令指针模型。

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
- 不在控制流未设计完整前只把 `loop`、`task_jump`、`branch` 加进下拉框。

## 当前基线

- 已有实体：`Workflow`、`Step`、`Target`、`WindowAssignment`、`RunSession`、`runHistory`。
- 已有运行：观察运行、后台运行 beta、每 hwnd 互斥、不同 hwnd 并行、队列错峰和任务后间隔。
- 已有后台动作：`hotkey`、`text_input`、`click`、`double_click`、`image_click`、`wait_image`、`detect_page`、`ocr_assert`、`snapshot`、`delay`、`retry_until` 的视觉目标等待。
- 已知缺口：专用 `loop`、跨任务 `task_jump`、显式恢复流程、后端事件流和管理员环境下的双击 live 验收尚未完成。
- 当前安全语义：`unsupported` 和 `error` 强制停止；识图/OCR/缺素材类失败在重试耗尽后默认停止，只有 `onFail=skip` 才继续。
- 当前 readiness 会校验 v7 同任务跳转引用，后向跳转必须有 `maxIterations`；`restore`、`jumpWorkflowId` 和 `onFail=restore` 仍标记为计划态/恢复计划，避免误报成完整恢复或跨任务跳转。

## 数据方案

schema v7 继续使用结构化 JSON + 原子写入：

- `workflows[]`: 任务定义，步骤仍保留兼容字段 `target/command/expect`，并保存 `targetStepId/elseTargetStepId/recoveryStepId/jumpWorkflowId/maxIterations` 这些控制流字段。
- `targets[]`: 共享目标库，保存图片 data URL、ROI、阈值、点击默认值、OCR 文本和备注。
- `assignments[]`: 窗口队列，保存 hwnd 与 `windowIdentity` 快照，以及队列项顺序、启用状态和等待参数。
- `runHistory[]`: 运行报告，保存队列计划、步骤结果、失败原因、开始/结束窗口身份。

当前 v7 边界：

- `normalizeStep` 保留新字段，并从旧 `command` 中尽量回填兼容参数。
- 复制任务时重映射同任务内 step id 引用，避免跳到原任务步骤。
- 单步复制会清空控制流引用，避免插入步骤带着旧上下文跳转。
- 导入和后台 readiness 会校验跳转目标存在、未停用、非自环；同任务 `targetStepId/elseTargetStepId` 会被指令指针 runner 执行，后向跳转必须设置 `maxIterations`。
- 保存仍使用临时文件 + rename；损坏 JSON 应保留错误提示，不自动覆盖用户数据。

## 运行器方案

已落地的 v7 子集：

- `delay`、pre/post delay、队列等待都必须可取消。
- `retry_until` 只对图片、ROI 或坐标目标做等待循环；纯状态目标阻止后台运行。
- 使用 `pc` 指令指针执行，而不是 `for...of`。
- 设置全局 `MAX_CONTROL_FLOW_STEPS` 和每个 loop 的 `maxIterations`，防止无限循环。
- `condition` 根据结构化 guard 和上一步/会话状态决定 true/false 目标。
- 普通成功步骤可用 `targetStepId` 跳到同一 workflow 内已启用步骤；后向跳转必须有次数上限。

未落地的 v7 边界：

- 每次 transition 还未写入 `runHistory` 独立事件，只进入会话日志和步骤结果。
- 专用 `loop` 步骤尚未进入下拉框；当前用同任务后向跳转和 `maxIterations` 表达有限循环。
- `task_jump` 只能保存 `jumpWorkflowId`，尚未接入队列调度。
- `restore` 应是普通可执行恢复步骤或恢复流程，不应再由 `onFail=restore` 隐式承诺。

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
- 右侧：步骤参数、素材/目标库、预览验证和失败报告。
- 顶部：后台就绪状态，按任务和步骤提示缺图片、缺坐标、缺 OCR 文本、缺窗口、权限不足、计划态步骤和可执行提醒。
- 常用动作少步骤完成：粘贴图片、采点、绑定目标、添加步骤、分配窗口、观察运行、后台运行。

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
- 内置素材模板只能补齐空目标，不覆盖用户采样。
- 后续文件化模板需要 manifest：目标 id、来源、分辨率、适用窗口尺寸、阈值、版本、冲突策略。

## 验收门禁

每个稳定切片至少运行：

```powershell
node --check src\main.js
npm run audit:input-safety
npm run audit:workflow-readiness
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

1. 继续修 v7 安全和 readiness，确保不会把计划态或失败态当成功。
2. 用管理员环境补 `double_click` 真实游戏窗口验收，确认游戏对后台双击消息的响应。
3. 扩展 schema v7 控制流：补 runHistory transition、专用 loop 和跨任务 task_jump。
4. 继续完善前端 runner，逐步把恢复流程和任务跳转纳入队列调度。
5. 实现显式 `restore` 恢复流程和失败恢复报告。
6. 将 runner 逐步迁到 Rust 事件流，前端只订阅状态和渲染报告。

## 回滚策略

- 每个切片保持单独 commit。
- 新 schema 发布前保留旧 workspace 导入兼容。
- 控制流功能未通过门禁时不暴露为可后台运行；最多显示为计划态提醒。
- 真实输入测试只在用户确认的安全窗口和管理员环境中运行。
