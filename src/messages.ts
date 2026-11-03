// Chinese keys also identify messages emitted by older source modules. New
// events are normalized to English; legacy journal text is not rewritten.
export const messages: Record<string, string> = {
  '账号目录索引无效；不会重建或覆盖现有账号，请检查 accounts.json': 'Invalid account registry; existing accounts will not be rebuilt or overwritten. Check accounts.json.',
  '检测到旧配置格式的后台；请先执行 node dist/cli.js stop，等待退出后重开面板。不会在线迁移配置': 'An older configuration backend is running. Run stop, wait for it to exit, then reopen the panel. Live migration is not allowed.',
  '检测到旧单账户后台；请先执行 node dist/cli.js stop，再重开面板。不会自动停止或替换它': 'An older single-account backend is running. Run stop before reopening the panel; it will not be replaced automatically.',
  '账号 ID 无效': 'Invalid account ID', '账号目录不能是符号链接或文件': 'Account directories cannot be symlinks or files',
  '账号不存在': 'Account does not exist', '账号数据目录缺失，不会自动重建': 'Account directory is missing; it will not be recreated automatically',
  '账号目录与凭据身份不一致': 'Account directory and credential identity do not match',
  '未登录': 'Not signed in', '账号数据需要检查': 'Account data needs attention',
  '本地账号数据无效，不会发送；其他账号不受影响': 'Invalid local account data; sending is blocked for this account only',
  '账号身份冲突，不会覆盖现有凭据': 'Account identity conflict; existing credentials will not be overwritten',
  '登录成功，保持暂停；请手动启用此账号': 'Signed in and paused; enable this account explicitly',
  '登录未保存': 'Sign-in was not saved', '设置同步开关无效': 'Invalid settings synchronization switch',
  '设置同步未完整完成；已修改的 {0} 个账号保持暂停，请检查后重试': 'Settings sync was incomplete; {0} changed accounts remain paused. Check the files before retrying.',
  '等待期间后台控制状态已改变，请重新操作启动': 'Backend control changed while waiting; start again explicitly',
  '后台已收到全局停止请求，但部分账号状态未能写入，请检查本地文件': 'Global stop was requested, but some account states could not be saved. Check the local files.',
  '自动发送已暂停；只读查询继续': 'Automatic sending paused; read-only checks continue',
  '设置已保存，保持暂停；请手动启用': 'Settings saved and paused; enable explicitly',
  '请先完成登录': 'Sign in first', '等待期间控制状态已改变，请重新操作启用': 'Control changed while waiting; enable again explicitly',
  '请先选择模型': 'Select a model first',
  '已启用并复核先前待确认请求；先查询真实额度再决定是否发送': 'Enabled after reviewing the pending outcome; checking usage before deciding whether to send',
  '已请求只读查询，不会发送或新建开窗任务': 'Read-only check requested; no send or new window task',
  '正在停止后台，等待已开始的请求和凭证保存完成': 'Stopping the backend; waiting for in-flight requests and credential saves',
  '后台保持停止；请修正 config.json 并设 enabled=false，或手动复核启用': 'Backend remains stopped; repair config.json with enabled=false, or review and enable explicitly',
  '独立登录成功，保持暂停；选择模型后手动启用': 'Signed in and paused; select a model, then enable explicitly',
  '额度数据缺少明确限制状态': 'Usage data lacks explicit limit flags', '账号限制状态无效': 'Invalid account limit flags',
  '请求响应不完整，无法确认结果': 'Incomplete response; the outcome cannot be confirmed',
  '请求响应事件不一致': 'Response events do not match', '服务端未完成请求': 'The server did not complete the request',
  '请求未确认完成': 'Request completion was not confirmed', '请求未确认完成，禁止自动重发': 'Request completion was not confirmed; automatic retries are blocked',
  '账号操作已停止': 'Account operation stopped', '查询额度': 'Query usage', '请先登录': 'Sign in first',
  '查询模型': 'Query models', '模型目录格式无效': 'Invalid model catalog', '模型 ID 格式无效': 'Invalid model ID format',
  '当前账号没有可用模型': 'No models are available for this account', '查询期间账号已改变，请重新查询模型': 'Account changed during the query; fetch the model catalog again',
  '发送 hello': 'Send hello', '当前版本不支持 FedRAMP 账号': 'FedRAMP accounts are not supported',
  '续期返回的账号与当前账号不同，请重新登录': 'Renewal returned a different account; sign in again',
  '服务端返回的凭证已过期': 'The server returned expired credentials', '凭证格式无效': 'Invalid credential format',
  '本工具的凭证文件无效，请重新登录（不会读取其他工具的凭证）': 'Invalid application credentials; sign in again. Other tools credentials are never read.',
  '请先登录；旧凭证不会自动反复提交': 'Sign in first; old credentials will not be submitted repeatedly',
  '凭证续期': 'Renew credentials', '凭证续期失败或结果不明，请重新登录；不会重试旧 Refresh Token': 'Credential renewal failed or its outcome is unknown; sign in again. The old Refresh Token will not be retried.',
  '登录授权兑换': 'Exchange authorization', '获取设备码': 'Get device code',
  '获取设备码失败，请检查账号是否允许设备码登录': 'Could not get a device code; check whether the account allows device authorization',
  '请访问 {0}/codex/device\n输入设备码：{1}\n等待授权（最长 15 分钟）': 'Visit {0}/codex/device\nEnter device code: {1}\nWaiting for authorization (up to 15 minutes)',
  '等待设备授权': 'Wait for device authorization', '设备授权响应无效': 'Invalid device authorization response',
  '设备码已过期，请重新登录': 'Device code expired; sign in again', '授权被拒绝': 'Authorization denied',
  '设备授权失败，请检查账号是否允许设备码登录': 'Device authorization failed; check whether the account allows it',
  '设备授权': 'Device authorization', '设备登录已取消或超时': 'Device sign-in cancelled or timed out',
  '当前没有桌面会话，请使用设备码登录': 'No desktop session is available; use device authorization',
  '本地登录端口 1455/1457 被占用，请使用设备码登录': 'Login ports 1455/1457 are busy; use device authorization',
  '浏览器登录已取消或超时': 'Browser sign-in cancelled or timed out', '本地登录回调服务失败': 'Local login callback failed',
  '浏览器授权失败': 'Browser authorization failed', '授权已收到，可以关闭此页面并返回终端。': 'Authorization received. You can close this page and return to the terminal.',
  '请在浏览器完成登录：\n{0}': 'Complete sign-in in your browser:\n{0}',
  '命令无效；使用 --help 查看用法': 'Invalid command; use --help for usage', '--browser/--add 仅用于 login': '--browser/--add are only valid for login',
  '此命令作用于整个后台，不接受 --account；暂停单个账号请使用 pause --account ID': 'This command affects the whole backend and does not accept --account; use pause --account ID for one account',
  '--sync-settings 使用 on 或 off': '--sync-settings must be on or off', '设置参数仅用于 config': 'Settings arguments are only valid for config',
  'TUI 需要交互终端；使用 start 启动后台或 status 查看状态': 'TUI requires an interactive terminal; use start or status for headless operation',
  '已有后台进程；请先 stop': 'A backend is already running; stop it first',
  '多账户后台已运行；各账号启停保持独立，不自动启用。': 'Multi-account backend is running; each account keeps its own enabled state.',
  '账号 {0} 登录成功，保持暂停；未覆盖其他账号。': 'Account {0} signed in and paused; other accounts were not overwritten.',
  '设置已保存；{0} 个账号配置发生变化并保持暂停。': 'Settings saved; {0} changed accounts remain paused.',
  '已请求此账号只读查询。': 'Read-only check requested for this account.',
  '此账号自动发送已暂停；其他账号不受影响。': 'Automatic sending paused for this account only.',
  '此账号已复核并启用，将先查询真实额度。': 'Account reviewed and enabled; checking current usage first.',
  '已请求旧单账户后台停止；等已开始的请求完成后，可重开面板启动新版。': 'Older backend stop requested; reopen the panel once in-flight operations finish.',
  '已请求所有账号暂停并停止整个后台；等待已开始的请求和凭证保存完成。': 'All accounts were paused and backend stop requested; waiting for in-flight operations.',
  '{0}失败（HTTP {1}）': '{0} failed (HTTP {1})', '响应过大': 'Response too large', '操作已取消': 'Operation cancelled',
  '{0}网络失败或超时': '{0}: network failure or timeout', '服务端返回的数据格式无效': 'The server returned invalid data',
  '无法计算下次查询时间': 'Could not calculate the next check time', '额度数据已过期，等待重新查询': 'Usage data is stale; waiting for a fresh check',
  '不是支持的主五小时/周额度结构': 'Unsupported main five-hour/weekly usage structure',
  '服务端时间与本地不一致，禁止猜测发送': 'Server and local times disagree; speculative sending is blocked',
  '周额度已用完': 'Weekly allowance exhausted', '账号额度受限': 'Account allowance is restricted', '不在允许发送时段': 'Outside permitted sending hours',
  '等待服务端更新重置后的额度': 'Waiting for the server to publish reset usage', '窗口进行中，距重置还早': 'Window is active; waiting for the reset horizon',
  '重置后不在允许发送时段': 'The reset falls outside permitted sending hours', '请登录、选择模型，再手动启用': 'Sign in, select a model, then enable explicitly',
  '数据格式无效': 'Invalid data format', '缺少必要文本字段': 'A required text field is missing', '无效整数': 'Invalid integer',
  '模型 ID 无效': 'Invalid model ID', '时段必须使用 HH:MM': 'Hours must use HH:MM', '间隔须为 5–1440 分钟且能整除一天': 'Interval must be 5–1440 minutes and divide one day evenly',
  '额度百分比无效': 'Invalid usage percentage', '缺少额度限制状态': 'Usage limit flags are missing', '状态文件无效，已禁止发送': 'Invalid state file; sending is blocked',
  '观察状态无效': 'Invalid observation state', '事件数量无效': 'Invalid event count', '旧状态文件无效，不会迁移': 'Invalid older state; migration refused',
  '自动发送开关必须为 true 或 false': 'enabled must be true or false', '本地操作忙或锁文件异常，请稍后重试': 'Local operation is busy or a lock is invalid; try again later',
  '请指定专用数据子目录，不能使用磁盘根目录或用户主目录': 'Use a dedicated data subdirectory, not a filesystem root or your home directory',
  '数据目录不能是符号链接': 'The data directory cannot be a symlink',
  '目录不是本工具的有效数据目录；请使用全新专用目录，不会读取其中的凭证': 'This is not an application data directory; use a new dedicated directory. Existing credentials will not be read.',
  '无法确认 Windows 用户身份': 'Could not determine the Windows user identity',
  'config.json 无法读取、缺失或为符号链接；不会重建配置': 'config.json is unreadable, missing, or a symlink; it will not be recreated',
  'config.json 不是有效 JSON，已禁止发送；请修正文件': 'config.json is not valid JSON; sending is blocked until it is repaired',
  '配置字段或版本无效': 'Invalid configuration fields or version', '配置无效': 'Invalid configuration',
  'config.json: {0}；已禁止发送': 'config.json: {0}; sending is blocked',
  '状态快照无效，请重新读取': 'Invalid state snapshot; read it again',
  '配置已被其他操作修改，请重新读取；不会覆盖手工配置': 'Configuration changed elsewhere; read it again. Manual edits will not be overwritten.',
  '配置已在启用前修改，未覆盖；请重新读取后复核启用': 'Configuration changed before enable; nothing was overwritten. Read it again and review enabling.',
  '耗尽': 'Empty', '偏低': 'Low', '留意': 'Watch', '充足': 'Healthy',
  '时区不在支持列表中，请搜索选择 IANA 时区或 UTC': 'Time zone is not in the supported list; select an IANA zone or UTC',
  '后台': 'Worker', '面板': 'Panel', '模型 ID': 'Model ID', '使用主五小时额度池模型；也可返回主页按 M 从目录选择。': 'Use a main five-hour allowance model; M selects from the account catalog.',
  '时区': 'Time zone', '搜索选择 IANA 时区；默认取程序运行设备的时区。': 'Search IANA time zones; new settings default to the runtime device zone.',
  '允许开始时间': 'Start time', 'HH:MM，例如 04:30；起止相同表示全天。': 'HH:MM, e.g. 04:30; equal start/end means all day.',
  '允许结束时间': 'End time', 'HH:MM，例如 19:30；支持跨午夜时段。': 'HH:MM, e.g. 19:30; overnight hours are supported.',
  '查询间隔（分钟）': 'Check interval (min)', '5–1440 分钟，且能整除一天；默认 30。': '5–1440 minutes, dividing one day evenly; default 30.',
  'TUI 需要交互终端；后台启动请用 start，查看请用 status': 'TUI requires an interactive terminal; use start or status headlessly',
  '错误': 'Error', '注意': 'Warning', '信息': 'Info', '[A 切换账号]': '[A Switch account]', '正在读取本地状态…': 'Reading local state…',
  '已登录': 'Signed in', '模型': 'Model', '未选择 · 按 M 选择': 'Not selected · press M', '五小时': 'Five-hour', '周额度': 'Weekly', '待查询': 'Not checked',
  '{0}% [旧数据]': '{0}% [stale]', '{0} 重置': 'Resets {0}',
  '已暂停 · 仅查询额度': 'Paused · read-only checks', '待登录': 'Sign-in required', '需要重新登录': 'Sign in again',
  '发送结果待确认 · 不会自动重发': 'Outcome pending · no automatic retry', '后台未运行': 'Backend stopped', '整个后台正在停止': 'Backend is stopping',
  '已启用 · 正在处理': 'Enabled · working', '已启用': 'Enabled', '已启用 · 额度受限': 'Enabled · allowance restricted', '已启用 · 等待最新额度': 'Enabled · awaiting fresh usage',
  '状态': 'Status', '时段  {0}': 'Hours  {0}', '全天': 'All day', '时区  {0} · 每 {1} 分钟查询': 'Zone  {0} · every {1} min',
  '更新': 'Updated', ' · 待更新': ' · awaiting update',
  '登录账号': 'Sign in', '登录': 'Login', '选择模型': 'Select model', '修改设置': 'Settings', '设置': 'Settings',
  '只读查询': 'Read-only check', '查询': 'Check', '暂停当前账号': 'Pause account', '暂停': 'Pause', '启用当前账号': 'Enable account', '启用': 'Enable',
  '停止整个后台': 'Stop backend', '停止全部': 'Stop all', '连按两次退出': 'Press twice to close', '退出': 'Close',
  '订阅信息': 'Subscription', '快捷操作': 'Quick actions', '按 D 查看详细日志': 'Press D for detailed logs', '暂无事件。': 'No events yet.', '最近事件': 'Recent events',
  '↑↓/滚轮/PgUp/PgDn 滚动 · {0}–{1}/{2}': '↑↓/Wheel/PgUp/PgDn scroll · {0}–{1}/{2}',
  '↑↓ 选择 · Enter 确认 · Esc 返回': '↑↓ Select · Enter Confirm · Esc Back', 'F2 暂停 · Ctrl+C 连按两次退出': 'F2 Pause · Ctrl+C twice to close',
  '切换账号': 'Switch account', '只显示本地缓存，不影响其他账号运行。': 'Local cache only; other accounts keep running.',
  '数据异常': 'Invalid data', '已暂停': 'Paused', ' [当前]': ' [current]', '+ 添加账号': '+ Add account',
  '↑↓/滚轮 选择 · Enter 切换/添加': '↑↓/Wheel Select · Enter Switch/Add', 'Esc 返回 · 切换不会联网': 'Esc Back · switching stays offline',
  '添加账号': 'Add account', '登录当前账号': 'Sign in to account', '新账号默认暂停；不影响已有账号。': 'New accounts start paused; existing accounts are unchanged.',
  '当前账号已暂停；按身份保存，不覆盖其他账号。': 'This account is paused; credentials are saved by identity.',
  '设备码登录（推荐，适合服务器）': 'Device code (recommended for servers)', '浏览器登录（需要桌面会话）': 'Browser (requires a desktop session)',
  '设置同步开启：保存模型将影响所有账号。': 'Sync enabled: saving the model affects all accounts.',
  '设置同步关闭：只保存当前账号的模型。': 'Sync disabled: only this account is changed.',
  '↑↓/滚轮 选择 · Enter 保存': '↑↓/Wheel Select · Enter Save', 'PgUp/PgDn 翻页 · Esc 返回': 'PgUp/PgDn Page · Esc Back',
  '选择时区': 'Select time zone', '搜索: {0}▏': 'Search: {0}▏', '输入名称，如 Shanghai': 'Type a name, e.g. Shanghai',
  '没有匹配的时区。': 'No matching time zones.', '输入搜索 · ↑↓/滚轮 选择 · Enter 确认': 'Type to search · ↑↓/Wheel Select · Enter Confirm',
  'Ctrl+U 清空搜索 · Esc 返回设置': 'Ctrl+U Clear search · Esc Settings',
  '同步开启：保存影响所有账号。': 'Sync enabled: saving affects all accounts.', '同步关闭：只保存当前账号。': 'Sync disabled: only this account is changed.',
  '未选择': 'Not selected', '同步账号设置  {0}': 'Sync account settings  {0}', '开启': 'On', '关闭': 'Off',
  '[ 保存设置，变动账号暂停 ]': '[ Save settings; changed accounts pause ]',
  '↑↓ 选择 · Enter 编辑/切换/保存': '↑↓ Select · Enter Edit/Toggle/Save', 'Esc 放弃草稿 · F2 暂停': 'Esc Discard draft · F2 Pause',
  'Enter 只更新草稿，不直接保存。': 'Enter updates the draft only.', '←→ 移动 · Backspace/Delete 删除': '←→ Move · Backspace/Delete Remove',
  'Enter 确认 · Esc 放弃本项': 'Enter Confirm · Esc Discard field', '正在处理…': 'Working…',
  'Esc 取消等待 · ↑↓/滚轮 翻阅': 'Esc Cancel wait · ↑↓/Wheel Scroll', '已开始的凭证保存会安全收尾。': 'Credential saves already started will finish safely.',
  'Shift+↑↓ 翻阅': 'Shift+↑↓ Scroll', 'Shift+↑↓ 翻阅 · Ctrl+C×2 退出': 'Shift+↑↓ Scroll · Ctrl+C×2 Close',
  '再按一次 Ctrl+C 退出': 'Press Ctrl+C again to close', '本次会话 · 起始最多 8 条 · 上限 1000 条': 'This session · up to 8 initial events · max 1000',
  '暂无日志。': 'No logs yet.', '滚轮/↑↓ · PgUp/PgDn · Esc 返回': 'Wheel/↑↓ · PgUp/PgDn · Esc Back',
  '详细日志 · {0} · {1}': 'Detailed logs · {0} · {1}',
  '默认账号': 'Default account', '跟随最新': 'Following latest', '浏览历史': 'Browsing history', 'Ctrl+C 连按两次退出': 'Ctrl+C twice to close',
  '已返回；已开始的授权兑换/续期会完成保存，不会自动启用。': 'Returned; in-flight authorization/renewal will be saved without enabling.',
  '本项修改已放弃。': 'Field edit discarded.', '已返回账号列表。': 'Returned to accounts.', '已返回主页。': 'Returned to home.',
  '此账号已暂停；其他账号不受影响。': 'This account is paused; other accounts are unchanged.',
  '草稿已修改，选择“保存设置”后生效。': 'Draft updated; choose Save settings to apply.',
  '时区草稿已修改，保存设置后生效。': 'Time zone draft updated; save settings to apply.',
  '已请求此账号只读查询，不会发送。': 'Read-only check requested; no sending.', '此账号已启用，将先查询真实额度。': 'Account enabled; checking current usage first.',
  '已请求停止整个后台，所有账号暂停。': 'Backend stop requested; all accounts paused.',
  '打开登录': 'Open sign-in', '打开设置': 'Open settings', '查询模型目录': 'Fetch model catalog',
  '已切换，显示本地缓存；其他账号继续运行。': 'Account switched using local cache; other accounts keep running.',
  '浏览器授权': 'Browser authorization', '设备码授权': 'Device authorization',
  '登录成功，此账号保持暂停；其他账号不受影响。': 'Signed in and paused; other accounts are unchanged.',
  '保存模型': 'Save model', '模型已保存，{0} 个变动账号保持暂停。': 'Model saved; {0} changed accounts remain paused.',
  '保存设置': 'Save settings', '设置已保存，{0} 个变动账号保持暂停。': 'Settings saved; {0} changed accounts remain paused.',
  '启动后台': 'Start backend', '操作失败': 'Operation failed', '只读查询完成，未发送或新建开窗任务': 'Read-only check complete; no send or new window task',
  '自动发送已暂停，保留只读额度结果': 'Automatic sending paused; read-only usage was retained',
  '上次发送仍待确认；观察到活动窗口或手动复核启用前不再发送': 'Previous outcome is pending; no further sends until an active window is observed or reviewed explicitly',
  '已安排重置后 90 秒复查': 'A check is scheduled 90 seconds after reset',
  '发送前凭证已失效，请重新查询': 'Credentials expired before sending; check again',
  '发送 hello（已开始的请求不能撤回）': 'Sending hello (in-flight requests cannot be recalled)',
  '准备发送一条指定模型的 hello，已保存待确认标记': 'Preparing one model-specific hello; pending marker saved',
  '请求响应已完成，继续确认窗口是否激活': 'Request response completed; checking whether the window activated',
  '{0}；不会自动重发，继续只读确认': '{0}; no automatic retry; continuing read-only confirmation',
  '只读确认窗口': 'Read-only window confirmation', '已观察到活动窗口': 'An active window was observed',
  '尚未观察到活动窗口，保留待确认标记，禁止自动重发': 'No active window observed; pending marker retained and automatic retries blocked',
  '{0}；窗口未确认，禁止自动重发': '{0}; window not confirmed; automatic retries blocked',
  '这个数据目录已有后台进程': 'A backend already owns this data directory', '账号当前不能运行': 'Account cannot run right now',
  '账号启动已取消或停止': 'Account startup cancelled or stopped',
  '上次停止未能暂停配置；请先将 config.json 的 enabled 设为 false，或手动复核启用': 'The last stop could not pause configuration; set enabled=false in config.json, or review enabling explicitly',
  '后台已启动，旧的待执行计划已丢弃': 'Backend started; previous execution plans discarded',
  '后台已停止，已开始的凭证保存和请求已完成': 'Backend stopped; in-flight requests and credential saves finished',
  '这个数据目录已有多账户后台': 'A multi-account backend already owns this data directory',
  '账号 {0}：{1}': 'Account {0}: {1}', '账号数据不可用：{0}': 'Account data unavailable: {0}',
  '旧后台仍在退出，请稍后重试': 'The older backend is still exiting; try again shortly',
  '后台启动失败，请检查独立数据目录中的 worker.log': 'Backend startup failed; check worker.log in the data directory',
  '界面语言': 'Interface language', '语言仅影响显示，不暂停账号，也不参与设置同步。': 'Language affects display only; accounts and settings sync are unchanged.',
  '正在退出应用；等待已开始的操作安全完成。': 'Exiting application; finishing in-flight work safely…',
  '语言已保存。': 'Language saved.', '选择语言': 'Select language', '简体中文': '简体中文',
  'preferences.json 无效；language 应为 en 或 zh-CN，文件未被覆盖。': 'Invalid preferences.json; expected language en or zh-CN. The file was not overwritten.',
  '语言必须为 en 或 zh-CN': 'Language must be en or zh-CN',
  'application.json 无效；已禁止启动与发送，未修复任何文件。': 'Invalid application.json; startup and sending are blocked. No file was repaired.',
  '应用控制已在等待期间改变，请重新启动。': 'Application control changed while waiting; start again explicitly',
  '应用仍在退出，请等待已开始的操作完成。': 'Application is still exiting; wait for in-flight operations',
  '应用启动被更新的退出请求取消。': 'Application startup cancelled by a newer exit request',
  '应用仍在安全收尾，没有强制终止任何进程，请稍后重试退出。': 'Application is still draining in-flight work; no process was killed. Retry Quit shortly.',
  '应用正在退出，请等待完成。': 'Application is exiting; wait for it to finish',
  '当前后台不支持协作退出，请先执行一次 stop 再重开面板。': 'The running backend predates application exit support. Run stop once, then reopen the panel.',
  '旧后台不支持协作退出，升级前请先执行一次 stop。': 'An older backend cannot exit cooperatively. Run stop once before upgrading.',
  '应用已退出，账号设置与待确认记录已保留。': 'Application exited; account settings and pending outcomes were preserved.',
  '后台已退出，但无法关闭托盘图标。': 'Backend exited, but the tray icon could not be closed',
};
export const helpText = {
  en: `Codex Window · Standalone account/window scheduler (Node.js 24+ or bundled runtime)

  codex-window                 Open TUI; closing it keeps the backend running
  codex-window accounts        List local accounts, without network access
  codex-window login [--add]   Sign in; --add leaves existing accounts unchanged
  codex-window login --browser Browser authorization (requires desktop)
  codex-window models          List the selected account's models
  codex-window config          Show settings; --model/--timezone/--start/--end/--interval
  codex-window config --sync-settings on|off  Save and set global settings sync
  codex-window language [en|zh-CN]  Show or change the global display language
  codex-window start           Ensure backend is running; preserve account enable flags
  codex-window status          Read selected account state locally
  codex-window check           Request a read-only usage check
  codex-window pause           Pause this account's automatic sending
  codex-window resume          Review pending outcome and enable this account
  codex-window stop            Pause all accounts and stop the backend
  codex-window quit            Exit this application's sessions; preserve account settings
  codex-window run             Run the scheduler in the foreground

Global: --home PATH selects a dedicated data directory; --account ID selects an account.
New accounts start paused. Settings sync defaults to on; changed accounts pause.
Windows: launch CodexWindow.exe for the tray, with Open panel and Exit application.
`,
  'zh-CN': `Codex Window · 独立登录与多账户开窗调度（Node.js 24+ 或自带运行时）

  codex-window                 打开 TUI，关闭面板后后台继续运行
  codex-window accounts        查看本地账号列表，不联网
  codex-window login [--add]   登录；--add 添加账号，不暂停已有账号
  codex-window login --browser 浏览器授权（需要桌面）
  codex-window models          列出当前账号的模型目录
  codex-window config          查看设置；--model/--timezone/--start/--end/--interval 修改
  codex-window config --sync-settings on|off  保存并切换全局设置同步
  codex-window language [en|zh-CN]  查看或切换全局界面语言
  codex-window start           确保后台运行，保留各账号原有启停设置
  codex-window status          查看当前账号本地缓存
  codex-window check           请求只读额度查询
  codex-window pause           暂停当前账号自动发送
  codex-window resume          复核待确认并启用当前账号
  codex-window stop            暂停所有账号并停止后台
  codex-window quit            退出本应用的面板与后台，保留账号设置
  codex-window run             前台运行调度器

全局：--home PATH 指定独立数据目录；--account ID 选择账号。
新账号默认暂停，设置同步默认开启，配置实际变化的账号暂停。
Windows 请运行 CodexWindow.exe，从托盘打开面板或退出应用。
`,
};
export const nestedMessages: Record<string, number[]> = {
  '{0}失败（HTTP {1}）': [0], '{0}网络失败或超时': [0], 'config.json: {0}；已禁止发送': [0],
  '{0}；不会自动重发，继续只读确认': [0], '{0}；窗口未确认，禁止自动重发': [0], '账号 {0}：{1}': [1], '账号数据不可用：{0}': [0],
};
