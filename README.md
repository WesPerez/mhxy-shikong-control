# 梦幻西游：时空 接管台

这是放在 `E:\Project\Common` 下的独立项目，用来接管标题包含 `梦幻西游：时空` 的游戏窗口，并逐步迁移 `Maa_MHXY_MG` 中所有 Maa 功能、流程和图片识别资源。

当前阶段目标是建立基础接管能力：

- 枚举多个 `梦幻西游：时空` 窗口。
- 在一个应用里选择多个窗口，并用页签切换当前接管窗口。
- 读取旁边的 `Maa_MHXY_MG/assets/interface.json` 和 pipeline 清单。
- 列出原 Maa 任务和模板引用。
- 动态读取原 Maa 的任务选项、嵌套选项、输入项和 checkbox，并在运行前生成 `pipeline_override`。
- 支持原 Maa preset 顺序任务组合，例如 115/69 队长日常、队员日常和其他任务。
- 按原 Maa ROI 从当前时空版窗口截图，写入本项目的 `assets/resource/ShiKong/image/**`，不污染原 Maa 仓库。
- 启动时设置 PerMonitorV2 DPI awareness；截图优先从游戏窗口客户区 DC 读取，避免多显示器、DPI 缩放或遮挡时屏幕坐标 BitBlt 抓到其它窗口；失败时再回退到屏幕区域截图。
- 自动任务输入默认使用 hwnd 定向的后台窗口消息，不移动真实鼠标、不占用真实键盘焦点，多个游戏窗口可以各自接收独立 client 坐标事件；只有用户手动点击界面里的聚焦按钮时才会置前目标窗口。
- 截取模板时可手工输入 `x,y,w,h` 覆盖旧 ROI，用于逐张重采时空版相似图。
- 也可直接在窗口预览上拖框，按当前游戏客户区坐标精确截取选中区域到对应模板路径。
- 支持载入本地离线截图、在离线图上拖框，并把裁剪结果保存为选中模板的时空替换图。
- 保存替换映射到 `assets/resource/ShiKong/template_mapping.json`。
- 模板表会显示已替换数量、替换路径和截取来源空间，方便逐项清空未替换列表。
- 检测当前接管台和目标游戏窗口是否管理员权限。
- 读取原 Maa pipeline，按节点执行 `TemplateMatch`、`ColorMatch`、`OCR`、`Or`、`And` 的兼容运行流程。
- 对窗口客户区执行后台点击、拖拽、文本输入和扫描码按键动作；鼠标类动作会先按客户区坐标解析实际子窗口，再通过 `PostMessageW(hwnd, WM_*)` 投递，不调用 `SetCursorPos`、`mouse_event`、`SendInput` 或 `keybd_event`。
- 在界面中选择 Maa 任务，进行 dry-run 或限定步数执行，并查看每个节点的识别、动作和队列日志。
- 支持按 `runId` 请求停止当前任务；不会主动杀游戏进程。
- 运行报告会写入 `assets/resource/ShiKong/logs`，方便后续复盘节点命中和失败分支。
- 兼容审计会核对原 Maa 任务入口、preset、pipeline 节点引用、识别类型、动作类型和 custom hook，避免迁移过程中漏掉功能面。

## 目录关系

```text
E:\Project\Common
├─ Maa_MHXY_MG              # 原 Maa 项目，只作为迁移源读取
└─ MHXY-ShiKong-Control     # 新的时空版接管台
```

## 管理员权限

如果游戏以管理员权限启动，普通权限接管台可能无法稳定截图、置前或发送输入。Windows 会拦截低权限进程控制高权限窗口。

本项目已经：

- 在窗口列表显示目标窗口权限：管理员、普通或未知。
- 在顶部状态提示当前接管台是否管理员权限。
- 顶栏提供“管理员重启”，可在开发模式或非提升启动时通过 UAC 重新启动接管台。
- 顶栏提供“启动客户端”，读取 `assets/resource/ShiKong/app_launch.json` 或
  `SHIKONG_GAME_EXE`，用配置的 exe 路径启动 PC 客户端，不通过鼠标键盘操作。
- release 打包时给 Windows 可执行文件嵌入 `requireAdministrator` manifest，运行 release exe 时会请求管理员权限。
- manifest 和启动代码都会启用 PerMonitorV2 DPI awareness，避免高 DPI 显示器上把 4:3 客户区截成逻辑坐标尺寸。

开发时建议从“以管理员身份运行”的终端启动：

```powershell
cd E:\Project\Common\MHXY-ShiKong-Control
npm run tauri:dev
```

也可以让项目脚本自行触发 UAC：

```powershell
cd E:\Project\Common\MHXY-ShiKong-Control
npm run tauri:dev:admin
```

`tauri:dev:admin` 会以管理员权限重新进入 `npm run tauri:dev`，日志写入
`assets/resource/ShiKong/logs/tauri-dev-admin-*.log`。release 构建仍使用
`src-tauri/app.manifest` 中的 `requireAdministrator`，直接启动 exe 时会请求管理员权限。

如需让接管台启动 PC 客户端，复制并填写：

```powershell
copy assets\resource\ShiKong\app_launch.example.json assets\resource\ShiKong\app_launch.json
```

`app_launch.json` 使用 `exePath`、`args` 和 `workingDir` 字段；也可以只设置
`SHIKONG_GAME_EXE` 环境变量指定 exe。运行 Maa `StartApp` 节点时，任务会确认当前绑定 hwnd 已存在；
真正从无窗口启动客户端使用顶栏 `启动客户端`，避免多窗口验收时重复开新客户端。

## 开发命令

```powershell
cd E:\Project\Common\MHXY-ShiKong-Control
npm install
npm run build
cd src-tauri
cargo check
```

## OCR

当前 OCR 使用 `scripts/rapidocr_bridge.py` 常驻桥接本机 Python RapidOCR。默认调用 `python`，本机验证到 `C:\Users\Wes\AppData\Local\Programs\Python\Python38\python.exe` 可用。

如需指定 Python：

```powershell
$env:SHIKONG_PYTHON = "C:\Users\Wes\AppData\Local\Programs\Python\Python38\python.exe"
```

## 坐标和比例

目标游戏窗口大小可能变化，当前截图显示客户区近似 4:3。接管台不会假设固定像素尺寸；截图和 ROI 截取会按当前窗口客户区尺寸缩放。

原 Maa 资源的 ROI 大多来自 1280x720 坐标系。接管台默认使用 `4:3 中心裁切` 映射：把旧 1280x720 的中间 960x720 区域映射到时空版客户区。任务执行前也可以切回 `1280x720 拉伸`。

```text
4:3 默认:
target_x = (source_x - 160) / 960 * current_client_width
target_y = source_y / 720 * current_client_height

1280x720 拉伸:
target_x = source_x / 1280 * current_client_width
target_y = source_y / 720 * current_client_height
```

这适合先截取与原功能位置相近的图片。对于时空版布局明显变化的功能，后续仍需要重采模板和重标 ROI，而不是机械依赖旧坐标。

## Maa 运行器状态

当前运行器已经能加载 `Maa_MHXY_MG/assets/resource/base/pipeline/*.json`，并预留本项目覆盖目录：

```text
assets/resource/ShiKong/pipeline
assets/resource/ShiKong/image
```

已落地：

- `TemplateMatch`：优先使用 `ShiKong/image/**` 替换图，找不到时回退到原 Maa `base/image/**`。
- 时空替换图会使用 `template_mapping.json` 记录的新 `sourceRoi` 和 `sourceFrameWidth/Height` 缩放搜索区域，避免时空 4:3 UI 重排后仍卡在旧 1280x720 ROI。
- 同一个 Maa 模板支持多个 ShiKong 变体：`variants[]` 中可记录不同窗口尺寸、不同界面状态或不同截图来源，运行时和离线 probe 会在所有变体中取最高分。
- `ColorMatch`：支持 `upper/lower/count/roi`。
- `Or` / `And`：支持组合识别，也支持 Maa pipeline 中引用其他节点名的写法。
- `OCR`：已接入统一接口和状态探测；当前优先使用本机 Python 3.8 的 RapidOCR 桥接，原生 Rust ONNX 后端仍作为后续迁移项。
- 动作：`Click`、`Swipe`、`MultiSwipe`、`InputText`、`ClickKey`。
- 计数类 custom action：`count`、`countGlobal`、`countZG` 有基础兼容。
- `returnOCR` custom action：会运行指定识别节点，输出 OCR 文本，并可按识别框或参数点击。
- 自定义识别：已基础兼容 `invite`、`OCRNum`、`OCRVitality`、`sjqy_tiku_V2/V3`、`AIAnswer`、`zhipu`。
- `AIAnswer` / `zhipu`：配置了 API key/url/model 时会按 OpenAI-compatible chat completions 协议请求答案；缺少配置或请求失败时兜底点击 A，并在运行日志写明原因。`zhipu` 使用智谱 OpenAI 兼容地址和 `GLM-4-Flash-250414`。
- `pre_wait_freezes`、`post_wait_freezes`、`repeat_wait_freezes`：支持数字写法和 `{ time, threshold, target }` 局部等待写法。
- `focus`：作为 Maa UI 日志事件写入每步运行 detail，支持 `{name}` 和 `{best_result}` 占位符。
- `repeat_delay` / `end_hold`：重复点击间隔和滑动结束保持已接入。
- `target_offset`：按 Maa 矩形偏移语义处理，先把 `[dx,dy,dw,dh]` 加到目标矩形，再取点击中心，支持 4:3/拉伸坐标缩放。
- `next` 候选：普通候选命中后会清理同父节点剩余候选，避免 A 命中后继续误跑 B/C 分支。
- `[JumpBack]`：普通 `next` 路径中的 JumpBack 节点会在分支处理后返回父节点的候选列表，并清理同父节点剩余旧候选；`on_error` 路径中的 JumpBack 按 Maa 语义不回跳。
- `空节点`：作为默认 no-op 错误分支过滤，不再消耗运行步数或继承默认 `post_delay`。
- 任务 UI：支持 4:3/拉伸坐标模式切换、停止运行、运行报告持久化。
- Interface 选项：支持 `select`、`switch`、`input`、`checkbox`、嵌套 `option` 和占位符替换，例如 `{任务描述}`、`{抓鬼轮数}`、`{apikey}`。
- Preset：支持按原 `interface.json` 顺序依次运行 preset 中的任务，并应用 preset 自带选项。
- 图片替换工具：支持原 Maa ROI、手工源坐标 ROI，以及预览拖框的客户区 ROI；映射文件会记录 `sourceSpace`，区分 `baseline` 和 `client`。
- 离线截图替换：支持 PNG/JPEG 图片路径导入，映射文件会记录 `sourceSpace=image`。
- 替换覆盖：`Maa 清单` 会读取 `template_mapping.json`，模板计数显示 `已替换/总数`。
- 覆盖审计：可按资源域、pipeline、任务和唯一模板统计已替换/未替换引用，未替换模板会按公共性和引用数优先排序。
- 兼容审计：可在界面查看 Maa 任务入口、preset 引用、`next/on_error` 节点引用和 hook 支持状态；未知 hook 会作为 unsupported 暴露。
- 迁移门禁：可在界面读取 `latest-migration-status.json`，直接查看全量任务、preset、模板映射、模板验证和最新截图命中的达标情况。
- 批量裁剪计划：可生成 `assets/resource/ShiKong/crop_plans/*.json`，填入离线截图 ROI 后批量裁剪到 `ShiKong/image/**`，映射文件会记录 `sourceSpace=imagePlan`。
- 离线回放：`scripts/probe_pipeline_templates.py` 可对任意时空截图回放全部 pipeline 模板引用，输出命中报告和命中标框图。

已导入用户给的参考图：

```text
assets/resource/ShiKong/captures/reference-image-1.png
尺寸：828x666
assets/resource/ShiKong/captures/reference-image-1-client.png
尺寸：828x620，已去除 Windows 标题栏，作为运行时 client 坐标基准
assets/resource/ShiKong/captures/live-window-clientdc-dpi-1783371820.png
尺寸：763x573，通过 PerMonitorV2 DPI-aware 窗口 client DC 从当前游戏窗口读取
```

已从该参考图首批重采并通过离线回放验证的通用模板：

```text
assets/resource/ShiKong/image/dati/liaotian.png
assets/resource/ShiKong/image/jiayuan/dali.png
assets/resource/ShiKong/image/r5/haoyou1.png
assets/resource/ShiKong/image/r5/haoyou2.png
assets/resource/ShiKong/image/shangcheng/shangcheng.png
assets/resource/ShiKong/image/zonghe/baoguo.png
assets/resource/ShiKong/image/zonghe/baoguo_man.png
assets/resource/ShiKong/image/zonghe/huodong1.png
assets/resource/ShiKong/image/zonghe/huodong2.png
assets/resource/ShiKong/image/zonghe/jiahao.png
assets/resource/ShiKong/image/zonghe/xiaoditu_yueliang.png
```

这些模板已写入 `assets/resource/ShiKong/template_mapping.json`，并记录 `sourceRoi/sourceFrameWidth/sourceFrameHeight`，运行时会按当前 client 尺寸缩放搜索区域。

后续从管理员 playbook 实采图中补充并验证的模板：

```text
assets/resource/ShiKong/image/beibao/beibao_jiemian_panduan.png
assets/resource/ShiKong/image/zonghe/chenghao.png
```

映射文件兼容两种格式。旧格式仍可用：

```json
{
  "replacementPath": "assets/resource/ShiKong/image/zonghe/jiahao.png",
  "sourceRoi": [780, 556, 45, 46],
  "sourceFrameWidth": 828,
  "sourceFrameHeight": 620
}
```

新增多变体格式可用于后续采集更多窗口尺寸或 UI 状态：

```json
{
  "replacementPath": "assets/resource/ShiKong/image/zonghe/jiahao.png",
  "sourceRoi": [780, 556, 45, 46],
  "sourceFrameWidth": 828,
  "sourceFrameHeight": 620,
  "variants": [
    {
      "name": "small-window",
      "replacementPath": "assets/resource/ShiKong/image_variants/zonghe/jiahao-small.png",
      "sourceRoi": [718, 515, 41, 43],
      "sourceFrameWidth": 763,
      "sourceFrameHeight": 573
    }
  ]
}
```

## 图片覆盖审计和裁剪计划

界面中的“图片识别替换”区域现在有三层迁移视图：

- 模板表：逐条 Maa 模板引用，支持只看未替换、按路径/节点/pipeline 筛选。
- 覆盖报告：按资源域、pipeline 和任务聚合缺口，优先处理引用多、公共节点多的模板。
- 裁剪计划：把未替换模板导出为 JSON，手工填入离线图 ROI 后一键应用。

裁剪计划示例：

```json
{
  "version": 1,
  "name": "reference-home",
  "defaultImagePath": "assets/resource/ShiKong/captures/reference-image-1.png",
  "coordinateSpace": "image",
  "items": [
    {
      "template": "zonghe/zhujiemian_shiyong_cha.png",
      "roi": [10, 20, 80, 42],
      "note": "home close button"
    }
  ]
}
```

应用计划后会写入：

```text
assets/resource/ShiKong/image/<template path>
assets/resource/ShiKong/template_mapping.json
```

离线验证工具：

```powershell
python scripts\validate_mapped_templates.py --min-score 0.82
python scripts\probe_pipeline_templates.py --image assets/resource/ShiKong/captures/reference-image-1-client.png --preview
python scripts\suggest_templates.py --reference assets/resource/ShiKong/captures/reference-image-1-client.png --limit 80 --min-score 0.78 --preview --preview-limit 40
python scripts\suggest_templates.py --reference assets/resource/ShiKong/captures/script-home-2.png --roi-aware --min-score 0.70 --preview
python scripts\suggest_templates.py --reference assets/resource/ShiKong/captures/script-home-2.png --roi-aware --apply --append-variant --apply-threshold 0.90
python scripts\apply_probe_variants.py --report assets/resource/ShiKong/crop_plans/template-probe-1783373413418202900.json --min-score 0.94 --name home-763x573
python scripts\template_triage_report.py --top 120 --candidate-min-score 0.62 --report-name latest-unmapped-triage
python scripts\capture_window.py --list
python scripts\capture_window.py --output assets/resource/ShiKong/captures/script-home.png
python scripts\capture_playbook.py --list-steps
python scripts\capture_playbook.py --dry-run
python scripts\capture_playbook.py --from-step team-panel --until-step activity-panel --continue-on-error
npm run capture:playbook:admin
python scripts\probe_capture_manifest.py --preview --report-name latest-manifest-probe
npm run probe:verified
python scripts\apply_manifest_variants.py --report assets/resource/ShiKong/reports/latest-manifest-probe.json --dry-run
python scripts\apply_manifest_variants.py --report assets/resource/ShiKong/reports/latest-manifest-probe.json --apply
python scripts\migration_status.py
python scripts\migration_status.py --fail-on-incomplete
python scripts\live_acceptance.py
python scripts\goal_readiness.py --require-live-acceptance
```

`scripts/capture_window.py` 是迁移期采集工具：默认只列窗口或截图；传入 `--click x y` 才会向目标 hwnd/命中的子 hwnd 投递客户区点击消息，不移动真实鼠标。当前实测 `梦幻西游：时空` 进程为管理员权限，而普通终端不是管理员，因此截图成功、后台输入可能会被 Windows UIPI 拒绝。需要自动点开背包、活动、队伍等界面采集素材时，从管理员终端运行该脚本或运行 release 接管台。

`scripts\capture_playbook.py` 是批量面板截图工具，会读取：

```text
assets/resource/ShiKong/capture_playbooks/main-panels.json
```

默认 playbook 使用当前 4:3 主界面上的归一化坐标，依次采集主界面、右下展开态、任务、队伍、背包、福利、商城/商会/摆摊、活动分类、小地图、好友、技能四个 tab、工坊药术/考古等入口状态，并把截图和 `capture-manifest.json` 写到 `assets/resource/ShiKong/captures/playbook-*`。如果目标游戏是管理员权限而脚本不是管理员权限，脚本会在发送输入前停止，避免部分点击造成混乱；先用 `npm run capture:playbook:steps` 查看步骤，再用 `npm run capture:playbook:dry` 或 `python scripts\capture_playbook.py --dry-run` 检查输出。

playbook 动作支持：

```json
{ "click": [0.5, 0.5], "wait": 0.2 }
{ "key": "ESC", "wait": 0.2 }
{ "scancode": [56, 20], "wait": 0.8 }
{ "closePanel": true, "wait": 0.2 }
{ "ensurePlusExpanded": true, "wait": 0.2 }
{ "collapsePlusMenu": true, "wait": 0.2 }
```

`scancode` 使用和原 Maa `ClickKey` 相同的扫描码语义，适合队伍、背包、活动、小地图等快捷键入口；当组合里包含 Alt 扫描码 `0x38` 时，采集脚本和 Rust 后端都会用 `WM_SYSKEYDOWN/WM_SYSKEYUP` 和 Alt context bit 投递后台组合键。当前 PC 端队伍入口已验证为 `Alt+T`，扫描码 `[56, 20]`。`closePanel` 会在当前截图右上区域寻找红色或金橙色关闭按钮，避免把不同面板的关闭坐标写死；`ensurePlusExpanded` / `collapsePlusMenu` 会用已映射的右下收起按钮模板判断菜单状态，避免连续采集时展开菜单残留导致点偏。

正式采集建议从管理员终端运行。可以用 `--from-step` / `--until-step` 只重跑某一段，也可以用 `--step name` 只跑指定步骤；`--continue-on-error` 会把失败步骤写进 manifest 并继续后续步骤，失败时默认额外保存一张 `*-error.png` 方便复盘当前画面。

也可以直接运行 `npm run capture:playbook:admin`。该命令会通过 UAC 以管理员权限重新启动 `scripts/run_capture_playbook_admin.ps1`，完整执行默认 playbook。带 `--step` / `--from-step` / `--until-step` 做子集采集时，管理员脚本会先把这次采集写成 `capture-playbook-admin-*-probe` 独立报告，再用 `combined-latest-verified-panels/capture-manifest.json` 刷新 `latest-manifest-probe`，避免少量调试截图覆盖全量迁移门禁。日志写入：

```text
assets/resource/ShiKong/logs/capture-playbook-admin-*.log
```

背包/秘境材料类缺口可以用物品名 OCR 采集器处理。先把游戏停在背包、材料仓库或材料提交页，并确保目标物品在右侧物品格子中可见，然后运行：

```powershell
npm run capture:inventory:admin
```

默认只扫描格子并生成报告，不会修改模板映射。确认 OCR 命中可信后再固化：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run_inventory_item_capture_admin.ps1 -Target mijing_cailiao/bulaogen.png -Apply
```

也可以一次给多个目标，使用逗号分隔或重复 `-Target`。该采集器只向目标 hwnd 投递客户区点击消息，不移动真实鼠标；如果目标游戏是管理员权限而采集器不是管理员权限，会在点击前返回 `status=blocked`。命中的裁剪报告写入：

```text
assets/resource/ShiKong/crop_plans/inventory-name-scan-*/inventory-name-scan-report.json
```

`-Apply` 命中后会把裁剪图写入 `assets/resource/ShiKong/image/**`，并把来源记录追加到 `template_mapping.json`，用于覆盖 `beibao/*.png` 和 `mijing_cailiao/*.png` 这类普通截图难以低风险匹配的物品图标。

`scripts\probe_capture_manifest.py` 会读取 playbook 产生的 `capture-manifest.json`，对每张截图执行和 `probe_pipeline_templates.py` 一致的离线模板回放，并生成：

```text
assets/resource/ShiKong/reports/latest-manifest-probe.html
assets/resource/ShiKong/reports/latest-manifest-probe.json
assets/resource/ShiKong/reports/latest-manifest-probe-<capture>.json
assets/resource/ShiKong/reports/latest-manifest-probe-<capture>-hits.png
```

聚合报告会列出每张截图命中了多少 Maa 引用、覆盖了多少唯一模板，以及哪些已映射模板可以作为高置信变体候选。报告默认只读，不会修改 `template_mapping.json`。

不传 `--manifest` 时，`probe_capture_manifest.py` 会自动选择 `assets/resource/ShiKong/captures/playbook-*/capture-manifest.json` 中最新且至少包含一张 `status=ok` 截图的一份；`npm run probe:manifest` 也使用这个默认逻辑。全量门禁使用 curated 综合截图集时运行 `npm run probe:verified`，它会把 `combined-latest-verified-panels/capture-manifest.json` 重新生成到 `latest-manifest-probe`。

`scripts\apply_manifest_variants.py` 用于把聚合报告里的高置信变体候选写回 `template_mapping.json`。它默认 dry-run，只有传入 `--apply` 才会裁剪截图并写入 `assets/resource/ShiKong/image_variants/**`；同一模板下已存在的变体名称、来源截图+ROI 或替换路径会被跳过，避免重复沉淀同一批截图。

`scripts\migration_status.py` 是全量迁移门禁报告，会合并原 Maa 任务/preset、全部 pipeline 模板引用、`template_mapping.json`、最新模板验证报告、最新 manifest probe 和当前窗口权限状态，输出：

```text
assets/resource/ShiKong/reports/latest-migration-status.json
assets/resource/ShiKong/reports/latest-migration-status.html
```

默认只读并返回 0；加 `--fail-on-incomplete` 时，只要还有任务入口、preset、运行时识别覆盖、模板验证或 manifest probe 基础数据缺失，就返回非 0。运行时覆盖允许三类证据：已映射 ShiKong 模板、OCR/颜色/物品名 fallback、以及 ShiKong pipeline 覆盖已移除的旧模板依赖。报告同时从 34 个 `interface.json` 任务入口遍历实际运行时 pipeline，单独给出 `interfaceReachableTemplates` 和 `interfaceRuntimeCoveredTemplates`，用于区分正式界面任务缺口和原 Maa 资源中的未暴露/暂停资源。当前完成门禁已通过；全图片实体映射和综合截图全量命中保留为 audit warning，用于继续提高可解释性和实机信心，不再作为运行时完成阻塞项。

`scripts\live_acceptance.py` 是只读实机验收审计。它会列出当前 `梦幻西游：时空` 窗口、权限匹配、4:3 客户区比例、输入安全、迁移覆盖状态，以及 `assets/resource/ShiKong/logs/task-*.json` 中已经完成的非 dry-run 任务报告数量。它不会发送 click/key，不会启动或关闭游戏。没有逐个 Maa 任务的真实完成报告时，该审计会失败，用来提醒“实现门禁已过，但全功能实机长跑证据还没补齐”。由于完整验收最后会执行 `停止游戏`，如果 StopApp 成功关闭了唯一窗口，审计会接受同一 hwnd 的完整 34/34 非 dry-run 日志中保存的权限证据和 4:3 客户区证据，不会因为最终窗口已关闭而误判失败。

接管台的 `Maa 运行器` 区域提供 `Dry-run 全任务验收`、`执行全任务验收`、`Dry-run 已选窗口验收`、`执行已选窗口验收`、`执行缺失验收` 和 `执行已选窗口缺失`。它会按原 Maa `interface.json` 中的 34 个任务顺序执行；单窗口验收只跑当前页签窗口，已选窗口验收会让每个选中的 hwnd 各自串行跑完整矩阵，不同 hwnd 之间并发。缺失验收会先刷新 `latest-live-acceptance.json`，再按 hwnd 只执行尚未沉淀非 dry-run 完成报告的 Maa 任务；如果该 hwnd 没有历史报告，则按全量 34 个任务处理。每个任务仍走 hwnd 定向消息输入和后端 `save_task_report`，报告里会写入 `taskName`、`coordinateMode`、`controllerElevated` 和 `targetElevated`，供 `live_acceptance.py` 按 hwnd 分组逐项核验。验收通过要求至少一个 hwnd 自己完整覆盖 34/34 个 Maa 界面任务；多窗口报告会列出每个 hwnd 的完成数、缺失任务和权限证据。每个窗口的验收矩阵遇到第一个失败任务会停止，避免后续日志建立在已经偏离的游戏状态上。即使用管理员接管台跑完后再从普通终端执行审计，审计也会优先使用任务日志里的权限证据，避免误判。

release exe 也提供 headless 验收入口，适合最后一轮管理员实机长跑，不需要在 UI 里逐个点按钮：

```powershell
npm run tauri:build
npm run acceptance:release:admin
```

`acceptance:release:admin` 会通过 UAC 以管理员权限运行 `src-tauri/target/release/mhxy-shikong-control.exe --headless-acceptance --all-windows --missing-only`，对所有匹配 `梦幻西游：时空` 的窗口按 hwnd 并发、单 hwnd 串行补跑缺失 Maa 入口。它会继续写入同一套 `assets/resource/ShiKong/logs/task-*.json`，同时生成 `assets/resource/ShiKong/reports/latest-headless-acceptance.json`，随后刷新 `live_acceptance.py` 和 `acceptance_plan.py`。验收排序会把 `停止游戏` 放到最后，避免中途关闭 hwnd；每个任务报告会保存 `controllerElevated`、`targetElevated`、客户区宽高和 4:3 判断，供 StopApp 后审计使用。Dry-run 预检可用 `npm run acceptance:release:admin:dry`。

headless 验收默认使用 Maa interface 中的默认选项。需要传入非默认任务描述、队员名、捉鬼轮数、AI 答题配置等值时，复制 `assets/resource/ShiKong/headless_options.example.json` 为自己的本地 JSON，然后运行：

```powershell
npm run acceptance:options:validate -- --option-values assets/resource/ShiKong/headless_options.local.json
npm run acceptance:release:admin -- -OptionValues assets/resource/ShiKong/headless_options.local.json
```

JSON 支持 `global` 全局选项，以及 `tasks` 中按任务名、entry 或 task id 覆盖；优先级是默认值 < global < entry < 任务名 < task id。`acceptance:options:validate` 会只读校验任务键、Maa 选项名、select/switch case、checkbox case、input 字段和 int 类型；`acceptance:release:admin -OptionValues ...` 也会在管理员长跑前自动校验一次。真实配置文件不要提交敏感 API key。

接管台的 `迁移门禁` 区域会展示实机验收摘要、检查项、每个 hwnd 的 34 任务真实覆盖和 dry-run 预检覆盖，以及最近任务报告的任务名、窗口、完成状态、步数和停止原因。点击 `刷新实机验收` 会在接管台内调用 `scripts\live_acceptance.py` 重新生成 `latest-live-acceptance.json` 并立即读取展示；如果报告文件没有被本次刷新更新，接管台会报错而不是展示旧结果。单任务、已选窗口任务、预设和全任务验收矩阵的真实运行结束后也会自动刷新该报告。Dry-run 覆盖只用于提前发现入口/识别/日志链路问题，最终完成仍以非 dry-run 的 per-hwnd 34/34 覆盖为准。

同一区域的 `刷新验收计划` 会调用 `scripts\acceptance_plan.py`，把当前实机报告转换成每个 hwnd 的补跑计划，并在界面里直接显示下一步动作和缺失任务预览。

```powershell
python scripts\runtime_surface_audit.py
python scripts\live_acceptance.py
python scripts\acceptance_plan.py
python scripts\goal_readiness.py --require-live-acceptance
npm run acceptance:release:admin
```

`scripts\runtime_surface_audit.py` 会按 Rust 运行时实际加载的 pipeline 根（原 Maa base +
ShiKong override）审计 recognition、action、custom recognition、custom action 覆盖。报告会区分
34 个 interface 入口可达节点和全资源节点；interface 可达面不允许 unsupported 或 placeholder hook，
`StartApp` 在 PC 客户端语义下由“配置启动客户端”入口和任务内绑定窗口确认共同覆盖。

`scripts\acceptance_plan.py` 会把最新实机验收报告转换成每个 hwnd 的补跑计划，输出
`assets/resource/ShiKong/reports/latest-acceptance-plan.json` 和 `.html`。它只读报告和
`interface.json`，不会发送输入，也不会启动或关闭游戏；当某个 hwnd 已经有部分真实任务报告时，
计划会只列剩余缺失 Maa 任务。

`scripts\template_triage_report.py` 会生成只读审计页面和 JSON：

```text
assets/resource/ShiKong/reports/latest-unmapped-triage.html
assets/resource/ShiKong/reports/latest-unmapped-triage.json
```

报告会按未替换模板优先级展示原 Maa 小图、引用 pipeline/节点、建议采集界面，以及当前时空截图中的 ROI 候选裁剪。默认只在原 Maa ROI 附近搜索，减少误匹配；如需全图线索可加 `--search-mode both`。报告不会写入替换图，也不会修改 `template_mapping.json`，候选必须人工确认后再用拖框或裁剪计划应用。

`scripts\suggest_templates.py --append-variant` 只在显式 `--apply` 时生效。它会把已存在映射的新截图保存到 `assets/resource/ShiKong/image_variants/**` 并追加到 `variants[]`，不会覆盖第一张已确认模板。

`scripts\apply_probe_variants.py` 用于把离线 probe 已经确认命中的 ShiKong 模板固化为变体。它只接受 `source=ShiKong`、`hit=true`、分数超过阈值的项目，并按每个唯一模板限量裁剪，适合把不同窗口尺寸下的已验证命中保存下来。

仍需继续迁移：

- OCR 原生推理后端和模型目录；当前 RapidOCR Python 桥接可先支撑 OCR 节点迁移。
- Maa pipeline 的子任务返回/`JumpBack` 语义已按候选组模型实现：`next/on_error` 会按 Maa 默认 `timeout=20s`、`rate_limit=1000ms` 轮询候选列表，`[JumpBack]` 成功后返回父节点候选列表。
- 仍需在真实时空版客户端上逐任务回归候选轮询和错误回退路径。
- 时空版所有关键模板的重采和回归验证。
- 仍需在 release/管理员接管台里使用配置启动入口和真实窗口长跑验收；`StopApp` 已改为仅向当前绑定 hwnd 投递 `WM_CLOSE`，不会按进程名批量杀游戏进程。

## 当前覆盖核查

静态解析原 `assets/interface.json`：

```text
任务：34
选项定义：20
任务选项引用：14，缺失 0
嵌套选项引用：5，缺失 0
pipeline_override 涉及节点：31
preset：4，preset 任务引用：62，缺失 0
```

兼容审计当前验证结果：

```text
Rust 单元/资源测试：39 passed
前端构建：npm run build passed
Maa 任务入口：34/34 found
Preset：4 个，62 个任务引用，缺失 0
next/on_error 节点引用：缺失 0
unsupported hook：0
manual hook：0
runtime surface：interface 可达 594 节点，placeholder 0，missing refs 0
StartApp：supported，配置启动客户端 + 任务内确认当前绑定 hwnd
StopApp：supported，仅关闭当前绑定 hwnd，不按进程名杀进程
输入安全审计：npm run audit:input-safety passed；33 个源码/脚本文件中 forbidden real-input token 0，hwnd PostMessage/WM_* 输入证据 44 处
```

当前图片验证结果：

```text
已确认 ShiKong 唯一模板：88/265
文本/颜色/物品名 fallback 覆盖：178 个模板
ShiKong pipeline 覆盖移除旧模板依赖：6 个模板（wujian/bcg/baicaogu_weizhi1/2/3.png、baicaogu_shenshu_xiaoshi.png、wujian/mz/mz_mubiao_diban*.png）
运行时识别覆盖：265/265
界面任务可达运行时覆盖：230/230
validate_mapped_templates.py --min-score 0.82：98/98 passed（主映射 + 变体全部可回源命中）
combined-latest-verified-panels：34 张可靠截图，覆盖 home、队伍、背包、活动分类、小地图/世界地图、福利、商城/商会/摆摊、好友、帮派、技能/工坊、秘境模式等入口状态
probe_capture_manifest.py latest-manifest-probe：85 个唯一已映射模板在综合可靠截图集中命中
migration_status.py latest-migration-status：任务入口 34/34、preset 引用 62/62 通过；模板映射覆盖 88/265，运行时覆盖 265/265，界面任务可达运行时覆盖 230/230，最新可靠 manifest 命中 85/265，完成门禁通过；全图片实体映射和综合截图命中是 audit warning
当前全资源运行时缺口：0。剩余 audit warning 是全图片实体映射 88/265 和综合截图命中 85/265；大量模板已由 OCR/颜色/物品名 fallback 或 pipeline 覆盖承担运行时识别，不再需要实际替换小图。
实机验收缺口：还没有 `task-*.json` 非 dry-run 任务完成报告覆盖 34 个 Maa 入口；如果目标游戏是管理员权限而接管台不是管理员权限，真实后台输入会被 Windows UIPI 拦截。优先使用 `npm run acceptance:release:admin` 让 release exe 以管理员权限 headless 补跑缺失验收；也可以使用 `npm run tauri:dev:admin` 或 release 接管台 UI 后，在接管台点击 `执行全任务验收` 或 `执行已选窗口验收` 沉淀日志，再跑 `python scripts\live_acceptance.py` 验收。
已验证 PC 端后台队伍入口：Alt+T，经 `team-panel` 采集成功；原 Maa 的 `[57,48]` 在时空 PC 端只会残留/展开右下菜单，不再作为队伍步骤使用
```

下一批截图优先级：

```text
综合主界面更多展开态：任务、活动、队伍、背包、福利、商城、地图
日常任务链：抓鬼、宝图、运镖、副本、秘境、帮派签到、帮派答题
战斗和技能：战斗按钮、技能升级/加点、宠物/坐骑/布置
问答/OCR：日常答题、三界奇缘、帮派万卷答题、聊天答题窗口
账号/启动页：服务器状态点、登录/选区/角色选择界面
```

目标仍然是完整覆盖原 `Maa_MHXY_MG` 的所有功能。
