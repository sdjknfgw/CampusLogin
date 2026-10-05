# CampusLogin 苹果客户端

独立的 SwiftUI 原生客户端，共用协议层与界面，包含 `CampusLogin-iOS`、`CampusLogin-macOS` 两个 Xcode target。最低支持 iOS 16 / iPadOS 16、macOS 13；使用 Xcode 16 或更新版本打开 `CampusLogin.xcodeproj`，无需 CocoaPods、XcodeGen 或额外依赖。

## 已实现

- 标准 Dr.COM ePortal 门户的状态检查、登录与手动注销；有序 GET 参数和 JSON / JSONP 响应解析。
- 多门户档案、手动选择、添加、删除和导入现有 Windows JSON 档案。切换校园网络时需要确认当前档案，不依据未授权的 SSID 信息自动提交账号。
- 校园、电信、联通、移动、自定义后缀；自动模式可从已在线且属于本人账号的会话学习后缀。
- 登录前探测；其他账号在线时停止操作；密码错误、AC 拒绝或连续三次登录失败时停止重试；网络未就绪采用退避；在线后每 45–75 秒检查。
- 密码保存在设备钥匙串，配置不包含密码；日志仅在当前运行期间保留，最多 100 条。
- macOS 菜单栏入口、关闭窗口后继续检查、系统登录项开关；iPhone 和 iPad 可用自适应滚动界面。

## 首次运行

1. 连接校园 Wi-Fi（Mac 也可使用以太网），填写门户的局域网 IPv4 地址。当前项目记录的门户是 `172.19.0.1`，不会默认对它发送登录请求。
2. 点“添加标准 Dr.COM 门户”，然后点“仅检查”。标准登录接口是 `:801/eportal/portal/login`，探测接口是 `:80/drcom/chkstatus`。
3. 填写账号、密码并选择运营商；不知道后缀且尚未在线时，需要在学校认证页确认运营商。自动学习不会枚举运营商或反复试密码。
4. 按需开启自动登录，点“保存配置”。iOS / 新版 macOS 弹出本地网络权限请求时允许访问；已拒绝时到系统设置恢复权限。
5. 主动注销会暂停重连；点“立即登录”恢复。编辑认证信息或门户会取消当前检查，保存后恢复。系统报告网络路径改变时会暂停，确认门户后手动恢复；同一网络内认证掉线仍按心跳自动重连。

## 导入已有门户

通过“导入 JSON”选择 Windows 客户端的 `%APPDATA%\CampusLogin\settings.json`，或单个门户对象、门户数组。只读取 `profiles` 中的名称、地址和接口模板，忽略 Windows 账号密码密文、SSID、网关、日志和其他设置。

支持私有 IPv4 地址（10/8、172.16/12、192.168/16），GET 接口、`{{account}}`、`{{password}}`、`{{localIp}}`、`{{randomCb}}`、`{{epoch}}`、`{{epochMs}}` 占位符。公共 IP、域名、POST 或其他协议暂不支持，导入时会报错。没有移植 Electron 的浏览器请求抓取向导；非标准门户应先使用 Windows 向导建立档案后导入。

## iOS 生命周期

iOS 不允许此类普通应用无限后台运行。锁屏、切换后台后停止检查，回到前台恢复；用户暂停或登录失败导致的停止需要手动恢复。没有后台保活、开机自启、Wi-Fi 自动登录系统扩展或 VPN。不会通过后台音频等方式绕过系统限制。

## 在 Mac 上验证

```bash
bash CampusLogin-Apple/scripts/build-apple.sh
```

该脚本执行 10 项 Swift 测试，再构建 iOS 模拟器应用和未签名 macOS 开发应用。测试覆盖参数顺序、密码特殊字符、占位符注入、JSONP、账号边界、Windows 档案导入、失败停止、退避、运营商后缀、无密码配置，以及 URLSession 的模拟成功、HTTP 失败、重定向和无效响应。

开发环境为 Windows；已在 GitHub macOS runner 上完成 10 项测试（零失败）和 iOS / macOS Xcode 编译。验证记录见 [测试报告](测试报告.md)。云端完整流程另外执行 `scripts/smoke-apple.sh`，安装、启动 iOS 模拟器应用，启动本地临时签名的 macOS 应用，检查进程并保存截图。

在 [Apple app validation](https://github.com/sdjknfgw/CampusLogin/actions/workflows/apple-build.yml) 的成功运行中下载 `CampusLogin-Apple-development-builds`，内含 `CampusLogin-iOS-Simulator.zip`、`CampusLogin-macOS-unsigned.zip`；启动截图在 `CampusLogin-Apple-test-evidence` 中。macOS ZIP 是未签名开发构建；iOS ZIP 临时签名后只能用于模拟器，不能安装到真机。**尚未验证真实校园网认证、真机安装、Apple 分发签名或公证。**

## 真机安装和发行

- Xcode 选择 `CampusLogin-iOS`，在 Signing & Capabilities 中设置你的开发团队及可用的 Bundle ID，选择 iPhone 运行。免费个人团队可用于受限制的本机测试；TestFlight / App Store 需要 Apple Developer Program 和分发签名。模拟器 `.app` 不能安装到 iPhone。
- macOS 使用 `CampusLogin-macOS`。发布时选择 Apple 签名身份，Archive 后使用 Developer ID 导出并公证；Mac App Store 使用相应分发签名。已开启 App Sandbox、网络客户端权限、用户选定文件只读权限和 Hardened Runtime。
- 系统登录项建议在签名应用安装到 `/Applications` 后验证；如系统要求审批，在系统设置的登录项中确认。
- 两端 Info.plist 对校园门户 HTTP 设置了 ATS 例外，因为门户使用动态私有 IPv4 和明文协议。这是协议兼容所需；App Store 提交需要说明用途，审核通过与否不能在源码阶段保证。应用使用临时 URLSession、不持久化认证请求缓存、不接受接口重定向，避免凭据随重定向发送到其他地址。
- 图标复用项目已有吉祥物素材。

## 工程维护

`Core/` 是无 UI 的协议库；`App/` 是界面、生命周期、钥匙串和检查状态机；`Config/` 是权限配置。Xcode 工程已生成并提交，无需生成脚本即可打开。增加源文件后可以运行 `node CampusLogin-Apple/scripts/generate-project.mjs` 更新工程；生成器不写开发团队，签名信息由发布者在 Xcode 设置。`scripts/generate-icons.ps1` 在 Windows 上从原项目吉祥物生成资产，生成的 PNG 已随工程提供。
