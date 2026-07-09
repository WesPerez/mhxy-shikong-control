# 时空任务编排器

`MHXY-ShiKong-Control` 是放在 `E:\Project\Common` 下的独立 Tauri/Rust 项目。当前阶段已经从 Maa 迁移接管台转成面向“梦幻西游：时空”多窗口宏流程的本地任务编排器。

历史保留已经推到 GitHub：

- `dec5823`：保留前 20 多小时形成的旧接管台代码。
- `676884a`：新增图标、托盘、关闭隐藏、单实例唤醒。
- `44ce5cd`：把界面改成通用任务编排器。
- `e18c3fa`：移除前台置顶入口，收紧输入安全。
- `95d815c`：删除旧 Maa 迁移、验收、OCR/runtime 死代码。
- `bcd62c4`：移除未实现的全局串行策略入口，窗口策略只保留当前真实支持的 per-window-exclusive。

## 当前能力

- 应用标题和托盘提示为“时空任务编排器”。
- Windows bundle 图标、任务栏图标、标题栏图标、托盘图标已配置。
- 点窗口关闭按钮默认隐藏到托盘，不退出进程。
- 托盘右键菜单提供“显示主窗口”和“退出”，其中“退出”才是真退出。
- 多次启动同一个 exe 会唤醒已运行实例，不会保留多个主进程。
- 界面包含目标窗口列表、窗口任务队列、任务库、步骤时间线、步骤属性、识别目标、预览/ROI、运行队列和运行记录。
- 工作区保存到 Tauri AppData 下的 `workspace.json`，包含 workflows、assignments、targets、runHistory；保存使用临时文件替换并保留 `workspace.json.bak`，旧 assets 会在载入时迁移为 targets。
- 首次启动会生成 10 个示例任务，每个 10 步以上，覆盖 hotkey、图像等待、图像点击、OCR 确认、后台点击、后台文本输入、延迟、条件、重试、截图记录和失败恢复片段；旧工作区可用“导入示例包”补齐缺失示例，不覆盖已有任务。
- 任务库支持按蓝图批量新建任务，内置家园活力、福利签到、背包物品、组队准备、帮派签到、邮件领取、宠物照料、摊位搜索、任务链检查和材料整理 10 个 10 步以上草稿；生成后会自动创建目标占位，并定位到下一处待采样图像步骤。
- 任务库提供“演练套件”入口，可一次生成 10 个 10 步以上任务，并按已选窗口写入不同长度的独立队列，方便验证多窗口分别跑 `2/5/7/3/9/4/6/8/1/10` 个任务的场景。
- 顶部“准备演练”会刷新窗口、选择全部游戏窗口、补足演练任务、为没有队列的窗口写入不同长度队列、接入内置模板并保存工作区；它不会清空或覆盖已有窗口队列。
- 已支持把当前任务或批量选择的任务追加到多个窗口的独立队列，并对已选窗口按各自队列执行观察运行。
- 批量追加队列支持窗口错峰和任务间隔；每个队列项也能单独改启动前等待和任务后等待，配置只属于该窗口队列。
- 窗口任务队列支持复制当前窗口队列到其它已选窗口、确认后清空已选窗口队列；这些操作只修改本地 workspace 队列配置，不向游戏窗口发送输入。
- 观察运行只模拟每个 hwnd 的任务会话、互斥锁、步骤进度和日志，不向游戏窗口发送输入。
- 新增后台运行 beta：`hotkey`、`text_input`、`click`、`double_click`、`image_click` 可以通过目标 hwnd 投递后台消息。
- 步骤时间线支持添加、插入到当前步骤下方、复制步骤、上移/下移和删除；复制步骤会生成新的步骤 id。
- 步骤时间线新增 quick-step 快捷动作区，覆盖快捷键、坐标点击、识图点击链、OCR 判断、文本输入、右键物品、条件检查、失败恢复和 10 步任务骨架；插入后会沿用现有目标库占位、`Step.params` 同步和待采样图像步骤定位。
- 步骤时间线支持一键插入常用片段，包括打开界面、识图点击、文本输入、物品右键、状态检查和 10 步完整任务骨架；插入时会同步创建可复用逻辑目标。
- 步骤编辑器新增常用参数控件，可把热键、后台文本、点击/双击坐标与按钮、图像阈值、图像点击点位/偏移、步骤前后等待、延迟、条件和重试间隔同步到兼容的 `target/command` 字段。
- 步骤行会显示校验问题/提醒 badge，点击校验会跳到第一个有问题的步骤。
- 识别目标已升级为 `targets[]` 目标库，步骤通过 `targetId` 复用目标，并保留旧 `assetId` 导入兼容。
- 复制任务会同步克隆该任务引用的图片、ROI、OCR 和点击目标，保证副本与原任务可以独立改素材、阈值和默认点击点。
- 目标库支持搜索、类型筛选、重命名、类型/阈值/点击参数/OCR 文本/备注编辑、显示使用位置、绑定/解绑当前步骤，并且只允许删除 0 处使用的目标。
- 目标库可单独导出为 `mhxy-target-library` JSON 包，也可从完整工作区 JSON 或目标库包中合并导入；导入只补缺失字段或新增目标，不覆盖用户已有采样。
- 目标库会把蓝图/示例任务中的常见逻辑目标自动接入 `assets/resource/ShiKong/template_mapping.json` 里的内置模板；也可手动点击“接入内置素材”补齐空目标，不覆盖用户自己 Ctrl+V 或 ROI 绑定的素材。
- 后台执行启动前会用 Rust 重新读取 hwnd 身份；每个后台步骤执行前前端都会再做一次只读身份复核，输入/OCR/截图步骤还会传入启动时窗口身份快照给 Rust 端二次校验。发现 title、pid、process、client size 或权限状态漂移会安全失败。
- `image_click` 和 `double_click` 支持用 Ctrl+V 图片或 ROI 裁剪图做轻量模板匹配，匹配后按目标默认点击点点击或双击；点位支持模板中心和四角，并可用 `offsetX/offsetY` 微调。ROI 也可以绑定到后台点击/双击步骤并使用 ROI 中心。
- Ctrl+V 图片或 ROI 生成目标时，如果当前步骤不适合绑定图片，会自动在当前步骤下方新建可执行步骤，避免误改延迟/热键等步骤语义；如果 WebView 粘贴事件没有带图片文件，会尝试从 Windows 剪贴板 DIB/DIBV5 后端读取截图。
- 后台 `delay`、步骤前/后等待、队列错峰和任务间隔都使用真实等待时长，等待期间可响应停止请求；`retry_until` 对绑定图片、ROI 或坐标目标执行轻量等待循环，不发送额外输入，纯状态型目标会在后台校验中阻止执行，避免把未实现的状态判断当成功。
- 运行中的窗口队列支持暂停/继续；暂停只改变当前 `RunSession`，在步骤边界和等待点生效，不改任务/队列配置，也不会额外截图、OCR 或发送 hwnd 输入；已经进入后端执行的单步会先返回，再停在下一处暂停门闸。
- 工作区 schema v9 已保存 `targetStepId`、`elseTargetStepId`、`recoveryStepId`、`jumpWorkflowId`、`maxIterations`、`recoveryAction` 和 v8 引入的 `steps[].params` 前端结构化参数镜像；复制任务会重映射同任务步骤引用，单步复制会清空控制流引用。`params` 会继续投影回 `target/command/expect`，当前 Rust IPC 仍读取旧字段。
- 工作区载入和 JSON 导入会显示迁移审计摘要，包含 schema v9 规范化、旧 assets 迁移、运行记录裁剪、失效窗口队列过滤和最近备份路径，便于确认旧工作区升级后到底改了什么。
- 前端运行器已改为带 `MAX_CONTROL_FLOW_STEPS` 预算的指令指针模型：`condition` 会按 guard 选择 true/false 目标，普通成功步骤可用 `targetStepId` 跳到同任务步骤；一等 `loop` 步骤可做当前任务内的有限后向循环，必须设置循环目标和 `maxIterations`，本身不发送后台输入；跨任务环内任意未设上限的 `task_jump` 会在 readiness 中阻塞，直到该跳转补上最大循环次数。`onFail=restore` 可跳到同任务 `recoveryStepId` 执行失败恢复分支，默认恢复片段由 `ESC`、等待、页面确认和截图记录组成，且只在恢复分支执行；恢复后可按 `recoveryAction` 保守停止、在上限内重试原失败步骤，或继续原失败步骤后的正常路径；`jumpWorkflowId`/`task_jump` 会在当前 hwnd 会话内插入目标任务；计划态 restore 类型本身仍不发送后台输入。
- 运行状态 pill 和会话卡片会区分 idle/ready/running/paused/blocked/failed，界面日志保留最近 500 条，适合长时间运行时保持可用。
- 后台就绪面板的待补全项带结构化分类，不只依赖中文文案匹配；缺素材、缺坐标、缺 OCR 文本、缺目标、窗口、权限、计划态和恢复入口都会带稳定 category、聚焦控件和下一步动作。
- 待补全面板会把当前缺口转成动作坞按钮：缺图可直接从剪贴板绑定、ROI 存为目标或接入内置素材；缺坐标可开启预览采点或写入 ROI 中心；窗口、权限、OCR、目标库和演练入口也能从同一区域触达。
- 运行结束会写入 `runHistory` 报告，记录队列计划、错峰等待事件、暂停/继续事件、统一 `runEvents` 时间线、控制流 `controlFlowTransitions`、每步状态、失败点、耗时、暂停次数/时长、启动窗口身份和结束窗口身份，便于排查多窗口长时间运行。
- 运行面板会从 `runHistory` 自动提取失败/停止报告，显示失败原因、失败步骤、最近步骤轨迹、窗口身份和控制流摘要；展开详情可查看队列计划、队列事件、统一运行时间线、暂停/继续、控制流和最近步骤证据，并支持一键定位到当前任务库中的失败步骤或复制单条报告 JSON。
- `ocr_assert` 会截图、按 ROI 或命名区域裁剪后调用 Windows OCR；识别未命中或系统 OCR/语言包不可用都会明确失败，不会伪装成可识别。
- `127.0.0.1:47638` 是桌面应用单实例唤醒端口，不是前端页面。浏览器访问它会显示说明页；真实界面在标题为“时空任务编排器”的 Tauri 桌面窗口里。开发浏览器预览请启动 Vite 后访问 `http://127.0.0.1:5173/`。

## 任务模型

当前模型见 [docs/workflow-model.md](docs/workflow-model.md)，第二阶段产品方案和编码门禁见 [docs/product-plan.md](docs/product-plan.md)。

核心原则：

- 任务是可版本化的工作流定义，不是一串写死的截图点击。
- 工作区把 `Workflow`、`Step`、`Target`、`WindowAssignment`、`RunSession` 分开。
- 步骤要有目标、动作参数、成功确认、超时、重试、失败策略和成功流转。
- 图片、OCR、颜色、按钮、页面等识别目标应抽成共享目标库。
- 同一个 hwnd 只能有一个运行会话并串行消费自己的任务队列；不同 hwnd 可以独立并行。
- 恢复到初始界面应成为通用能力，而不是每个任务各写一遍；当前通过显式恢复入口和模板片段落地，不提供隐式全局返航。

## 输入安全

默认运行路径必须避免影响用户正在操作的鼠标和键盘：

- 禁止 `SendInput`、`SetCursorPos`、`mouse_event`、`keybd_event` 这类真实输入注入。
- 任务执行不调用 `SetForegroundWindow` 或 `BringWindowToTop`。
- 当前观察运行不发送任何游戏输入。
- 后台运行 beta 仅使用目标 hwnd 的 `PostMessageW` 消息路径投递快捷键、文本和点击。
- 需要管理员权限时由应用提示并通过 UAC 重启，不通过鼠标键盘绕过。

可运行审计：

```powershell
python scripts\audit_input_safety.py --json
python scripts\audit_control_flow_schema.py --json
npm run test:step-params
npm run audit:step-params
npm run audit:quick-steps
npm run audit:completion-action-dock
npm run test:control-flow
python scripts\audit_workflow_readiness.py --json
python scripts\audit_readiness_taxonomy.py --json
python scripts\audit_queue_readiness.py --json
```

## 开发命令

```powershell
cd E:\Project\Common\MHXY-ShiKong-Control
npm install
npm run build
npm run test:step-params
npm run test:control-flow
npm run test:target-library
npm run audit:step-params
npm run audit:quick-steps
npm run audit:completion-action-dock
npm run audit:input-safety
npm run audit:control-flow-schema
npm run audit:workflow-readiness
npm run audit:readiness-taxonomy
npm run audit:queue-readiness
cd src-tauri
cargo fmt --check
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
```

打包：

```powershell
cd E:\Project\Common\MHXY-ShiKong-Control
npm run tauri:build
```

release exe:

```text
src-tauri\target\release\mhxy-shikong-control.exe
```

NSIS 安装包：

```text
src-tauri\target\release\bundle\nsis\时空任务编排器_0.1.0_x64-setup.exe
```

## 目录关系

```text
E:\Project\Common
├─ Maa_MHXY_MG              # 原 Maa 项目，仅作为历史参考/迁移来源
├─ screen-watch-ocr-tauri   # OCRRUST 参考项目
└─ MHXY-ShiKong-Control     # 当前项目
```

## 后续路线

1. 按 [docs/product-plan.md](docs/product-plan.md) 的方案门禁扩展恢复片段模板覆盖面、补真实窗口 live 验收和更完整的失败分析导出。
2. 扩展 `targets` 文件化模板、批量导入导出和 OCR 文本目标实测。
3. 继续完善后台 hwnd 输入执行器：增加 Rust 后端 runner、事件流、停止/失败恢复和真实游戏反馈验证。
4. 接入 OCR 实测，每补一个真实任务都保留观察运行、运行报告和输入安全审计。
