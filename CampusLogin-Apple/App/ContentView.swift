import SwiftUI
import UniformTypeIdentifiers

@MainActor struct ContentView: View {
    @ObservedObject var model: CampusModel
    @State private var name = "校园网络"
    @State private var host = "172.19.0.1"
    @State private var importing = false
    @State private var confirmingLogout = false
    @State private var confirmingDelete = false
    @Environment(\.openURL) private var openURL

    private let accent = Color(red: 0.38, green: 0.91, blue: 0.84)
    private let background = Color(red: 0.035, green: 0.055, blue: 0.09)
    private let card = Color(red: 0.07, green: 0.10, blue: 0.15)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("CAMPUS / CONNECT").font(.system(.caption, design: .monospaced)).tracking(2).foregroundStyle(accent)
                        Text("校园网助手").font(.system(size: 30, weight: .bold, design: .rounded))
                    }
                    Spacer()
                    Image(systemName: "network").font(.largeTitle).foregroundStyle(accent)
                }
                section {
                    HStack {
                        Circle().fill(model.online ? accent : Color.orange).frame(width: 9, height: 9)
                        Text(model.status).font(.title3.bold())
                        Spacer()
                        if model.working { ProgressView().tint(accent) }
                    }
                    Text(model.detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    HStack {
                        Button("立即登录") { model.start() }.buttonStyle(.borderedProminent).disabled(model.working)
                        Button("仅检查") { model.start(probeOnly: true) }.buttonStyle(.bordered).disabled(model.working)
                        Button("暂停") { model.pause() }.buttonStyle(.bordered)
                    }
                    if model.isMonitoring { Text("自动检查正在运行").font(.caption).foregroundStyle(accent) }
                }
                section {
                    Text("门户档案").font(.headline)
                    if !model.config.profiles.isEmpty {
                        Picker("当前门户", selection: edit(\.selectedID)) {
                            ForEach(model.config.profiles) { profile in
                                Text("\(profile.name) · \(profile.host)").tag(profile.id)
                            }
                        }
                        if let profile = model.config.profile {
                            HStack {
                                Button("打开认证页面") {
                                    if PortalProfile.isPrivateIPv4(profile.host), let url = URL(string: "http://\(profile.host)/") { openURL(url) }
                                }
                                Spacer()
                                Button("删除档案", role: .destructive) { confirmingDelete = true }
                            }
                        }
                    }
                    field("档案名称", text: $name)
                    field("门户 IPv4 地址", text: $host)
                    HStack {
                        Button("添加标准 Dr.COM 门户") { model.addProfile(name: name, host: host) }
                        Spacer()
                        Button("导入 JSON") { importing = true }
                    }.buttonStyle(.bordered)
                    Text("默认使用 ePortal 登录接口。不同门户请导入 Windows 端保存的 JSON 档案；添加档案后点“仅检查”验证。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                section {
                    Text("认证信息").font(.headline)
                    field("学号 / 账号", text: edit(\.account, accountChanged: true))
                    SecureField("认证密码", text: Binding(get: { model.password }, set: {
                        model.edited(); model.password = $0
                    })).textFieldStyle(.roundedBorder)
                    Picker("运营商", selection: edit(\.carrier)) {
                        Text("校园用户").tag("campus")
                        Text("自动学习后缀").tag("auto")
                        Text("中国移动 @cmcc").tag("cmcc")
                        Text("校园电信 @dx").tag("dx")
                        Text("校园联通 @lt").tag("lt")
                        Text("自定义后缀").tag("custom")
                    }
                    if model.config.carrier == "custom" { field("例如 @cmcc", text: edit(\.customSuffix)) }
                    if model.config.carrier == "auto" {
                        Text(model.config.learnedSuffix.isEmpty ? "未学习后缀：未在线时请自行选择运营商" : "已学习：\(model.config.learnedSuffix)")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Toggle("自动登录与断线检查", isOn: edit(\.autoLogin))
                    #if os(macOS)
                    Toggle("登录 Mac 时启动", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
                    #endif
                    Button("保存配置") { model.save() }.buttonStyle(.borderedProminent)
                    Text("密码仅保存到本机钥匙串，不写入 JSON，不通过 iCloud 同步。门户使用 HTTP 认证，请仅在可信校园网络上使用。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                #if os(iOS)
                Label("iOS 自动检查仅在应用前台运行。锁屏或切换到后台后暂停，返回应用时恢复；不支持开机自启或持续后台重连。", systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.secondary)
                #else
                Label("关闭控制面板后可从菜单栏打开。退出应用会停止自动重连。", systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.secondary)
                #endif
                section {
                    HStack {
                        Text("运行记录").font(.headline)
                        Spacer()
                        Button("注销当前会话", role: .destructive) { confirmingLogout = true }
                            .disabled(model.working || !model.online)
                    }
                    if model.logs.isEmpty { Text("尚无记录").foregroundStyle(.secondary) }
                    ForEach(Array(model.logs.prefix(30).enumerated()), id: \.offset) { _, entry in
                        Text(entry).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                }
                Link("查看 GitHub Releases", destination: URL(string: "https://github.com/sdjknfgw/CampusLogin/releases/latest")!)
                    .font(.caption)
            }.padding(24).frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
        }
        .background(LinearGradient(colors: [background, card, background], startPoint: .topLeading, endPoint: .bottomTrailing))
        .preferredColorScheme(.dark).tint(accent)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            if case .success(let url) = result { model.importProfiles(url) }
        }
        .confirmationDialog("注销后将暂停自动重连", isPresented: $confirmingLogout, titleVisibility: .visible) {
            Button("确认注销", role: .destructive) { model.logout() }
        }
        .confirmationDialog("删除当前门户档案？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("删除", role: .destructive) { model.removeSelected() }
        }
    }

    private func edit<Value>(_ key: WritableKeyPath<Configuration, Value>, accountChanged: Bool = false) -> Binding<Value> {
        Binding(get: { model.config[keyPath: key] }, set: {
            model.edited(accountChanged: accountChanged)
            model.config[keyPath: key] = $0
        })
    }

    private func section<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14, content: content)
            .padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(card.opacity(0.85), in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(accent.opacity(0.13)))
    }

    private func field(_ title: String, text: Binding<String>) -> some View {
        TextField(title, text: text).textFieldStyle(.roundedBorder)
            #if os(iOS)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            #endif
    }
}
