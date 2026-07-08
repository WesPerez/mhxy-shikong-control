# 时空任务编排器

`MHXY-ShiKong-Control` 是放在 `E:\Project\Common` 下的独立 Tauri/Rust 项目。当前阶段已经从 Maa 迁移接管台转成面向“梦幻西游：时空”多窗口宏流程的本地任务编排器。

历史保留已经推到 GitHub：

- `dec5823`：保留前 20 多小时形成的旧接管台代码。
- `676884a`：新增图标、托盘、关闭隐藏、单实例唤醒。
- `44ce5cd`：把界面改成通用任务编排器。
- `e18c3fa`：移除前台置顶入口，收紧输入安全。
- `95d815c`：删除旧 Maa 迁移、验收、OCR/runtime 死代码。

## 当前能力

- 应用标题和托盘提示为“时空任务编排器”。
- Windows bundle 图标、任务栏图标、标题栏图标、托盘图标已配置。
- 点窗口关闭按钮默认隐藏到托盘，不退出进程。
- 托盘右键菜单提供“显示主窗口”和“退出”，其中“退出”才是真退出。
- 多次启动同一个 exe 会唤醒已运行实例，不会保留多个主进程。
- 界面包含目标窗口列表、窗口任务队列、任务库、步骤时间线、步骤属性、识别目标、预览/ROI、运行队列和运行记录。
- 工作区保存到 Tauri AppData 下的 `workspace.json`，包含 workflows、assignments、targets、runHistory；旧 assets 会在载入时迁移为 targets。
- 首次启动会生成 5 个示例任务，每个 10 步以上，覆盖 hotkey、图像等待、图像点击、OCR 确认、后台点击、延迟、条件、重试、截图记录、恢复状态。
- 已支持把当前任务追加到多个窗口的独立队列，并对已选窗口按各自队列执行观察运行。
- 观察运行只模拟每个 hwnd 的任务会话、互斥锁、步骤进度和日志，不向游戏窗口发送输入。
- 新增后台运行 beta：`hotkey`、`click`、`image_click` 可以通过目标 hwnd 投递后台消息。
- 步骤编辑器新增常用参数控件，可把热键、点击坐标/按钮、图像阈值、延迟、条件和重试间隔同步到兼容的 `target/command` 字段。
- 识别目标已升级为 `targets[]` 目标库，步骤通过 `targetId` 复用目标，并保留旧 `assetId` 导入兼容。
- 后台执行会随每步传入启动时窗口身份快照，并在 Rust 端重新校验 title、pid、process、client size 和权限状态，发现漂移会安全失败。
- `image_click` 支持用 Ctrl+V 图片或 ROI 裁剪图做轻量模板匹配，匹配后按目标默认点击点点击；ROI 也可以绑定到后台点击步骤并使用 ROI 中心。
- OCR 目前仍是模型占位，运行时会明确返回未实现，不会伪装成可识别。

## 任务模型

当前方向见 [docs/workflow-model.md](docs/workflow-model.md)。

核心原则：

- 任务是可版本化的工作流定义，不是一串写死的截图点击。
- 工作区把 `Workflow`、`Step`、`Target`、`WindowAssignment`、`RunSession` 分开。
- 步骤要有目标、动作参数、成功确认、超时、重试、失败策略和成功流转。
- 图片、OCR、颜色、按钮、页面等识别目标应抽成共享目标库。
- 同一个 hwnd 只能有一个运行会话并串行消费自己的任务队列；不同 hwnd 可以独立并行。
- 恢复到初始界面应成为通用能力，而不是每个任务各写一遍。

## 输入安全

默认运行路径必须避免影响用户正在操作的鼠标和键盘：

- 禁止 `SendInput`、`SetCursorPos`、`mouse_event`、`keybd_event` 这类真实输入注入。
- 任务执行不调用 `SetForegroundWindow` 或 `BringWindowToTop`。
- 当前观察运行不发送任何游戏输入。
- 后台运行 beta 仅使用目标 hwnd 的 `PostMessageW` 消息路径投递点击和快捷键。
- 需要管理员权限时由应用提示并通过 UAC 重启，不通过鼠标键盘绕过。

可运行审计：

```powershell
python scripts\audit_input_safety.py --json
```

## 开发命令

```powershell
cd E:\Project\Common\MHXY-ShiKong-Control
npm install
npm run build
cd src-tauri
cargo check
cargo test
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

1. 扩展 `targets` 识别目标库，补重命名、删除、分类、使用位置、文件化模板和 OCR 文本目标。
2. 补共享 `restore` 恢复流程。
3. 继续完善后台 hwnd 输入执行器：增加 Rust 后端 runner、事件流、停止/失败恢复和真实游戏反馈验证。
4. 接入 OCR 实测，每补一个真实任务都保留观察运行、运行报告和输入安全审计。
