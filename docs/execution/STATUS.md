<!-- generated-by: scripts/execution_progress.py; do-not-edit-manually -->
<!-- state-digest: sha256:7fe7941b05db7fd41fd6a81352b7dc5f5bc253eab1ce23cbb2da40c898cd7d48 -->
<!-- checkpoint-id: CP-0065 -->
# 长任务执行状态

> 本页由 `scripts/execution_progress.py` 从 `state.json`、事件账本和证据账本生成。
> 线程聊天不是恢复权威；冲突时以当前源码、Git、测试和实际运行结果为准。

## 恢复首屏

- 恢复结论：**可恢复代码工作；其它副作用仍需各自门禁**
- 更新时间（UTC）：`2026-07-14T14:25:03Z`
- 更新时间（北京时间）：`2026-07-14T22:25:03+08:00`
- 长期任务：`MHXY-AUTOMATION-WORKBENCH`
- 运行：`RUN-20260710-CONTINUITY-BASELINE` / attempt `9`
- 总体状态：`active`
- 当前阶段：`P4`
- 当前切片：`P4-S6` - Full home-vitality vertical remaining gates
- 阶段状态：`in_progress`；切片状态：`in_progress`；动作状态：`succeeded`
- 当前切片验收：已满足 `2`，待验证或阻塞 `1`，合计 `3`
- 本轮是否发送真实游戏输入：`true`
- 当前工作：当前没有副作用动作在执行，停在下一动作之前
- 最新当前有效证据：最近事件：副作用动作 ACT-P4S6-COMMIT-001 -> succeeded（EVT-0882；不是当前验收通过证据）
- 唯一下一动作：Commit P4-S6 partial progress; begin P5 persistence specialized path.
- 当前切片执行 blocker：none
- 全局恢复/验收风险：P4-S6-C3 restart retention needs P5 persistence specialized verifier/app restart live proof
- 最新 checkpoint：`CP-0065`；safeToResume=`true`；safeToRunLiveInput=`false`
- 当前允许：只读审计、连续性元数据对账、当前切片内的代码工作。
- 当前禁止：归属不明对象的清理或停止、未登记 intent 的副作用动作、真实游戏输入。
- 运行观察（STATUS 生成时）：**新鲜**；observedAt=`2026-07-14T14:24:33Z`；年龄=`30s`；TTL=`300s`；expiresAt=`2026-07-14T14:29:33Z`。执行窗口/进程动作前以 `execution:resume-check` 的动态结果为准。

## 验收轴

| 验收轴 | 状态 | 依据/限制 |
|---|---|---|
| 代码表面能力 | `部分` | 源码已有 15 类步骤、任务/目标/队列/readiness/失败报告等表面能力，但大型文件耦合且真实闭环不足。 |
| 自动测试 | `已过期` | test rebind；当前没有绑定现有 HEAD/工作树指纹的有效通过证据 |
| 当前提交构建 | `已过期` | vite rebind；当前没有绑定现有 HEAD/工作树指纹的有效通过证据 |
| 当前提交应用已启动 | `已过期` | app EVD-0395；当前没有绑定现有 HEAD/工作树指纹的有效通过证据 |
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

- src/home-vitality-core.js
- src/main.js
- docs/execution

### 非目标

- Do not stop user game
- Do not expand to P6 multi-task set yet

### 安全边界

- Live input only after elevated gates and manual confirmation

### 验收条件

| ID | 条件 | 状态 | 允许证据类别 | 证据 |
|---|---|---|---|---|
| `P4-S6-C1` | Offline full blueprint instantiate, readiness, recovery contracts pass | `passed` | `source_audit`, `test` | `EVD-0390`, `EVD-0391` |
| `P4-S6-C2` | At least multi-step home-vitality live path beyond single hotkey with postcondition | `passed` | `live_input`, `live_outcome` | `EVD-0403`, `EVD-0406` |
| `P4-S6-C3` | Restart retains task/assets or documents explicit remaining gap with evidence | `pending` | `app_runtime`, `persistence` | none |

## 当前动作

- 当前没有未决副作用动作。

## 下一步

- 唯一下一动作：Commit P4-S6 partial progress; begin P5 persistence specialized path.
- 命令：`npm run execution:resume-check`

## 阻塞与风险

### 阻塞

- P4-S6-C3 restart retention needs P5 persistence specialized verifier/app restart live proof

### 禁止盲目执行

- Do not stop MyGame_x64r without user request.

## Git 现场

- 分支：`main`
- observed HEAD：`3199ad1caaa6241b65d3ec5b0767b067d40d7e14`
- verified HEAD：`9b55dd076a5beec5ef04aeddb135a334720993ca`
- origin/main：`3eef34f8c4b115c94e2c3cd6adb93cf329a60ef9`
- working tree fingerprint：`sha256:18f72ac573c15d805505ed2f953cb7fcfade2c6d79778e614dff6e59925948a9`
- 最新 checkpoint：`CP-0065` (state_snapshot)
- checkpoint safeToResume：`true`
- checkpoint safeToRunLiveInput：`false`

### 当前非 ignored 改动

- `docs/execution/STATUS.md`
- `docs/execution/events.jsonl`
- `docs/execution/state.json`

## 运行进程与产物

### 本轮管理的进程

- PID `61780`：controller-app；cleanupAllowed=`true`
- PID `55040`：controller-app；cleanupAllowed=`true`
- PID `8604`：controller-app；cleanupAllowed=`true`
- PID `71160`：controller-app；cleanupAllowed=`true`
- PID `51816`：controller-app；cleanupAllowed=`true`

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
- PID `71160`：`mhxy-shikong-control.exe`，controller-app；present=`true`，归属=`created_by_current_run`，cleanupAllowed=`false`
- PID `51816`：`mhxy-shikong-control.exe`，controller-app；present=`true`，归属=`created_by_current_run`，cleanupAllowed=`false`

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
| `EVD-0399` | `window_identity` | `passed` | `stale` | Verified live window identity for game-client (read-only, no input)<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0400` | `live_preflight` | `passed` | `stale` | Strict target capture completed bounded zero-input wait_image preflight<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0401` | `window_identity` | `passed` | `stale` | Verified live window identity for game-client (read-only, no input)<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0402` | `window_identity` | `passed` | `stale` | Verified live window identity for game-client (read-only, no input)<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0403` | `live_input` | `passed` | `stale` | Bounded home-vitality live input executed with inputSent after elevated gates<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0404` | `window_identity` | `passed` | `stale` | Verified live window identity for game-client (read-only, no input)<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0405` | `window_identity` | `passed` | `stale` | Verified live window identity for game-client (read-only, no input)<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0406` | `live_outcome` | `passed` | `stale` | Bounded home-vitality live outcome observed after inputSent<br>证据 HEAD 与当前 observed HEAD 不同 |

## 最近事件

| seq | 时间 | 类型 | 摘要 |
|---:|---|---|---|
| 873 | `2026-07-14T14:24:21Z` | `runtime_observation` | Verified live window identity for game-client (read-only, no input) |
| 874 | `2026-07-14T14:24:24Z` | `checkpoint` | 创建 CP-0064：ESC outcome |
| 875 | `2026-07-14T14:24:25Z` | `action_intent` | 登记副作用动作 ACT-P4S6-LIVE-D |
| 876 | `2026-07-14T14:24:26Z` | `runtime_observation` | Verified live window identity for game-client (read-only, no input) |
| 877 | `2026-07-14T14:24:33Z` | `runtime_observation` | Bounded home-vitality live outcome observed after inputSent |
| 878 | `2026-07-14T14:24:34Z` | `action_result` | 副作用动作 ACT-P4S6-LIVE-D -> succeeded |
| 879 | `2026-07-14T14:24:59Z` | `decision` | P4-S6-C1 offline contracts passed (EVD-0390/0391). P4-S6-C2 multi-step live ALT+N+ESC passed (EVD-0403/0406). P4-S6-C3 restart retention remains pending: persistence specialized verifier allowlist empty; belongs to P5. |
| 880 | `2026-07-14T14:25:00Z` | `checkpoint` | 创建 CP-0065：C1/C2 done; C3 deferred to P5 |
| 881 | `2026-07-14T14:25:01Z` | `action_intent` | 登记副作用动作 ACT-P4S6-COMMIT-001 |
| 882 | `2026-07-14T14:25:03Z` | `action_result` | 副作用动作 ACT-P4S6-COMMIT-001 -> succeeded |

## 异常恢复

1. 阅读 `AGENTS.md`、本页和 `docs/execution/PROTOCOL.md`。
2. 运行 `npm run execution:resume-check`；退出码非 0 时不要执行任何副作用动作。
3. 再运行 `npm run audit:execution-state` 和 `git status --short --ignored`，比较 observed/verified/upstream HEAD 和 dirty 文件。
4. 重新核验 AppData、应用版本、进程、窗口身份和证据文件；过期 PID 只能作为线索。
5. 若存在 `running` 或 `unknown_after_interruption` 动作，先 reconciliation，禁止直接重试。
6. 追加 `reconciliation` 事件后，从“唯一下一动作”继续。

详细规则见 [PROTOCOL.md](PROTOCOL.md)，长期产品方案见 [project-audit-and-master-plan.md](../project-audit-and-master-plan.md)。
