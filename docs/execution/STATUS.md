<!-- generated-by: scripts/execution_progress.py; do-not-edit-manually -->
<!-- state-digest: sha256:9a97ab964d7407f069839f50a5e844b60e274ea3a0eee6f5cb7aa8ebf59a0797 -->
<!-- checkpoint-id: CP-0073 -->
# 长任务执行状态

> 本页由 `scripts/execution_progress.py` 从 `state.json`、事件账本和证据账本生成。
> 线程聊天不是恢复权威；冲突时以当前源码、Git、测试和实际运行结果为准。

## 恢复首屏

- 恢复结论：**STOP：存在未决副作用，只允许只读对账**
- 更新时间（UTC）：`2026-07-14T17:32:22Z`
- 更新时间（北京时间）：`2026-07-15T01:32:22+08:00`
- 长期任务：`MHXY-AUTOMATION-WORKBENCH`
- 运行：`RUN-20260710-CONTINUITY-BASELINE` / attempt `9`
- 总体状态：`active`
- 当前阶段：`P5`
- 当前切片：`P5-S3` - Backup restore UI and AppData restart persistence verifier
- 阶段状态：`in_progress`；切片状态：`verified`；动作状态：`running`
- 当前切片验收：已满足 `2`，待验证或阻塞 `0`，合计 `2`
- 本轮是否发送真实游戏输入：`true`
- 当前工作：未决动作 `ACT-P5-COMMIT-S3-001` 处于 `running`，等待只读对账
- 最新当前有效证据：P5-S3-core（EVD-0449，当前工作区绑定有效）
- 唯一下一动作：对账未决副作用动作 ACT-P5-COMMIT-S3-001；结果明确前禁止重放
- 当前切片执行 blocker：none
- 全局恢复/验收风险：P4-S6-C3 restart retention needs P5 persistence specialized verifier/app restart live proof
- 最新 checkpoint：`CP-0073`；safeToResume=`true`；safeToRunLiveInput=`false`
- 当前允许：只读审计、连续性元数据对账。
- 当前禁止：归属不明对象的清理或停止、未登记 intent 的副作用动作、重放未决动作、真实游戏输入。
- 运行观察（STATUS 生成时）：**新鲜**；observedAt=`2026-07-14T17:32:14Z`；年龄=`8s`；TTL=`300s`；expiresAt=`2026-07-14T17:37:14Z`。执行窗口/进程动作前以 `execution:resume-check` 的动态结果为准。

## 验收轴

| 验收轴 | 状态 | 依据/限制 |
|---|---|---|
| 代码表面能力 | `部分` | 源码已有 15 类步骤、任务/目标/队列/readiness/失败报告等表面能力，但大型文件耦合且真实闭环不足。 |
| 自动测试 | `已通过` | P5-S3 core EVD-0449 |
| 当前提交构建 | `已通过` | P5-S3 vite EVD-0448 |
| 当前提交应用已启动 | `版本过旧` | app evidence stale after HEAD advance; next slice will relaunch |
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
| `P4` 第一个真实纵向任务 | `verified` | 以家园活力完成 UI 到游戏后置验证的真实闭环。 |
| `P5` 持久化和素材文件化 | `in_progress` | 按方案评估 SQLite/结构化 JSON，补版本迁移、原子写入和备份。 |
| `P6` 第二至第五个真实任务 | `pending` | 逐个纵向闭环更多真实任务，不用草稿数量代替可用性。 |
| `P7` 双窗口并行和队列控制 | `pending` | 验证同窗口串行、跨窗口并行、暂停继续和隔离。 |
| `P8` 回归任务与发布门 | `pending` | 扩展到 5-10 个可重复回归任务并完成失败矩阵。 |
| `P9` 源码清理、稳定提交和发布 | `pending` | 在调用链和完整验证后清理、提交、推送和发布稳定版本。 |

## 当前切片

### 范围

- scripts
- src
- docs/execution

### 非目标

- No force push
- No real AppData overwrite without backup verifier

### 安全边界

- No real AppData overwrite without backup verifier
- No game input in this slice

### 验收条件

| ID | 条件 | 状态 | 允许证据类别 | 证据 |
|---|---|---|---|---|
| `P5-S3-C1` | Persistence specialized verifier and backup/restore contracts exist offline | `passed` | `source_audit`, `test` | `EVD-0447`, `EVD-0449` |
| `P5-S3-C2` | Core tests and vite pass with persistence verifier wired | `passed` | `build`, `test` | `EVD-0448`, `EVD-0449` |

## 当前动作

- actionId：`ACT-P5-COMMIT-S3-001`
- 类型：`git_commit`
- 目标：`local-repo`
- 副作用级别：`git_commit`
- 状态：`running`

## 下一步

- 唯一下一动作：对账未决副作用动作 ACT-P5-COMMIT-S3-001；结果明确前禁止重放
- 命令：`npm run execution:resume-check`

## 阻塞与风险

### 阻塞

- P4-S6-C3 restart retention needs P5 persistence specialized verifier/app restart live proof

### 禁止盲目执行

- Do not stop MyGame_x64r without user request.

## Git 现场

- 分支：`main`
- observed HEAD：`bf1adb14289f3ec794c3fced54c4a828ecab270a`
- verified HEAD：`9a15ec0ed96772984af950178a44ae1ca861a90e`
- origin/main：`3eef34f8c4b115c94e2c3cd6adb93cf329a60ef9`
- working tree fingerprint：`sha256:d7b201e9cedb61d26126cef732bf0e532726f0857c41322565ee6445fe52e12a`
- 最新 checkpoint：`CP-0073` (state_snapshot)
- checkpoint safeToResume：`true`
- checkpoint safeToRunLiveInput：`false`

### 当前非 ignored 改动

- `docs/execution/STATUS.md`
- `docs/execution/checkpoints/CP-0073-pre-commit-p5s3.json`
- `docs/execution/events.jsonl`
- `docs/execution/evidence.jsonl`
- `docs/execution/state.json`
- `package.json`
- `scripts/audit_workspace_persistence.py`
- `scripts/execution_progress.py`
- `scripts/test_verify_workspace_persistence.py`
- `scripts/verify_workspace_persistence.py`

## 运行进程与产物

### 本轮管理的进程

- PID `61780`：controller-app；cleanupAllowed=`true`
- PID `55040`：controller-app；cleanupAllowed=`true`
- PID `8604`：controller-app；cleanupAllowed=`true`
- PID `71160`：controller-app；cleanupAllowed=`true`
- PID `51816`：controller-app；cleanupAllowed=`true`
- PID `87704`：controller-app；cleanupAllowed=`true`

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
- PID `87704`：`mhxy-shikong-control.exe`，controller-app；present=`true`，归属=`created_by_current_run`，cleanupAllowed=`false`

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
| `EVD-0442` | `build` | `passed` | `stale` | P5-S2-rebind-vite<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0443` | `test` | `passed` | `stale` | P5-S2-rebind-core<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0444` | `source_audit` | `passed` | `stale` | P5-S2-r2-audit<br>证据工作树指纹与当前现场不同 |
| `EVD-0445` | `build` | `passed` | `stale` | P5-S2-r2-vite<br>证据工作树指纹与当前现场不同 |
| `EVD-0446` | `test` | `passed` | `stale` | P5-S2-r2-core<br>证据工作树指纹与当前现场不同 |
| `EVD-0447` | `source_audit` | `passed` | `valid` | P5-S3-persistence-audit<br>绑定当前 HEAD、工作树指纹和受信来源 |
| `EVD-0448` | `build` | `passed` | `valid` | P5-S3-vite<br>绑定当前 HEAD、工作树指纹和受信来源 |
| `EVD-0449` | `test` | `passed` | `valid` | P5-S3-core<br>绑定当前 HEAD、工作树指纹和受信来源 |

## 最近事件

| seq | 时间 | 类型 | 摘要 |
|---:|---|---|---|
| 1012 | `2026-07-14T17:29:56Z` | `evidence_recorded` | P5-S3-persistence-audit |
| 1013 | `2026-07-14T17:29:59Z` | `test_run` | P5-S3-vite |
| 1014 | `2026-07-14T17:31:54Z` | `test_run` | P5-S3-core |
| 1015 | `2026-07-14T17:32:12Z` | `runtime_observation` | pre-commit P5-S3 |
| 1016 | `2026-07-14T17:32:14Z` | `runtime_observation` | pre-commit P5-S3 controller |
| 1017 | `2026-07-14T17:32:15Z` | `slice_state_changed` | 更新验收轴 automated -> passed |
| 1018 | `2026-07-14T17:32:16Z` | `slice_state_changed` | 更新验收轴 currentCommitBuilt -> passed |
| 1019 | `2026-07-14T17:32:18Z` | `slice_state_changed` | P5-S3 persistence verifier and offline backup/restore contracts verified |
| 1020 | `2026-07-14T17:32:21Z` | `checkpoint` | 创建 CP-0073：Commit P5-S3 persistence verifier |
| 1021 | `2026-07-14T17:32:22Z` | `action_intent` | 登记副作用动作 ACT-P5-COMMIT-S3-001 |

## 异常恢复

1. 阅读 `AGENTS.md`、本页和 `docs/execution/PROTOCOL.md`。
2. 运行 `npm run execution:resume-check`；退出码非 0 时不要执行任何副作用动作。
3. 再运行 `npm run audit:execution-state` 和 `git status --short --ignored`，比较 observed/verified/upstream HEAD 和 dirty 文件。
4. 重新核验 AppData、应用版本、进程、窗口身份和证据文件；过期 PID 只能作为线索。
5. 若存在 `running` 或 `unknown_after_interruption` 动作，先 reconciliation，禁止直接重试。
6. 追加 `reconciliation` 事件后，从“唯一下一动作”继续。

详细规则见 [PROTOCOL.md](PROTOCOL.md)，长期产品方案见 [project-audit-and-master-plan.md](../project-audit-and-master-plan.md)。
