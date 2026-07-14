<!-- generated-by: scripts/execution_progress.py; do-not-edit-manually -->
<!-- state-digest: sha256:4a82fc4cd0221aee7eabe5bfbd3a47f1a615b5d55d9278c3c5d4472ff63cb81f -->
<!-- checkpoint-id: CP-0057 -->
# 长任务执行状态

> 本页由 `scripts/execution_progress.py` 从 `state.json`、事件账本和证据账本生成。
> 线程聊天不是恢复权威；冲突时以当前源码、Git、测试和实际运行结果为准。

## 恢复首屏

- 恢复结论：**STOP：存在未决副作用，只允许只读对账**
- 更新时间（UTC）：`2026-07-14T13:16:39Z`
- 更新时间（北京时间）：`2026-07-14T21:16:39+08:00`
- 长期任务：`MHXY-AUTOMATION-WORKBENCH`
- 运行：`RUN-20260710-CONTINUITY-BASELINE` / attempt `9`
- 总体状态：`active`
- 当前阶段：`P4`
- 当前切片：`P4-S5` - Home-vitality bounded live queue under elevated controller
- 阶段状态：`in_progress`；切片状态：`in_progress`；动作状态：`running`
- 当前切片验收：已满足 `0`，待验证或阻塞 `2`，合计 `2`
- 本轮是否发送真实游戏输入：`false`
- 当前工作：未决动作 `ACT-P4S5-COMMIT-LIVEFIX-001` 处于 `running`，等待只读对账
- 最新当前有效证据：最近事件：登记副作用动作 ACT-P4S5-COMMIT-LIVEFIX-001（EVT-0802；不是当前验收通过证据）
- 唯一下一动作：对账未决副作用动作 ACT-P4S5-COMMIT-LIVEFIX-001；结果明确前禁止重放
- 当前切片执行 blocker：none
- 全局恢复/验收风险：Game HWND exists (PID 86812 / HWND 26157554) but controller privilege is insufficient for gated input.
- 最新 checkpoint：`CP-0057`；safeToResume=`true`；safeToRunLiveInput=`true`
- 当前允许：只读审计、连续性元数据对账。
- 当前禁止：归属不明对象的清理或停止、未登记 intent 的副作用动作、重放未决动作。
- 运行观察（STATUS 生成时）：**新鲜**；observedAt=`2026-07-14T13:13:06Z`；年龄=`213s`；TTL=`300s`；expiresAt=`2026-07-14T13:18:06Z`。执行窗口/进程动作前以 `execution:resume-check` 的动态结果为准。

## 验收轴

| 验收轴 | 状态 | 依据/限制 |
|---|---|---|
| 代码表面能力 | `部分` | 源码已有 15 类步骤、任务/目标/队列/readiness/失败报告等表面能力，但大型文件耦合且真实闭环不足。 |
| 自动测试 | `已过期` | core rebind 8ac6d74；当前没有绑定现有 HEAD/工作树指纹的有效通过证据 |
| 当前提交构建 | `已过期` | vite rebind 8ac6d74；当前没有绑定现有 HEAD/工作树指纹的有效通过证据 |
| 当前提交应用已启动 | `已过期` | app rebind 8ac6d74；当前没有绑定现有 HEAD/工作树指纹的有效通过证据 |
| 后台 HWND 输入已实际发送 | `未验证` | 当前 HEAD 没有应用 UI 到指定 hwnd 的真实输入通过证据。 |
| 游戏后置状态已观察 | `未验证` | 没有绑定当前 HEAD、exe、workspace 和窗口身份的游戏后置状态证据。 |
| 前台鼠标键盘未受影响 | `部分` | 静态安全审计只允许 PostMessageW 路径，但尚缺当前版本实测前后台 HWND、鼠标位置和用户并行操作证据。 |
| 双窗口隔离 | `未验证` | 两个游戏进程存在，但当前 HEAD 尚未完成双窗口不同队列并行隔离验收。 |
| 重启持久化 | `未验证` | EVD-0029 和 EVD-0030 已证明 workspace.json 与旧 workspace.json.bak 分别完成不可覆盖备份且源/目标 SHA-256 一致；真实 AppData 迁移、应用重启回读和第二次重启幂等仍未验证。 |

## 阶段表

| 阶段 | 状态 | 验收摘要 |
|---|---|---|
| `P0` 数据保护与可重复基线 | `verified` | 保护真实 v6 工作区、建立匿名迁移 fixture 和可重复验证基线。 |
| `P1` 运行安全硬化 | `verified` | 消除窗口身份、权限、误跑和输入安全 P0/P1 风险。 |
| `P2` 工作台可达性与单步调试 | `verified` | 重构默认窗口下的操作路径，建立每个功能即时可见、可测的工作台。 |
| `P3` 严格捕获和视觉引擎 | `verified` | 修复捕获、ROI、模板、OCR 和预览一致性。 |
| `P4` 第一个真实纵向任务 | `in_progress` | 以家园活力完成 UI 到游戏后置验证的真实闭环。 |
| `P5` 持久化和素材文件化 | `pending` | 按方案评估 SQLite/结构化 JSON，补版本迁移、原子写入和备份。 |
| `P6` 第二至第五个真实任务 | `pending` | 逐个纵向闭环更多真实任务，不用草稿数量代替可用性。 |
| `P7` 双窗口并行和队列控制 | `pending` | 验证同窗口串行、跨窗口并行、暂停继续和隔离。 |
| `P8` 回归任务与发布门 | `pending` | 扩展到 5-10 个可重复回归任务并完成失败矩阵。 |
| `P9` 源码清理、稳定提交和发布 | `pending` | 在调用链和完整验证后清理、提交、推送和发布稳定版本。 |

## 当前切片

### 范围

- src/main.js
- src/home-vitality-core.js
- docs/execution

### 非目标

- Do not stop user game process
- Do not expand beyond home-vitality first vertical task

### 安全边界

- Live input only via controller PostMessage path after manual confirmation
- Game process is user_preexisting; cleanupAllowed=false

### 验收条件

| ID | 条件 | 状态 | 允许证据类别 | 证据 |
|---|---|---|---|---|
| `P4-S5-C1` | bounded home-vitality input path executes with inputSent evidence only after manual confirmation and elevated window gates | `pending` | `live_input` | none |
| `P4-S5-C2` | game postcondition observed for vitality change without claiming broader multi-task completion | `pending` | `live_outcome` | none |

## 当前动作

- actionId：`ACT-P4S5-COMMIT-LIVEFIX-001`
- 类型：`git_commit`
- 目标：`main`
- 副作用级别：`git_commit`
- 状态：`running`

## 下一步

- 唯一下一动作：对账未决副作用动作 ACT-P4S5-COMMIT-LIVEFIX-001；结果明确前禁止重放
- 命令：`npm run execution:resume-check`

## 阻塞与风险

### 阻塞

- Game HWND exists (PID 86812 / HWND 26157554) but controller privilege is insufficient for gated input.

### 禁止盲目执行

- Do not stop MyGame_x64r without user request.

## Git 现场

- 分支：`main`
- observed HEAD：`8ac6d74706bba2aee078c642e12ed7c9566483e4`
- verified HEAD：`8ac6d74706bba2aee078c642e12ed7c9566483e4`
- origin/main：`3eef34f8c4b115c94e2c3cd6adb93cf329a60ef9`
- working tree fingerprint：`sha256:21dff1064a5accf304102be771e30d38864d898833919ff2de9ea4d6b4a72799`
- 最新 checkpoint：`CP-0057` (state_snapshot)
- checkpoint safeToResume：`true`
- checkpoint safeToRunLiveInput：`true`

### 当前非 ignored 改动

- `docs/execution/STATUS.md`
- `docs/execution/checkpoints/CP-0057-p4-s5-pre-live-home-vitality-8ac6d74.json`
- `docs/execution/events.jsonl`
- `docs/execution/evidence.jsonl`
- `docs/execution/state.json`
- `scripts/verify_bounded_live_input.py`
- `src-tauri/src/bin/bounded_live_step.rs`

## 运行进程与产物

### 本轮管理的进程

- PID `61780`：controller-app；cleanupAllowed=`true`
- PID `55040`：controller-app；cleanupAllowed=`true`
- PID `8604`：controller-app；cleanupAllowed=`true`

### 只观察到的外部进程

- PID `42432`：`mhxy-shikong-control.exe`，旧控制器历史线索；present=`false`，归属=`preexisting`，cleanupAllowed=`false`
- PID `26056`：`MyGame_x64r.exe`，历史游戏窗口线索 A；present=`false`，归属=`user_preexisting`，cleanupAllowed=`false`
- PID `52448`：`MyGame_x64r.exe`，历史游戏窗口线索 B；present=`false`，归属=`user_preexisting`，cleanupAllowed=`false`
- PID `12744`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`task-owned`，cleanupAllowed=`false`
- PID `16244`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `18332`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `50936`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `80388`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `2960`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `73840`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `1832`：`MyGame_x64r.exe`，game-client；present=`false`，归属=`user_preexisting`，cleanupAllowed=`false`
- PID `61780`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `68420`：`MyGame_x64r.exe`，game-client；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `86812`：`MyGame_x64r.exe`，game-client；present=`true`，归属=`user_preexisting`，cleanupAllowed=`false`
- PID `71740`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`task_owned`，cleanupAllowed=`false`
- PID `16824`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `56384`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `30892`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `55040`：`mhxy-shikong-control.exe`，controller-app；present=`true`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `8604`：`mhxy-shikong-control.exe`，controller-app；present=`true`，归属=`created_by_current_run`，cleanupAllowed=`false`

### 本轮管理的产物

- `AGENTS.md`
- `docs/execution/`
- `scripts/execution_progress.py`
- `scripts/audit_execution_state.py`

### 观察到但未接管的产物

- `assets/resource/ShiKong/reports/`
- `src-tauri/target*/`
- `.codex-window-*.png`

## 最近证据

| ID | 类型 | 原始结果 | 当前适用性 | 结论/原因 |
|---|---|---|---|---|
| `EVD-0369` | `window_identity` | `passed` | `stale` | Verified live window identity for game-client (read-only, no input)<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0370` | `live_preflight` | `passed` | `stale` | Strict target capture completed bounded zero-input wait_image preflight<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0371` | `test` | `passed` | `stale` | P4-S5-rebind-core-8ac6d74<br>证据工作树指纹与当前现场不同 |
| `EVD-0372` | `build` | `passed` | `stale` | P4-S5-rebind-vite-8ac6d74<br>证据工作树指纹与当前现场不同 |
| `EVD-0373` | `app_runtime` | `passed` | `stale` | Current-commit controller app launched and observed as created_by_current_run process<br>证据工作树指纹与当前现场不同 |
| `EVD-0374` | `app_runtime` | `passed` | `stale` | Current-commit controller app launched and observed as created_by_current_run process<br>证据工作树指纹与当前现场不同 |
| `EVD-0375` | `window_identity` | `passed` | `stale` | Verified live window identity for game-client (read-only, no input)<br>证据工作树指纹与当前现场不同 |
| `EVD-0376` | `live_preflight` | `passed` | `stale` | Strict target capture completed bounded zero-input wait_image preflight<br>证据工作树指纹与当前现场不同 |

## 最近事件

| seq | 时间 | 类型 | 摘要 |
|---:|---|---|---|
| 793 | `2026-07-14T13:11:25Z` | `action_intent` | 登记副作用动作 ACT-P4S5-APP-006 |
| 794 | `2026-07-14T13:11:31Z` | `runtime_observation` | Current-commit controller app launched and observed as created_by_current_run process |
| 795 | `2026-07-14T13:11:32Z` | `action_result` | 副作用动作 ACT-P4S5-APP-006 -> succeeded |
| 796 | `2026-07-14T13:11:34Z` | `slice_state_changed` | 更新验收轴 currentCommitAppLaunched -> passed |
| 797 | `2026-07-14T13:12:27Z` | `runtime_observation` | Verified live window identity for game-client (read-only, no input) |
| 798 | `2026-07-14T13:13:06Z` | `runtime_observation` | Strict target capture completed bounded zero-input wait_image preflight |
| 799 | `2026-07-14T13:13:08Z` | `checkpoint` | 创建 CP-0057：Ready for bounded live on 8ac6d74 |
| 800 | `2026-07-14T13:13:09Z` | `action_intent` | 登记副作用动作 ACT-P4S5-LIVE-HOTKEY-002 |
| 801 | `2026-07-14T13:13:13Z` | `action_result` | 副作用动作 ACT-P4S5-LIVE-HOTKEY-002 -> failed |
| 802 | `2026-07-14T13:16:39Z` | `action_intent` | 登记副作用动作 ACT-P4S5-COMMIT-LIVEFIX-001 |

## 异常恢复

1. 阅读 `AGENTS.md`、本页和 `docs/execution/PROTOCOL.md`。
2. 运行 `npm run execution:resume-check`；退出码非 0 时不要执行任何副作用动作。
3. 再运行 `npm run audit:execution-state` 和 `git status --short --ignored`，比较 observed/verified/upstream HEAD 和 dirty 文件。
4. 重新核验 AppData、应用版本、进程、窗口身份和证据文件；过期 PID 只能作为线索。
5. 若存在 `running` 或 `unknown_after_interruption` 动作，先 reconciliation，禁止直接重试。
6. 追加 `reconciliation` 事件后，从“唯一下一动作”继续。

详细规则见 [PROTOCOL.md](PROTOCOL.md)，长期产品方案见 [project-audit-and-master-plan.md](../project-audit-and-master-plan.md)。
