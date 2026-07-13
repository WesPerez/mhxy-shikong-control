<!-- generated-by: scripts/execution_progress.py; do-not-edit-manually -->
<!-- state-digest: sha256:14f86224eb1f51a421d45d0f0a36f32cc0ba02aa9f6c52aa111ea04ddfcabb7f -->
<!-- checkpoint-id: CP-0033 -->
# 长任务执行状态

> 本页由 `scripts/execution_progress.py` 从 `state.json`、事件账本和证据账本生成。
> 线程聊天不是恢复权威；冲突时以当前源码、Git、测试和实际运行结果为准。

## 恢复首屏

- 恢复结论：**可恢复代码工作；其它副作用仍需各自门禁**
- 更新时间（UTC）：`2026-07-13T10:05:55Z`
- 更新时间（北京时间）：`2026-07-13T18:05:55+08:00`
- 长期任务：`MHXY-AUTOMATION-WORKBENCH`
- 运行：`RUN-20260710-CONTINUITY-BASELINE` / attempt `1`
- 总体状态：`active`
- 当前阶段：`P3`
- 当前切片：`P3-S8` - Specialized window-identity-v1 verifier for read-only HWND identity evidence
- 阶段状态：`in_progress`；切片状态：`verified`；动作状态：`none`
- 当前切片验收：已满足 `3`，待验证或阻塞 `0`，合计 `3`
- 本轮是否发送真实游戏输入：`false`
- 当前工作：当前没有副作用动作在执行，停在下一动作之前
- 最新当前有效证据：Verified live window identity for controller-app (read-only, no input)（EVD-0137，当前工作区绑定有效）
- 唯一下一动作：Optional: rebuild/relaunch current HEAD app; P4 requires live game windows for identity/capture/OCR e2e
- 当前切片执行 blocker：none
- 全局恢复/验收风险：P2 UI 切片需要启动本任务构建的本地应用；externalAuthorization=appdata_backup_only 不包含进程启动
- 最新 checkpoint：`CP-0033`；safeToResume=`true`；safeToRunLiveInput=`false`
- 当前允许：只读审计、连续性元数据对账、当前切片内的代码工作。
- 当前禁止：归属不明对象的清理或停止、未登记 intent 的副作用动作、真实游戏输入。
- 运行观察（STATUS 生成时）：**新鲜**；observedAt=`2026-07-13T10:04:32Z`；年龄=`83s`；TTL=`300s`；expiresAt=`2026-07-13T10:09:32Z`。执行窗口/进程动作前以 `execution:resume-check` 的动态结果为准。

## 验收轴

| 验收轴 | 状态 | 依据/限制 |
|---|---|---|
| 代码表面能力 | `部分` | 源码已有 15 类步骤、任务/目标/队列/readiness/失败报告等表面能力，但大型文件耦合且真实闭环不足。 |
| 自动测试 | `已过期` | P2-S2 verifier 配置、10 个测试发现和静态全回归通过；真实 Playwright UI 未执行；当前没有绑定现有 HEAD/工作树指纹的有效通过证据 |
| 当前提交构建 | `版本过旧` | Ledger commit 536201d moved HEAD after EVD-0120; rebind after P3-S6 product work |
| 当前提交应用已启动 | `版本过旧` | Ledger commit 536201d moved HEAD after EVD-0121; rebind after P3-S6 product work |
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
| `P3` 严格捕获和视觉引擎 | `in_progress` | 修复捕获、ROI、模板、OCR 和预览一致性。 |
| `P4` 第一个真实纵向任务 | `pending` | 以家园活力完成 UI 到游戏后置验证的真实闭环。 |
| `P5` 持久化和素材文件化 | `pending` | 按方案评估 SQLite/结构化 JSON，补版本迁移、原子写入和备份。 |
| `P6` 第二至第五个真实任务 | `pending` | 逐个纵向闭环更多真实任务，不用草稿数量代替可用性。 |
| `P7` 双窗口并行和队列控制 | `pending` | 验证同窗口串行、跨窗口并行、暂停继续和隔离。 |
| `P8` 回归任务与发布门 | `pending` | 扩展到 5-10 个可重复回归任务并完成失败矩阵。 |
| `P9` 源码清理、稳定提交和发布 | `pending` | 在调用链和完整验证后清理、提交、推送和发布稳定版本。 |

## 当前切片

### 范围

- scripts/verify_window_identity.py
- scripts/execution_progress.py
- scripts/test_execution_progress.py
- package.json

### 非目标

- Do not send live game input
- Do not claim game window identity without a live game process
- Do not migrate AppData

### 安全边界

- window-identity-v1 is read-only EnumWindows/GetWindowText/GetClientRect/OpenProcess query only
- No PostMessage, SendInput, SetCursorPos, or focus steal

### 验收条件

| ID | 条件 | 状态 | 允许证据类别 | 证据 |
|---|---|---|---|---|
| `P3-S8-C1` | window-identity-v1 is allowlisted and rejects incomplete identity | `passed` | `test` | `EVD-0132`, `EVD-0135` |
| `P3-S8-C2` | owned controller window identity verified read-only with hwnd/pid/title/process/size/privilege | `passed` | `window_identity` | `EVD-0134`, `EVD-0137` |
| `P3-S8-C3` | core regression and Vite build remain green after window-identity verifier wiring | `passed` | `build`, `test` | `EVD-0132`, `EVD-0133`, `EVD-0135`, `EVD-0136` |

## 当前动作

- 当前没有未决副作用动作。

## 下一步

- 唯一下一动作：Optional: rebuild/relaunch current HEAD app; P4 requires live game windows for identity/capture/OCR e2e
- 命令：`npm run execution:resume-check`

## 阻塞与风险

### 阻塞

- P2 UI 切片需要启动本任务构建的本地应用；externalAuthorization=appdata_backup_only 不包含进程启动

### 禁止盲目执行

- 未扩展授权前不启动/停止应用、不发送游戏输入、不改写 AppData、不 commit/push

## Git 现场

- 分支：`main`
- observed HEAD：`0c045b35e76a98e1444af5d776205cc3454288e4`
- verified HEAD：`4eb8f9e41ffad8ad703a38819fa2262d127ad0e8`
- origin/main：`3eef34f8c4b115c94e2c3cd6adb93cf329a60ef9`
- working tree fingerprint：`sha256:37f3ca7864fe1c6776418b05513b5d607f40e2ac199ece1a2851b3555edfbb87`
- 最新 checkpoint：`CP-0033` (state_snapshot)
- checkpoint safeToResume：`true`
- checkpoint safeToRunLiveInput：`false`

### 当前非 ignored 改动

- `docs/execution/STATUS.md`
- `docs/execution/checkpoints/CP-0032-p3-s8-window-identity-verified.json`
- `docs/execution/checkpoints/CP-0033-p3-s8-rebind-0c045b3.json`
- `docs/execution/events.jsonl`
- `docs/execution/evidence.jsonl`
- `docs/execution/state.json`

## 运行进程与产物

### 本轮管理的进程

- PID `16244`：controller-app；cleanupAllowed=`true`

### 只观察到的外部进程

- PID `42432`：`mhxy-shikong-control.exe`，旧控制器历史线索；present=`false`，归属=`preexisting`，cleanupAllowed=`false`
- PID `26056`：`MyGame_x64r.exe`，历史游戏窗口线索 A；present=`false`，归属=`user_preexisting`，cleanupAllowed=`false`
- PID `52448`：`MyGame_x64r.exe`，历史游戏窗口线索 B；present=`false`，归属=`user_preexisting`，cleanupAllowed=`false`
- PID `12744`：`mhxy-shikong-control.exe`，controller-app；present=`false`，归属=`task-owned`，cleanupAllowed=`false`
- PID `16244`：`mhxy-shikong-control.exe`，controller-app；present=`true`，归属=`created_by_current_run`，cleanupAllowed=`false`

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
| `EVD-0130` | `test` | `passed` | `stale` | P3-S7 rebind on aae2190: core regression after ledger commit<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0131` | `build` | `passed` | `stale` | P3-S7 rebind on aae2190: Vite build after ledger commit<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0132` | `test` | `passed` | `stale` | P3-S8 window-identity verifier: full core regression green<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0133` | `build` | `passed` | `stale` | P3-S8 window-identity verifier: Vite build green<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0134` | `window_identity` | `passed` | `stale` | Verified live window identity for controller-app (read-only, no input)<br>证据 HEAD 与当前 observed HEAD 不同 |
| `EVD-0135` | `test` | `passed` | `valid` | P3-S8 rebind on 0c045b3: core regression after window-identity commit<br>绑定当前 HEAD、工作树指纹和受信来源 |
| `EVD-0136` | `build` | `passed` | `valid` | P3-S8 rebind on 0c045b3: Vite build after window-identity commit<br>绑定当前 HEAD、工作树指纹和受信来源 |
| `EVD-0137` | `window_identity` | `passed` | `valid` | Verified live window identity for controller-app (read-only, no input)<br>绑定当前 HEAD、工作树指纹和受信来源 |

## 最近事件

| seq | 时间 | 类型 | 摘要 |
|---:|---|---|---|
| 354 | `2026-07-13T10:03:02Z` | `runtime_observation` | Verified live window identity for controller-app (read-only, no input) |
| 355 | `2026-07-13T10:03:57Z` | `checkpoint` | 创建 CP-0031：window-identity-v1 specialized verifier proven on owned controller window without input |
| 356 | `2026-07-13T10:04:31Z` | `runtime_observation` | Refresh after P3-S8 product commit 0c045b3 |
| 357 | `2026-07-13T10:04:32Z` | `runtime_observation` | Refresh after window-identity evidence EVD-0134 |
| 358 | `2026-07-13T10:04:34Z` | `checkpoint` | 创建 CP-0032：window-identity-v1 specialized verifier proven on owned controller window without input |
| 359 | `2026-07-13T10:05:23Z` | `test_run` | P3-S8 rebind on 0c045b3: core regression after window-identity commit |
| 360 | `2026-07-13T10:05:46Z` | `test_run` | P3-S8 rebind on 0c045b3: Vite build after window-identity commit |
| 361 | `2026-07-13T10:05:47Z` | `runtime_observation` | Verified live window identity for controller-app (read-only, no input) |
| 362 | `2026-07-13T10:05:48Z` | `slice_state_changed` | P3-S8 rebind complete on HEAD 0c045b3 with window-identity-v1 and core/build evidence |
| 363 | `2026-07-13T10:05:56Z` | `checkpoint` | 创建 CP-0033：P3-S8 criteria rebound on product HEAD 0c045b3 with EVD-0135/0136/0137 |

## 异常恢复

1. 阅读 `AGENTS.md`、本页和 `docs/execution/PROTOCOL.md`。
2. 运行 `npm run execution:resume-check`；退出码非 0 时不要执行任何副作用动作。
3. 再运行 `npm run audit:execution-state` 和 `git status --short --ignored`，比较 observed/verified/upstream HEAD 和 dirty 文件。
4. 重新核验 AppData、应用版本、进程、窗口身份和证据文件；过期 PID 只能作为线索。
5. 若存在 `running` 或 `unknown_after_interruption` 动作，先 reconciliation，禁止直接重试。
6. 追加 `reconciliation` 事件后，从“唯一下一动作”继续。

详细规则见 [PROTOCOL.md](PROTOCOL.md)，长期产品方案见 [project-audit-and-master-plan.md](../project-audit-and-master-plan.md)。
