import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

const TARGET_TITLE = "梦幻西游：时空";
const WORKSPACE_SCHEMA_VERSION = 6;
const DEFAULT_IMAGE_THRESHOLD = 0.86;
const WINDOW_CLIENT_SIZE_TOLERANCE = 2;
const MAX_LOG_ROWS = 500;
const MAX_SESSION_STEP_RESULTS = 300;
const MAX_TEXT_INPUT_CHARS = 500;
const targetBackedStepTypes = new Set(["image_click", "wait_image", "detect_page", "click", "ocr_assert"]);
const capturedImageStepTypes = new Set(["image_click", "wait_image", "detect_page"]);
const stepFailActions = new Set(["stop", "retry", "skip", "restore"]);
const targetKindOptions = ["image", "roi", "page", "ocr", "click_target", "state", "unknown"];
const workflowConcurrencyOptions = new Set(["per-window-exclusive"]);
const imageClickPointOptions = new Set(["center", "top-left", "top-right", "bottom-left", "bottom-right"]);
const builtinTargetTemplateBindings = [
  { target: "page.home.ready", key: "zonghe/jiahao.png", kind: "page", name: "主界面判定", threshold: 0.86 },
  { target: "target.activity.icon", key: "zonghe/huodong1.png", kind: "image", name: "活动入口" },
  { target: "page.activity.ready", key: "zonghe/huodong_jiemian_panduan.png", kind: "page", name: "活动界面判定" },
  { target: "button.welfare", key: "qiandao/fuli.png", kind: "image", name: "福利入口" },
  { target: "page.welfare.ready", key: "qiandao/fuli.png", kind: "page", name: "福利界面判定" },
  { target: "button.cumulative_reward", key: "qiandao/leiji2.png", kind: "image", name: "累计奖励" },
  { target: "page.guild.ready", key: "qiandao/bangpai_jiemian_panduan.png", kind: "page", name: "帮派界面判定" },
  { target: "button.guild_welfare", key: "qiandao/bangpaifuli.png", kind: "image", name: "帮派福利入口" },
  { target: "button.guild_checkin", key: "qiandao/bangpaifuli.png", kind: "image", name: "帮派福利签到区" },
  { target: "button.confirm", key: "zonghe/zhujiemian_shiyong_cha.png", kind: "image", name: "确认/关闭按钮" },
  { target: "button.team_up", key: "duiwu/duiwu-zudui.png", kind: "image", name: "组队按钮" },
  { target: "page.team.ready", key: "duiwu/duiwu-duiwu.png", kind: "page", name: "队伍界面判定" },
  { target: "page.bag.ready", key: "beibao/beibao_jiemian_panduan.png", kind: "page", name: "背包界面判定" },
  { target: "button.home_clean", key: "jiayuan/dali.png", kind: "image", name: "家园打理按钮" },
  { target: "page.home_yard.ready", key: "jiayuan/dali.png", kind: "page", name: "家园打理页判定" },
  { target: "item.target", key: "beibao/zhenfajuan.png", kind: "image", name: "示例背包物品", threshold: 0.82 },
  { target: "item.treasure_map", key: "baotu/cangbaotu.png", kind: "image", name: "藏宝图物品" },
  { target: "entry.secret_realm", key: "mijing/mijing_moshi.png", kind: "image", name: "秘境入口/模式" },
  { target: "item.realm_material", key: "mijing_cailiao/nanshanyu.png", kind: "image", name: "秘境材料" },
  { target: "target.realm_material", key: "mijing_cailiao/nanshanyu.png", kind: "image", name: "秘境材料确认" },
  { target: "page.stall.ready", key: "shangcheng/baitan_zhujiemian.png", kind: "page", name: "摆摊界面判定" },
  { target: "page.quest.ready", key: "zonghe/renwu_tanchuang.png", kind: "page", name: "任务面板判定" },
  { target: "item.current_quest", key: "zonghe/rwl_suojin.png", kind: "image", name: "当前任务条目" },
  { target: "item.target_material", key: "beibao/bailianjingtie.png", kind: "image", name: "目标材料" },
];

const stepTypes = [
  ["detect_page", "检测页面"],
  ["wait_image", "等待图像"],
  ["image_click", "图像点击"],
  ["ocr_assert", "OCR 确认"],
  ["click", "后台点击"],
  ["hotkey", "快捷键"],
  ["text_input", "文本输入"],
  ["delay", "延迟等待"],
  ["condition", "条件判断"],
  ["retry_until", "重试直到"],
  ["snapshot", "截图记录"],
  ["restore", "恢复状态"],
];

const stepLabels = Object.fromEntries(stepTypes);

const stepDefaults = {
  detect_page: {
    name: "检测页面",
    target: "page.home.ready",
    command: "match=image_or_ocr",
    expect: "ready=true",
    timeoutMs: 3000,
    retry: 2,
    onFail: "restore",
  },
  wait_image: {
    name: "等待图像",
    target: "target.image",
    command: "threshold=0.86",
    expect: "visible",
    timeoutMs: 5000,
    retry: 2,
    onFail: "retry",
  },
  image_click: {
    name: "图像点击",
    target: "button.target",
    command: "button=left; point=center",
    expect: "screen.changed",
    timeoutMs: 2600,
    retry: 1,
    onFail: "retry",
  },
  ocr_assert: {
    name: "OCR 确认",
    target: "text.keyword",
    command: "lang=zh; roi=auto",
    expect: "text_found",
    timeoutMs: 4200,
    retry: 2,
    onFail: "restore",
  },
  click: {
    name: "后台点击",
    target: "x=0,y=0",
    command: "button=left; mode=hwnd-message",
    expect: "click.accepted",
    timeoutMs: 1300,
    retry: 0,
    onFail: "stop",
  },
  hotkey: {
    name: "快捷键",
    target: "ALT+N",
    command: "mode=hwnd-key",
    expect: "panel.open",
    timeoutMs: 1200,
    retry: 0,
    onFail: "stop",
  },
  text_input: {
    name: "文本输入",
    target: "要输入的文本",
    command: "mode=hwnd-char",
    expect: "text.sent",
    timeoutMs: 1200,
    retry: 0,
    onFail: "stop",
  },
  delay: {
    name: "延迟等待",
    target: "800ms",
    command: "reason=animation",
    expect: "time.elapsed",
    timeoutMs: 800,
    retry: 0,
    onFail: "skip",
  },
  condition: {
    name: "条件判断",
    target: "state.flag",
    command: "guard=true",
    expect: "condition.checked",
    timeoutMs: 1000,
    retry: 0,
    onFail: "skip",
  },
  retry_until: {
    name: "重试直到",
    target: "page.target.ready",
    command: "interval=800ms",
    expect: "ready=true",
    timeoutMs: 8000,
    retry: 5,
    onFail: "restore",
  },
  snapshot: {
    name: "截图记录",
    target: "window.client",
    command: "dry-run log only",
    expect: "snapshot.recorded",
    timeoutMs: 1000,
    retry: 0,
    onFail: "skip",
  },
  restore: {
    name: "恢复状态",
    target: "restore.home",
    command: "safe sequence",
    expect: "page.home.ready",
    timeoutMs: 6000,
    retry: 1,
    onFail: "stop",
  },
};

const stepBlockPresets = [
  {
    id: "open-panel",
    label: "打开界面 · 3步",
    steps: [
      { type: "hotkey", name: "打开目标界面", target: "ALT+N", command: "mode=hwnd-key", expect: "panel.open" },
      { type: "delay", name: "等待界面动画", target: "800ms", command: "reason=panel_transition", expect: "time.elapsed" },
      { type: "detect_page", name: "确认界面就绪", target: "page.target.ready", command: "threshold=0.86", expect: "ready=true" },
    ],
  },
  {
    id: "image-click-flow",
    label: "识图点击 · 4步",
    steps: [
      { type: "wait_image", name: "等待目标出现", target: "target.image", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "点击目标", target: "button.target", command: "button=left; point=center", expect: "screen.changed" },
      { type: "delay", name: "等待点击反馈", target: "600ms", command: "reason=click_feedback", expect: "time.elapsed" },
      { type: "retry_until", name: "等待下一状态", target: "page.next.ready", command: "interval=600ms", expect: "ready=true", timeoutMs: 5000, retry: 2 },
    ],
  },
  {
    id: "text-input",
    label: "文本输入 · 2步",
    steps: [
      { type: "text_input", name: "输入文本", target: "要输入的文本", command: "mode=hwnd-char", expect: "text.sent" },
      { type: "delay", name: "等待输入反馈", target: "300ms", command: "reason=text_input_feedback", expect: "time.elapsed" },
    ],
  },
  {
    id: "right-click-item",
    label: "物品右键 · 4步",
    steps: [
      { type: "wait_image", name: "查找物品图标", target: "item.target", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "右键使用物品", target: "item.target", command: "button=right; point=center", expect: "action.accepted" },
      { type: "delay", name: "等待服务器反馈", target: "1000ms", command: "reason=server_response", expect: "time.elapsed" },
      { type: "snapshot", name: "记录使用结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
    ],
  },
  {
    id: "guard-snapshot",
    label: "状态检查 · 3步",
    steps: [
      { type: "detect_page", name: "检测当前页面", target: "page.current.ready", command: "threshold=0.86", expect: "ready=true" },
      { type: "condition", name: "判断是否继续", target: "state.can_continue", command: "guard=true", expect: "continue" },
      { type: "snapshot", name: "记录判断现场", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
    ],
  },
  {
    id: "full-task-skeleton",
    label: "完整任务骨架 · 10步",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开目标面板", target: "ALT+N", command: "mode=hwnd-key", expect: "panel.open" },
      { type: "delay", name: "等待面板动画", target: "800ms", command: "reason=panel_transition", expect: "time.elapsed" },
      { type: "wait_image", name: "等待入口出现", target: "entry.target", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "进入目标页面", target: "entry.target", command: "button=left; point=center", expect: "page.target.open" },
      { type: "delay", name: "等待切页", target: "700ms", command: "reason=page_transition", expect: "time.elapsed" },
      { type: "wait_image", name: "等待操作按钮", target: "button.primary_action", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "执行主要操作", target: "button.primary_action", command: "button=left; point=center", expect: "action.accepted" },
      { type: "snapshot", name: "记录结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
];

const workflowBlueprints = [
  {
    id: "home-vitality",
    label: "家园活力",
    category: "家园",
    defaultPrefix: "家园活力",
    description: "打开家园/人物相关入口，按 OCR 和图像目标处理活力、打理与确认动作。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开功能面板", target: "ALT+N", command: "mode=hwnd-key", expect: "panel.open" },
      { type: "delay", name: "等待面板动画", target: "800ms", command: "reason=panel_transition", expect: "time.elapsed" },
      { type: "ocr_assert", name: "确认功能面板", target: "家园", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "wait_image", name: "等待家园入口", target: "entry.home", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "进入家园", target: "entry.home", command: "button=left; point=center", expect: "home.panel.ready" },
      { type: "retry_until", name: "等待家园页面", target: "page.home_yard.ready", command: "interval=700ms", expect: "ready=true", timeoutMs: 7000, retry: 3 },
      { type: "wait_image", name: "等待打理按钮", target: "button.home_clean", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "执行打理", target: "button.home_clean", command: "button=left; point=center", expect: "action.accepted" },
      { type: "delay", name: "等待反馈", target: "1000ms", command: "reason=server_response", expect: "time.elapsed" },
      { type: "ocr_assert", name: "确认活力状态", target: "活力", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "snapshot", name: "记录家园结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "daily-reward",
    label: "福利签到",
    category: "日常",
    defaultPrefix: "福利签到",
    description: "进入福利/活动页面，处理签到、确认弹窗和奖励记录。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开活动面板", target: "ALT+N", command: "mode=hwnd-key", expect: "activity.panel.open" },
      { type: "wait_image", name: "等待福利入口", target: "button.welfare", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "进入福利页", target: "button.welfare", command: "button=left; point=center", expect: "welfare.visible" },
      { type: "delay", name: "等待切页动画", target: "700ms", command: "reason=page_transition", expect: "time.elapsed" },
      { type: "ocr_assert", name: "确认福利标题", target: "福利", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "wait_image", name: "等待签到按钮", target: "button.sign_in", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "点击签到", target: "button.sign_in", command: "button=left; point=center", expect: "reward.popup" },
      { type: "image_click", name: "确认奖励", target: "button.confirm", command: "button=left; point=center", expect: "popup.closed" },
      { type: "retry_until", name: "等待福利页稳定", target: "page.welfare.ready", command: "interval=600ms", expect: "ready=true", timeoutMs: 5000, retry: 3 },
      { type: "snapshot", name: "记录领取结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "bag-item-use",
    label: "背包物品",
    category: "背包",
    defaultPrefix: "背包物品",
    description: "打开背包，识别目标物品，支持左键选择、右键使用和确认弹窗。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开背包", target: "ALT+E", command: "mode=hwnd-key", expect: "bag.open" },
      { type: "wait_image", name: "等待背包界面", target: "page.bag.ready", command: "threshold=0.85", expect: "visible" },
      { type: "ocr_assert", name: "确认背包标题", target: "包裹", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "wait_image", name: "查找目标物品", target: "item.target", command: "threshold=0.88", expect: "visible" },
      { type: "image_click", name: "选择目标物品", target: "item.target", command: "button=left; point=center", expect: "item.selected" },
      { type: "image_click", name: "右键使用物品", target: "item.target", command: "button=right; point=center", expect: "action.accepted" },
      { type: "delay", name: "等待服务器反馈", target: "1000ms", command: "reason=server_response", expect: "time.elapsed" },
      { type: "ocr_assert", name: "确认物品提示", target: "使用", command: "lang=zh; roi=dialog", expect: "text_found" },
      { type: "image_click", name: "确认使用", target: "button.confirm", command: "button=left", expect: "popup.closed" },
      { type: "snapshot", name: "记录物品结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "team-prep",
    label: "组队准备",
    category: "组队",
    defaultPrefix: "组队准备",
    description: "打开队伍界面，选择活动分类，等待目标活动并尝试申请或确认队伍状态。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开队伍", target: "ALT+T", command: "mode=hwnd-key", expect: "team.panel.open" },
      { type: "wait_image", name: "等待组队按钮", target: "button.team_up", command: "threshold=0.84", expect: "visible" },
      { type: "image_click", name: "进入组队", target: "button.team_up", command: "button=left; point=center", expect: "team.list.visible" },
      { type: "ocr_assert", name: "确认组队标题", target: "组队", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "image_click", name: "选择活动分类", target: "tab.daily_activity", command: "button=left", expect: "activity.filter.ready" },
      { type: "retry_until", name: "等待目标活动", target: "text.target_activity", command: "interval=800ms", expect: "text_found", timeoutMs: 7000, retry: 4 },
      { type: "click", name: "点击第一条队伍", target: "list.row.1", command: "button=left; mode=hwnd-message", expect: "team.detail.open" },
      { type: "image_click", name: "申请加入", target: "button.apply_join", command: "button=left", expect: "apply.sent" },
      { type: "delay", name: "等待申请反馈", target: "1200ms", command: "reason=server_response", expect: "time.elapsed" },
      { type: "snapshot", name: "记录队伍状态", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "guild-checkin",
    label: "帮派签到",
    category: "帮派",
    defaultPrefix: "帮派签到",
    description: "进入帮派福利，处理签到、累计奖励、结果确认和恢复。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开帮派", target: "ALT+B", command: "mode=hwnd-key", expect: "guild.panel.open" },
      { type: "wait_image", name: "等待帮派页", target: "page.guild.ready", command: "threshold=0.84", expect: "visible" },
      { type: "image_click", name: "进入帮派福利", target: "button.guild_welfare", command: "button=left", expect: "guild.welfare.ready" },
      { type: "ocr_assert", name: "确认福利文字", target: "帮派福利", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "wait_image", name: "等待签到按钮", target: "button.guild_checkin", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "点击签到", target: "button.guild_checkin", command: "button=left", expect: "reward.popup" },
      { type: "image_click", name: "领取累计", target: "button.cumulative_reward", command: "button=left", expect: "maybe.reward" },
      { type: "delay", name: "等待奖励动画", target: "900ms", command: "reason=reward_animation", expect: "time.elapsed" },
      { type: "ocr_assert", name: "确认领取结果", target: "已领取", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "snapshot", name: "记录帮派福利", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "mail-claim",
    label: "邮件领取",
    category: "日常",
    defaultPrefix: "邮件领取",
    description: "打开邮件/系统消息，识别可领取附件，确认领取并记录结果。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开消息入口", target: "ALT+M", command: "mode=hwnd-key", expect: "mail.panel.open" },
      { type: "wait_image", name: "等待邮件列表", target: "page.mail.ready", command: "threshold=0.84", expect: "visible" },
      { type: "ocr_assert", name: "确认邮件标题", target: "邮件", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "condition", name: "检查是否有未读附件", target: "state.mail_attachment", command: "guard=true", expect: "continue" },
      { type: "wait_image", name: "查找附件图标", target: "icon.mail_attachment", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "选择附件邮件", target: "icon.mail_attachment", command: "button=left; point=center", expect: "mail.detail.open" },
      { type: "image_click", name: "领取附件", target: "button.claim_attachment", command: "button=left; point=center", expect: "reward.popup" },
      { type: "image_click", name: "确认领取", target: "button.confirm", command: "button=left; point=center", expect: "popup.closed" },
      { type: "retry_until", name: "等待附件状态刷新", target: "state.mail_attachment_claimed", command: "interval=700ms", expect: "true", timeoutMs: 6000, retry: 3 },
      { type: "snapshot", name: "记录邮件结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "pet-care",
    label: "宠物照料",
    category: "宠物",
    defaultPrefix: "宠物照料",
    description: "打开宠物界面，检查状态、喂养或使用道具，并确认反馈。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开宠物界面", target: "ALT+P", command: "mode=hwnd-key", expect: "pet.panel.open" },
      { type: "wait_image", name: "等待宠物面板", target: "page.pet.ready", command: "threshold=0.84", expect: "visible" },
      { type: "ocr_assert", name: "确认宠物标题", target: "宠物", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "condition", name: "判断是否需要喂养", target: "state.pet_needs_food", command: "guard=true", expect: "continue" },
      { type: "wait_image", name: "查找喂养按钮", target: "button.pet_feed", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "点击喂养", target: "button.pet_feed", command: "button=left; point=center", expect: "bag.item.pick" },
      { type: "wait_image", name: "等待口粮物品", target: "item.pet_food", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "选择口粮", target: "item.pet_food", command: "button=left; point=center", expect: "item.selected" },
      { type: "image_click", name: "确认使用", target: "button.confirm", command: "button=left; point=center", expect: "pet.feed.done" },
      { type: "ocr_assert", name: "确认宠物状态", target: "气血", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "snapshot", name: "记录宠物结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "stall-search",
    label: "摊位搜索",
    category: "交易",
    defaultPrefix: "摊位搜索",
    description: "打开摊位/摆摊界面，输入搜索词，仅采集和确认结果，不默认购买。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开交易入口", target: "ALT+S", command: "mode=hwnd-key", expect: "market.panel.open" },
      { type: "wait_image", name: "等待摊位界面", target: "page.stall.ready", command: "threshold=0.84", expect: "visible" },
      { type: "ocr_assert", name: "确认交易标题", target: "摊位", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "image_click", name: "点击搜索框", target: "input.stall_search", command: "button=left; point=center", expect: "input.focused" },
      { type: "text_input", name: "输入搜索词", target: "搜索关键词", command: "mode=hwnd-char", expect: "text.sent" },
      { type: "image_click", name: "执行搜索", target: "button.search", command: "button=left; point=center", expect: "search.sent" },
      { type: "retry_until", name: "等待搜索结果", target: "list.search_result.ready", command: "interval=800ms", expect: "ready=true", timeoutMs: 8000, retry: 4 },
      { type: "ocr_assert", name: "确认结果文字", target: "价格", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "condition", name: "默认不购买", target: "state.purchase_allowed", command: "guard=false", expect: "manual_review" },
      { type: "snapshot", name: "记录搜索结果", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "quest-chain",
    label: "任务链检查",
    category: "任务",
    defaultPrefix: "任务链检查",
    description: "打开任务面板，定位当前任务、识别目标按钮，适合串成多窗口状态检查。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开任务面板", target: "ALT+Q", command: "mode=hwnd-key", expect: "quest.panel.open" },
      { type: "wait_image", name: "等待任务列表", target: "page.quest.ready", command: "threshold=0.84", expect: "visible" },
      { type: "ocr_assert", name: "确认任务标题", target: "任务", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "wait_image", name: "查找当前任务", target: "item.current_quest", command: "threshold=0.84", expect: "visible" },
      { type: "image_click", name: "选择当前任务", target: "item.current_quest", command: "button=left; point=center", expect: "quest.detail.open" },
      { type: "ocr_assert", name: "确认任务说明", target: "目标", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "condition", name: "判断是否可自动寻路", target: "state.quest_auto_path", command: "guard=true", expect: "continue" },
      { type: "image_click", name: "点击自动寻路", target: "button.auto_path", command: "button=left; point=center", expect: "path.started" },
      { type: "retry_until", name: "等待寻路状态", target: "state.pathing", command: "interval=1000ms", expect: "true", timeoutMs: 9000, retry: 5 },
      { type: "snapshot", name: "记录任务状态", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
  {
    id: "material-prep",
    label: "材料整理",
    category: "背包",
    defaultPrefix: "材料整理",
    description: "检查背包材料、仓库入口和确认弹窗，适合做副本/生活技能前置准备。",
    steps: [
      { type: "detect_page", name: "确认主界面", target: "page.home.ready", command: "threshold=0.86", expect: "home.visible" },
      { type: "hotkey", name: "打开背包", target: "ALT+E", command: "mode=hwnd-key", expect: "bag.open" },
      { type: "wait_image", name: "等待背包界面", target: "page.bag.ready", command: "threshold=0.85", expect: "visible" },
      { type: "ocr_assert", name: "确认背包标题", target: "包裹", command: "lang=zh; roi=top", expect: "text_found" },
      { type: "condition", name: "检查背包空间", target: "state.bag_space", command: "guard=>2", expect: "continue" },
      { type: "wait_image", name: "查找目标材料", target: "item.target_material", command: "threshold=0.86", expect: "visible" },
      { type: "image_click", name: "选择目标材料", target: "item.target_material", command: "button=left; point=center", expect: "item.selected" },
      { type: "image_click", name: "移动到整理区", target: "button.sort_material", command: "button=left; point=center", expect: "sort.accepted" },
      { type: "delay", name: "等待整理反馈", target: "900ms", command: "reason=server_response", expect: "time.elapsed" },
      { type: "ocr_assert", name: "确认整理结果", target: "整理", command: "lang=zh; roi=panel", expect: "text_found" },
      { type: "snapshot", name: "记录材料状态", target: "window.client", command: "dry-run log only", expect: "snapshot.recorded" },
      { type: "restore", name: "恢复主界面", target: "restore.home", command: "safe sequence", expect: "page.home.ready" },
    ],
  },
];

const exerciseSuiteBlueprintIds = [
  "home-vitality",
  "daily-reward",
  "bag-item-use",
  "team-prep",
  "guild-checkin",
  "mail-claim",
  "pet-care",
  "stall-search",
  "quest-chain",
  "material-prep",
];
const exerciseSuiteQueuePattern = [2, 5, 7, 3, 9, 4, 6, 8, 1, 10];

const state = {
  windows: [],
  selected: new Set(),
  activeHwnd: null,
  privilege: null,
  launchStatus: null,
  preview: null,
  previewSource: "window",
  roiSelection: null,
  roiDragStart: null,
  previewClickCapture: false,
  previewClickButton: "left",
  workspace: createSeedWorkspace(),
  workspacePath: "",
  selectedStepId: null,
  selectedTargetId: "",
  targetSearch: "",
  targetKindFilter: "all",
  stepValidation: {},
  saveTimer: null,
  sessions: {},
  sessionSerial: 0,
};

const $ = (selector) => document.querySelector(selector);
const appWindow = getCurrentWindow();

async function setupCloseToTray() {
  try {
    await appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      await appWindow.hide();
    });
  } catch (error) {
    appendLog("warn", `关闭到托盘监听注册失败：${error}`);
  }
}

function setStatus(message) {
  $("#status").textContent = message;
}

function setRunState(value) {
  const element = $("#run-state");
  element.textContent = value;
  element.classList.remove("idle", "ready", "running", "blocked");
  element.classList.add(value);
  renderOpsDashboard();
}

function appendLog(level, message) {
  const row = document.createElement("div");
  row.className = `log-row ${level}`;
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  row.innerHTML = `
    <span>${escapeHtml(time)}</span>
    <strong>${escapeHtml(level)}</strong>
    <p>${escapeHtml(message)}</p>
  `;
  const log = $("#run-log");
  log.prepend(row);
  while (log.children.length > MAX_LOG_ROWS) {
    log.lastElementChild?.remove();
  }
}

function createSeedWorkspace() {
  const workflows = createSampleWorkflows();
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeWorkflowId: workflows[0]?.id || null,
    workflows,
    assignments: {},
    targets: createTargetCatalogFromWorkflows(workflows),
    runHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createSampleWorkflows() {
  return [
    workflow("wf-daily-welfare", "每日福利领取", "日常", "从主界面进入活动与福利页，领取可见奖励后恢复首页。", [
      step("daily-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("daily-02", "hotkey", "打开活动面板", "ALT+N", "mode=hwnd-key", "activity.panel.open"),
      step("daily-03", "wait_image", "等待活动入口", "target.activity.icon", "threshold=0.86", "visible"),
      step("daily-04", "image_click", "进入福利页", "button.welfare", "button=left; point=center", "welfare.visible"),
      step("daily-05", "delay", "等待切页动画", "700ms", "reason=panel_transition", "time.elapsed"),
      step("daily-06", "ocr_assert", "确认福利标题", "福利", "lang=zh; roi=top", "text_found"),
      step("daily-07", "image_click", "点击签到", "button.sign_in", "button=left; point=center", "reward.popup"),
      step("daily-08", "condition", "判断是否已领取", "state.reward_claimed", "guard=false", "continue"),
      step("daily-09", "image_click", "确认奖励", "button.confirm", "button=left; point=center", "popup.closed"),
      step("daily-10", "snapshot", "记录领取结果", "window.client", "dry-run log only", "snapshot.recorded"),
      step("daily-11", "retry_until", "等待回到福利页", "page.welfare.ready", "interval=600ms", "ready=true", 5000, 3),
      step("daily-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-team-activity", "组队活动准备", "组队", "选择活动、检查队伍入口和确认状态，适合多窗口分别跑准备流程。", [
      step("team-01", "detect_page", "确认当前页面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("team-02", "hotkey", "打开队伍", "ALT+T", "mode=hwnd-key", "team.panel.open"),
      step("team-03", "wait_image", "等待组队按钮", "button.team_up", "threshold=0.84", "visible"),
      step("team-04", "image_click", "进入组队", "button.team_up", "button=left; point=center", "team.list.visible"),
      step("team-05", "ocr_assert", "确认组队标题", "组队", "lang=zh; roi=top", "text_found"),
      step("team-06", "condition", "判断是否已有队伍", "state.in_team", "guard=false", "create_or_join"),
      step("team-07", "image_click", "选择活动分类", "tab.daily_activity", "button=left", "activity.filter.ready"),
      step("team-08", "retry_until", "等待目标活动", "text.target_activity", "interval=800ms", "text_found", 7000, 4),
      step("team-09", "click", "点击第一条队伍", "list.row.1", "button=left; mode=hwnd-message", "team.detail.open"),
      step("team-10", "image_click", "申请加入", "button.apply_join", "button=left", "apply.sent"),
      step("team-11", "delay", "等待申请反馈", "1200ms", "reason=server_response", "time.elapsed"),
      step("team-12", "snapshot", "记录队伍状态", "window.client", "dry-run log only", "snapshot.recorded"),
      step("team-13", "restore", "返回主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-treasure-map", "藏宝图处理", "背包", "识别背包与藏宝图，按状态打开或跳过，并记录处理结果。", [
      step("map-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("map-02", "hotkey", "打开背包", "ALT+E", "mode=hwnd-key", "bag.open"),
      step("map-03", "wait_image", "等待背包界面", "page.bag.ready", "threshold=0.85", "visible"),
      step("map-04", "ocr_assert", "确认背包标题", "包裹", "lang=zh; roi=top", "text_found"),
      step("map-05", "condition", "背包是否已满", "state.bag_full", "guard=false", "continue"),
      step("map-06", "wait_image", "查找藏宝图", "item.treasure_map", "threshold=0.88", "visible"),
      step("map-07", "image_click", "选择藏宝图", "item.treasure_map", "button=left; point=center", "item.selected"),
      step("map-08", "click", "使用物品", "button.use_item", "button=right; mode=hwnd-message", "map.dialog"),
      step("map-09", "ocr_assert", "确认藏宝图提示", "藏宝图", "lang=zh; roi=dialog", "text_found"),
      step("map-10", "image_click", "确认使用", "button.confirm", "button=left", "action.accepted"),
      step("map-11", "retry_until", "等待状态变化", "state.map_consumed", "interval=900ms", "true", 7000, 4),
      step("map-12", "snapshot", "记录处理结果", "window.client", "dry-run log only", "snapshot.recorded"),
      step("map-13", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-guild-checkin", "帮派签到", "帮派", "从主界面进入帮派福利，处理签到和累计奖励。", [
      step("guild-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("guild-02", "hotkey", "打开帮派", "ALT+B", "mode=hwnd-key", "guild.panel.open"),
      step("guild-03", "wait_image", "等待帮派页", "page.guild.ready", "threshold=0.84", "visible"),
      step("guild-04", "image_click", "进入帮派福利", "button.guild_welfare", "button=left", "guild.welfare.ready"),
      step("guild-05", "ocr_assert", "确认福利文字", "帮派福利", "lang=zh; roi=top", "text_found"),
      step("guild-06", "condition", "判断今日是否已签", "state.guild_checked", "guard=false", "continue"),
      step("guild-07", "image_click", "点击签到", "button.guild_checkin", "button=left", "reward.popup"),
      step("guild-08", "image_click", "领取累计", "button.cumulative_reward", "button=left", "maybe.reward"),
      step("guild-09", "delay", "等待奖励动画", "900ms", "reason=reward_animation", "time.elapsed"),
      step("guild-10", "ocr_assert", "确认领取结果", "已领取", "lang=zh; roi=panel", "text_found"),
      step("guild-11", "snapshot", "记录帮派福利", "window.client", "dry-run log only", "snapshot.recorded"),
      step("guild-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-secret-realm", "秘境材料准备", "副本", "检查秘境入口、材料与队伍状态，失败时恢复到主界面。", [
      step("realm-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("realm-02", "hotkey", "打开活动", "ALT+N", "mode=hwnd-key", "activity.panel.open"),
      step("realm-03", "wait_image", "等待秘境入口", "entry.secret_realm", "threshold=0.84", "visible"),
      step("realm-04", "image_click", "进入秘境页", "entry.secret_realm", "button=left", "realm.panel.ready"),
      step("realm-05", "ocr_assert", "确认秘境标题", "秘境", "lang=zh; roi=top", "text_found"),
      step("realm-06", "condition", "检查次数是否可用", "state.realm_attempts", "guard=>0", "continue"),
      step("realm-07", "hotkey", "打开背包检查材料", "ALT+E", "mode=hwnd-key", "bag.open"),
      step("realm-08", "wait_image", "查找秘境材料", "item.realm_material", "threshold=0.86", "visible"),
      step("realm-09", "wait_image", "确认材料图标", "target.realm_material", "threshold=0.84", "material.visible"),
      step("realm-10", "click", "选择材料格", "grid.material_slot", "button=left; mode=hwnd-message", "item.selected"),
      step("realm-11", "retry_until", "等待准备就绪", "state.realm_ready", "interval=1000ms", "true", 9000, 5),
      step("realm-12", "snapshot", "记录准备状态", "window.client", "dry-run log only", "snapshot.recorded"),
      step("realm-13", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-mail-claim", "邮件领取", "日常", "识别系统邮件附件、领取并记录结果。", [
      step("mail-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("mail-02", "hotkey", "打开消息入口", "ALT+M", "mode=hwnd-key", "mail.panel.open"),
      step("mail-03", "wait_image", "等待邮件列表", "page.mail.ready", "threshold=0.84", "visible"),
      step("mail-04", "ocr_assert", "确认邮件标题", "邮件", "lang=zh; roi=top", "text_found"),
      step("mail-05", "condition", "检查未领附件", "state.mail_attachment", "guard=true", "continue"),
      step("mail-06", "wait_image", "查找附件图标", "icon.mail_attachment", "threshold=0.86", "visible"),
      step("mail-07", "image_click", "选择附件邮件", "icon.mail_attachment", "button=left; point=center", "mail.detail.open"),
      step("mail-08", "image_click", "领取附件", "button.claim_attachment", "button=left; point=center", "reward.popup"),
      step("mail-09", "image_click", "确认领取", "button.confirm", "button=left; point=center", "popup.closed"),
      step("mail-10", "retry_until", "等待附件状态刷新", "state.mail_attachment_claimed", "interval=700ms", "true", 6000, 3),
      step("mail-11", "snapshot", "记录邮件结果", "window.client", "dry-run log only", "snapshot.recorded"),
      step("mail-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-pet-care", "宠物照料", "宠物", "打开宠物界面，检查状态并执行喂养确认。", [
      step("pet-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("pet-02", "hotkey", "打开宠物界面", "ALT+P", "mode=hwnd-key", "pet.panel.open"),
      step("pet-03", "wait_image", "等待宠物面板", "page.pet.ready", "threshold=0.84", "visible"),
      step("pet-04", "ocr_assert", "确认宠物标题", "宠物", "lang=zh; roi=top", "text_found"),
      step("pet-05", "condition", "判断是否需要喂养", "state.pet_needs_food", "guard=true", "continue"),
      step("pet-06", "wait_image", "查找喂养按钮", "button.pet_feed", "threshold=0.86", "visible"),
      step("pet-07", "image_click", "点击喂养", "button.pet_feed", "button=left; point=center", "bag.item.pick"),
      step("pet-08", "wait_image", "等待口粮物品", "item.pet_food", "threshold=0.86", "visible"),
      step("pet-09", "image_click", "选择口粮", "item.pet_food", "button=left; point=center", "item.selected"),
      step("pet-10", "image_click", "确认使用", "button.confirm", "button=left; point=center", "pet.feed.done"),
      step("pet-11", "ocr_assert", "确认宠物状态", "气血", "lang=zh; roi=panel", "text_found"),
      step("pet-12", "snapshot", "记录宠物结果", "window.client", "dry-run log only", "snapshot.recorded"),
      step("pet-13", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-stall-search", "摊位搜索", "交易", "输入搜索词并采集摊位结果，默认不购买。", [
      step("stall-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("stall-02", "hotkey", "打开交易入口", "ALT+S", "mode=hwnd-key", "market.panel.open"),
      step("stall-03", "wait_image", "等待摊位界面", "page.stall.ready", "threshold=0.84", "visible"),
      step("stall-04", "ocr_assert", "确认交易标题", "摊位", "lang=zh; roi=top", "text_found"),
      step("stall-05", "image_click", "点击搜索框", "input.stall_search", "button=left; point=center", "input.focused"),
      step("stall-06", "text_input", "输入搜索词", "搜索关键词", "mode=hwnd-char", "text.sent"),
      step("stall-07", "image_click", "执行搜索", "button.search", "button=left; point=center", "search.sent"),
      step("stall-08", "retry_until", "等待搜索结果", "list.search_result.ready", "interval=800ms", "ready=true", 8000, 4),
      step("stall-09", "ocr_assert", "确认结果文字", "价格", "lang=zh; roi=panel", "text_found"),
      step("stall-10", "condition", "默认不购买", "state.purchase_allowed", "guard=false", "manual_review"),
      step("stall-11", "snapshot", "记录搜索结果", "window.client", "dry-run log only", "snapshot.recorded"),
      step("stall-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-quest-chain", "任务链检查", "任务", "定位当前任务、识别说明并尝试自动寻路。", [
      step("quest-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("quest-02", "hotkey", "打开任务面板", "ALT+Q", "mode=hwnd-key", "quest.panel.open"),
      step("quest-03", "wait_image", "等待任务列表", "page.quest.ready", "threshold=0.84", "visible"),
      step("quest-04", "ocr_assert", "确认任务标题", "任务", "lang=zh; roi=top", "text_found"),
      step("quest-05", "wait_image", "查找当前任务", "item.current_quest", "threshold=0.84", "visible"),
      step("quest-06", "image_click", "选择当前任务", "item.current_quest", "button=left; point=center", "quest.detail.open"),
      step("quest-07", "ocr_assert", "确认任务说明", "目标", "lang=zh; roi=panel", "text_found"),
      step("quest-08", "condition", "判断是否可自动寻路", "state.quest_auto_path", "guard=true", "continue"),
      step("quest-09", "image_click", "点击自动寻路", "button.auto_path", "button=left; point=center", "path.started"),
      step("quest-10", "retry_until", "等待寻路状态", "state.pathing", "interval=1000ms", "true", 9000, 5),
      step("quest-11", "snapshot", "记录任务状态", "window.client", "dry-run log only", "snapshot.recorded"),
      step("quest-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
    workflow("wf-material-prep", "材料整理", "背包", "检查背包材料、整理按钮和状态反馈。", [
      step("material-01", "detect_page", "确认主界面", "page.home.ready", "match=image_or_ocr", "home.visible"),
      step("material-02", "hotkey", "打开背包", "ALT+E", "mode=hwnd-key", "bag.open"),
      step("material-03", "wait_image", "等待背包界面", "page.bag.ready", "threshold=0.85", "visible"),
      step("material-04", "ocr_assert", "确认背包标题", "包裹", "lang=zh; roi=top", "text_found"),
      step("material-05", "condition", "检查背包空间", "state.bag_space", "guard=>2", "continue"),
      step("material-06", "wait_image", "查找目标材料", "item.target_material", "threshold=0.86", "visible"),
      step("material-07", "image_click", "选择目标材料", "item.target_material", "button=left; point=center", "item.selected"),
      step("material-08", "image_click", "移动到整理区", "button.sort_material", "button=left; point=center", "sort.accepted"),
      step("material-09", "delay", "等待整理反馈", "900ms", "reason=server_response", "time.elapsed"),
      step("material-10", "ocr_assert", "确认整理结果", "整理", "lang=zh; roi=panel", "text_found"),
      step("material-11", "snapshot", "记录材料状态", "window.client", "dry-run log only", "snapshot.recorded"),
      step("material-12", "restore", "恢复主界面", "restore.home", "safe sequence", "page.home.ready"),
    ]),
  ];
}

function workflow(id, name, category, description, steps) {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id,
    name,
    category,
    description,
    tags: [category, "示例"],
    initialCheck: "page.home.ready",
    targetPolicy: {
      titleNeedle: TARGET_TITLE,
      inputMode: "hwnd-message",
      concurrency: "per-window-exclusive",
    },
    steps,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function step(
  id,
  type,
  name,
  target,
  command,
  expect,
  timeoutMs = stepDefaults[type]?.timeoutMs ?? 3000,
  retry = stepDefaults[type]?.retry ?? 0,
  onFail = stepDefaults[type]?.onFail ?? "stop",
) {
  return {
    id,
    type,
    name,
    target,
    command,
    expect,
    timeoutMs,
    retry,
    onFail,
    enabled: true,
    notes: "",
  };
}

async function loadWorkspace() {
  try {
    const result = await invoke("load_workflow_workspace");
    state.workspacePath = result.path;
    state.workspace = normalizeWorkspace(result.data);
    let shouldSave = false;
    if (!state.workspace.workflows.length) {
      state.workspace = createSeedWorkspace();
      shouldSave = true;
      appendLog("info", `首次启动已写入 ${state.workspace.workflows.length} 个示例任务`);
    }
    const hydrated = await hydrateBuiltinTargetTemplates({ log: true });
    shouldSave = shouldSave || hydrated > 0;
    if (shouldSave) await saveWorkspaceNow();
    $("#workspace-state").textContent = result.existed ? "loaded" : "seeded";
    $("#workspace-state").classList.add("ok");
    $("#workspace-path").textContent = state.workspacePath;
  } catch (error) {
    state.workspace = createSeedWorkspace();
    await hydrateBuiltinTargetTemplates({ log: true });
    $("#workspace-state").textContent = "memory";
    $("#workspace-state").classList.remove("ok");
    $("#workspace-path").textContent = "工作区载入失败，当前使用内存草稿";
    appendLog("error", `工作区载入失败：${error}`);
  }
}

function normalizeWorkspace(value) {
  const seed = createSeedWorkspace();
  const source = value && typeof value === "object" ? value : {};
  const workflows = Array.isArray(source.workflows)
    ? source.workflows.map(normalizeWorkflow)
    : seed.workflows;
  const activeWorkflowId = workflows.some((item) => item.id === source.activeWorkflowId)
    ? source.activeWorkflowId
    : workflows[0]?.id || null;
  const targetSource = [
    ...(Array.isArray(source.assets) ? source.assets : []),
    ...(Array.isArray(source.targets) ? source.targets : []),
  ];
  const targets = targetSource.length
    ? mergeTargetCatalog(targetSource.map(normalizeTarget), workflows)
    : createTargetCatalogFromWorkflows(workflows);
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeWorkflowId,
    workflows,
    assignments: normalizeAssignments(source.assignments, workflows),
    targets,
    runHistory: Array.isArray(source.runHistory) ? source.runHistory.slice(0, 80) : [],
    createdAt: source.createdAt || new Date().toISOString(),
    updatedAt: source.updatedAt || new Date().toISOString(),
  };
}

function normalizeWorkflow(value) {
  const typeSafeSteps = Array.isArray(value?.steps) ? value.steps.map(normalizeStep) : [];
  const concurrency = String(value?.targetPolicy?.concurrency || "per-window-exclusive");
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: String(value?.id || randomId("wf")),
    name: String(value?.name || "未命名任务"),
    category: String(value?.category || "未分类"),
    description: String(value?.description || ""),
    tags: Array.isArray(value?.tags) ? value.tags.map(String) : [],
    initialCheck: String(value?.initialCheck || "page.home.ready"),
    targetPolicy: {
      titleNeedle: String(value?.targetPolicy?.titleNeedle || TARGET_TITLE),
      inputMode: String(value?.targetPolicy?.inputMode || "hwnd-message"),
      concurrency: workflowConcurrencyOptions.has(concurrency) ? concurrency : "per-window-exclusive",
    },
    steps: typeSafeSteps,
    createdAt: value?.createdAt || new Date().toISOString(),
    updatedAt: value?.updatedAt || new Date().toISOString(),
  };
}

function normalizeStep(value) {
  const type = stepLabels[value?.type] ? value.type : "detect_page";
  const defaults = stepDefaults[type];
  return {
    id: String(value?.id || randomId("step")),
    type,
    name: String(value?.name || defaults.name),
    target: String(value?.target || defaults.target),
    command: String(value?.command || defaults.command),
    expect: String(value?.expect || defaults.expect),
    timeoutMs: Number(value?.timeoutMs ?? defaults.timeoutMs),
    retry: Number(value?.retry ?? defaults.retry),
    onFail: normalizeStepFailAction(value?.onFail, defaults.onFail),
    enabled: value?.enabled !== false,
    targetId: value?.targetId ? String(value.targetId) : value?.assetId ? String(value.assetId) : "",
    notes: String(value?.notes || ""),
  };
}

function normalizeStepFailAction(value, fallback = "stop") {
  const action = String(value || "").trim();
  if (stepFailActions.has(action)) return action;
  const fallbackAction = String(fallback || "").trim();
  return stepFailActions.has(fallbackAction) ? fallbackAction : "stop";
}

function normalizeTarget(value) {
  const threshold = normalizedThreshold(value?.match?.threshold ?? value?.threshold, DEFAULT_IMAGE_THRESHOLD);
  return {
    id: String(value?.id || randomId("target")),
    name: String(value?.name || "未命名目标"),
    kind: String(value?.kind || (value?.dataUrl ? "image" : value?.roi ? "roi" : "unknown")),
    createdAt: String(value?.createdAt || new Date().toISOString()),
    updatedAt: String(value?.updatedAt || value?.createdAt || new Date().toISOString()),
    dataUrl: value?.dataUrl ? String(value.dataUrl) : "",
    roi: value?.roi || null,
    match: {
      threshold,
      scope: String(value?.match?.scope || (value?.roi ? "roi" : "window")),
    },
    texts: Array.isArray(value?.texts) ? value.texts.map(String).filter(Boolean) : [],
    click: {
      button: normalizedTargetButton(value?.click?.button || value?.button || "left"),
      point: String(value?.click?.point || value?.point || "center"),
    },
    source: value?.source || null,
    width: Number(value?.width || 0),
    height: Number(value?.height || 0),
    note: String(value?.note || ""),
  };
}

function mergeTargetCatalog(targets, workflows) {
  const byId = new Map();
  for (const target of createTargetCatalogFromWorkflows(workflows)) {
    byId.set(target.id, target);
  }
  for (const target of targets) {
    byId.set(target.id, target);
  }
  return [...byId.values()];
}

function createTargetCatalogFromWorkflows(workflows) {
  const byId = new Map();
  for (const workflow of workflows || []) {
    for (const item of workflow.steps || []) {
      const id = catalogTargetIdForStep(item);
      if (!id) continue;
      if (byId.has(id)) continue;
      byId.set(
        id,
        normalizeTarget({
          id,
          name: friendlyTargetName(id),
          kind: targetKindForStep(item),
          match: {
            threshold: commandValue(item.command, "threshold") || defaultThresholdForStep(item),
            scope: commandValue(item.command, "roi") || "window",
          },
          click: {
            button: normalizedButton(item.command),
            point: commandValue(item.command, "point") || "center",
          },
          texts: item.type === "ocr_assert" ? [item.target] : [],
          note: "由任务步骤生成的逻辑目标，可直接粘贴图片或绑定 ROI",
        }),
      );
    }
  }
  return [...byId.values()];
}

function isLogicalTargetName(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("=") || durationMsFromText(text) != null) return false;
  if (/^[A-Z]+(?:\+[A-Z0-9]+)+$/i.test(text)) return false;
  return /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_.:-]*$/u.test(text);
}

function friendlyTargetName(id) {
  const text = String(id || "").trim();
  const names = {
    page: "页面",
    button: "按钮",
    target: "目标",
    text: "文本",
    state: "状态",
    item: "物品",
    tab: "页签",
    entry: "入口",
    grid: "格子",
    list: "列表",
    asset: "素材",
  };
  const [head, ...tail] = text.split(".");
  const prefix = names[head] || head || "目标";
  return tail.length ? `${prefix} · ${tail.join(".")}` : prefix;
}

function targetKindForStep(item) {
  if (item.type === "ocr_assert") return "ocr";
  if (item.type === "condition" || item.type === "retry_until") return "state";
  if (item.type === "detect_page") return "page";
  if (item.type === "click") return "click_target";
  return "image";
}

function defaultThresholdForStep(item) {
  return ["image_click", "wait_image", "detect_page"].includes(item.type) ? DEFAULT_IMAGE_THRESHOLD : "";
}

function catalogTargetIdForStep(item) {
  if (!targetBackedStepTypes.has(item?.type)) return "";
  const explicitId = String(item.targetId || item.assetId || "").trim();
  if (explicitId) return explicitId;
  return isLogicalTargetName(item.target) ? item.target.trim() : "";
}

function normalizeAssignments(value, workflows = state.workspace.workflows) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const workflowIds = new Set(workflows.map((item) => item.id));
  return Object.fromEntries(
    Object.entries(value)
      .map(([hwnd, assignment]) => [String(hwnd), normalizeAssignment(hwnd, assignment, workflowIds)])
      .filter(([, assignment]) => assignment.queue.length > 0),
  );
}

function normalizeAssignment(hwnd, value, workflowIds = new Set(state.workspace.workflows.map((item) => item.id))) {
  const source = value && typeof value === "object" ? value : {};
  const windowIdentity = normalizeWindowIdentity(source.windowIdentity || { ...source, hwnd });
  const legacyWorkflowId = source.workflowId ? String(source.workflowId) : "";
  const queue = Array.isArray(source.queue)
    ? source.queue.map(normalizeQueueItem)
    : legacyWorkflowId
      ? [normalizeQueueItem({ workflowId: legacyWorkflowId, addedAt: source.assignedAt })]
      : [];
  return {
    hwnd: source.hwnd ?? hwnd,
    title: String(source.title || ""),
    processId: source.processId ?? null,
    processName: String(source.processName || windowIdentity.processName || ""),
    clientWidth: Number(source.clientWidth || windowIdentity.clientWidth || 0),
    clientHeight: Number(source.clientHeight || windowIdentity.clientHeight || 0),
    elevated: typeof source.elevated === "boolean" ? source.elevated : windowIdentity.elevated,
    display: String(source.display || hwnd),
    windowIdentity,
    queue: queue
      .filter((item) => workflowIds.has(item.workflowId))
      .map((item, index) => ({ ...item, order: index + 1 })),
    assignedAt: String(source.assignedAt || new Date().toISOString()),
    updatedAt: String(source.updatedAt || source.assignedAt || new Date().toISOString()),
  };
}

function normalizeWindowIdentity(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    hwnd: Number(source.hwnd) || 0,
    title: String(source.title || ""),
    processId: Number(source.processId) || 0,
    processName: String(source.processName || ""),
    clientWidth: Number(source.clientWidth) || 0,
    clientHeight: Number(source.clientHeight) || 0,
    elevated: typeof source.elevated === "boolean" ? source.elevated : null,
  };
}

function normalizeQueueItem(value) {
  const source = value && typeof value === "object" ? value : {};
  const startDelayMs = normalizedNonNegativeInteger(source.startDelayMs) ?? 0;
  const afterDelayMs = normalizedNonNegativeInteger(source.afterDelayMs) ?? 0;
  return {
    id: String(source.id || randomId("queue")),
    workflowId: String(source.workflowId || ""),
    enabled: source.enabled !== false,
    order: Number(source.order || 0),
    startDelayMs,
    afterDelayMs,
    addedAt: String(source.addedAt || new Date().toISOString()),
  };
}

async function saveWorkspaceNow() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = null;
  try {
    state.workspace.updatedAt = new Date().toISOString();
    const result = await invoke("save_workflow_workspace", { workspace: state.workspace });
    state.workspacePath = result.savedPath;
    $("#workspace-state").textContent = "saved";
    $("#workspace-state").classList.add("ok");
    $("#workspace-path").textContent = `${result.savedPath} · ${result.bytes} bytes`;
    return result;
  } catch (error) {
    $("#workspace-state").textContent = "save failed";
    $("#workspace-state").classList.remove("ok");
    appendLog("error", `工作区保存失败：${error}`);
    return null;
  }
}

function markDirty(reason = "draft") {
  const workflow = activeWorkflow();
  if (workflow) workflow.updatedAt = new Date().toISOString();
  if (reason !== "run logged") state.stepValidation = {};
  $("#task-model-state").textContent = reason;
  $("#task-model-state").classList.remove("ok");
  $("#workspace-state").textContent = "dirty";
  $("#workspace-state").classList.remove("ok");
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(saveWorkspaceNow, 500);
  renderWorkflowList();
  renderQueueWorkflowPicker();
  renderAssignments();
  renderOpsDashboard();
}

function activeWorkflow() {
  return (
    state.workspace.workflows.find((item) => item.id === state.workspace.activeWorkflowId) ||
    state.workspace.workflows[0] ||
    null
  );
}

function workflowById(id) {
  return state.workspace.workflows.find((item) => item.id === id) || null;
}

function selectedStep() {
  const workflow = activeWorkflow();
  return workflow?.steps.find((item) => item.id === state.selectedStepId) || null;
}

function activeWindow() {
  return state.windows.find((item) => String(item.hwnd) === String(state.activeHwnd)) || null;
}

function selectedWindows() {
  return state.windows.filter((item) => state.selected.has(String(item.hwnd)));
}

function isQueueLocked(hwnd) {
  return state.sessions[String(hwnd)]?.status === "running";
}

function selectedEditableWindows() {
  const skipped = [];
  const targets = selectedWindows().filter((target) => {
    if (!isQueueLocked(target.hwnd)) return true;
    skipped.push(target.display || target.hwnd);
    return false;
  });
  if (skipped.length) appendLog("warn", `已跳过运行中的窗口队列：${skipped.join("，")}`);
  return targets;
}

function assignmentForHwnd(hwnd) {
  return state.workspace.assignments[String(hwnd)] || null;
}

function ensureAssignment(target) {
  const key = String(target.hwnd);
  const existing = state.workspace.assignments[key];
  const now = new Date().toISOString();
  const assignment = existing || {
    hwnd: target.hwnd,
    title: target.title,
    processId: target.processId,
    display: target.display,
    queue: [],
    assignedAt: now,
    updatedAt: now,
  };
  assignment.hwnd = target.hwnd;
  assignment.title = target.title;
  assignment.processId = target.processId;
  assignment.processName = target.processName || "";
  assignment.clientWidth = Number(target.clientWidth) || 0;
  assignment.clientHeight = Number(target.clientHeight) || 0;
  assignment.elevated = typeof target.elevated === "boolean" ? target.elevated : null;
  assignment.display = target.display;
  assignment.windowIdentity = windowIdentityForTarget(target);
  assignment.queue = Array.isArray(assignment.queue) ? assignment.queue.map(normalizeQueueItem) : [];
  assignment.updatedAt = now;
  state.workspace.assignments[key] = assignment;
  return assignment;
}

function queueRunEntriesForTarget(target) {
  const assignment = assignmentForHwnd(target.hwnd);
  return (assignment?.queue || [])
    .filter((item) => item.enabled)
    .map((item) => ({ queueItem: normalizeQueueItem(item), workflow: workflowById(item.workflowId) }))
    .filter((entry) => entry.workflow);
}

function activeWorkflowRunEntry() {
  const workflow = activeWorkflow();
  if (!workflow) return null;
  return {
    workflow,
    queueItem: queueItemForWorkflow(workflow.id),
  };
}

function renumberQueue(queue) {
  return queue.map((item, index) => normalizeQueueItem({ ...item, order: index + 1 }));
}

function selectedWorkflowIdsForQueue() {
  const select = $("#queue-workflow-picker");
  const selected = select ? [...select.selectedOptions].map((option) => option.value) : [];
  if (selected.length) return selected;
  return activeWorkflow()?.id ? [activeWorkflow().id] : [];
}

function queueTimingOptions() {
  return {
    staggerMs: normalizedNonNegativeInteger($("#queue-stagger-ms")?.value) ?? 0,
    gapMs: normalizedNonNegativeInteger($("#queue-gap-ms")?.value) ?? 0,
  };
}

function queueItemForWorkflow(workflowId, order = 1, options = {}) {
  return normalizeQueueItem({
    workflowId,
    order,
    startDelayMs: options.startDelayMs,
    afterDelayMs: options.afterDelayMs,
    addedAt: new Date().toISOString(),
  });
}

function cloneQueueItems(queue) {
  return (queue || [])
    .filter((item) => workflowById(item.workflowId))
    .map((item, index) =>
      normalizeQueueItem({
        workflowId: item.workflowId,
        enabled: item.enabled,
        order: index + 1,
        startDelayMs: item.startDelayMs,
        afterDelayMs: item.afterDelayMs,
        addedAt: new Date().toISOString(),
      }),
    );
}

function totalQueuedWorkflows() {
  return Object.values(state.workspace.assignments || {}).reduce(
    (sum, assignment) => sum + (assignment.queue?.length || 0),
    0,
  );
}

function renderQueueOverview() {
  const board = $("#queue-overview");
  if (!board) return;
  board.replaceChildren();
  const rows = Object.entries(state.workspace.assignments || {}).filter(
    ([, assignment]) => (assignment.queue || []).length,
  );
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "暂无窗口队列";
    board.append(empty);
    return;
  }
  for (const [hwnd, assignment] of rows.slice(0, 5)) {
    const target = state.windows.find((item) => String(item.hwnd) === String(hwnd));
    const queue = (assignment.queue || []).map(normalizeQueueItem);
    const enabled = queue.filter((item) => item.enabled !== false && workflowById(item.workflowId));
    const stepTotal = enabled.reduce((sum, item) => sum + (workflowById(item.workflowId)?.steps.length || 0), 0);
    const delayTotal = enabled.reduce((sum, item) => sum + (item.startDelayMs || 0) + (item.afterDelayMs || 0), 0);
    const row = document.createElement("article");
    row.className = "queue-overview-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(target?.display || assignment.display || `hwnd=${hwnd}`)}</strong>
        <small>${enabled.length}/${queue.length} 项启用 · ${stepTotal} 步 · 等待 ${durationLabel(delayTotal)}</small>
      </div>
    `;
    const chips = document.createElement("div");
    chips.className = "queue-overview-chips";
    for (const item of enabled.slice(0, 4)) {
      const workflow = workflowById(item.workflowId);
      if (!workflow) continue;
      const chip = document.createElement("span");
      chip.textContent = workflow.name;
      chip.title = queueItemSummary(item, workflow);
      chips.append(chip);
    }
    if (enabled.length > 4) {
      const more = document.createElement("span");
      more.textContent = `+${enabled.length - 4}`;
      chips.append(more);
    }
    row.append(chips);
    board.append(row);
  }
  if (rows.length > 5) {
    const more = document.createElement("div");
    more.className = "queue-overview-more";
    more.textContent = `还有 ${rows.length - 5} 个窗口队列`;
    board.append(more);
  }
}

function renderOpsDashboard() {
  const windows = state.windows || [];
  const selectedCount = selectedWindows().length;
  const elevatedCount = windows.filter((item) => item.elevated === true).length;
  const assignmentCount = Object.values(state.workspace.assignments || {}).filter(
    (assignment) => (assignment.queue || []).length,
  ).length;
  const queueTotal = totalQueuedWorkflows();
  const sessions = Object.values(state.sessions || {});
  const runningSessions = sessions.filter((session) => session.status === "running");
  const active = activeWorkflow();
  const completion = active ? workflowCompletionState(active, validateWorkflow(active, "background")) : null;
  const issueCount = completion?.items.filter((item) => item.severity === "issue").length || 0;
  const warningCount = completion?.items.filter((item) => item.severity === "warning").length || 0;
  const lastRun = state.workspace.runHistory?.[0] || null;

  setText("#ops-window-total", windows.length);
  setText("#ops-window-detail", `已选 ${selectedCount} · 管理员 ${elevatedCount}`);
  setText("#ops-queue-total", queueTotal);
  setText("#ops-queue-detail", `${assignmentCount} 个窗口已分配`);
  setText("#ops-running-total", runningSessions.length);
  setText("#ops-running-detail", runningSessions.length ? runningSessions.map((item) => item.display).join(" / ") : "idle");
  setText("#ops-active-workflow", active?.name || "未载入");
  setText(
    "#ops-active-gaps",
    active ? `${active.steps.length} 步 · 阻塞 ${issueCount} · 提醒 ${warningCount}` : "等待工作区",
  );
  setText("#ops-dispatch-mode", state.privilege?.currentProcessElevated ? "Admin + PostMessageW" : "PostMessageW");
  setText(
    "#ops-dispatch-detail",
    windows.length ? `hwnd 身份复核 · ${TARGET_TITLE}` : "等待扫描目标窗口",
  );
  setText("#ops-last-run-status", lastRun?.status || "none");
  setText(
    "#ops-last-run-detail",
    lastRun
      ? `${lastRun.display || lastRun.hwnd} · ${durationLabel(lastRun.durationMs)} · ${lastRun.endedAt || ""}`
      : "暂无运行记录",
  );
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = String(value ?? "");
}

function renderAll() {
  fillWorkflowBlueprintSelect($("#workflow-blueprint-select"));
  renderBlueprintPreview();
  renderBlueprintGallery();
  renderQueueWorkflowPicker();
  renderWorkflowList();
  renderWorkflowForm();
  renderSteps();
  renderStepEditor();
  renderTargets();
  renderWindows();
  renderAssignments();
  renderSessions();
  renderOpsDashboard();
}

function renderWorkflowList() {
  $("#workflow-count").textContent = String(state.workspace.workflows.length);
  const list = $("#workflow-list");
  list.replaceChildren();
  for (const item of state.workspace.workflows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workflow-row";
    button.classList.toggle("active", item.id === state.workspace.activeWorkflowId);
    button.innerHTML = `
      <strong>${escapeHtml(item.name)}</strong>
      <span>${escapeHtml(item.category || "未分类")} · ${item.steps.length} 步</span>
      <small>${escapeHtml(item.description || "无备注")}</small>
    `;
    button.addEventListener("click", () => {
      state.workspace.activeWorkflowId = item.id;
      state.selectedStepId = item.steps[0]?.id || null;
      renderWorkflowForm();
      renderWorkflowList();
      renderSteps();
      renderStepEditor();
      renderTargets();
      setStatus(`已选择任务：${item.name}`);
    });
    list.append(button);
  }
}

function renderWorkflowForm() {
  const workflow = activeWorkflow();
  if (!workflow) return;
  $("#active-workflow-title").textContent = workflow.name;
  $("#workflow-name").value = workflow.name;
  $("#workflow-category").value = workflow.category || "";
  $("#workflow-initial-check").value = workflow.initialCheck || "";
  $("#workflow-concurrency").value = workflow.targetPolicy?.concurrency || "per-window-exclusive";
  $("#workflow-description").value = workflow.description || "";
}

function bindWorkflowInputs() {
  const updates = [
    ["#workflow-name", "name"],
    ["#workflow-category", "category"],
    ["#workflow-initial-check", "initialCheck"],
    ["#workflow-description", "description"],
  ];
  for (const [selector, field] of updates) {
    $(selector).addEventListener("input", (event) => {
      const workflow = activeWorkflow();
      if (!workflow) return;
      workflow[field] = event.target.value;
      markDirty("draft");
      renderWorkflowForm();
      renderSteps();
    });
  }
  $("#workflow-concurrency").addEventListener("change", (event) => {
    const workflow = activeWorkflow();
    if (!workflow) return;
    workflow.targetPolicy.concurrency = workflowConcurrencyOptions.has(event.target.value)
      ? event.target.value
      : "per-window-exclusive";
    markDirty("draft");
  });
}

function blueprintTargetId(definition, namespace) {
  if (
    !targetBackedStepTypes.has(definition.type) ||
    !isLogicalTargetName(definition.target)
  ) {
    return "";
  }
  const group = definition.type === "ocr_assert" ? "ocr" : "target";
  return `${namespace}.${group}.${definition.target.trim()}`;
}

function createBlueprintStep(definition, namespace) {
  return normalizeStep({
    ...definition,
    id: randomId("step"),
    targetId: blueprintTargetId(definition, namespace),
  });
}

function createWorkflowFromBlueprint(blueprintInput, index = 1, namePrefix = "") {
  const blueprint = typeof blueprintInput === "string" ? workflowBlueprintById(blueprintInput) : blueprintInput;
  const workflowId = randomId("wf");
  const namespace = `task.${blueprint.id}.${workflowId}`;
  const prefix = String(namePrefix || blueprint.defaultPrefix || blueprint.label || "任务").trim();
  const workflow = normalizeWorkflow({
    id: workflowId,
    name: index > 1 ? `${prefix} ${index}` : prefix,
    category: blueprint.category || "草稿",
    description: blueprint.description || "",
    tags: ["蓝图", blueprint.label || blueprint.id],
    steps: blueprint.steps.map((item) => createBlueprintStep(item, namespace)),
  });
  ensureTargetsForSteps(workflow.steps);
  return workflow;
}

async function createWorkflowBatch(options = {}) {
  const blueprint = workflowBlueprintById(options.blueprintId || $("#workflow-blueprint-select")?.value);
  const countInput = Number($("#workflow-batch-count")?.value || 1);
  const count = Math.max(1, Math.min(10, Math.floor(Number.isFinite(countInput) ? countInput : 1)));
  const prefix = String(options.namePrefix ?? $("#workflow-name-prefix")?.value ?? "").trim();
  const workflows = Array.from({ length: count }, (_, index) =>
    createWorkflowFromBlueprint(blueprint, index + 1, prefix),
  );
  state.workspace.workflows.unshift(...workflows);
  state.workspace.activeWorkflowId = workflows[0]?.id || state.workspace.activeWorkflowId;
  state.selectedStepId = workflows[0]?.steps[0]?.id || null;
  selectFirstUnboundCapturedStep(workflows[0]?.steps || []);
  await hydrateBuiltinTargetTemplates({ log: true });
  markDirty("draft");
  renderAll();
  appendLog("info", `按蓝图生成 ${workflows.length} 个任务：${blueprint.label}`);
  if (options.assignToSelected) assignWorkflowsToSelected(workflows);
  return workflows;
}

async function importSampleWorkflowPack() {
  const existingIds = new Set(state.workspace.workflows.map((item) => item.id));
  const samples = createSampleWorkflows().filter((item) => !existingIds.has(item.id));
  if (!samples.length) {
    setStatus("内置示例包已存在");
    appendLog("info", "内置示例包已存在，没有重复导入");
    return [];
  }
  state.workspace.workflows.unshift(...samples);
  state.workspace.targets = mergeTargetCatalog(
    [...state.workspace.targets, ...createTargetCatalogFromWorkflows(samples)],
    state.workspace.workflows,
  );
  await hydrateBuiltinTargetTemplates({ log: true });
  state.workspace.activeWorkflowId = samples[0].id;
  state.selectedStepId = samples[0]?.steps[0]?.id || null;
  selectFirstUnboundCapturedStep(samples[0]?.steps || []);
  markDirty("sample pack");
  renderAll();
  setStatus(`已导入 ${samples.length} 个内置示例任务`);
  appendLog(
    "info",
    `导入示例包：${samples.map((item) => `${item.name}(${item.steps.length}步)`).join(" / ")}`,
  );
  return samples;
}

async function prepareExerciseWorkspace() {
  setStatus("正在准备多窗口演练...");
  await refreshWindows();
  selectGameWindows();
  const targets = selectedEditableWindows();
  const workflows = await ensureExerciseSuiteWorkflows();
  const queueResult = queueExerciseSuiteForTargets(workflows, targets, { onlyEmptyQueues: true });
  const hydrated = await hydrateBuiltinTargetTemplates({ log: true });
  state.workspace.activeWorkflowId = workflows[0]?.id || state.workspace.activeWorkflowId;
  state.selectedStepId = workflows[0]?.steps[0]?.id || state.selectedStepId;
  selectFirstUnboundCapturedStep(workflows[0]?.steps || []);
  markDirty("exercise prepared");
  renderAll();
  const validation = validateWorkflowQueue(workflows, "definition");
  if (validation.issues.length) {
    setRunState("blocked");
    $("#run-summary").textContent = validation.issues.join(" / ");
    appendLog("warn", `演练准备后定义校验未通过：${validation.issues.join("；")}`);
  } else {
    setRunState("ready");
    $("#run-summary").textContent =
      `演练准备完成：${workflows.length} 个任务 · ${queueResult.queued} 个窗口新写入队列 · ${queueResult.skipped} 个窗口保留原队列`;
  }
  await saveWorkspaceNow();
  setStatus(
    `演练已准备：${targets.length} 个窗口，新增队列 ${queueResult.queued} 个，保留 ${queueResult.skipped} 个，模板 ${hydrated} 个`,
  );
  appendLog(
    "info",
    `一键演练准备：任务 ${workflows.length} 个；窗口 ${targets.length} 个；新队列 ${queueResult.queueSizes.join(" / ") || "none"}；已保留已有队列 ${queueResult.skipped} 个`,
  );
}

async function ensureExerciseSuiteWorkflows() {
  const byBlueprintId = new Map();
  for (const workflow of state.workspace.workflows) {
    const labels = new Set((workflow.tags || []).map(String));
    for (const blueprintId of exerciseSuiteBlueprintIds) {
      const blueprint = workflowBlueprintById(blueprintId);
      if (
        labels.has(blueprint.label || blueprint.id) &&
        String(workflow.name || "").trim().startsWith("演练 ")
      ) {
        byBlueprintId.set(blueprintId, workflow);
      }
    }
  }

  const created = [];
  for (const blueprintId of exerciseSuiteBlueprintIds) {
    if (byBlueprintId.has(blueprintId)) continue;
    const blueprint = workflowBlueprintById(blueprintId);
    const workflow = createWorkflowFromBlueprint(blueprint, 1, `演练 ${blueprint.defaultPrefix || blueprint.label}`);
    byBlueprintId.set(blueprintId, workflow);
    created.push(workflow);
  }
  if (created.length) {
    state.workspace.workflows.unshift(...created);
    await hydrateBuiltinTargetTemplates({ log: true });
    appendLog("info", `补足演练任务：${created.map((item) => item.name).join(" / ")}`);
  }
  return exerciseSuiteBlueprintIds.map((blueprintId) => byBlueprintId.get(blueprintId)).filter(Boolean);
}

async function createExerciseSuite() {
  const workflows = exerciseSuiteBlueprintIds.map((blueprintId) => {
    const blueprint = workflowBlueprintById(blueprintId);
    return createWorkflowFromBlueprint(blueprint, 1, `演练 ${blueprint.defaultPrefix || blueprint.label}`);
  });
  state.workspace.workflows.unshift(...workflows);
  await hydrateBuiltinTargetTemplates({ log: true });
  state.workspace.activeWorkflowId = workflows[0]?.id || state.workspace.activeWorkflowId;
  state.selectedStepId = workflows[0]?.steps[0]?.id || null;
  selectFirstUnboundCapturedStep(workflows[0]?.steps || []);

  const targets = selectedEditableWindows();
  const queueResult = queueExerciseSuiteForTargets(workflows, targets);

  markDirty(targets.length ? "exercise suite queued" : "exercise suite");
  renderAll();
  const summary = `${workflows.length} 个任务 · 每个 ${workflows.map((item) => item.steps.length).join("/")} 步`;
  if (targets.length) {
    setStatus(`已生成演练套件并分配到 ${targets.length} 个窗口队列`);
    appendLog(
      "info",
      `演练套件：${summary}；窗口队列长度 ${queueResult.queueSizes.join(" / ")}；等待 ${queueResult.staggerMs}ms/${queueResult.gapMs}ms`,
    );
  } else {
    setStatus("已生成演练套件；选择窗口后可追加或复制队列");
    appendLog("info", `演练套件：${summary}；未选择窗口，暂未分配队列`);
  }
  return workflows;
}

function queueExerciseSuiteForTargets(workflows, targets, options = {}) {
  const timing = queueTimingOptions();
  const staggerMs = normalizedNonNegativeInteger(timing.staggerMs) ?? 0;
  const gapMs = normalizedNonNegativeInteger(timing.gapMs) ?? 0;
  const queueSizes = [];
  let queued = 0;
  let skipped = 0;
  for (const [targetIndex, target] of targets.entries()) {
    const assignment = ensureAssignment(target);
    if (options.onlyEmptyQueues && assignment.queue.length) {
      skipped += 1;
      continue;
    }
    const queueSize = Math.min(
      workflows.length,
      exerciseSuiteQueuePattern[targetIndex % exerciseSuiteQueuePattern.length],
    );
    queueSizes.push(queueSize);
    queued += 1;
    for (let workflowIndex = 0; workflowIndex < queueSize; workflowIndex += 1) {
      const workflow = workflows[(targetIndex + workflowIndex) % workflows.length];
      assignment.queue.push(
        queueItemForWorkflow(workflow.id, assignment.queue.length + 1, {
          startDelayMs: workflowIndex === 0 ? targetIndex * staggerMs : 0,
          afterDelayMs: gapMs,
        }),
      );
    }
    assignment.queue = renumberQueue(assignment.queue);
    assignment.updatedAt = new Date().toISOString();
  }
  return { queued, skipped, queueSizes, staggerMs, gapMs };
}

function newWorkflow() {
  const blueprint = workflowBlueprintById($("#workflow-blueprint-select")?.value);
  const prefix = String($("#workflow-name-prefix")?.value || blueprint.defaultPrefix || "新任务").trim();
  const workflow = createWorkflowFromBlueprint(blueprint, 1, prefix);
  state.workspace.workflows.unshift(workflow);
  state.workspace.activeWorkflowId = workflow.id;
  state.selectedStepId = workflow.steps[0]?.id || null;
  selectFirstUnboundCapturedStep(workflow.steps);
  markDirty("draft");
  renderAll();
}

function duplicateWorkflow() {
  const source = activeWorkflow();
  if (!source) return;
  const now = new Date().toISOString();
  const targetIdMap = new Map();
  const clonedTargets = [];
  const cloneTargetId = (oldTargetId, sourceStep) => {
    if (!oldTargetId) return "";
    if (targetIdMap.has(oldTargetId)) return targetIdMap.get(oldTargetId);
    const existing = state.workspace.targets.find((target) => target.id === oldTargetId);
    const cloned = cloneWorkflowTargetForDuplicate(existing, oldTargetId, sourceStep, source.name, now);
    targetIdMap.set(oldTargetId, cloned.id);
    clonedTargets.push(cloned);
    return cloned.id;
  };
  const copy = normalizeWorkflow(JSON.parse(JSON.stringify(source)));
  copy.id = randomId("wf");
  copy.name = `${source.name} 副本`;
  copy.createdAt = now;
  copy.updatedAt = copy.createdAt;
  copy.steps = source.steps.map((sourceStep) => {
    const item = normalizeStep({
      ...JSON.parse(JSON.stringify(sourceStep)),
      id: randomId("step"),
    });
    const oldTargetId = stepTargetId(sourceStep);
    const newTargetId = cloneTargetId(oldTargetId, sourceStep);
    if (newTargetId) {
      item.targetId = newTargetId;
      delete item.assetId;
      const sourceTargetText = String(sourceStep.target || "").trim();
      const oldExplicitTarget = String(sourceStep.targetId || sourceStep.assetId || "").trim();
      if (!sourceTargetText || sourceTargetText === oldTargetId || sourceTargetText === oldExplicitTarget) {
        item.target = newTargetId;
      } else {
        item.target = String(sourceStep.target || "");
      }
    }
    return item;
  });
  state.workspace.targets.unshift(...clonedTargets);
  state.workspace.workflows.unshift(copy);
  state.workspace.activeWorkflowId = copy.id;
  state.selectedStepId = copy.steps[0]?.id || null;
  markDirty("draft");
  renderAll();
  appendLog("info", `复制任务：${copy.name}，已克隆 ${clonedTargets.length} 个识别目标`);
}

function cloneWorkflowTargetForDuplicate(existingTarget, oldTargetId, sourceStep, sourceWorkflowName, timestamp) {
  const base = existingTarget
    ? JSON.parse(JSON.stringify(existingTarget))
    : {
        id: oldTargetId,
        name: friendlyTargetName(oldTargetId),
        kind: targetKindForStep(sourceStep),
        match: {
          threshold: defaultThresholdForStep(sourceStep) || DEFAULT_IMAGE_THRESHOLD,
          scope: commandValue(sourceStep.command, "roi") || "window",
        },
        click: {
          button: normalizedButton(sourceStep.command),
          point: commandValue(sourceStep.command, "point") || "center",
        },
        texts: sourceStep.type === "ocr_assert" ? [sourceStep.target] : [],
        note: "由复制任务补建的目标占位",
      };
  const originalNote = String(base.note || "").trim();
  return normalizeTarget({
    ...base,
    id: randomId("target"),
    name: `${base.name || friendlyTargetName(oldTargetId)} 副本`,
    createdAt: timestamp,
    updatedAt: timestamp,
    note: [originalNote, `由复制任务从“${sourceWorkflowName}”克隆，编辑不会影响原任务`]
      .filter(Boolean)
      .join("\n"),
  });
}

function deleteWorkflow() {
  const workflow = activeWorkflow();
  if (!workflow || state.workspace.workflows.length <= 1) {
    setStatus("至少保留一个任务");
    return;
  }
  state.workspace.workflows = state.workspace.workflows.filter((item) => item.id !== workflow.id);
  for (const [hwnd, assignment] of Object.entries(state.workspace.assignments)) {
    assignment.queue = (assignment.queue || []).filter((item) => item.workflowId !== workflow.id);
    if (!assignment.queue.length) delete state.workspace.assignments[hwnd];
  }
  state.workspace.activeWorkflowId = state.workspace.workflows[0]?.id || null;
  state.selectedStepId = activeWorkflow()?.steps[0]?.id || null;
  markDirty("draft");
  renderAll();
  appendLog("info", `删除任务：${workflow.name}`);
}

function fillStepTypeSelect(select) {
  select.replaceChildren(
    ...stepTypes.map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `${label} · ${value}`;
      return option;
    }),
  );
}

function fillStepBlockSelect(select) {
  select.replaceChildren(
    ...stepBlockPresets.map((preset) => {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      return option;
    }),
  );
}

function workflowBlueprintById(id) {
  return workflowBlueprints.find((item) => item.id === id) || workflowBlueprints[0];
}

function fillWorkflowBlueprintSelect(select) {
  if (!select) return;
  const current = select.value || workflowBlueprints[0]?.id || "";
  select.replaceChildren(
    ...workflowBlueprints.map((blueprint) => {
      const option = document.createElement("option");
      option.value = blueprint.id;
      option.textContent = `${blueprint.label} · ${blueprint.steps.length} 步`;
      return option;
    }),
  );
  select.value = workflowBlueprintById(current)?.id || workflowBlueprints[0]?.id || "";
  syncWorkflowBlueprintDefaults();
}

function syncWorkflowBlueprintDefaults(options = {}) {
  const input = $("#workflow-name-prefix");
  const blueprint = workflowBlueprintById($("#workflow-blueprint-select")?.value);
  if (!input || !blueprint) return;
  if (options.force || !input.value.trim()) input.value = blueprint.defaultPrefix || blueprint.label;
}

function renderBlueprintPreview() {
  const preview = $("#blueprint-preview");
  if (!preview) return;
  const blueprint = workflowBlueprintById($("#workflow-blueprint-select")?.value);
  if (!blueprint) {
    preview.replaceChildren();
    return;
  }
  const counts = blueprint.steps.reduce((sum, step) => {
    sum[step.type] = (sum[step.type] || 0) + 1;
    return sum;
  }, {});
  const actionStats = [
    ["hotkey", "热键"],
    ["image_click", "识图点击"],
    ["click", "坐标点击"],
    ["ocr_assert", "OCR"],
    ["wait_image", "等图"],
    ["text_input", "文本"],
    ["delay", "等待"],
  ]
    .filter(([type]) => counts[type])
    .map(([type, label]) => `${label} ${counts[type]}`)
    .join(" · ");

  preview.replaceChildren();
  const summary = document.createElement("div");
  summary.className = "blueprint-summary";
  summary.innerHTML = `
    <strong>${escapeHtml(blueprint.label)}</strong>
    <span>${escapeHtml(blueprint.category)} · ${blueprint.steps.length} 步 · ${escapeHtml(actionStats || "语义步骤")}</span>
    <small>${escapeHtml(blueprint.description || "")}</small>
  `;
  const track = document.createElement("div");
  track.className = "blueprint-step-track";
  blueprint.steps.slice(0, 12).forEach((step, index) => {
    const chip = document.createElement("span");
    chip.className = `blueprint-chip type-${step.type}`;
    chip.title = `${step.name} · ${step.target}`;
    chip.textContent = `${String(index + 1).padStart(2, "0")} ${stepLabels[step.type] || step.type}`;
    track.append(chip);
  });
  if (blueprint.steps.length > 12) {
    const more = document.createElement("span");
    more.className = "blueprint-chip more";
    more.textContent = `+${blueprint.steps.length - 12}`;
    track.append(more);
  }
  preview.append(summary, track);
}

function renderBlueprintGallery() {
  const gallery = $("#blueprint-gallery");
  const select = $("#workflow-blueprint-select");
  if (!gallery || !select) return;
  const activeId = workflowBlueprintById(select.value)?.id || workflowBlueprints[0]?.id || "";
  gallery.replaceChildren(
    ...workflowBlueprints.map((blueprint) => {
      const counts = blueprint.steps.reduce((sum, step) => {
        sum[step.type] = (sum[step.type] || 0) + 1;
        return sum;
      }, {});
      const button = document.createElement("button");
      button.type = "button";
      button.className = "blueprint-card";
      button.classList.toggle("active", blueprint.id === activeId);
      button.innerHTML = `
        <span>${escapeHtml(blueprint.category)}</span>
        <strong>${escapeHtml(blueprint.label)}</strong>
        <small>${blueprint.steps.length} 步 · 热键 ${counts.hotkey || 0} · 识图 ${counts.image_click || 0} · OCR ${counts.ocr_assert || 0}</small>
      `;
      button.addEventListener("click", () => {
        select.value = blueprint.id;
        syncWorkflowBlueprintDefaults({ force: true });
        renderBlueprintPreview();
        renderBlueprintGallery();
      });
      return button;
    }),
  );
}

function renderQueueWorkflowPicker() {
  const select = $("#queue-workflow-picker");
  if (!select) return;
  const previous = new Set([...select.selectedOptions].map((option) => option.value));
  const activeId = activeWorkflow()?.id || "";
  select.replaceChildren(
    ...state.workspace.workflows.map((workflow) => {
      const option = document.createElement("option");
      option.value = workflow.id;
      option.textContent = `${workflow.name} · ${workflow.steps.length} 步`;
      option.selected = previous.size ? previous.has(workflow.id) : workflow.id === activeId;
      return option;
    }),
  );
}

function renderSteps(validationOverride = null) {
  const workflow = activeWorkflow();
  $("#step-count").textContent = String(workflow?.steps.length || 0);
  const list = $("#step-list");
  list.replaceChildren();
  if (!workflow?.steps.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block";
    empty.textContent = "暂无步骤";
    list.append(empty);
    renderWorkflowCompletion(workflow);
    return;
  }
  if (!state.selectedStepId || !workflow.steps.some((item) => item.id === state.selectedStepId)) {
    state.selectedStepId = workflow.steps[0]?.id || null;
  }
  const validation = validationOverride || validateWorkflow(workflow);
  state.stepValidation = buildStepValidationIndex(workflow, validation);
  workflow.steps.forEach((item, index) => {
    const row = document.createElement("button");
    const stepMessages = state.stepValidation[item.id] || { issues: [], warnings: [] };
    const badgeClass = stepMessages.issues.length ? "issue" : stepMessages.warnings.length ? "warning" : "";
    const badgeText = stepMessages.issues.length
      ? `问题 ${stepMessages.issues.length}`
      : stepMessages.warnings.length
        ? `提醒 ${stepMessages.warnings.length}`
        : "";
    row.type = "button";
    row.className = "step-row";
    row.classList.toggle("active", item.id === state.selectedStepId);
    row.classList.toggle("disabled", item.enabled === false);
    row.classList.toggle("has-issue", stepMessages.issues.length > 0);
    row.classList.toggle("has-warning", !stepMessages.issues.length && stepMessages.warnings.length > 0);
    row.innerHTML = `
      <span>${String(index + 1).padStart(2, "0")}</span>
      <strong>${escapeHtml(item.name || stepLabels[item.type] || item.type)}</strong>
      <small>${item.enabled === false ? "停用 · " : ""}${escapeHtml(stepLabels[item.type] || item.type)} · ${escapeHtml(item.target || "target: none")}</small>
      ${badgeText ? `<em class="step-badge ${badgeClass}" title="${escapeHtml([...stepMessages.issues, ...stepMessages.warnings].join(" / "))}">${badgeText}</em>` : ""}
    `;
    row.addEventListener("click", () => {
      state.selectedStepId = item.id;
      const boundTarget = targetForStep(item);
      if (boundTarget) state.selectedTargetId = boundTarget.id;
      renderSteps();
      renderStepEditor();
      renderTargets();
    });
    list.append(row);
  });
  renderWorkflowCompletion(workflow);
}

function renderWorkflowCompletion(workflow = activeWorkflow(), validation = null) {
  const board = $("#workflow-completion");
  if (!board) return;
  const title = $("#completion-title");
  const summary = $("#completion-summary");
  const list = $("#completion-list");
  const nextButton = $("#focus-next-gap");
  list.replaceChildren();
  if (!workflow) {
    title.textContent = "待补全";
    summary.textContent = "没有当前任务";
    nextButton.disabled = true;
    board.classList.remove("ready");
    return;
  }
  const completion = workflowCompletionState(workflow, validation || validateWorkflow(workflow, "background"));
  const issueCount = completion.items.filter((item) => item.severity === "issue").length;
  const warningCount = completion.items.filter((item) => item.severity === "warning").length;
  board.classList.toggle("ready", completion.items.length === 0);
  nextButton.disabled = completion.items.length === 0;
  title.textContent = completion.items.length ? "待采样 / 待补全" : "后台执行准备";
  summary.textContent = completion.items.length
    ? `${completion.items.length} 项待处理 · ${issueCount} 项会阻塞后台执行 · ${warningCount} 项提醒`
    : `${workflow.name} 已满足后台执行的基础素材要求`;
  if (!completion.items.length) {
    const ready = document.createElement("div");
    ready.className = "empty-block compact";
    ready.textContent = "当前任务没有缺图、缺坐标或缺 OCR 文本";
    list.append(ready);
    return;
  }
  for (const item of completion.items.slice(0, 8)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `completion-item ${item.severity}`;
    row.title = item.message;
    row.innerHTML = `
      <em>${escapeHtml(item.kind)}</em>
      <span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(completionMessageDetail(item.message))}</small>
      </span>
      <b>${escapeHtml(item.action)}</b>
    `;
    row.addEventListener("click", () => {
      selectCompletionItem(item);
    });
    list.append(row);
  }
  if (completion.items.length > 8) {
    const more = document.createElement("div");
    more.className = "empty-block compact";
    more.textContent = `还有 ${completion.items.length - 8} 项，补完上面的项后会继续显示`;
    list.append(more);
  }
}

function workflowCompletionState(workflow, validation = validateWorkflow(workflow, "background")) {
  const items = [];
  const stepMessages = new Set();
  const steps = workflow?.steps || [];
  for (const [index, item] of steps.entries()) {
    const messages = [
      ...(validation.stepIssues?.[item.id] || []).map((message) => ({ message, severity: "issue" })),
      ...(validation.stepWarnings?.[item.id] || []).map((message) => ({ message, severity: "warning" })),
    ];
    const hasSpecificGap = messages.some(({ message }) => isSpecificCompletionGap(message));
    for (const { message, severity } of messages) {
      stepMessages.add(message);
      if (hasSpecificGap && message.includes("缺少目标")) continue;
      items.push({
        stepId: item.id,
        stepIndex: index,
        severity,
        kind: completionKindForMessage(message),
        title: `${String(index + 1).padStart(2, "0")} ${item.name || stepLabels[item.type] || item.type}`,
        action: completionActionForMessage(message),
        message,
      });
    }
  }
  for (const message of validation.issues || []) {
    if (!stepMessages.has(message)) items.push(workflowCompletionItem(message, "issue", workflow));
  }
  for (const message of validation.warnings || []) {
    if (!stepMessages.has(message)) items.push(workflowCompletionItem(message, "warning", workflow));
  }
  items.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "issue" ? -1 : 1;
    return (left.stepIndex ?? 9999) - (right.stepIndex ?? 9999);
  });
  return { items, validation };
}

function workflowCompletionItem(message, severity, workflow) {
  return {
    stepId: "",
    stepIndex: null,
    severity,
    kind: completionKindForMessage(message),
    title: workflow?.name || "当前任务",
    action: completionActionForMessage(message),
    message,
  };
}

function isSpecificCompletionGap(message) {
  return /Ctrl\+V 图片|OCR 需要目标文本|文本输入需要|后台点击需要|绑定的识别目标已不存在|匹配阈值|鼠标键|重试间隔|延迟步骤/.test(
    message,
  );
}

function completionKindForMessage(message) {
  if (message.includes("文本输入")) return "文本";
  if (message.includes("Ctrl+V 图片")) return "缺图";
  if (message.includes("OCR 需要目标文本")) return "OCR";
  if (message.includes("未限定 ROI")) return "ROI";
  if (message.includes("后台点击需要")) return "坐标";
  if (message.includes("识别目标已不存在") || message.includes("缺少目标")) return "目标";
  if (message.includes("快捷键")) return "热键";
  if (message.includes("阈值")) return "阈值";
  if (message.includes("鼠标键")) return "鼠标";
  if (message.includes("延迟") || message.includes("间隔")) return "时间";
  if (message.includes("少于 10 步") || message.includes("步骤")) return "步骤";
  return message.includes("提醒") ? "提醒" : "检查";
}

function completionActionForMessage(message) {
  if (message.includes("文本输入")) return "填文本";
  if (message.includes("Ctrl+V 图片")) return "粘贴图";
  if (message.includes("OCR 需要目标文本")) return "填文本";
  if (message.includes("未限定 ROI")) return "设 ROI";
  if (message.includes("后台点击需要")) return "填坐标";
  if (message.includes("识别目标已不存在") || message.includes("缺少目标")) return "绑目标";
  if (message.includes("快捷键")) return "改热键";
  if (message.includes("阈值")) return "改阈值";
  if (message.includes("鼠标键")) return "改按钮";
  if (message.includes("延迟") || message.includes("间隔")) return "改时间";
  if (message.includes("少于 10 步")) return "加步骤";
  return "定位";
}

function completionMessageDetail(message) {
  return String(message || "").replace(/^第\s+\d+\s+步\s*/, "");
}

function focusNextCompletionGap() {
  const workflow = activeWorkflow();
  const item = workflowCompletionState(workflow, validateWorkflow(workflow, "background")).items[0];
  if (!item) {
    setStatus("当前任务没有待补全项");
    return;
  }
  selectCompletionItem(item);
}

function selectCompletionItem(item) {
  const workflow = activeWorkflow();
  if (!workflow) return;
  if (item.stepId) {
    const stepItem = workflow.steps.find((step) => step.id === item.stepId);
    if (!selectStepAndTarget(stepItem)) return;
    revealCompletionTarget(stepItem, item);
    renderSteps();
    renderStepEditor();
    renderTargets();
    focusCompletionField(item, stepItem);
    setStatus(completionStatusMessage(item));
    return;
  }
  renderWorkflowForm();
  if (item.message.includes("少于 10 步")) {
    $("#step-block-preset")?.focus();
    setStatus("可插入完整任务骨架或继续添加步骤");
  } else {
    $("#workflow-name")?.focus();
    setStatus("已定位任务属性");
  }
}

function revealCompletionTarget(stepItem, completionItem) {
  const targetId = stepTargetId(stepItem);
  const target = targetId ? state.workspace.targets.find((item) => item.id === targetId) : null;
  if (target) {
    state.selectedTargetId = target.id;
    if (!targetPassesCurrentFilters(target)) {
      state.targetSearch = "";
      state.targetKindFilter = "all";
    }
    return;
  }
  if (completionItem.message.includes("缺少目标") || completionItem.message.includes("识别目标已不存在")) {
    state.selectedTargetId = "";
  }
}

function targetPassesCurrentFilters(target) {
  if (!target) return false;
  const query = state.targetSearch.trim().toLowerCase();
  if (state.targetKindFilter !== "all" && target.kind !== state.targetKindFilter) return false;
  return !query || targetSearchText(target).includes(query);
}

function focusCompletionField(item, stepItem) {
  window.requestAnimationFrame(() => {
    const selector = completionFocusSelector(item, stepItem);
    const element = selector ? $(selector) : null;
    if (!element) return;
    element.focus();
    if (typeof element.select === "function") element.select();
  });
}

function completionFocusSelector(item, stepItem) {
  if (item.message.includes("文本输入")) return "#param-text-value";
  if (item.message.includes("OCR 需要目标文本")) {
    return targetForStep(stepItem) ? "#target-texts" : "#step-expect";
  }
  if (item.message.includes("后台点击需要")) return "#param-click-x";
  if (item.message.includes("快捷键")) return "#param-hotkey";
  if (item.message.includes("阈值")) return "#param-image-threshold";
  if (item.message.includes("鼠标键")) {
    return stepItem?.type === "image_click" ? "#param-image-button" : "#param-click-button";
  }
  if (item.message.includes("延迟") || item.message.includes("间隔")) {
    return stepItem?.type === "retry_until" ? "#param-retry-interval" : "#param-delay-ms";
  }
  if (item.message.includes("缺少目标") || item.message.includes("识别目标已不存在")) return "#param-target-select";
  return "";
}

function completionStatusMessage(item) {
  if (item.message.includes("Ctrl+V 图片")) return "已定位缺图步骤：复制图片后直接 Ctrl+V，或在预览中框 ROI 后存为目标";
  if (item.message.includes("文本输入")) return "已定位文本输入步骤：填写要发给目标窗口的文字";
  if (item.message.includes("OCR 需要目标文本")) return "已定位 OCR 步骤：填写目标文本后即可用于后台识别";
  if (item.message.includes("后台点击需要")) return "已定位点击步骤：填写 x/y 坐标或绑定 ROI 目标";
  if (item.message.includes("未限定 ROI")) return "已定位 OCR ROI 提醒：可绑定 ROI 或在命令里设置 roi=top/panel/dialog";
  return `已定位：${completionMessageDetail(item.message)}`;
}

function createStep(type) {
  const defaults = stepDefaults[type] || stepDefaults.detect_page;
  return normalizeStep({
    id: randomId("step"),
    type,
    name: defaults.name,
    target: defaults.target,
    command: defaults.command,
    expect: defaults.expect,
    timeoutMs: defaults.timeoutMs,
    retry: defaults.retry,
    onFail: defaults.onFail,
  });
}

function selectedStepIndex(workflow = activeWorkflow()) {
  return workflow?.steps.findIndex((item) => item.id === state.selectedStepId) ?? -1;
}

function capturedStepNeedsImage(item) {
  return capturedImageStepTypes.has(item?.type) && !targetForStep(item)?.dataUrl;
}

function selectStepAndTarget(item) {
  if (!item) return false;
  state.selectedStepId = item.id;
  const boundTarget = targetForStep(item);
  state.selectedTargetId = boundTarget ? boundTarget.id : "";
  return true;
}

function selectFirstUnboundCapturedStep(steps) {
  return selectStepAndTarget(steps.find(capturedStepNeedsImage));
}

function selectNextUnboundCapturedStepAfter(stepId) {
  const workflow = activeWorkflow();
  const steps = workflow?.steps || [];
  const index = steps.findIndex((item) => item.id === stepId);
  if (index < 0) return false;
  return selectStepAndTarget(steps.slice(index + 1).find(capturedStepNeedsImage));
}

function ensureTargetsForSteps(steps) {
  for (const item of steps) {
    const id = catalogTargetIdForStep(item);
    if (!id) continue;
    if (state.workspace.targets.some((target) => target.id === id)) continue;
    state.workspace.targets.unshift(
      normalizeTarget({
        id,
        name: friendlyTargetName(id),
        kind: targetKindForStep(item),
        match: {
          threshold: defaultThresholdForStep(item) || DEFAULT_IMAGE_THRESHOLD,
          scope: "window",
        },
        click: {
          button: normalizedButton(item.command),
          point: commandValue(item.command, "point") || "center",
        },
        texts: item.type === "ocr_assert" ? [item.target] : [],
        note: "由步骤片段自动创建，可直接 Ctrl+V 粘贴图片或绑定 ROI",
      }),
    );
  }
}

function insertStepsAt(items, index) {
  const workflow = activeWorkflow();
  if (!workflow) return null;
  const nextItems = items.filter(Boolean);
  if (!nextItems.length) return null;
  ensureTargetsForSteps(nextItems);
  const safeIndex = Math.max(0, Math.min(index, workflow.steps.length));
  workflow.steps.splice(safeIndex, 0, ...nextItems);
  state.selectedStepId = nextItems[0].id;
  markDirty("draft");
  renderSteps();
  renderStepEditor();
  renderTargets();
  return nextItems;
}

function insertStepAt(item, index) {
  return insertStepsAt([item], index)?.[0] || null;
}

function addStep() {
  const workflow = activeWorkflow();
  if (!workflow) return;
  const item = createStep($("#new-step-type").value);
  insertStepAt(item, workflow.steps.length);
  appendLog("info", `添加步骤：${item.name}`);
}

function insertStepBelowSelected() {
  const workflow = activeWorkflow();
  if (!workflow) return;
  const item = createStep($("#new-step-type").value);
  const index = selectedStepIndex(workflow);
  insertStepAt(item, index >= 0 ? index + 1 : workflow.steps.length);
  appendLog("info", `插入步骤：${item.name}`);
}

function cloneStepForInsert(source) {
  if (!source) return null;
  const item = normalizeStep({
    ...JSON.parse(JSON.stringify(source)),
    id: randomId("step"),
    name: `${source.name || stepLabels[source.type] || "步骤"} 副本`,
  });
  item.target = String(source.target ?? "");
  item.command = String(source.command ?? "");
  item.expect = String(source.expect ?? "");
  item.targetId = source.targetId ? String(source.targetId) : "";
  item.notes = String(source.notes ?? "");
  item.enabled = source.enabled !== false;
  return item;
}

function duplicateSelectedStep() {
  const workflow = activeWorkflow();
  const index = selectedStepIndex(workflow);
  if (!workflow || index < 0) {
    setStatus("需要先选择步骤");
    return;
  }
  const item = cloneStepForInsert(workflow.steps[index]);
  insertStepAt(item, index + 1);
  appendLog("info", `复制步骤：${item.name}`);
}

function createStepFromBlockDefinition(definition) {
  const item = createStep(definition.type);
  return normalizeStep({
    ...item,
    ...definition,
    id: randomId("step"),
  });
}

function createStepBlock(presetId) {
  const preset = stepBlockPresets.find((item) => item.id === presetId) || stepBlockPresets[0];
  return {
    preset,
    steps: preset.steps.map(createStepFromBlockDefinition),
  };
}

function insertStepBlock() {
  const workflow = activeWorkflow();
  if (!workflow) return;
  const { preset, steps } = createStepBlock($("#step-block-preset").value);
  const index = selectedStepIndex(workflow);
  const inserted = insertStepsAt(steps, index >= 0 ? index + 1 : workflow.steps.length);
  if (!inserted) return;
  if (selectFirstUnboundCapturedStep(inserted)) {
    renderSteps();
    renderStepEditor();
    renderTargets();
  }
  appendLog("info", `插入片段：${preset.label}（${inserted.length} 步）`);
  setStatus(`已插入片段：${preset.label}`);
}

function moveSelectedStep(direction) {
  const workflow = activeWorkflow();
  const index = workflow?.steps.findIndex((item) => item.id === state.selectedStepId) ?? -1;
  const next = index + direction;
  if (!workflow || index < 0 || next < 0 || next >= workflow.steps.length) return;
  [workflow.steps[index], workflow.steps[next]] = [workflow.steps[next], workflow.steps[index]];
  markDirty("draft");
  renderSteps();
}

function deleteSelectedStep() {
  const workflow = activeWorkflow();
  const index = workflow?.steps.findIndex((item) => item.id === state.selectedStepId) ?? -1;
  if (!workflow || index < 0) return;
  const [removed] = workflow.steps.splice(index, 1);
  state.selectedStepId = workflow.steps[Math.min(index, workflow.steps.length - 1)]?.id || null;
  markDirty("draft");
  renderSteps();
  renderStepEditor();
  renderTargets();
  appendLog("info", `删除步骤：${removed.name}`);
}

function renderStepParamPanel(item) {
  const panel = $("#step-param-panel");
  if (!panel) return;
  for (const element of panel.querySelectorAll("[data-step-types]")) {
    const types = element.dataset.stepTypes.split(/\s+/).filter(Boolean);
    element.hidden = !types.includes(item.type);
  }
  for (const element of panel.querySelectorAll("[data-param-for]")) {
    const types = element.dataset.paramFor.split(/\s+/).filter(Boolean);
    element.hidden = !types.includes(item.type);
  }

  $("#step-param-summary").textContent = paramSummaryForStep(item);
  renderTargetSelect(item);
  $("#param-pre-delay-ms").value = commandDurationMs(item.command, "preDelay") ?? "";
  $("#param-post-delay-ms").value = commandDurationMs(item.command, "postDelay") ?? "";
  $("#param-hotkey").value = item.type === "hotkey" ? item.target || "" : "";
  $("#param-text-value").value = item.type === "text_input" ? textInputValueForStep(item) : "";

  const boundTarget = targetForStep(item);
  const boundDefaults = targetCommandDefaults(boundTarget, item.command);
  const point = parsePointText(item.target) || parsePointText(item.command);
  $("#param-click-x").value = point?.x ?? "";
  $("#param-click-y").value = point?.y ?? "";
  $("#param-click-button").value = boundDefaults.button;

  $("#param-image-threshold").value = commandValue(item.command, "threshold") || boundDefaults.threshold;
  $("#param-image-button").value = boundDefaults.button;
  $("#param-image-point").value = commandValue(item.command, "point") || boundDefaults.point;
  $("#param-image-offset-x").value = commandIntegerValue(item.command, "offsetX") ?? "";
  $("#param-image-offset-y").value = commandIntegerValue(item.command, "offsetY") ?? "";
  $("#param-image-target").value = ["image_click", "wait_image", "detect_page"].includes(item.type)
    ? item.target || ""
    : "";

  $("#param-delay-ms").value = durationMsFromText(item.target) ?? item.timeoutMs ?? "";
  $("#param-delay-reason").value = commandValue(item.command, "reason") || "";
  $("#param-condition-target").value = item.type === "condition" ? item.target || "" : "";
  $("#param-condition-guard").value = commandValue(item.command, "guard") || "";
  $("#param-retry-target").value = item.type === "retry_until" ? item.target || "" : "";
  $("#param-retry-interval").value = durationMsFromText(commandValue(item.command, "interval")) ?? "";
}

function renderTargetSelect(item) {
  const select = $("#param-target-select");
  if (!select) return;
  const currentId = stepTargetId(item);
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "未绑定目标库";
  select.append(empty);
  for (const target of state.workspace.targets) {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = `${target.name} · ${target.kind}`;
    select.append(option);
  }
  select.value = state.workspace.targets.some((target) => target.id === currentId) ? currentId : "";
}

function paramSummaryForStep(item) {
  const target = targetForStep(item);
  const timing = timingSummaryForStep(item);
  if (["image_click", "wait_image", "detect_page"].includes(item.type)) {
    const threshold = commandValue(item.command, "threshold") || target?.match?.threshold || DEFAULT_IMAGE_THRESHOLD;
    const offset = item.type === "image_click" ? clickOffsetSummary(item) : "";
    const base = target ? `${target.name} · threshold ${threshold}` : `未绑定图片目标 · threshold ${threshold}`;
    return `${base}${offset}${timing}`;
  }
  if (item.type === "click") {
    const point = parsePointText(item.target) || parsePointText(item.command);
    const base = point ? `点击 ${point.x},${point.y}` : target?.roi ? "点击绑定 ROI 中心" : "需要坐标或 ROI";
    return `${base}${timing}`;
  }
  if (item.type === "hotkey") return `${item.target || "输入快捷键"}${timing}`;
  if (item.type === "text_input") return `${textInputValueForStep(item) || "输入文本"}${timing}`;
  if (item.type === "delay") return `${durationMsFromText(item.target) ?? item.timeoutMs ?? 0} ms${timing}`;
  return `保留为编排语义，当前后端不直接输入${timing}`;
}

function timingSummaryForStep(item) {
  const preDelay = commandDurationMs(item.command, "preDelay");
  const postDelay = commandDurationMs(item.command, "postDelay");
  const parts = [];
  if (preDelay) parts.push(`前 ${preDelay}ms`);
  if (postDelay) parts.push(`后 ${postDelay}ms`);
  return parts.length ? ` · ${parts.join(" / ")}` : "";
}

function clickOffsetSummary(item) {
  const x = commandIntegerValue(item.command, "offsetX") || 0;
  const y = commandIntegerValue(item.command, "offsetY") || 0;
  return x || y ? ` · offset ${x},${y}` : "";
}

function bindStepParamEditor() {
  $("#param-target-select").addEventListener("change", (event) => {
    const target = state.workspace.targets.find((item) => item.id === event.target.value);
    if (!target) {
      updateSelectedStepFromParams((item) => {
        unbindStepTarget(item);
      });
      renderTargets();
      return;
    }
    state.selectedTargetId = target.id;
    updateSelectedStepFromParams((item) => {
      bindTargetToStep(item, target, { preserveClick: item.type === "click" });
    });
    renderTargets();
  });
  $("#param-pre-delay-ms").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithDelayValue(item.command, "preDelay", event.target.value);
    });
  });
  $("#param-post-delay-ms").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithDelayValue(item.command, "postDelay", event.target.value);
    });
  });
  $("#param-hotkey").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value.trim();
      item.command = commandWithValues(item.command, { mode: "hwnd-key" });
    });
  });
  $("#param-text-value").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value;
      item.command = commandWithValues(item.command, { mode: "hwnd-char" });
    });
  });
  $("#param-click-x").addEventListener("input", updateClickPointFromParams);
  $("#param-click-y").addEventListener("input", updateClickPointFromParams);
  $("#param-click-button").addEventListener("change", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, {
        button: event.target.value,
        mode: "hwnd-message",
      });
    });
  });
  $("#param-image-threshold").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, { threshold: event.target.value.trim() });
    });
  });
  $("#param-image-button").addEventListener("change", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, { button: event.target.value });
    });
  });
  $("#param-image-point").addEventListener("change", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, { point: event.target.value });
    });
  });
  $("#param-image-offset-x").addEventListener("input", updateImageOffsetFromParams);
  $("#param-image-offset-y").addEventListener("input", updateImageOffsetFromParams);
  $("#param-image-target").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value.trim();
      if (item.targetId && item.targetId !== item.target) unbindStepTarget(item);
    });
    renderTargets();
  });
  $("#param-delay-ms").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      const ms = normalizedNonNegativeInteger(event.target.value);
      if (ms != null) {
        item.target = `${ms}ms`;
        item.timeoutMs = ms;
      }
    });
  });
  $("#param-delay-reason").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, { reason: event.target.value.trim() });
    });
  });
  $("#param-condition-target").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value.trim();
    });
  });
  $("#param-condition-guard").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.command = commandWithValues(item.command, { guard: event.target.value.trim() });
    });
  });
  $("#param-retry-target").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      item.target = event.target.value.trim();
    });
  });
  $("#param-retry-interval").addEventListener("input", (event) => {
    updateSelectedStepFromParams((item) => {
      const ms = normalizedNonNegativeInteger(event.target.value);
      if (ms != null) item.command = commandWithValues(item.command, { interval: `${ms}ms` });
    });
  });
}

function bindTargetEditor() {
  $("#target-search").addEventListener("input", (event) => {
    state.targetSearch = event.target.value;
    renderTargets({ preserveEditor: true });
  });
  $("#target-kind-filter").addEventListener("change", (event) => {
    state.targetKindFilter = event.target.value;
    renderTargets({ preserveEditor: true });
  });
  $("#target-name").addEventListener("input", (event) => {
    updateSelectedTarget((target) => {
      target.name = event.target.value.trim() || target.id;
    });
  });
  $("#target-kind").addEventListener("change", (event) => {
    updateSelectedTarget((target) => {
      target.kind = event.target.value || "unknown";
    });
  });
  $("#target-threshold").addEventListener("input", (event) => {
    updateSelectedTarget(
      (target) => {
        target.match = {
          ...(target.match || {}),
          threshold: normalizedThreshold(event.target.value, target.match?.threshold ?? DEFAULT_IMAGE_THRESHOLD),
        };
      },
      { sync: { threshold: true } },
    );
  });
  $("#target-click-button").addEventListener("change", (event) => {
    updateSelectedTarget(
      (target) => {
        target.click = {
          ...(target.click || {}),
          button: normalizedTargetButton(event.target.value),
        };
      },
      { sync: { clickButton: true } },
    );
  });
  $("#target-click-point").addEventListener("change", (event) => {
    updateSelectedTarget(
      (target) => {
        target.click = {
          ...(target.click || {}),
          point: event.target.value || "center",
        };
      },
      { sync: { clickPoint: true } },
    );
  });
  $("#target-texts").addEventListener("input", (event) => {
    updateSelectedTarget((target) => {
      target.texts = event.target.value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
    });
  });
  $("#target-note").addEventListener("input", (event) => {
    updateSelectedTarget((target) => {
      target.note = event.target.value;
    });
  });
  $("#bind-selected-target").addEventListener("click", bindSelectedTargetToStep);
  $("#unbind-step-target").addEventListener("click", unbindCurrentStepTarget);
  $("#delete-target").addEventListener("click", deleteSelectedTarget);
  $("#apply-builtin-templates").addEventListener("click", applyBuiltinTemplatesToTargets);
}

function updateClickPointFromParams() {
  updateSelectedStepFromParams((item) => {
    const x = normalizedNonNegativeInteger($("#param-click-x").value);
    const y = normalizedNonNegativeInteger($("#param-click-y").value);
    if (x != null && y != null) {
      item.target = `x=${x},y=${y}`;
      item.command = commandWithValues(item.command, { mode: "hwnd-message" });
    }
  });
}

function updateImageOffsetFromParams() {
  updateSelectedStepFromParams((item) => {
    item.command = commandWithIntegerValue(item.command, "offsetX", $("#param-image-offset-x").value);
    item.command = commandWithIntegerValue(item.command, "offsetY", $("#param-image-offset-y").value);
  });
}

function updateSelectedStepFromParams(mutator) {
  const item = selectedStep();
  if (!item) return;
  mutator(item);
  $("#step-target").value = item.target || "";
  $("#step-command").value = item.command || "";
  $("#step-timeout").value = String(item.timeoutMs ?? 0);
  markDirty("draft");
  renderSteps();
  renderStepParamPanel(item);
}

function renderStepEditor() {
  const item = selectedStep();
  $("#step-editor-empty").hidden = Boolean(item);
  $("#step-editor").hidden = !item;
  if (!item) return;
  renderStepValidationDetails(item);
  $("#step-name").value = item.name || "";
  $("#step-type").value = item.type;
  $("#step-enabled").checked = item.enabled !== false;
  $("#step-target").value = item.target || "";
  $("#step-command").value = item.command || "";
  $("#step-expect").value = item.expect || "";
  $("#step-timeout").value = String(item.timeoutMs ?? 0);
  $("#step-retry").value = String(item.retry ?? 0);
  $("#step-on-fail").value = item.onFail || "stop";
  $("#step-notes").value = item.notes || "";
  renderStepParamPanel(item);
}

function renderStepValidationDetails(item) {
  const box = $("#step-validation-detail");
  const messages = state.stepValidation[item?.id] || { issues: [], warnings: [] };
  const rows = [
    ...messages.issues.map((text) => ({ type: "issue", label: "问题", text })),
    ...messages.warnings.map((text) => ({ type: "warning", label: "提醒", text })),
  ];
  box.hidden = rows.length === 0;
  box.innerHTML = rows
    .slice(0, 4)
    .map(
      (row) => `
        <p class="${row.type}">
          <strong>${row.label}</strong>
          <span>${escapeHtml(row.text)}</span>
        </p>
      `,
    )
    .join("");
}

function bindStepEditor() {
  const update = (field, coerce = (value) => value) => (event) => {
    const item = selectedStep();
    if (!item) return;
    item[field] = coerce(event.target.value);
    if (field === "target" && item.targetId && item.targetId !== item.target) unbindStepTarget(item);
    markDirty("draft");
    renderSteps();
    if (["target", "command"].includes(field)) renderStepParamPanel(item);
    if (field === "target") renderTargets();
  };
  $("#step-name").addEventListener("input", update("name"));
  $("#step-target").addEventListener("input", update("target"));
  $("#step-command").addEventListener("input", update("command"));
  $("#step-expect").addEventListener("input", update("expect"));
  $("#step-enabled").addEventListener("change", (event) => {
    const item = selectedStep();
    if (!item) return;
    item.enabled = event.target.checked;
    markDirty("draft");
    renderSteps();
  });
  $("#step-timeout").addEventListener("input", update("timeoutMs", (value) => Number(value) || 0));
  $("#step-retry").addEventListener("input", update("retry", (value) => Number(value) || 0));
  $("#step-on-fail").addEventListener("change", update("onFail"));
  $("#step-notes").addEventListener("input", update("notes"));
  $("#step-type").addEventListener("change", (event) => {
    const item = selectedStep();
    if (!item) return;
    const defaults = stepDefaults[event.target.value] || stepDefaults.detect_page;
    item.type = event.target.value;
    item.name = defaults.name;
    item.target = defaults.target;
    item.command = defaults.command;
    item.expect = defaults.expect;
    item.timeoutMs = defaults.timeoutMs;
    item.retry = defaults.retry;
    item.onFail = defaults.onFail;
    if (!targetBackedStepTypes.has(item.type)) {
      item.targetId = "";
    }
    markDirty("draft");
    renderSteps();
    renderStepEditor();
  });
}

function commandParts(command) {
  return String(command || "")
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const splitAt = part.indexOf("=");
      if (splitAt < 0) return { raw: part };
      const key = part.slice(0, splitAt).trim();
      const value = part.slice(splitAt + 1).trim();
      return key ? { key, value } : { raw: part };
    });
}

function commandValue(command, key) {
  const expected = key.toLowerCase();
  for (const part of commandParts(command)) {
    if (part.key?.toLowerCase() === expected && part.value) return part.value;
  }
  return "";
}

function commandDurationMs(command, key) {
  const raw = commandValue(command, key);
  return raw ? durationMsFromText(raw) : null;
}

function commandIntegerValue(command, key) {
  const raw = commandValue(command, key);
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

function commandWithValues(command, updates) {
  const updateKeys = new Set(Object.keys(updates).map((key) => key.toLowerCase()));
  const parts = commandParts(command).filter((part) => !part.key || !updateKeys.has(part.key.toLowerCase()));
  for (const [key, value] of Object.entries(updates)) {
    const text = String(value ?? "").trim();
    if (text) parts.push({ key, value: text });
  }
  return parts.map((part) => (part.key ? `${part.key}=${part.value}` : part.raw)).join("; ");
}

function commandWithDelayValue(command, key, value) {
  const text = String(value ?? "").trim();
  if (!text) return commandWithValues(command, { [key]: "" });
  const ms = normalizedNonNegativeInteger(text);
  return ms == null ? command : commandWithValues(command, { [key]: `${ms}ms` });
}

function commandWithIntegerValue(command, key, value) {
  const text = String(value ?? "").trim();
  if (!text) return commandWithValues(command, { [key]: "" });
  const integer = normalizedInteger(text);
  return integer == null ? command : commandWithValues(command, { [key]: integer });
}

function parsePointText(value) {
  let x = null;
  let y = null;
  for (const part of String(value || "")
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [rawKey, rawValue] = part.split("=");
    if (!rawKey || !/^\d+$/.test(rawValue || "")) continue;
    if (rawKey.toLowerCase() === "x") x = Number(rawValue);
    if (rawKey.toLowerCase() === "y") y = Number(rawValue);
  }
  return x != null && y != null ? { x, y } : null;
}

function durationMsFromText(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  let match = text.match(/^(\d+)ms$/);
  if (match) return Number(match[1]);
  match = text.match(/^(\d+(?:\.\d+)?)s$/);
  if (match) return Math.round(Number(match[1]) * 1000);
  return /^\d+$/.test(text) ? Number(text) : null;
}

function normalizedNonNegativeInteger(value) {
  if (String(value ?? "").trim() === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizedInteger(value) {
  if (String(value ?? "").trim() === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function normalizedButton(command) {
  const value = commandValue(command, "button").toLowerCase();
  if (["right", "r", "secondary"].includes(value)) return "right";
  return "left";
}

function normalizedTargetButton(value) {
  return ["right", "r", "secondary"].includes(String(value || "").toLowerCase()) ? "right" : "left";
}

function normalizedThreshold(value, fallback = DEFAULT_IMAGE_THRESHOLD) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function stepTargetId(item) {
  if (!item) return "";
  if (item.targetId) return item.targetId;
  if (item.assetId) return item.assetId;
  return targetBackedStepTypes.has(item.type) && isLogicalTargetName(item.target) ? item.target.trim() : "";
}

function targetForStep(item) {
  const id = stepTargetId(item);
  return id ? state.workspace.targets.find((target) => target.id === id) || null : null;
}

function unbindStepTarget(item, options = {}) {
  if (!item) return "";
  const previousId = stepTargetId(item);
  item.targetId = "";
  delete item.assetId;
  if (options.clearTarget || (previousId && item.target?.trim() === previousId)) {
    item.target = "";
  }
  return previousId;
}

function targetUsages(targetId) {
  if (!targetId) return [];
  const usages = [];
  for (const workflow of state.workspace.workflows || []) {
    for (const [stepIndex, item] of (workflow.steps || []).entries()) {
      if (stepTargetId(item) !== targetId) continue;
      usages.push({
        workflowId: workflow.id,
        workflowName: workflow.name,
        stepId: item.id,
        stepName: item.name,
        stepIndex,
      });
    }
  }
  return usages;
}

function selectedManagedTarget() {
  return state.selectedTargetId
    ? state.workspace.targets.find((target) => target.id === state.selectedTargetId) || null
    : null;
}

function visibleTargets() {
  const query = state.targetSearch.trim().toLowerCase();
  return state.workspace.targets.filter((target) => {
    if (state.targetKindFilter !== "all" && target.kind !== state.targetKindFilter) return false;
    if (!query) return true;
    return targetSearchText(target).includes(query);
  });
}

function targetSearchText(target) {
  return [
    target.id,
    target.name,
    target.kind,
    target.note,
    target.texts?.join(" "),
    target.source?.display,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function ensureSelectedTarget(filteredTargets = null) {
  const visibleIds = filteredTargets ? new Set(filteredTargets.map((target) => target.id)) : null;
  const current = selectedManagedTarget();
  if (current && (!visibleIds || visibleIds.has(current.id))) return current;
  const bound = targetForStep(selectedStep());
  if (bound && (!visibleIds || visibleIds.has(bound.id))) {
    state.selectedTargetId = bound.id;
  } else {
    state.selectedTargetId = filteredTargets ? filteredTargets[0]?.id || "" : state.workspace.targets[0]?.id || "";
  }
  return selectedManagedTarget();
}

function fillTargetKindSelects() {
  for (const selector of ["#target-kind-filter", "#target-kind"]) {
    const select = $(selector);
    if (!select) continue;
    const current = select.value || (selector === "#target-kind-filter" ? "all" : "image");
    const actualKinds = state.workspace.targets.map((target) => target.kind || "unknown");
    const kindOptions = [...new Set([...targetKindOptions, ...actualKinds])];
    const options = selector === "#target-kind-filter" ? ["all", ...kindOptions] : kindOptions;
    select.replaceChildren(
      ...options.map((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === "all" ? "全部类型" : value;
        return option;
      }),
    );
    select.value = options.includes(current) ? current : options[0];
  }
}

function renderTargetEditor(filteredTargets = null) {
  const target = ensureSelectedTarget(filteredTargets);
  $("#target-editor-empty").hidden = Boolean(target);
  $("#target-editor").hidden = !target;
  if (!target) return;

  $("#target-name").value = target.name || "";
  $("#target-kind").value = [...$("#target-kind").options].some((option) => option.value === target.kind)
    ? target.kind
    : "unknown";
  $("#target-threshold").value = String(target.match?.threshold ?? DEFAULT_IMAGE_THRESHOLD);
  $("#target-click-button").value = target.click?.button || "left";
  $("#target-click-point").value = target.click?.point || "center";
  $("#target-texts").value = (target.texts || []).join("\n");
  $("#target-note").value = target.note || "";

  const usages = targetUsages(target.id);
  const usageText = usages.length
    ? `${usages.length} 处使用 · ${usages.slice(0, 3).map((item) => `${item.workflowName}/${item.stepName}`).join("，")}${usages.length > 3 ? "…" : ""}`
    : "0 处使用";
  $("#target-usage").textContent = usageText;
  $("#bind-selected-target").disabled = !selectedStep();
  $("#unbind-step-target").disabled = !stepTargetId(selectedStep());
  $("#delete-target").disabled = usages.length > 0;
  $("#delete-target").title = usages.length > 0 ? "目标仍被步骤使用，先解除绑定后再删除" : "删除当前未使用目标";
}

function updateSelectedTarget(mutator, options = {}) {
  const target = selectedManagedTarget();
  if (!target) return;
  mutator(target);
  target.updatedAt = new Date().toISOString();
  syncTargetDefaultsToBoundSteps(target, options.sync || {});
  markDirty("target");
  renderTargets({ preserveEditor: true });
  renderStepEditor();
  renderWorkflowCompletion();
}

function syncTargetDefaultsToBoundSteps(target, options = {}) {
  const updates = {};
  if (options.threshold) updates.threshold = normalizedThreshold(target.match?.threshold, DEFAULT_IMAGE_THRESHOLD);
  if (options.clickButton) updates.button = target.click?.button || "left";
  if (options.clickPoint) updates.point = target.click?.point || "center";
  if (!Object.keys(updates).length) return;
  for (const workflow of state.workspace.workflows || []) {
    for (const item of workflow.steps || []) {
      if (stepTargetId(item) !== target.id) continue;
      if (options.threshold && ["image_click", "wait_image", "detect_page"].includes(item.type)) {
        item.command = commandWithValues(item.command, { threshold: updates.threshold });
      }
      if (options.clickButton && ["image_click", "click"].includes(item.type)) {
        item.command = commandWithValues(item.command, { button: updates.button });
      }
      if (options.clickPoint && item.type === "image_click") {
        item.command = commandWithValues(item.command, { point: updates.point });
      }
    }
  }
}

function bindSelectedTargetToStep() {
  const target = selectedManagedTarget();
  if (!target) {
    setStatus("需要先选择目标");
    return;
  }
  if (!selectedStep()) {
    setStatus("需要先选择步骤");
    return;
  }
  bindTargetToSelectedStep(target, { preserveClick: true });
  markDirty("target");
  renderTargets();
  renderSteps();
  renderStepEditor();
  setStatus(`已绑定目标：${target.name}`);
}

function unbindCurrentStepTarget() {
  const item = selectedStep();
  const targetId = stepTargetId(item);
  if (!item || !targetId) {
    setStatus("当前步骤没有绑定目标");
    return;
  }
  const previous = targetForStep(item);
  unbindStepTarget(item);
  markDirty("target");
  renderTargets();
  renderSteps();
  renderStepEditor();
  setStatus(`已解除步骤目标：${previous?.name || targetId}`);
}

function deleteSelectedTarget() {
  const target = selectedManagedTarget();
  if (!target) {
    setStatus("需要先选择目标");
    return;
  }
  const usages = targetUsages(target.id);
  if (usages.length) {
    appendLog("warn", `目标仍被 ${usages.length} 个步骤使用，拒绝删除：${target.name}`);
    setStatus("目标仍在使用，先解除绑定");
    renderTargetEditor();
    return;
  }
  const index = state.workspace.targets.findIndex((item) => item.id === target.id);
  state.workspace.targets = state.workspace.targets.filter((item) => item.id !== target.id);
  state.selectedTargetId =
    state.workspace.targets[Math.min(index, state.workspace.targets.length - 1)]?.id ||
    state.workspace.targets[0]?.id ||
    "";
  markDirty("target");
  renderTargets();
  renderStepEditor();
  appendLog("info", `删除未使用目标：${target.name}`);
  setStatus(`已删除目标：${target.name}`);
}

function targetMatchesBuiltinBinding(targetId, logicalTargetId) {
  const id = String(targetId || "").trim();
  const logical = String(logicalTargetId || "").trim();
  return Boolean(id && logical && (id === logical || id.endsWith(`.${logical}`)));
}

function builtinBindingForTarget(target) {
  return builtinTargetTemplateBindings.find((binding) =>
    targetMatchesBuiltinBinding(target?.id, binding.target),
  );
}

function builtinTemplateCandidates() {
  return state.workspace.targets
    .map((target) => ({ target, binding: builtinBindingForTarget(target) }))
    .filter(({ target, binding }) => binding && !target.dataUrl && !target.roi);
}

function shouldRefreshGeneratedTargetName(target) {
  if (!target?.name) return true;
  const note = String(target.note || "");
  return note.includes("由任务步骤生成") || note.includes("由步骤片段自动创建");
}

function appendTargetNote(target, note) {
  const next = String(note || "").trim();
  if (!next) return;
  const current = String(target.note || "").trim();
  if (current.includes(next)) return;
  target.note = current ? `${current}\n${next}` : next;
}

function applyBuiltinTemplateToTarget(target, binding, template) {
  target.dataUrl = template.dataUrl || "";
  target.width = Number(template.width || 0);
  target.height = Number(template.height || 0);
  target.kind = binding.kind || target.kind || "image";
  if (shouldRefreshGeneratedTargetName(target) && binding.name) target.name = binding.name;
  target.match = {
    ...(target.match || {}),
    threshold: normalizedThreshold(binding.threshold ?? target.match?.threshold, DEFAULT_IMAGE_THRESHOLD),
    scope: target.match?.scope || "window",
  };
  target.click = {
    ...(target.click || {}),
    button: binding.button || target.click?.button || "left",
    point: binding.point || target.click?.point || "center",
  };
  target.source = {
    type: "builtin-template",
    display: `内置素材 · ${template.key}`,
    key: template.key,
    path: template.replacementPath,
    sourceRoi: template.sourceRoi || null,
    sourceFrameWidth: Number(template.sourceFrameWidth || 0),
    sourceFrameHeight: Number(template.sourceFrameHeight || 0),
    matchScore: template.matchScore ?? null,
  };
  appendTargetNote(target, `内置素材：${template.key}${template.note ? `；${template.note}` : ""}`);
  target.updatedAt = new Date().toISOString();
  syncTargetDefaultsToBoundSteps(target, { threshold: true, clickButton: true, clickPoint: true });
}

async function applyBuiltinTemplatesToTargets() {
  const stateLabel = $("#builtin-template-state");
  const candidates = builtinTemplateCandidates();
  if (!candidates.length) {
    const message = "没有可补的空目标";
    if (stateLabel) stateLabel.textContent = message;
    setStatus(message);
    appendLog("info", "内置素材：当前目标都已绑定素材/ROI，或没有匹配的内置模板");
    return;
  }
  const keys = [...new Set(candidates.map(({ binding }) => binding.key))];
  if (stateLabel) stateLabel.textContent = `读取 ${keys.length} 个内置模板…`;
  try {
    const templates = await invoke("load_builtin_target_templates", { keys });
    const byKey = new Map(templates.map((item) => [item.key, item]));
    let applied = 0;
    let missing = 0;
    for (const { target, binding } of candidates) {
      if (target.dataUrl || target.roi) continue;
      const template = byKey.get(binding.key);
      if (!template) {
        missing += 1;
        continue;
      }
      applyBuiltinTemplateToTarget(target, binding, template);
      applied += 1;
    }
    if (applied) {
      markDirty("builtin templates");
      renderTargets({ preserveEditor: true });
      renderStepEditor();
      renderWorkflowCompletion();
    }
    const message = `已接入 ${applied} 个内置素材${missing ? `，${missing} 个缺模板` : ""}`;
    if (stateLabel) stateLabel.textContent = message;
    setStatus(message);
    appendLog("info", `内置素材：${message}`);
  } catch (error) {
    const message = `内置素材读取失败：${error}`;
    if (stateLabel) stateLabel.textContent = "读取失败";
    setStatus(message);
    appendLog("error", message);
  }
}

async function hydrateBuiltinTargetTemplates(options = {}) {
  const candidates = builtinTemplateCandidates();
  if (!candidates.length) return 0;
  const keys = [...new Set(candidates.map(({ binding }) => binding.key))];
  let templates = [];
  try {
    templates = await invoke("load_builtin_target_templates", { keys });
  } catch (error) {
    appendLog("warn", `内置素材自动接入失败：${error}`);
    return 0;
  }
  const byKey = new Map(templates.map((item) => [item.key, item]));
  let applied = 0;
  for (const { target, binding } of candidates) {
    if (target.dataUrl || target.roi) continue;
    const template = byKey.get(binding.key);
    if (!template) continue;
    applyBuiltinTemplateToTarget(target, binding, template);
    applied += 1;
  }
  if (applied && options.log !== false) {
    appendLog("info", `已自动接入 ${applied} 个内置素材目标`);
  }
  return applied;
}

function targetCommandDefaults(target, command = "") {
  return {
    threshold: normalizedThreshold(target?.match?.threshold, DEFAULT_IMAGE_THRESHOLD),
    button: target?.click?.button || normalizedButton(command),
    point: target?.click?.point || commandValue(command, "point") || "center",
  };
}

function commandWithMissingValues(command, defaults) {
  const missing = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (value != null && value !== "" && !commandValue(command, key)) missing[key] = value;
  }
  return Object.keys(missing).length ? commandWithValues(command, missing) : command;
}

async function refreshPrivilege() {
  try {
    state.privilege = await invoke("privilege_status");
    const elevated = state.privilege.currentProcessElevated;
    $("#privilege-state").textContent = elevated ? "管理员" : "普通权限";
    $("#privilege-state").classList.toggle("ok", elevated);
    $("#restart-admin").disabled = elevated;
    $("#restart-admin").title = elevated ? "当前已是管理员权限" : "用 UAC 重新启动";
  } catch (error) {
    $("#privilege-state").textContent = "权限读取失败";
    $("#restart-admin").disabled = false;
    appendLog("error", `权限状态读取失败：${error}`);
  }
  renderOpsDashboard();
}

async function refreshGameLaunchStatus() {
  const button = $("#launch-game-client");
  const label = $("#launch-status");
  try {
    state.launchStatus = await invoke("game_launch_status");
    button.disabled = !state.launchStatus.configured;
    button.title = state.launchStatus.message;
    label.textContent = state.launchStatus.configured
      ? `配置：${state.launchStatus.source}`
      : "未配置客户端路径";
    label.title = state.launchStatus.message;
  } catch (error) {
    state.launchStatus = null;
    button.disabled = true;
    label.textContent = "启动配置读取失败";
    label.title = String(error);
  }
}

async function refreshWindows() {
  setStatus("正在扫描目标窗口...");
  await refreshPrivilege();
  try {
    state.windows = await invoke("list_game_windows", { titleNeedle: TARGET_TITLE });
  } catch (error) {
    state.windows = [];
    setStatus(`窗口扫描失败：${error}`);
    appendLog("error", `窗口扫描失败：${error}`);
  }

  const live = new Set(state.windows.map((item) => String(item.hwnd)));
  state.selected = new Set([...state.selected].filter((hwnd) => live.has(hwnd)));
  if (!state.activeHwnd || !live.has(String(state.activeHwnd))) {
    state.activeHwnd = state.selected.values().next().value || state.windows[0]?.hwnd || null;
  }
  if (state.activeHwnd) state.selected.add(String(state.activeHwnd));

  renderWindows();
  renderAssignments();
  renderOpsDashboard();
  await capturePreview();
  const elevatedTargets = state.windows.filter((item) => item.elevated === true).length;
  if (elevatedTargets > 0 && state.privilege?.currentProcessElevated === false) {
    setStatus(`找到 ${state.windows.length} 个窗口，其中 ${elevatedTargets} 个需要管理员权限`);
  } else {
    setStatus(`找到 ${state.windows.length} 个窗口`);
  }
}

function renderWindows() {
  $("#window-count").textContent = String(state.windows.length);
  const list = $("#window-list");
  list.replaceChildren();

  if (!state.windows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block";
    empty.textContent = `未找到标题包含“${TARGET_TITLE}”的窗口`;
    list.append(empty);
    updateActiveMeta();
    renderOpsDashboard();
    return;
  }

  for (const item of state.windows) {
    const row = document.createElement("label");
    row.className = "window-row";
    row.classList.toggle("active", String(item.hwnd) === String(state.activeHwnd));

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(String(item.hwnd));
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selected.add(String(item.hwnd));
        state.activeHwnd = item.hwnd;
      } else {
        state.selected.delete(String(item.hwnd));
        if (String(state.activeHwnd) === String(item.hwnd)) {
          state.activeHwnd = selectedWindows()[0]?.hwnd || null;
        }
      }
      renderWindows();
      renderAssignments();
      capturePreview();
    });

    const body = document.createElement("span");
    const privilege = item.elevated === true ? "管理员" : item.elevated === false ? "普通" : "未知";
    const assigned = state.workspace.assignments[String(item.hwnd)];
    const queued = assigned?.queue || [];
    const nextWorkflow = queued.filter((entry) => entry.enabled).map((entry) => workflowById(entry.workflowId)).find(Boolean);
    const assignedName = queued.length
      ? `队列 ${queued.length} 项 · 下一项：${nextWorkflow?.name || "无启用任务"}`
      : "未分配";
    body.innerHTML = `
      <strong>${escapeHtml(item.display)}</strong>
      <small>${escapeHtml(item.processName || "-")} · ${escapeHtml(item.clientWidth)}x${escapeHtml(item.clientHeight)} · ${privilege}</small>
      <em>${escapeHtml(assignedName)}</em>
    `;
    body.addEventListener("click", (event) => {
      event.preventDefault();
      state.activeHwnd = item.hwnd;
      state.selected.add(String(item.hwnd));
      renderWindows();
      renderAssignments();
      capturePreview();
    });

    row.append(checkbox, body);
    list.append(row);
  }
  updateActiveMeta();
  renderOpsDashboard();
}

function selectGameWindows() {
  state.selected = new Set(state.windows.map((item) => String(item.hwnd)));
  state.activeHwnd = state.windows[0]?.hwnd || null;
  renderWindows();
  renderAssignments();
  capturePreview();
  setStatus(`已选择 ${state.selected.size} 个窗口`);
}

function assignWorkflowToSelected() {
  const workflow = activeWorkflow();
  if (!workflow) {
    setStatus("需要先选择任务");
    return;
  }
  assignWorkflowsToSelected([workflow]);
}

function assignWorkflowsToSelected(workflows) {
  const validWorkflows = (workflows || []).filter(Boolean);
  const targets = selectedEditableWindows();
  if (!validWorkflows.length || !targets.length) {
    setStatus("需要先选择任务和可编辑窗口");
    return 0;
  }
  appendWorkflowIdsToTargets(
    validWorkflows.map((workflow) => workflow.id),
    targets,
  );
  setStatus(`已把 ${validWorkflows.length} 个任务追加到 ${targets.length} 个窗口队列`);
  return targets.length;
}

function appendPickedWorkflowsToSelected() {
  const workflowIds = selectedWorkflowIdsForQueue();
  const targets = selectedEditableWindows();
  if (!workflowIds.length || !targets.length) {
    setStatus("需要先选择任务和可编辑窗口");
    return 0;
  }
  appendWorkflowIdsToTargets(workflowIds, targets);
  setStatus(`已把 ${workflowIds.length} 个任务追加到 ${targets.length} 个窗口队列`);
  return targets.length;
}

function appendWorkflowIdsToTargets(workflowIds, targets, timing = queueTimingOptions()) {
  const validIds = workflowIds.filter((workflowId) => workflowById(workflowId));
  const staggerMs = normalizedNonNegativeInteger(timing.staggerMs) ?? 0;
  const gapMs = normalizedNonNegativeInteger(timing.gapMs) ?? 0;
  for (const [targetIndex, target] of targets.entries()) {
    const assignment = ensureAssignment(target);
    for (const [workflowIndex, workflowId] of validIds.entries()) {
      assignment.queue.push(
        queueItemForWorkflow(workflowId, assignment.queue.length + 1, {
          startDelayMs: workflowIndex === 0 ? targetIndex * staggerMs : 0,
          afterDelayMs: gapMs,
        }),
      );
    }
    assignment.queue = renumberQueue(assignment.queue);
    assignment.updatedAt = new Date().toISOString();
  }
  markDirty("queued");
  renderWindows();
  renderAssignments();
}

function copyActiveQueueToSelectedWindows() {
  const source = activeWindow();
  const sourceAssignment = source ? assignmentForHwnd(source.hwnd) : null;
  const sourceQueue = cloneQueueItems(sourceAssignment?.queue || []);
  const targets = selectedEditableWindows().filter((target) => String(target.hwnd) !== String(source?.hwnd));
  if (!source || !sourceQueue.length || !targets.length) {
    setStatus("需要先选中有队列的源窗口和目标窗口");
    return 0;
  }
  if (!window.confirm(`复制会覆盖 ${targets.length} 个窗口的现有队列，继续？`)) return 0;
  for (const target of targets) {
    const assignment = ensureAssignment(target);
    assignment.queue = cloneQueueItems(sourceQueue);
    assignment.updatedAt = new Date().toISOString();
  }
  markDirty("queued");
  renderWindows();
  renderAssignments();
  setStatus(`已复制当前窗口队列到 ${targets.length} 个窗口`);
  return targets.length;
}

function clearSelectedQueues() {
  const targets = selectedEditableWindows().filter((target) => assignmentForHwnd(target.hwnd)?.queue?.length);
  if (!targets.length) {
    setStatus("已选窗口没有可清空的队列");
    return 0;
  }
  if (!window.confirm(`将清空 ${targets.length} 个窗口的任务队列，继续？`)) return 0;
  for (const target of targets) {
    delete state.workspace.assignments[String(target.hwnd)];
  }
  markDirty("queued");
  renderWindows();
  renderAssignments();
  setStatus(`已清空 ${targets.length} 个窗口队列`);
  return targets.length;
}

function renderAssignments() {
  renderQueueOverview();
  const list = $("#assignment-list");
  list.replaceChildren();
  const entries = Object.entries(state.workspace.assignments || {}).filter(
    ([, assignment]) => assignment.queue?.length,
  );
  $("#assignment-count").textContent = String(totalQueuedWorkflows());
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "还没有窗口任务队列";
    list.append(empty);
    renderOpsDashboard();
    return;
  }
  for (const [hwnd, assignment] of entries) {
    const locked = isQueueLocked(hwnd);
    const row = document.createElement("div");
    row.className = "queue-window";
    row.classList.toggle("running", locked);
    row.innerHTML = `
      <button class="compact-row queue-window-head" type="button">
        <strong>${escapeHtml(assignment.display || hwnd)}</strong>
        <span>${assignment.queue.length} 个任务 · hwnd=${escapeHtml(hwnd)}${locked ? " · 运行中锁定" : ""}</span>
      </button>
      <div class="queue-items"></div>
    `;
    row.querySelector(".queue-window-head").addEventListener("click", () => {
      state.activeHwnd = hwnd;
      state.selected.add(String(hwnd));
      const firstWorkflow = assignment.queue.map((item) => workflowById(item.workflowId)).find(Boolean);
      if (firstWorkflow) {
        state.workspace.activeWorkflowId = firstWorkflow.id;
        state.selectedStepId = firstWorkflow.steps[0]?.id || null;
      }
      renderAll();
      capturePreview();
    });
    const items = row.querySelector(".queue-items");
    assignment.queue.forEach((queueItem, index) => {
      const workflow = workflowById(queueItem.workflowId);
      const itemRow = document.createElement("div");
      itemRow.className = "queue-item";
      itemRow.classList.toggle("disabled", queueItem.enabled === false || !workflow);
      itemRow.innerHTML = `
        <button class="queue-item-title" type="button">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <strong>${escapeHtml(workflow?.name || "任务已删除")}</strong>
          <small>${escapeHtml(queueItemSummary(queueItem, workflow))}</small>
        </button>
        <div class="queue-item-timing">
          <label>
            前等
            <input type="number" min="0" step="100" value="${escapeHtml(queueItem.startDelayMs || 0)}" data-delay-field="startDelayMs" ${locked ? "disabled" : ""} />
          </label>
          <label>
            后等
            <input type="number" min="0" step="100" value="${escapeHtml(queueItem.afterDelayMs || 0)}" data-delay-field="afterDelayMs" ${locked ? "disabled" : ""} />
          </label>
        </div>
        <div class="queue-item-actions">
          <button type="button" data-action="toggle" ${locked ? "disabled" : ""}>${queueItem.enabled === false ? "启用" : "停用"}</button>
          <button type="button" data-action="up" ${locked ? "disabled" : ""}>上移</button>
          <button type="button" data-action="down" ${locked ? "disabled" : ""}>下移</button>
          <button type="button" data-action="remove" ${locked ? "disabled" : ""}>删除</button>
        </div>
      `;
      itemRow.querySelector(".queue-item-title").addEventListener("click", () => {
        if (!workflow) return;
        state.workspace.activeWorkflowId = workflow.id;
        state.selectedStepId = workflow.steps[0]?.id || null;
        state.activeHwnd = hwnd;
        renderAll();
        capturePreview();
      });
      itemRow.querySelector(".queue-item-timing").addEventListener("change", (event) => {
        const field = event.target?.dataset?.delayField;
        if (!field) return;
        updateQueueItemTiming(hwnd, queueItem.id, field, event.target.value);
      });
      itemRow.querySelector(".queue-item-actions").addEventListener("click", (event) => {
        const action = event.target?.dataset?.action;
        if (!action) return;
        updateQueueItem(hwnd, queueItem.id, action);
      });
      items.append(itemRow);
    });
    list.append(row);
  }
  renderOpsDashboard();
}

function queueItemSummary(queueItem, workflow) {
  if (queueItem.enabled === false) return "停用";
  const parts = [`${workflow?.steps?.length || 0} 步`];
  if (queueItem.startDelayMs) parts.push(`前等 ${durationLabel(queueItem.startDelayMs)}`);
  if (queueItem.afterDelayMs) parts.push(`后等 ${durationLabel(queueItem.afterDelayMs)}`);
  return parts.join(" · ");
}

function updateQueueItem(hwnd, queueItemId, action) {
  if (isQueueLocked(hwnd)) {
    setStatus("该窗口正在运行，队列已锁定");
    appendLog("warn", `运行中的窗口队列不可修改：hwnd=${hwnd}`);
    renderAssignments();
    return;
  }
  const assignment = assignmentForHwnd(hwnd);
  const queue = assignment?.queue || [];
  const index = queue.findIndex((item) => item.id === queueItemId);
  if (!assignment || index < 0) return;
  if (action === "remove") {
    queue.splice(index, 1);
  } else if (action === "up" && index > 0) {
    [queue[index - 1], queue[index]] = [queue[index], queue[index - 1]];
  } else if (action === "down" && index < queue.length - 1) {
    [queue[index + 1], queue[index]] = [queue[index], queue[index + 1]];
  } else if (action === "toggle") {
    queue[index].enabled = queue[index].enabled === false;
  }
  assignment.queue = queue.map((item, orderIndex) => ({ ...item, order: orderIndex + 1 }));
  assignment.updatedAt = new Date().toISOString();
  if (!assignment.queue.length) delete state.workspace.assignments[String(hwnd)];
  markDirty("queued");
  renderAssignments();
  renderWindows();
}

function updateQueueItemTiming(hwnd, queueItemId, field, value) {
  if (isQueueLocked(hwnd)) {
    setStatus("该窗口正在运行，队列已锁定");
    appendLog("warn", `运行中的窗口队列不可修改：hwnd=${hwnd}`);
    renderAssignments();
    return;
  }
  if (!["startDelayMs", "afterDelayMs"].includes(field)) return;
  const assignment = assignmentForHwnd(hwnd);
  const queueItem = assignment?.queue?.find((item) => item.id === queueItemId);
  if (!assignment || !queueItem) return;
  queueItem[field] = normalizedNonNegativeInteger(value) ?? 0;
  assignment.updatedAt = new Date().toISOString();
  markDirty("queued");
  renderWindows();
  renderSessions();
}

async function restartAsAdmin() {
  try {
    await invoke("restart_as_admin");
    setStatus("已请求管理员权限重启");
  } catch (error) {
    setStatus(`管理员重启失败：${error}`);
    appendLog("error", `管理员重启失败：${error}`);
  }
}

async function launchGameClient() {
  try {
    await refreshGameLaunchStatus();
    const result = await invoke("launch_game_client");
    setStatus(`已启动客户端 pid=${result.pid}`);
    appendLog("info", `客户端启动：pid=${result.pid}`);
    window.setTimeout(refreshWindows, 3000);
  } catch (error) {
    setStatus(`启动客户端失败：${error}`);
    appendLog("error", `启动客户端失败：${error}`);
  } finally {
    await refreshGameLaunchStatus();
  }
}

async function capturePreview() {
  const target = activeWindow();
  clearRoiSelection();
  if (!target) {
    clearPreview("未选择窗口");
    return;
  }

  updateActiveMeta();
  try {
    const preview = await invoke("capture_window_preview", { hwnd: Number(target.hwnd) });
    setPreviewImage(preview.dataUrl, preview.width, preview.height, "window");
    updateActiveMeta(`${target.display} · ${preview.width}x${preview.height} · hwnd=${target.hwnd}`);
    setStatus("窗口预览已刷新");
  } catch (error) {
    clearPreview("预览失败");
    setStatus(`预览失败：${error}`);
    appendLog("error", `预览失败：${error}`);
  }
}

async function loadOfflineImage() {
  const imagePath = $("#offline-image-path").value.trim();
  if (!imagePath) {
    setStatus("需要输入离线截图路径");
    return;
  }
  clearRoiSelection();
  try {
    const preview = await invoke("import_preview_image", { imagePath, saveCopy: false });
    setPreviewImage(preview.dataUrl, preview.width, preview.height, "image");
    updateActiveMeta(`离线图 · ${preview.width}x${preview.height}`);
    setStatus(`已载入离线图：${imagePath}`);
  } catch (error) {
    clearPreview("离线图载入失败");
    setStatus(`载入离线图失败：${error}`);
    appendLog("error", `载入离线图失败：${error}`);
  }
}

function setPreviewImage(dataUrl, width, height, source) {
  const image = $("#preview-image");
  image.src = dataUrl;
  state.preview = { width, height };
  state.previewSource = source;
  $("#preview-empty").style.display = "none";
  updateRoiBox();
}

function clearPreview(message) {
  $("#preview-image").removeAttribute("src");
  $("#preview-empty").style.display = "grid";
  $("#preview-empty").textContent = message;
  state.preview = null;
  state.previewSource = "window";
  updateActiveMeta();
  updateRoiMeta();
}

function updateActiveMeta(override = null) {
  if (override) {
    $("#active-window-meta").textContent = override;
    return;
  }
  const target = activeWindow();
  $("#active-window-meta").textContent = target
    ? `${target.display} · hwnd=${target.hwnd} · ${target.clientWidth}x${target.clientHeight}`
    : "未选择窗口";
}

async function saveSnapshot() {
  const target = activeWindow();
  if (!target) {
    setStatus("需要先选择窗口");
    return;
  }
  try {
    const result = await invoke("save_window_snapshot", { hwnd: Number(target.hwnd) });
    setStatus(`已保存截图：${result.savedPath}`);
    appendLog("info", `截图保存：${result.savedPath}`);
  } catch (error) {
    setStatus(`保存截图失败：${error}`);
    appendLog("error", `保存截图失败：${error}`);
  }
}

function startRoiDrag(event) {
  if (state.previewClickCapture) {
    captureClickPointFromPreview(event);
    return;
  }
  if (event.button !== 0) return;
  const point = imagePointFromEvent(event);
  if (!point) return;
  event.preventDefault();
  state.roiDragStart = point;
  state.roiSelection = { x: point.x, y: point.y, w: 0, h: 0 };
  updateRoiBox();
}

function moveRoiDrag(event) {
  if (!state.roiDragStart) return;
  const point = imagePointFromEvent(event);
  if (!point) return;
  const start = state.roiDragStart;
  state.roiSelection = {
    x: Math.min(start.x, point.x),
    y: Math.min(start.y, point.y),
    w: Math.abs(point.x - start.x),
    h: Math.abs(point.y - start.y),
  };
  updateRoiBox();
}

function endRoiDrag() {
  if (!state.roiDragStart) return;
  state.roiDragStart = null;
  if (!state.roiSelection || state.roiSelection.w < 2 || state.roiSelection.h < 2) {
    clearRoiSelection();
    return;
  }
  updateRoiBox();
  appendLog("info", `ROI 更新：${roiText(state.roiSelection)}`);
}

function imagePointFromEvent(event) {
  const image = $("#preview-image");
  if (!state.preview || !image.getAttribute("src")) return null;
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  return {
    x: Math.round((x / rect.width) * state.preview.width),
    y: Math.round((y / rect.height) * state.preview.height),
  };
}

function clearRoiSelection() {
  state.roiDragStart = null;
  state.roiSelection = null;
  updateRoiBox();
}

function updateRoiBox() {
  const box = $("#roi-box");
  const image = $("#preview-image");
  const roi = state.roiSelection;
  if (!state.preview || !roi || roi.w < 1 || roi.h < 1 || !image.getAttribute("src")) {
    box.style.display = "none";
    updateRoiMeta();
    return;
  }
  const imageRect = image.getBoundingClientRect();
  const stageRect = $(".preview-stage").getBoundingClientRect();
  const scaleX = imageRect.width / state.preview.width;
  const scaleY = imageRect.height / state.preview.height;
  box.style.display = "block";
  box.style.left = `${imageRect.left - stageRect.left + roi.x * scaleX}px`;
  box.style.top = `${imageRect.top - stageRect.top + roi.y * scaleY}px`;
  box.style.width = `${roi.w * scaleX}px`;
  box.style.height = `${roi.h * scaleY}px`;
  updateRoiMeta();
}

function updateRoiMeta() {
  $("#roi-meta").textContent = state.roiSelection ? `ROI: ${roiText(state.roiSelection)}` : "ROI: none";
}

function togglePreviewClickCapture() {
  state.previewClickCapture = !state.previewClickCapture;
  updatePreviewClickCaptureUi();
  setStatus(state.previewClickCapture ? "采点模式已开启：在预览图上点一下生成后台点击步骤" : "采点模式已关闭");
}

function updatePreviewClickCaptureUi(point = null) {
  const button = $("#preview-click-capture");
  if (button) {
    button.classList.toggle("active", state.previewClickCapture);
    button.setAttribute("aria-pressed", String(state.previewClickCapture));
  }
  const select = $("#preview-click-button");
  if (select) select.value = state.previewClickButton;
  $(".preview-stage")?.classList.toggle("sampling", state.previewClickCapture);
  const meta = $("#preview-click-meta");
  if (!meta) return;
  if (point) {
    meta.textContent = `采点: ${point.x},${point.y} · ${state.previewClickButton === "right" ? "右键" : "左键"}`;
  } else {
    meta.textContent = state.previewClickCapture
      ? `采点: on · ${state.previewClickButton === "right" ? "右键" : "左键"}`
      : "采点: off";
  }
}

function setPreviewClickButton(value) {
  state.previewClickButton = normalizedTargetButton(value);
  updatePreviewClickCaptureUi();
}

function roiText(roi) {
  return `${roi.x},${roi.y},${roi.w},${roi.h}`;
}

function roiCenterPoint(roi) {
  if (!roi) return null;
  return {
    x: Math.round(Number(roi.x || 0) + Number(roi.w || 0) / 2),
    y: Math.round(Number(roi.y || 0) + Number(roi.h || 0) / 2),
  };
}

function captureClickPointFromPreview(event) {
  if (![0, 2].includes(event.button)) return;
  const point = imagePointFromEvent(event);
  if (!point) return;
  event.preventDefault();
  const button = event.button === 2 ? "right" : state.previewClickButton;
  state.previewClickButton = normalizedTargetButton(button);
  const destination = ensurePreviewClickStep();
  if (!destination.step) {
    setStatus("需要先创建任务");
    return;
  }
  applyClickPointToStep(destination.step, point, state.previewClickButton);
  markDirty("draft");
  clearRoiSelection();
  renderSteps();
  renderStepEditor();
  renderTargets();
  updatePreviewClickCaptureUi(point);
  appendLog(
    "info",
    `${destination.created ? "已自动新增" : "已更新"}后台点击步骤：${point.x},${point.y} · ${state.previewClickButton}`,
  );
  setStatus(`${destination.created ? "已新增" : "已更新"}后台点击：${point.x},${point.y}`);
}

function ensurePreviewClickStep() {
  const current = selectedStep();
  if (current?.type === "click") return { step: current, created: false };
  const workflow = activeWorkflow();
  if (!workflow) return { step: null, created: false };
  const item = createStep("click");
  const index = selectedStepIndex(workflow);
  const inserted = insertStepAt(item, index >= 0 ? index + 1 : workflow.steps.length);
  return { step: inserted, created: Boolean(inserted) };
}

function applyClickPointToStep(item, point, button = "left") {
  item.type = "click";
  item.name = item.name || "后台点击";
  item.target = `x=${point.x},y=${point.y}`;
  item.command = commandWithValues(item.command, {
    button: normalizedTargetButton(button),
    mode: "hwnd-message",
  });
  item.expect = item.expect || "click.accepted";
  item.timeoutMs = item.timeoutMs || stepDefaults.click.timeoutMs;
  item.onFail = normalizeStepFailAction(item.onFail, stepDefaults.click.onFail);
  unbindStepTarget(item);
}

function ensureCapturedTargetStep(targetItem) {
  const current = selectedStep();
  const hasTemplateImage = Boolean(targetItem?.dataUrl);
  if (hasTemplateImage && current && capturedImageStepTypes.has(current.type)) {
    return { step: current, created: false };
  }
  if (!hasTemplateImage && current?.type === "click") {
    return { step: current, created: false };
  }
  const workflow = activeWorkflow();
  if (!workflow) return { step: null, created: false };
  const item = createStep(hasTemplateImage ? "image_click" : "click");
  if (!hasTemplateImage) {
    const point = roiCenterPoint(targetItem?.roi);
    if (point) item.target = `x=${point.x},y=${point.y}`;
    item.command = commandWithValues(item.command, {
      button: targetItem?.click?.button || "left",
      mode: "hwnd-message",
    });
  }
  const index = selectedStepIndex(workflow);
  const inserted = insertStepAt(item, index >= 0 ? index + 1 : workflow.steps.length);
  return { step: inserted, created: true };
}

async function targetFromRoi() {
  const roi = state.roiSelection;
  if (!roi || !state.preview) {
    setStatus("需要先在预览图上框选 ROI");
    return;
  }
  const target = activeWindow();
  const dataUrl = await cropPreviewRoiDataUrl(roi).catch((error) => {
    appendLog("warn", `ROI 裁剪失败，仅保存坐标：${error}`);
    return "";
  });
  const targetItem = normalizeTarget({
    id: randomId("target"),
    name: `ROI ${roiText(roi)}`,
    kind: "roi",
    createdAt: new Date().toISOString(),
    dataUrl,
    roi,
    match: { threshold: DEFAULT_IMAGE_THRESHOLD, scope: "roi" },
    click: { button: "left", point: "center" },
    source: {
      type: state.previewSource,
      hwnd: target?.hwnd || null,
      display: target?.display || "",
    },
    width: state.preview.width,
    height: state.preview.height,
    note: "由预览框选生成",
  });
  const destination = ensureCapturedTargetStep(targetItem);
  if (!destination.step) {
    setStatus("需要先创建任务步骤");
    return;
  }
  const shouldAdvance = Boolean(targetItem.dataUrl) && !destination.created && capturedStepNeedsImage(destination.step);
  const savedTarget = saveTargetForStep(targetItem, destination.step, { allowReplace: !destination.created });
  state.selectedTargetId = savedTarget.id;
  bindTargetToStep(destination.step, savedTarget, { preserveClick: !targetItem.dataUrl });
  const advanced = shouldAdvance && selectNextUnboundCapturedStepAfter(destination.step.id);
  markDirty("target");
  renderTargets();
  renderSteps();
  renderStepEditor();
  setStatus(
    advanced
      ? `已保存 ROI 目标：${savedTarget.name}，已跳到下一个待绑定图像步骤`
      : `${destination.created ? "已自动新增步骤并保存" : "已保存"} ROI 目标：${savedTarget.name}`,
  );
}

async function cropPreviewRoiDataUrl(roi) {
  const image = $("#preview-image");
  if (!image.getAttribute("src")) throw new Error("preview image is empty");
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, roi.w);
  canvas.height = Math.max(1, roi.h);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas context unavailable");
  await image.decode().catch(() => {});
  context.drawImage(image, roi.x, roi.y, roi.w, roi.h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function handlePasteImage(event) {
  const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
  const editableTarget = isEditablePasteTarget(event.target);
  let dataUrl = "";
  let size = { width: 0, height: 0 };
  let note = "由 Ctrl+V 粘贴创建";
  if (item) {
    event.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    dataUrl = await readBlobAsDataUrl(file);
    size = await imageSize(dataUrl).catch(() => ({ width: 0, height: 0 }));
  } else {
    if (editableTarget) return;
    let imported = null;
    try {
      imported = await invoke("import_clipboard_image");
    } catch (error) {
      const message = String(error);
      if (!message.includes("剪贴板里没有图片")) {
        appendLog("warn", `后端剪贴板图片导入失败：${message}`);
      }
      return;
    }
    event.preventDefault();
    dataUrl = imported.dataUrl || "";
    size = { width: imported.width || 0, height: imported.height || 0 };
    note = "由 Ctrl+V 后端剪贴板导入创建";
  }
  if (!dataUrl) return;
  const targetItem = normalizeTarget({
    id: randomId("target"),
    name: `粘贴图片 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
    kind: "image",
    createdAt: new Date().toISOString(),
    dataUrl,
    match: { threshold: DEFAULT_IMAGE_THRESHOLD, scope: "window" },
    click: { button: "left", point: "center" },
    width: size.width,
    height: size.height,
    note,
  });
  const destination = ensureCapturedTargetStep(targetItem);
  if (!destination.step) {
    setStatus("需要先创建任务步骤");
    return;
  }
  const shouldAdvance = !destination.created && capturedStepNeedsImage(destination.step);
  const savedTarget = saveTargetForStep(targetItem, destination.step, { allowReplace: !destination.created });
  state.selectedTargetId = savedTarget.id;
  bindTargetToStep(destination.step, savedTarget);
  const advanced = shouldAdvance && selectNextUnboundCapturedStepAfter(destination.step.id);
  markDirty("target");
  renderTargets();
  renderSteps();
  renderStepEditor();
  appendLog(
    "info",
    advanced
      ? `已粘贴图片目标并跳到下一个待绑定图像步骤：${savedTarget.name}`
      : `${destination.created ? "已自动新增图像点击步骤并" : "已"}粘贴图片目标：${savedTarget.name}`,
  );
}

function isEditablePasteTarget(target) {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  return Boolean(element.closest("input, textarea, select, [contenteditable='true']"));
}

function bindTargetToSelectedStep(targetItem, options = {}) {
  const item = selectedStep();
  if (!item) return;
  bindTargetToStep(item, targetItem, options);
}

function bindTargetToStep(item, targetItem, options = {}) {
  item.targetId = targetItem.id;
  item.target = targetItem.id;
  const commandDefaults = targetCommandDefaults(targetItem, item.command);
  if (item.type === "click" && options.preserveClick) {
    item.command = commandWithValues(item.command, {
      button: commandDefaults.button,
      mode: "hwnd-message",
    });
    return;
  }
  if (item.type === "ocr_assert" || targetItem.kind === "ocr") {
    item.type = "ocr_assert";
    item.name = item.name || "OCR 确认";
    item.command = commandWithMissingValues(item.command, { lang: "zh" });
    item.expect = item.expect || "text_found";
    return;
  }
  if (!["image_click", "wait_image", "detect_page"].includes(item.type)) {
    item.type = "image_click";
    item.name = "图像点击";
    item.expect = "screen.changed";
  }
  item.command = commandWithValues(item.command, commandDefaults);
}

function saveTargetForStep(incomingTarget, item, options = {}) {
  const allowReplace = options.allowReplace !== false;
  const existing = allowReplace && item ? targetForStep(item) : null;
  const existingUsages = existing ? targetUsages(existing.id) : [];
  const canReplaceExisting = existing && (existingUsages.length <= 1 || isStepBlockPlaceholderTarget(existing));
  if (!canReplaceExisting) {
    state.workspace.targets.unshift(incomingTarget);
    return incomingTarget;
  }
  const next = normalizeTarget({
    ...existing,
    kind: incomingTarget.kind || existing.kind,
    dataUrl: incomingTarget.dataUrl || existing.dataUrl,
    roi: incomingTarget.roi || existing.roi,
    match: incomingTarget.match || existing.match,
    click: incomingTarget.click || existing.click,
    source: incomingTarget.source || existing.source,
    width: incomingTarget.width || existing.width,
    height: incomingTarget.height || existing.height,
    note: incomingTarget.note || existing.note,
    updatedAt: new Date().toISOString(),
  });
  Object.assign(existing, next);
  return existing;
}

function isStepBlockPlaceholderTarget(targetItem) {
  return !targetItem?.dataUrl && !targetItem?.roi && String(targetItem?.note || "").includes("步骤片段自动创建");
}

function targetThumbLabel(targetItem) {
  if (targetItem?.dataUrl) return "";
  if (isStepBlockPlaceholderTarget(targetItem)) return "待贴图";
  if (targetItem?.roi) return "ROI";
  if (targetItem?.kind === "ocr") return "OCR";
  if (targetItem?.kind === "click_target") return "XY";
  if (targetItem?.kind === "state") return "STATE";
  if (targetItem?.kind === "page") return "PAGE";
  if (targetItem?.kind === "image") return "IMG";
  return "?";
}

function renderTargets(options = {}) {
  fillTargetKindSelects();
  $("#target-search").value = state.targetSearch;
  $("#target-kind-filter").value = state.targetKindFilter;
  const filteredTargets = visibleTargets();
  $("#target-count").textContent =
    filteredTargets.length === state.workspace.targets.length
      ? String(state.workspace.targets.length)
      : `${filteredTargets.length}/${state.workspace.targets.length}`;
  const list = $("#target-list");
  list.replaceChildren();
  const previousSelectedTargetId = state.selectedTargetId;
  if (!state.workspace.targets.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "暂无识别目标";
    list.append(empty);
    state.selectedTargetId = "";
    renderTargetEditor([]);
    return;
  }
  ensureSelectedTarget(filteredTargets);
  if (!filteredTargets.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "没有符合筛选条件的目标";
    list.append(empty);
    renderTargetEditor(filteredTargets);
    return;
  }
  const boundTargetId = stepTargetId(selectedStep());
  for (const targetItem of filteredTargets) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "compact-row target-row";
    row.classList.toggle("active", targetItem.id === state.selectedTargetId);
    row.classList.toggle("bound", targetItem.id === boundTargetId);
    const thumb = targetItem.dataUrl
      ? `<img src="${targetItem.dataUrl}" alt="${escapeHtml(targetItem.name)}" />`
      : `<i>${escapeHtml(targetThumbLabel(targetItem))}</i>`;
    const threshold = targetItem.match?.threshold ?? DEFAULT_IMAGE_THRESHOLD;
    const click = `${targetItem.click?.button || "left"}@${targetItem.click?.point || "center"}`;
    const usages = targetUsages(targetItem.id).length;
    row.innerHTML = `
      ${thumb}
      <span>
        <strong>${escapeHtml(targetItem.name)}</strong>
        <small>${escapeHtml(targetItem.kind)} · ${targetItem.width || "-"}x${targetItem.height || "-"} · t=${escapeHtml(threshold)} · ${escapeHtml(click)} · ${usages} 处</small>
      </span>
      <em>${targetItem.id === boundTargetId ? "已绑定" : "选择"}</em>
    `;
    row.addEventListener("click", () => {
      state.selectedTargetId = targetItem.id;
      renderTargets();
      setStatus(`已选择目标：${targetItem.name}`);
    });
    row.addEventListener("dblclick", () => {
      state.selectedTargetId = targetItem.id;
      bindSelectedTargetToStep();
    });
    list.append(row);
  }
  if (!options.preserveEditor || previousSelectedTargetId !== state.selectedTargetId) {
    renderTargetEditor(filteredTargets);
  }
}

function validateWorkflow(workflow = activeWorkflow(), mode = "definition") {
  const result = {
    issues: [],
    warnings: [],
    stepIssues: {},
    stepWarnings: {},
    firstIssueStepId: "",
  };
  const addStepMessage = (bucket, item, message) => {
    if (!item?.id) return;
    const group = bucket === "issues" ? result.stepIssues : result.stepWarnings;
    (group[item.id] ||= []).push(message);
    if (bucket === "issues" && !result.firstIssueStepId) result.firstIssueStepId = item.id;
  };
  const addIssue = (message, item = null) => {
    result.issues.push(message);
    addStepMessage("issues", item, message);
  };
  const addWarning = (message, item = null) => {
    result.warnings.push(message);
    addStepMessage("warnings", item, message);
  };
  if (!workflow) addIssue("没有当前任务");
  if (workflow && !workflow.name.trim()) addIssue("任务名称为空");
  if (workflow && workflow.steps.length === 0) addIssue("步骤为空");
  const enabledSteps = workflow?.steps.filter((item) => item.enabled !== false) || [];
  if (workflow && workflow.steps.length > 0 && !enabledSteps.length) {
    addIssue("没有启用步骤");
  }
  if (workflow && enabledSteps.length > 0 && enabledSteps.length < 10) {
    addWarning("少于 10 步，作为完整样例覆盖不足");
  }
  for (const [index, item] of workflow?.steps.entries() || []) {
    const prefix = `第 ${index + 1} 步`;
    if (!stepLabels[item.type]) addIssue(`${prefix} 类型未知`, item);
    if (item.enabled === false) continue;
    if (!item.name.trim()) addIssue(`${prefix} 名称为空`, item);
    if (!item.target.trim() && !["delay", "snapshot", "text_input"].includes(item.type)) {
      addIssue(`${prefix} 缺少目标`, item);
    }
    if (!Number.isFinite(item.timeoutMs) || item.timeoutMs < 0) addIssue(`${prefix} 超时必须是非负数`, item);
    if (!Number.isFinite(item.retry) || item.retry < 0) addIssue(`${prefix} 重试必须是非负数`, item);
    if (item.type === "hotkey" && !/[+]/.test(item.target)) {
      addWarning(`${prefix} 快捷键建议使用 ALT+N 这类组合格式`, item);
    }
    validateStepRuntimeFields(item, prefix, addIssue, addWarning, mode);
  }
  return result;
}

function buildStepValidationIndex(workflow, validation) {
  const byId = {};
  const steps = workflow?.steps || [];
  for (const item of steps) {
    byId[item.id] = {
      issues: [...(validation.stepIssues?.[item.id] || [])],
      warnings: [...(validation.stepWarnings?.[item.id] || [])],
    };
  }
  return byId;
}

function validateStepRuntimeFields(item, prefix, addIssue, addWarning, mode) {
  const button = commandValue(item.command, "button");
  if (button && !["left", "l", "primary", "right", "r", "secondary"].includes(button.toLowerCase())) {
    addIssue(`${prefix} 鼠标键只支持 left/right`, item);
  }
  const threshold = commandValue(item.command, "threshold");
  if (threshold) {
    const value = Number(threshold);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      addIssue(`${prefix} 匹配阈值必须在 0 到 1 之间`, item);
    }
  }
  for (const key of ["preDelay", "postDelay"]) {
    const raw = commandValue(item.command, key);
    if (raw && durationMsFromText(raw) == null) {
      addIssue(`${prefix} ${key} 必须是 300ms、1s 或非负毫秒数字`, item);
    }
  }
  for (const key of ["offsetX", "offsetY"]) {
    const raw = commandValue(item.command, key);
    if (raw && normalizedInteger(raw) == null) {
      addIssue(`${prefix} ${key} 必须是整数像素`, item);
    }
  }
  const clickPoint = commandValue(item.command, "point");
  if (item.type === "image_click" && clickPoint && !imageClickPointOptions.has(clickPoint)) {
    addIssue(`${prefix} 图像点击点只支持 center/top-left/top-right/bottom-left/bottom-right`, item);
  }
  const point = parsePointText(item.target) || parsePointText(item.command);
  const targetId = stepTargetId(item);
  const targetItem = targetForStep(item);
  const hasRoi = Boolean(targetItem?.roi);
  const hasImage = Boolean(targetItem?.dataUrl);
  if (targetId && !targetItem) {
    addIssue(`${prefix} 绑定的识别目标已不存在`, item);
  }
  if (item.type === "click" && !point && !hasRoi) {
    const message = `${prefix} 后台点击需要 x/y 坐标或绑定 ROI 目标`;
    mode === "background" ? addIssue(message, item) : addWarning(message, item);
  }
  if (["image_click", "wait_image", "detect_page"].includes(item.type) && !hasImage) {
    const message = `${prefix} 图像步骤需要 Ctrl+V 图片或 ROI 裁剪图`;
    mode === "background" ? addIssue(message, item) : addWarning(message, item);
  }
  if (item.type === "image_click" && !hasImage && (point || hasRoi)) {
    addWarning(`${prefix} 没有图片时会退化为直接点击坐标/ROI，请确认这是有意行为`, item);
  }
  if (item.type === "ocr_assert") {
    validateOcrStepRuntimeFields(item, prefix, addIssue, addWarning, mode);
  }
  if (item.type === "delay" && durationMsFromText(item.target) == null && item.timeoutMs <= 0) {
    addIssue(`${prefix} 延迟步骤需要有效等待时长`, item);
  }
  if (item.type === "text_input") {
    const text = textInputValueForStep(item);
    if (!text) {
      addIssue(`${prefix} 文本输入需要内容`, item);
    } else if ([...text].length > MAX_TEXT_INPUT_CHARS) {
      addIssue(`${prefix} 文本输入最多 ${MAX_TEXT_INPUT_CHARS} 个字符`, item);
    }
  }
  if (item.type === "retry_until") {
    const interval = commandValue(item.command, "interval");
    if (interval && durationMsFromText(interval) == null) {
      addIssue(`${prefix} 重试间隔格式应为 800ms 或 1s`, item);
    }
  }
}

function validateOcrStepRuntimeFields(item, prefix, addIssue, addWarning, mode) {
  const texts = ocrExpectedTextsForStep(item);
  if (!texts.length) {
    const message = `${prefix} OCR 需要目标文本，可在目标库 OCR 文本里填写或在步骤目标/expect/text 参数里填写`;
    mode === "background" ? addIssue(message, item) : addWarning(message, item);
  }
  const lang = ocrLanguageForStep(item);
  if (lang && !/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(lang)) {
    addWarning(`${prefix} OCR 语言标记建议使用 zh、zh-Hans、en-US 这类格式`, item);
  }
  if (mode === "background" && !targetForStep(item)?.roi && isUnboundedOcrRegion(ocrRegionForStep(item))) {
    addWarning(`${prefix} OCR 未限定 ROI，会识别整窗，建议绑定 ROI 或设置 roi=top/panel/dialog`, item);
  }
}

function isUnboundedOcrRegion(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || ["auto", "full", "window"].includes(normalized);
}

function ocrExpectedTextsForStep(item, targetItem = targetForStep(item)) {
  const texts = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (!text || isGenericOcrExpectation(text)) return;
    if (!texts.some((item) => item.toLowerCase() === text.toLowerCase())) texts.push(text);
  };
  for (const text of targetItem?.texts || []) push(text);
  if (!texts.length) push(item?.target);
  push(item?.expect);
  push(commandValue(item?.command || "", "text"));
  push(commandValue(item?.command || "", "contains"));
  push(commandValue(item?.command || "", "expect"));
  return texts;
}

function isGenericOcrExpectation(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    !normalized ||
    normalized.startsWith("text.") ||
    ["text_found", "text.visible", "found", "visible", "ready", "ready=true", "screen.changed", "panel.open"].includes(normalized)
  );
}

function ocrLanguageForStep(item) {
  return commandValue(item?.command || "", "lang") || commandValue(item?.command || "", "language") || "zh";
}

function ocrRegionForStep(item) {
  return commandValue(item?.command || "", "roi") || "";
}

function textInputValueForStep(item) {
  return (
    commandValue(item?.command || "", "text") ||
    commandValue(item?.command || "", "value") ||
    String(item?.target || "")
  ).trim();
}

function validateActiveWorkflow() {
  const workflow = activeWorkflow();
  const result = validateWorkflow(workflow);
  if (result.issues.length) {
    if (result.firstIssueStepId) state.selectedStepId = result.firstIssueStepId;
    $("#task-model-state").textContent = "invalid";
    $("#task-model-state").classList.remove("ok");
    setRunState("blocked");
    $("#run-summary").textContent = result.issues.join(" / ");
    appendLog("warn", `定义校验未通过：${result.issues.join("；")}`);
    setStatus("任务定义需要补全");
    renderSteps();
    renderStepEditor();
    renderTargets();
    return false;
  }
  state.stepValidation = buildStepValidationIndex(workflow, result);
  $("#task-model-state").textContent = result.warnings.length ? "ready with warnings" : "ready";
  $("#task-model-state").classList.add("ok");
  setRunState("ready");
  const enabledSteps = workflow.steps.filter((item) => item.enabled !== false).length;
  $("#run-summary").textContent = `${workflow.name} · 启用 ${enabledSteps}/${workflow.steps.length} 步 · ${result.warnings.join(" / ") || "可运行"}`;
  appendLog("info", `定义校验通过：启用 ${enabledSteps}/${workflow.steps.length} 步`);
  renderSteps();
  renderStepEditor();
  return true;
}

function validateAllWorkflows() {
  const failures = [];
  const warnings = [];
  for (const workflow of state.workspace.workflows) {
    const result = validateWorkflow(workflow);
    if (result.issues.length) failures.push(`${workflow.name}: ${result.issues.length} 个问题`);
    if (result.warnings.length) warnings.push(`${workflow.name}: ${result.warnings.length} 个提醒`);
  }
  if (failures.length) {
    setRunState("blocked");
    $("#run-summary").textContent = failures.join(" / ");
    appendLog("warn", `全部校验未通过：${failures.join("；")}`);
    return false;
  }
  setRunState("ready");
  $("#run-summary").textContent = `全部 ${state.workspace.workflows.length} 个任务通过；${warnings.length ? warnings.join(" / ") : "样例覆盖完整"}`;
  appendLog("info", `全部任务校验通过：${state.workspace.workflows.length} 个`);
  return true;
}

function dryRunSelected() {
  void runSelected("dry");
}

function backgroundRunSelected() {
  void runSelected("background");
}

async function runSelected(mode) {
  const targets = selectedWindows();
  if (!targets.length) {
    setStatus("需要先选择窗口");
    return;
  }
  let launched = 0;
  for (const target of targets) {
    const assignment = assignmentForHwnd(target.hwnd);
    const hasWindowQueue = Boolean(assignment?.queue?.length);
    const source = hasWindowQueue ? "queue" : "active";
    const runEntries = hasWindowQueue ? queueRunEntriesForTarget(target) : [activeWorkflowRunEntry()].filter(Boolean);
    const workflows = runEntries.map((entry) => entry.workflow);
    if (hasWindowQueue) {
      const mismatch = windowIdentityMismatchReason(assignment.windowIdentity, windowIdentityForTarget(target));
      if (mismatch) {
        appendLog("warn", `${target.display} 队列窗口身份不匹配：${mismatch}；请刷新窗口后重新分配任务`);
        continue;
      }
    }
    if (!workflows.length) {
      appendLog("warn", `${target.display} 没有可运行任务`);
      continue;
    }
    const validation = validateWorkflowQueue(workflows, mode);
    if (validation.issues.length) {
      if (validation.firstBlockingWorkflow?.id === activeWorkflow()?.id) {
        state.stepValidation = buildStepValidationIndex(
          validation.firstBlockingWorkflow,
          validation.firstBlockingValidation,
        );
        if (validation.firstBlockingValidation.firstIssueStepId) {
          state.selectedStepId = validation.firstBlockingValidation.firstIssueStepId;
        }
        renderSteps(validation.firstBlockingValidation);
        renderStepEditor();
      }
      appendLog("warn", `${target.display} 队列校验失败：${validation.issues.join("；")}`);
      continue;
    }
    if (validation.warnings.length) {
      appendLog("warn", `${target.display} 队列提醒：${validation.warnings.join("；")}`);
    }
    if (await startRunForWindow(target, runEntries, mode, source)) launched += 1;
  }
  setStatus(launched ? `已启动 ${launched} 个窗口队列` : "没有启动任何窗口队列");
}

function validateWorkflowQueue(workflows, mode = "definition") {
  const issues = [];
  const warnings = [];
  let firstBlockingWorkflow = null;
  let firstBlockingValidation = null;
  for (const [index, workflow] of workflows.entries()) {
    const result = validateWorkflow(workflow, mode);
    if (result.issues.length && !firstBlockingWorkflow) {
      firstBlockingWorkflow = workflow;
      firstBlockingValidation = result;
    }
    for (const issue of result.issues) issues.push(`${index + 1}.${workflow.name}: ${issue}`);
    for (const warning of result.warnings) warnings.push(`${index + 1}.${workflow.name}: ${warning}`);
  }
  return { issues, warnings, firstBlockingWorkflow, firstBlockingValidation };
}

async function startRunForWindow(target, runEntries, mode, source) {
  const key = String(target.hwnd);
  const running = state.sessions[key]?.status === "running";
  if (running) {
    appendLog("warn", `${target.display} 已有运行中的会话，同 hwnd 保持互斥`);
    return false;
  }
  const windowIdentity = await currentWindowIdentityForRun(target, mode);
  if (!windowIdentity) return false;
  const runPlan = runEntries.map((entry) => ({
    workflow: JSON.parse(JSON.stringify(entry.workflow)),
    queueItem: normalizeQueueItem(entry.queueItem || { workflowId: entry.workflow.id }),
  }));
  const enabledStepTotal = runPlan.reduce(
    (sum, entry) => sum + entry.workflow.steps.filter((item) => item.enabled !== false).length,
    0,
  );
  if (!enabledStepTotal) {
    appendLog("warn", `${target.display} 队列没有启用步骤`);
    return false;
  }
  const session = {
    id: `run-${++state.sessionSerial}`,
    mode,
    source,
    hwnd: target.hwnd,
    display: target.display,
    windowIdentity,
    workflowIds: runPlan.map((entry) => entry.workflow.id),
    workflowNames: runPlan.map((entry) => entry.workflow.name),
    workflowId: runPlan[0]?.workflow.id || "",
    workflowName: runPlan.length === 1 ? runPlan[0].workflow.name : `${runPlan.length} 个任务`,
    queuePlan: runPlan.map((entry, index) => ({
      queueItemId: entry.queueItem.id,
      workflowId: entry.workflow.id,
      workflowName: entry.workflow.name,
      order: index + 1,
      startDelayMs: entry.queueItem.startDelayMs || 0,
      afterDelayMs: entry.queueItem.afterDelayMs || 0,
    })),
    queueEvents: [],
    currentWorkflowName: "",
    status: "running",
    currentStep: 0,
    totalSteps: enabledStepTotal,
    startedAt: new Date().toISOString(),
    logs: [],
    stepResults: [],
    failureReason: "",
    failedWorkflowName: "",
    failedStepName: "",
    endedWindowIdentity: null,
    endedWindowIdentityError: "",
    cancelRequested: false,
  };
  state.sessions[key] = session;
  setRunState("running");
  appendLog("info", `${modeLabel(mode)} 启动：${target.display} -> ${session.workflowNames.join(" / ")}`);
  renderSessions();
  void runSession(session, runPlan);
  return true;
}

async function runSession(session, runPlan) {
  for (const entry of runPlan) {
    const workflow = entry.workflow;
    const queueItem = entry.queueItem;
    if (session.cancelRequested || session.status === "failed") break;
    session.currentWorkflowName = workflow.name;
    if (queueItem.startDelayMs > 0) {
      const completed = await runQueueDelay(session, workflow, "start", queueItem.startDelayMs);
      if (!completed) break;
    }
    const steps = workflow.steps.filter((item) => item.enabled !== false);
    for (const item of steps) {
      if (session.cancelRequested) break;
      session.currentStep += 1;
      const stepStartedAt = new Date();
      let result = null;
      let stopAfterResult = false;
      const preDelay = await runStepDelay(session, workflow, item, "preDelay");
      if (!preDelay.completed) {
        result = withStepTimingDetail(
          {
            status: "stopped",
            action: "pre_delay",
            detail: "interrupted after stop request during step preDelay",
            inputSent: false,
            matched: false,
          },
          preDelay.elapsedMs,
          0,
        );
        recordSessionStepResult(session, workflow, item, result, stepStartedAt, new Date());
        renderSessions();
        break;
      }
      if (session.mode === "background") {
        result = await executeBackgroundStepWithRetries(session, item).catch((error) => ({
          status: "error",
          action: "backend",
          detail: String(error),
          inputSent: false,
          matched: false,
        }));
        session.logs.unshift(formatStepLog(session.currentStep - 1, workflow, item, result));
        stopAfterResult = shouldStopAfterResult(item, result);
        if (stopAfterResult) {
          session.cancelRequested = true;
          session.status = "failed";
          session.failureReason = result.detail || `${result.status}/${result.action}`;
          session.failedWorkflowName = workflow.name;
          session.failedStepName = item.name || stepLabels[item.type] || item.type;
        }
      } else {
        result = {
          status: "observed",
          action: "dry_run",
          detail: "observation run only; no backend screenshot or input was invoked",
          inputSent: false,
          matched: false,
        };
        session.logs.unshift(formatStepLog(session.currentStep - 1, workflow, item, result));
        await cancellableSleep(session, dryRunDelay(item));
      }
      const postDelay =
        session.cancelRequested || stopAfterResult
          ? { completed: true, elapsedMs: 0 }
          : await runStepDelay(session, workflow, item, "postDelay");
      if (!postDelay.completed) {
        result = {
          ...result,
          status: "stopped",
          action: "post_delay",
          detail: `${result?.detail || ""}; interrupted after stop request during step postDelay`,
        };
      }
      result = withStepTimingDetail(result, preDelay.elapsedMs, postDelay.elapsedMs);
      recordSessionStepResult(session, workflow, item, result, stepStartedAt, new Date());
      renderSessions();
      if (session.status === "failed") break;
    }
    if (session.cancelRequested || session.status === "failed") break;
    if (queueItem.afterDelayMs > 0) {
      const completed = await runQueueDelay(session, workflow, "after", queueItem.afterDelayMs);
      if (!completed) break;
    }
  }
  if (session.status !== "failed") {
    session.status = session.cancelRequested ? "stopped" : "done";
    if (session.status === "stopped" && !session.failureReason) session.failureReason = "user requested stop";
  }
  session.endedAt = new Date().toISOString();
  session.durationMs = Math.max(0, Date.parse(session.endedAt) - Date.parse(session.startedAt));
  await attachEndedWindowIdentity(session);
  state.workspace.runHistory.unshift(runHistoryEntryFromSession(session));
  state.workspace.runHistory = state.workspace.runHistory.slice(0, 80);
  markDirty("run logged");
  renderSessions();
  const stillRunning = Object.values(state.sessions).some((item) => item.status === "running");
  setRunState(stillRunning ? "running" : "idle");
  appendLog(
    session.status === "done" ? "info" : "warn",
    `${modeLabel(session.mode)} ${session.status}：${session.display}`,
  );
}

function recordSessionStepResult(session, workflow, item, result, startedAt, endedAt) {
  const record = {
    order: session.currentStep,
    workflowId: workflow.id,
    workflowName: workflow.name,
    stepId: item.id,
    stepName: item.name || stepLabels[item.type] || item.type,
    stepType: item.type,
    status: result?.status || "unknown",
    action: result?.action || "",
    detail: result?.detail || "",
    inputSent: Boolean(result?.inputSent),
    matched: Boolean(result?.matched),
    x: result?.x ?? null,
    y: result?.y ?? null,
    score: result?.score ?? null,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
  };
  session.stepResults.push(record);
  if (session.stepResults.length > MAX_SESSION_STEP_RESULTS) {
    session.stepResults.splice(0, session.stepResults.length - MAX_SESSION_STEP_RESULTS);
  }
}

async function runQueueDelay(session, workflow, phase, ms) {
  const label = phase === "start" ? "启动前错峰" : "任务后间隔";
  appendLog("info", `${session.display} / ${workflow.name} ${label} ${durationLabel(ms)}`);
  const startedAt = new Date();
  const completed = await cancellableSleep(session, ms);
  const endedAt = new Date();
  const event = {
    workflowId: workflow.id,
    workflowName: workflow.name,
    phase,
    delayMs: ms,
    status: completed ? "done" : "stopped",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
  };
  session.queueEvents.push(event);
  session.logs.unshift(`${workflow.name} / ${label} ${completed ? "完成" : "已停止"} · ${durationLabel(ms)}`);
  renderSessions();
  return completed;
}

async function runStepDelay(session, workflow, item, key) {
  const ms = stepTimingDelay(item, key);
  if (ms <= 0) return { completed: true, elapsedMs: 0 };
  const label = key === "preDelay" ? "步骤前等待" : "步骤后等待";
  appendLog("info", `${session.display} / ${workflow.name} / ${item.name} ${label} ${durationLabel(ms)}`);
  const startedAt = Date.now();
  const completed = await cancellableSleep(session, ms);
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  session.logs.unshift(`${workflow.name} / ${item.name} / ${label} ${completed ? "完成" : "已停止"} · ${durationLabel(ms)}`);
  renderSessions();
  return { completed, elapsedMs: completed ? ms : elapsedMs };
}

function stepTimingDelay(item, key) {
  return Math.max(0, commandDurationMs(item.command, key) ?? 0);
}

function withStepTimingDetail(result, preDelayMs, postDelayMs) {
  if (!preDelayMs && !postDelayMs) return result;
  return {
    ...result,
    detail: `${result?.detail || ""}; timing preDelay=${preDelayMs}ms postDelay=${postDelayMs}ms`,
  };
}

async function attachEndedWindowIdentity(session) {
  try {
    const current = await invoke("current_window_identity", { hwnd: Number(session.hwnd) });
    session.endedWindowIdentity = windowIdentityForTarget(current);
    session.endedWindowIdentityError = "";
  } catch (error) {
    session.endedWindowIdentity = null;
    session.endedWindowIdentityError = String(error);
  }
}

function runHistoryEntryFromSession(session) {
  return {
    id: session.id,
    mode: session.mode,
    source: session.source,
    hwnd: session.hwnd,
    display: session.display,
    workflowId: session.workflowId,
    workflowName: session.workflowName,
    workflowIds: session.workflowIds,
    workflowNames: session.workflowNames,
    queueLength: session.workflowIds.length,
    status: session.status,
    totalSteps: session.totalSteps,
    completedSteps: session.currentStep,
    durationMs: session.durationMs || 0,
    failureReason: session.failureReason || "",
    failedWorkflowName: session.failedWorkflowName || "",
    failedStepName: session.failedStepName || "",
    windowIdentity: session.windowIdentity,
    endedWindowIdentity: session.endedWindowIdentity,
    endedWindowIdentityError: session.endedWindowIdentityError || "",
    queuePlan: session.queuePlan || [],
    queueEvents: session.queueEvents || [],
    stepResults: session.stepResults.slice(-MAX_SESSION_STEP_RESULTS),
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
}

async function executeBackgroundStepWithRetries(session, item) {
  const retries = Math.max(0, Math.floor(Number.isFinite(Number(item.retry)) ? Number(item.retry) : 0));
  const attempts = retries + 1;
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await executeBackgroundStep(session, item);
    if (attempts > 1) {
      result = {
        ...result,
        detail: `${result.detail} (attempt ${attempt}/${attempts})`,
      };
    }
    if (!shouldRetryBackgroundStep(item, result) || attempt === attempts) return result;
    const completed = await cancellableSleep(session, backgroundRetryDelay(item));
    if (!completed) {
      return {
        ...result,
        status: "stopped",
        action: "retry_wait",
        detail: `${result.detail}; stopped during retry wait`,
      };
    }
  }
  return result;
}

async function executeBackgroundStep(session, item) {
  if (item.type === "delay") {
    const ms = backgroundStepDelay(item);
    const completed = await cancellableSleep(session, ms);
    return {
      status: completed ? "ok" : "stopped",
      action: "delay",
      detail: completed ? `waited ${ms}ms` : `interrupted after stop request during ${ms}ms delay`,
      inputSent: false,
      matched: false,
    };
  }
  if (item.type === "retry_until") {
    return executeRetryUntilStep(session, item);
  }
  return executeBackendStep(session, item);
}

async function executeRetryUntilStep(session, item) {
  if (!retryUntilHasVisualTarget(item)) {
    const result = await executeBackendStep(session, item);
    return {
      ...result,
      action: "retry_until",
      detail: `${result.detail}; no image or ROI target is bound, kept as planned state wait`,
    };
  }
  const timeoutMs = Math.max(0, Number(item.timeoutMs) || 0);
  const intervalMs = backgroundRetryDelay(item);
  const deadline = Date.now() + timeoutMs;
  const probe = { ...item, type: "wait_image" };
  let attempt = 0;
  let result = null;
  do {
    attempt += 1;
    result = await executeBackendStep(session, probe);
    if (result.matched || result.status === "matched" || result.status === "sent") {
      return {
        ...result,
        status: "ok",
        action: "retry_until",
        detail: `${result.detail} (ready after ${attempt} attempt${attempt === 1 ? "" : "s"})`,
      };
    }
    if (!["below_threshold", "planned"].includes(result.status)) return result;
    if (Date.now() >= deadline) break;
    const completed = await cancellableSleep(session, Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    if (!completed) return {
      ...(result || {}),
      status: "stopped",
      action: "retry_until",
      detail: `interrupted after stop request during retry_until wait; ${result?.detail || ""}`.trim(),
      inputSent: false,
      matched: false,
    };
  } while (timeoutMs > 0);
  return {
    ...(result || {}),
    status: "below_threshold",
    action: "retry_until",
    detail: `retry_until timeout after ${timeoutMs}ms${result?.detail ? `; ${result.detail}` : ""}`,
    inputSent: false,
    matched: false,
  };
}

function retryUntilHasVisualTarget(item) {
  const targetItem = targetForStep(item);
  return Boolean(targetItem?.dataUrl || targetItem?.roi || parsePointText(item.target) || parsePointText(item.command));
}

function shouldRetryBackgroundStep(item, result) {
  if (!["below_threshold", "text_miss", "ocr_unavailable"].includes(result.status)) return false;
  return item.onFail === "retry" || ["wait_image", "detect_page", "image_click", "ocr_assert"].includes(item.type);
}

function backgroundRetryDelay(item) {
  return Math.max(50, durationMsFromText(commandValue(item.command, "interval")) ?? 300);
}

function backgroundStepDelay(item) {
  return Math.max(0, durationMsFromText(item.target) ?? item.timeoutMs ?? 0);
}

async function executeBackendStep(session, item) {
  const payload = backendStepPayload(item);
  return invoke("execute_workflow_step", {
    hwnd: Number(session.hwnd),
    step: payload,
    expectedWindow: session.windowIdentity || null,
  });
}

function windowIdentityForTarget(target) {
  return {
    hwnd: Number(target.hwnd) || 0,
    title: target.title || "",
    processId: Number(target.processId) || 0,
    processName: target.processName || "",
    clientWidth: Number(target.clientWidth) || 0,
    clientHeight: Number(target.clientHeight) || 0,
    elevated: typeof target.elevated === "boolean" ? target.elevated : null,
  };
}

async function currentWindowIdentityForRun(target, mode) {
  const expected = windowIdentityForTarget(target);
  const expectedIssue = requiredBackgroundWindowIdentityIssue(expected);
  if (expectedIssue) {
    appendLog("warn", `${target.display} 窗口身份不完整：${expectedIssue}；请刷新窗口列表后再运行`);
    return null;
  }
  if (mode !== "background") return expected;
  let current = null;
  try {
    current = normalizeWindowIdentity(
      await invoke("current_window_identity", {
        hwnd: Number(target.hwnd),
      }),
    );
  } catch (error) {
    appendLog("warn", `${target.display} 后端窗口身份复核失败：${error}`);
    return null;
  }
  const currentIssue = requiredBackgroundWindowIdentityIssue(current);
  if (currentIssue) {
    appendLog("warn", `${target.display} 后端窗口身份不完整：${currentIssue}；请刷新窗口列表后再运行`);
    return null;
  }
  const mismatch = windowIdentityMismatchReason(expected, current);
  if (mismatch) {
    appendLog("warn", `${target.display} 后端窗口身份已变化：${mismatch}；请刷新窗口列表后再运行`);
    return null;
  }
  return current;
}

function requiredBackgroundWindowIdentityIssue(identity) {
  const value = normalizeWindowIdentity(identity);
  if (!value.hwnd) return "缺少 hwnd";
  if (!value.title) return "缺少窗口标题";
  if (!value.processId) return "缺少进程 PID";
  if (!value.clientWidth || !value.clientHeight) return "缺少客户区尺寸";
  return "";
}

function windowIdentityMismatchReason(expected, actual) {
  const left = normalizeWindowIdentity(expected);
  const right = normalizeWindowIdentity(actual);
  if (left.hwnd && right.hwnd && left.hwnd !== right.hwnd) return `hwnd ${left.hwnd} -> ${right.hwnd}`;
  if (left.title && right.title && left.title !== right.title) return `title ${left.title} -> ${right.title}`;
  if (left.processId && right.processId && left.processId !== right.processId) return `pid ${left.processId} -> ${right.processId}`;
  if (left.processName && right.processName && left.processName.toLowerCase() !== right.processName.toLowerCase()) {
    return `process ${left.processName} -> ${right.processName}`;
  }
  if (left.clientWidth && right.clientWidth && Math.abs(left.clientWidth - right.clientWidth) > WINDOW_CLIENT_SIZE_TOLERANCE) {
    return `clientWidth ${left.clientWidth} -> ${right.clientWidth}`;
  }
  if (left.clientHeight && right.clientHeight && Math.abs(left.clientHeight - right.clientHeight) > WINDOW_CLIENT_SIZE_TOLERANCE) {
    return `clientHeight ${left.clientHeight} -> ${right.clientHeight}`;
  }
  if (typeof left.elevated === "boolean" && typeof right.elevated === "boolean" && left.elevated !== right.elevated) {
    return `elevated ${left.elevated} -> ${right.elevated}`;
  }
  return "";
}

function backendStepPayload(item) {
  const targetItem = targetForStep(item);
  const targetId = stepTargetId(item);
  const command = effectiveCommandForStep(item, targetItem);
  const payload = {
    type: item.type,
    target: item.target || "",
    command,
    expect: item.expect || "",
    targetId,
    targetKind: targetItem?.kind || "",
    targetDataUrl: targetItem?.dataUrl || "",
    assetId: targetId,
    assetKind: targetItem?.kind || "",
    assetDataUrl: targetItem?.dataUrl || "",
    roi: targetItem?.roi || null,
  };
  if (item.type === "ocr_assert") {
    payload.targetTexts = ocrExpectedTextsForStep(item, targetItem);
    payload.ocrLanguage = ocrLanguageForStep(item);
    payload.ocrRegion = ocrRegionForStep(item);
  }
  return payload;
}

function effectiveCommandForStep(item, targetItem = targetForStep(item)) {
  if (!targetItem) return item.command || "";
  const defaults = targetCommandDefaults(targetItem, item.command);
  if (["image_click", "wait_image", "detect_page"].includes(item.type)) {
    return commandWithMissingValues(item.command, defaults);
  }
  if (item.type === "click") {
    return commandWithMissingValues(item.command, {
      button: defaults.button,
      mode: "hwnd-message",
    });
  }
  return item.command || "";
}

function formatStepLog(index, workflow, item, result) {
  const point = result.x != null && result.y != null ? ` @${result.x},${result.y}` : "";
  const score = result.score != null ? ` score=${Number(result.score).toFixed(3)}` : "";
  const sent = result.inputSent ? " sent" : "";
  return `${String(index + 1).padStart(2, "0")} ${workflow.name} / ${item.name} [${item.type}] ${result.status}/${result.action}${point}${score}${sent} · ${result.detail}`;
}

function shouldStopAfterResult(item, result) {
  if (result.status === "error") return true;
  if (["unsupported", "missing_asset", "below_threshold", "text_miss", "ocr_unavailable", "missing_expect"].includes(result.status)) {
    return ["stop", "restore"].includes(item.onFail || "stop");
  }
  return false;
}

function modeLabel(mode) {
  return mode === "background" ? "后台运行" : "观察运行";
}

function dryRunDelay(item) {
  if (item.type === "delay") return Math.max(120, Math.min(480, durationMsFromText(item.target) ?? item.timeoutMs ?? 200));
  return Math.max(90, Math.min(260, Math.round((item.timeoutMs || 1000) / 24)));
}

function stopDryRun() {
  let count = 0;
  for (const session of Object.values(state.sessions)) {
    if (session.status === "running") {
      session.cancelRequested = true;
      count += 1;
    }
  }
  appendLog("warn", `已请求停止 ${count} 个运行会话`);
  renderSessions();
}

function renderSessions() {
  const lanes = $("#session-lanes");
  lanes.replaceChildren();
  const sessions = Object.values(state.sessions);
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-block compact";
    empty.textContent = "暂无运行会话";
    lanes.append(empty);
  }
  for (const session of sessions) {
    const lane = document.createElement("div");
    lane.className = `session-lane ${session.status}`;
    lane.innerHTML = `
      <div>
        <strong>${escapeHtml(session.display)}</strong>
        <span>${escapeHtml(modeLabel(session.mode))} · ${escapeHtml(session.workflowName)} · ${session.currentStep}/${session.totalSteps}</span>
      </div>
      <progress max="${session.totalSteps}" value="${session.currentStep}"></progress>
      <small>${escapeHtml(session.status)} · ${escapeHtml(session.currentWorkflowName || "等待")} · hwnd=${escapeHtml(session.hwnd)}</small>
    `;
    if (session.logs.length) {
      const latest = document.createElement("small");
      latest.textContent = session.logs[0];
      lane.append(latest);
    }
    lanes.append(lane);
  }
  renderRunHistory(lanes);
  renderOpsDashboard();
}

function renderRunHistory(container) {
  const records = state.workspace.runHistory.slice(0, 5);
  if (!records.length) return;
  const header = document.createElement("div");
  header.className = "run-history-title";
  header.textContent = "最近运行报告";
  container.append(header);
  for (const record of records) {
    const lane = document.createElement("div");
    const status = record.status || "unknown";
    const lastStep = Array.isArray(record.stepResults) ? record.stepResults.at(-1) : null;
    const failed = record.failedStepName || (status === "failed" ? lastStep?.stepName : "");
    lane.className = `session-lane history ${status}`;
    lane.innerHTML = `
      <div>
        <strong>${escapeHtml(record.display || record.hwnd)}</strong>
        <span>${escapeHtml(modeLabel(record.mode))} · ${escapeHtml(record.workflowName || `${record.queueLength || 0} 个任务`)} · ${escapeHtml(status)}</span>
      </div>
      <small>${escapeHtml(record.completedSteps ?? record.stepResults?.length ?? 0)}/${escapeHtml(record.totalSteps || 0)} 步 · ${escapeHtml(durationLabel(record.durationMs))} · ${escapeHtml(record.endedAt || "")}</small>
      <small>${escapeHtml(failed ? `失败点：${failed}` : lastStep ? `末步：${lastStep.stepName} ${lastStep.status}/${lastStep.action}` : "无步骤明细")}</small>
    `;
    if (record.failureReason) {
      const reason = document.createElement("small");
      reason.textContent = record.failureReason;
      lane.append(reason);
    }
    if (record.endedWindowIdentityError) {
      const identity = document.createElement("small");
      identity.textContent = `结束窗口身份读取失败：${record.endedWindowIdentityError}`;
      lane.append(identity);
    }
    container.append(lane);
  }
}

function durationLabel(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

function exportWorkspace() {
  const json = JSON.stringify(state.workspace, null, 2);
  $("#workspace-json").value = json;
  navigator.clipboard?.writeText(json).catch(() => {});
  setStatus("工作区 JSON 已导出并尝试复制");
}

async function importWorkspace() {
  try {
    const parsed = JSON.parse($("#workspace-json").value);
    state.workspace = normalizeWorkspace(parsed);
    state.selectedStepId = activeWorkflow()?.steps[0]?.id || null;
    markDirty("imported");
    await saveWorkspaceNow();
    renderAll();
    setStatus("工作区 JSON 已载入");
  } catch (error) {
    setStatus(`工作区 JSON 载入失败：${error.message}`);
    appendLog("error", `工作区 JSON 载入失败：${error.message}`);
  }
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function imageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new globalThis.Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function cancellableSleep(session, ms) {
  const deadline = Date.now() + Math.max(0, Number(ms) || 0);
  while (!session.cancelRequested && Date.now() < deadline) {
    await sleep(Math.min(250, deadline - Date.now()));
  }
  return !session.cancelRequested;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function randomId(prefix) {
  const id =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${id}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

fillStepTypeSelect($("#new-step-type"));
fillStepTypeSelect($("#step-type"));
fillStepBlockSelect($("#step-block-preset"));
fillWorkflowBlueprintSelect($("#workflow-blueprint-select"));

$("#refresh-windows").addEventListener("click", refreshWindows);
$("#launch-game-client").addEventListener("click", launchGameClient);
$("#select-game-windows").addEventListener("click", selectGameWindows);
$("#prepare-exercise-workspace").addEventListener("click", prepareExerciseWorkspace);
$("#restart-admin").addEventListener("click", restartAsAdmin);
$("#save-workspace").addEventListener("click", () => saveWorkspaceNow());
$("#capture-preview").addEventListener("click", capturePreview);
$("#save-snapshot").addEventListener("click", saveSnapshot);
$("#load-offline-image").addEventListener("click", loadOfflineImage);
$("#target-from-roi").addEventListener("click", targetFromRoi);
$("#assign-selected").addEventListener("click", assignWorkflowToSelected);
$("#append-picked-workflows").addEventListener("click", appendPickedWorkflowsToSelected);
$("#copy-active-queue-to-selected").addEventListener("click", copyActiveQueueToSelectedWindows);
$("#clear-selected-queues").addEventListener("click", clearSelectedQueues);
$("#workflow-blueprint-select").addEventListener("change", () => {
  syncWorkflowBlueprintDefaults({ force: true });
  renderBlueprintPreview();
  renderBlueprintGallery();
});
$("#create-workflow-from-blueprint").addEventListener("click", () => createWorkflowBatch());
$("#create-and-assign-blueprint").addEventListener("click", () => createWorkflowBatch({ assignToSelected: true }));
$("#create-exercise-suite").addEventListener("click", createExerciseSuite);
$("#new-workflow").addEventListener("click", newWorkflow);
$("#import-sample-pack").addEventListener("click", importSampleWorkflowPack);
$("#duplicate-workflow").addEventListener("click", duplicateWorkflow);
$("#delete-workflow").addEventListener("click", deleteWorkflow);
$("#add-step").addEventListener("click", addStep);
$("#insert-step-below").addEventListener("click", insertStepBelowSelected);
$("#duplicate-step").addEventListener("click", duplicateSelectedStep);
$("#insert-step-block").addEventListener("click", insertStepBlock);
$("#move-step-up").addEventListener("click", () => moveSelectedStep(-1));
$("#move-step-down").addEventListener("click", () => moveSelectedStep(1));
$("#delete-step").addEventListener("click", deleteSelectedStep);
$("#focus-next-gap").addEventListener("click", focusNextCompletionGap);
$("#validate-workflow").addEventListener("click", validateActiveWorkflow);
$("#validate-all-workflows").addEventListener("click", validateAllWorkflows);
$("#dry-run-selected").addEventListener("click", dryRunSelected);
$("#background-run-selected").addEventListener("click", backgroundRunSelected);
$("#stop-dry-run").addEventListener("click", stopDryRun);
$("#export-workspace").addEventListener("click", exportWorkspace);
$("#import-workspace").addEventListener("click", importWorkspace);
$("#preview-click-capture").addEventListener("click", togglePreviewClickCapture);
$("#preview-click-button").addEventListener("change", (event) => setPreviewClickButton(event.target.value));
$("#preview-image").addEventListener("mousedown", startRoiDrag);
$("#preview-image").addEventListener("contextmenu", (event) => {
  if (state.previewClickCapture) event.preventDefault();
});
window.addEventListener("mousemove", moveRoiDrag);
window.addEventListener("mouseup", endRoiDrag);
window.addEventListener("resize", updateRoiBox);
window.addEventListener("paste", handlePasteImage);

bindWorkflowInputs();
bindStepEditor();
bindStepParamEditor();
bindTargetEditor();
appendLog("info", "本地任务模型初始化中");
await setupCloseToTray();
await loadWorkspace();
state.selectedStepId = activeWorkflow()?.steps[0]?.id || null;
renderAll();
updatePreviewClickCaptureUi();
await refreshPrivilege();
await refreshGameLaunchStatus();
await refreshWindows();
