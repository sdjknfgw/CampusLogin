# CampusLogin

校园网 Dr.COM 自动认证工具，包含 Windows 桌面端和 Android 客户端。支持多校园网门户档案、断线重连和手动检查 GitHub Releases 更新。

## 下载

在 [Releases](https://github.com/sdjknfgw/CampusLogin/releases/latest) 下载 Windows 安装程序或 Android APK。更新检查只显示版本号、更新说明和下载页面，不会自动安装。

首次连接新校园网时，Windows 端会在识别到 Dr.COM 门户后打开登录向导。Android 端可点“自动检测校园网门户”，随后在浏览器中正常登录一次；应用会在两分钟内对当前 Wi-Fi 网关进行只读验证，发现门户后由用户确认使用。它不读取、保存或上传浏览器页面内容、账号或密码。网络标识冲突时需要手动选择门户档案。

## Windows 开发与构建

需要 Node.js 22 或兼容版本。

```powershell
cd CampusLogin
npm install
npm start
npm run dist
```

## Android 开发与构建

使用 Android Studio 或 Gradle 8.7、JDK 17 和 Android SDK 34。生成可覆盖安装的 Release APK 时，需要提供原签名密钥，并通过环境变量设置 `CAMPUS_SIGN_STORE`、`CAMPUS_SIGN_STORE_PASSWORD`、`CAMPUS_SIGN_KEY_ALIAS` 和 `CAMPUS_SIGN_KEY_PASSWORD`。签名密钥不包含在公开仓库中。

```powershell
cd CampusLogin-Android
gradle assembleRelease
```

## 发布更新

创建版本标签（例如 `v1.0.2`）并在 GitHub 创建对应 Release。Release 标题或标签提供版本号，正文提供更新说明；Windows 安装程序与 Android APK 作为 Release 附件上传。两个客户端通过公开 GitHub Releases API 查询最新稳定版本。

## License

MIT，详见 [LICENSE](LICENSE)。
