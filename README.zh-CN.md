# Codex Window

[English](README.md)

独立的 **TypeScript + Node.js** 订阅开窗工具，仅提供 TUI：

**登录 → 查询真实额度 → 按规则等待 → 必要时发一条 hello → 展示本地结果。**

不是 OpenAI 官方产品，不能重置已有窗口或增加额度；请求可能消耗少量额度，订阅接口未来也可能变化。不依赖、不读取 Pi、Codex CLI 或旧 Rust 程序的凭据，不自动换号，不安装或替换旧服务。

## 运行

CI 生成自带 Node 的 **Windows x64 / Linux x64** 免安装包，不要求用户安装 Node/npm。首次发布前可在成功的 Actions 运行中取得 artifacts；工作流不会自动创建 Release。

- **Windows 10/11 桌面**：完整解压，双击 `CodexWindow.exe` 进入托盘，菜单打开 TUI 或退出应用；保留旁边的 `codex-window-core.exe`。关闭面板不停止后台。预览版没有代码签名，可能出现系统信誉提示，不要为运行它关闭安全软件。
- **Linux glibc（如 Ubuntu 22.04+）**：解压到专用目录，`chmod +x codex-window && ./codex-window`。
- 暂不提供 macOS、ARM、Alpine/musl 官方包或支持承诺。Windows 编译与交互仍需 CI 和真机验收，不能因有工作流就声称已经通过。

源码运行需要 Node.js 24+，运行时没有第三方 npm 依赖：

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js
```

`npm start` 也可以，但会多留一个 npm 包装进程。不要全局安装覆盖旧命令，**同一真实账号只启用一套调度器**，包括其他工具的旧服务。

旧后台存活时不会自动替换或在线迁移；先关闭旧面板，执行旧版的 `stop`，等待退出后再打开新版。这样会暂停账号，但保留凭据和发送待确认，无需重新登录。

## 快捷键与语言

首次 **L 登录 → M 选择主五小时额度池模型 → R 启用**。设备码授权要求账号允许该登录方式，浏览器登录需要桌面会话。

| 按键 | 功能 |
| --- | --- |
| A | 切换/添加账号，只读取本地缓存，不影响其他账号 |
| L | 登录，先暂停当前账号，按真实身份保存 |
| M | 选择模型，前台按账号缓存目录 5 分钟 |
| S | 设置、同步开关、全局界面语言 |
| C | 只读查询，不发送 |
| R | 复核待确认并启用当前账号，先重新查额度 |
| I / F2 | 暂停当前账号，只读查询继续 |
| X | 暂停全部账号并停止后台 |
| D | 查看当前面板会话日志 |
| Esc | 返回上一步，放弃当前项编辑/等待 |
| Ctrl+C 两次 | 3 秒内确认关闭面板，后台继续 |

**默认 English**，不按时区或系统语言自动切换。S 内选择 English / 简体中文，也可运行 `language en|zh-CN`。语言是全局显示偏好，不参与账号设置同步，也不会暂停账号。**打开 S 不暂停，保存实际变动的业务设置才暂停受影响账号**；L/M 仍暂停当前账号。新消息可按语言显示，旧中文历史不重写。

首页为圆角卡片，宽屏左右、窄屏上下，高度不足滚动，不要求放大终端、不禁用操作。事件默认预览 3 行，宽屏右上角标 D；详细日志支持滚轮/方向键/翻页/Home/End。仅会话累计最多 1000 条，初始载入最多 8 条缓存，**不是完整持久历史**；搜索和跨会话历史后置。右下角提示无边框、默认 3 秒，第一次 Ctrl+C 红色确认。额度显示剩余百分比和文字标签，支持 `NO_COLOR=1`。

## 多账户、设置与调度

- 一份后台，各账号独立任务；凭据、额度、启停、待确认隔离，慢/坏账号不阻塞其他账号。同一真实账号去重，新账号默认暂停。
- **设置同步默认开启**：S 保存和 M 选模型同步所有账号的模型、时区、允许时段、查询间隔；只暂停配置实际变化的账号，逐个 R 启用。关闭同步后只改当前账号。启停、凭据和结果不复制。
- 各账号 `config.json` 是唯一业务设置来源，运行结果只写 `state.json`。手改一个账号不触发同步，手动 `enabled=true` 不清除发送待确认。
- 新设置默认取运行设备时区，SSH 是服务器时区，旧账号时区不变。IANA 时区/UTC 可搜索选择。默认时段 04:30–19:30、间隔 30 分钟；相同时段表示全天，支持跨午夜；间隔须 5–1440 且整除一天。
- 后台使用到点定时器＋文件通知＋30 秒兜底，不再 250ms 轮询。配置改变会重新安排；发送前重读配置，损坏/缺失/非法配置报错并禁止该账号发送，不覆盖错误文件。
- 默认当地整点/半点查询，临近重置才安排重置后 90 秒复查；窗口已开启就不发送。额度必须新鲜、完整、一致、允许发送且账号已启用；不猜测、不探测额外模型或额度池。
- 发送前持久保存待确认，结果不明不自动重试，重启也保留。有效活动窗口或明确 R 复核才解除。续期先保存新凭据，结果不明要求重登，不重复提交旧 Refresh Token。

配置示例（时区只是示例，不是固定默认）：

```json
{
  "app": "codex-window-config",
  "version": 1,
  "model": "MODEL_ID",
  "timezone": "Asia/Shanghai",
  "start": "04:30",
  "end": "19:30",
  "pollMinutes": 30,
  "enabled": false
}
```

不要同时从编辑器与界面保存同一配置，建议编辑器原子保存。坏配置不妨碍停止；停止后修复时先设 `enabled=false` 或明确复核启用，不能绕过上次停止。

## 后台退出与命令行

Linux 包使用 `./codex-window`，源码替换为 `node dist/cli.js`，Windows 终端使用 `.\codex-window-core.exe`。

```sh
./codex-window accounts
./codex-window login --add
./codex-window config --sync-settings off
./codex-window config --model MODEL_ID
./codex-window start
./codex-window status --account ID
./codex-window language zh-CN
./codex-window pause --account ID
./codex-window quit
```

所有命令支持 `--home PATH` / `CODEX_WINDOW_HOME`。账号命令支持 `--account ID`，默认 `default`；全局启停不接受此参数。完整命令见 `--help`。

- **quit / 托盘“退出应用”**：协作关闭本目录的面板与后台，等待已开始的请求/凭据保存，不强杀，不改账号启停设置或待确认；下次启动沿用启用状态，先查新额度。超时会报错，不伪装成功。
- **stop / X**：暂停全部账号并停止后台，下次启动仍暂停。
- 双 Ctrl+C 只退出面板，不无条件等待网络；如果恰在续期中，下一次可能需要重登，不会重试旧 Token。Esc 返回会让已开始的授权兑换/续期完成保存。

需要代理可用 `NODE_OPTIONS=--use-env-proxy` 配合 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`；私有 CA 用 `NODE_EXTRA_CA_CERTS`，不要关闭 TLS 验证。

## 数据与安全

默认 `~/.codex-window-node`（Windows 为 USERPROFILE 下），与程序目录及其他工具分离。

- `auth.json` 为**明文私有凭据**，不得上传、提交或贴到报告。Unix 私有权限，Windows 按用户/SYSTEM 限制目录权限。
- `config.json`、`state.json` 为各账号设置与状态，`accounts.json` 保存目录索引/同步；新增账号位于 `accounts/<哈希ID>/`，原账号位置不变。
- `preferences.json` 只保存全局语言。损坏时提示并回退英文，不覆盖文件，也不阻断安全停止命令。
- `application.json`、`session-*.json`、`*.lock` 是内部退出协调与互斥，不要编辑；`worker.log` 为后台诊断，启动时超过 1 MiB 会截断。

不要把数据目录指向 Pi/Codex/旧 Rust，也不要删除状态排查重复请求，否则会丢失待确认。后台运行期间保留源码/发行包目录。详细设计：[多账户](docs/MULTI_ACCOUNT.md)、[配置与调度](docs/CONFIG_AND_SCHEDULING.md)、[发行与托盘](docs/DISTRIBUTION.md)。

## 开发与验收

```sh
npm run check
npm test
npm run package
npm run check:package
npm run archive
```

Windows 打包需 Visual Studio C 工具＋Windows SDK 开发者终端；CI 配置了 Linux/Windows 构建、独立二进制无头检查、压缩包和校验和。只上传 artifacts，不自动发布。测试仅用临时目录、合成凭据和本地模拟 HTTP，**不做 TUI/托盘 UI 自动化**。真实账号、多账户长期运行、双语交互及 Windows 托盘必须人工验收。验证边界见 [VERIFICATION.md](docs/VERIFICATION.md)。

## 许可

[MIT](LICENSE)，接口/规则参考来源的版权声明见 [NOTICE.md](NOTICE.md)。发行包另外保留匹配 Node 运行时及第三方许可 `LICENSE_NODE.txt`。
