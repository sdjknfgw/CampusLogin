import Foundation
import Combine
import Network
#if os(macOS)
import ServiceManagement
#endif

@MainActor final class CampusModel: ObservableObject {
    @Published var config: Configuration
    @Published var password = ""
    @Published private(set) var status = "未配置"
    @Published private(set) var detail = "连接校园 Wi-Fi 后，添加或导入门户档案"
    @Published private(set) var logs: [String] = []
    @Published private(set) var working = false
    @Published private(set) var online = false
    @Published private(set) var isMonitoring = false
    @Published private(set) var available = false
    #if os(macOS)
    @Published private(set) var launchAtLogin = SMAppService.mainApp.status == .enabled
    #endif
    private let client = PortalClient()
    private let monitor = NWPathMonitor()
    private var operation: Task<Void, Never>?
    private var generation = UUID()
    private var policy = LoginPolicy()
    private var active = false
    private var sawNetwork = false
    private var lastNetworkIdentity = ""
    private let storageKey = "CampusLogin.Apple.Configuration.v1"

    init() {
        if let data = UserDefaults.standard.data(forKey: storageKey),
           let config = try? JSONDecoder().decode(Configuration.self, from: data) { self.config = config }
        else { config = Configuration() }
        do { password = try Keychain.read() } catch { detail = error.localizedDescription }
        monitor.pathUpdateHandler = { [weak self] path in
            let connected = path.status == .satisfied && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
            Task { @MainActor [weak self] in
                guard let self else { return }
                let changed = self.available != connected
                let initial = !self.sawNetwork
                self.sawNetwork = true
                let identity = path.availableInterfaces.filter { path.usesInterfaceType($0.type) }
                    .map { "\($0.name):\($0.index)" }.sorted().joined(separator: "|")
                    + "|" + LocalNetwork.ipv4(host: self.config.profile?.host ?? "")
                let pathChanged = !initial && identity != self.lastNetworkIdentity
                self.lastNetworkIdentity = identity
                self.available = connected
                if connected && pathChanged {
                    self.cancel(); self.policy.pause(); self.online = false
                    self.status = "请确认当前门户"
                    self.record("网络路径发生变化，请确认门户档案后点击立即登录")
                } else if changed && connected && self.active && !self.policy.halted && self.config.autoLogin {
                    self.start(manual: false)
                }
                if !connected { self.cancel(); self.status = "等待校园网络"; self.online = false }
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.campuslogin.network"))
    }

    private func persist() throws {
        UserDefaults.standard.set(try JSONEncoder().encode(config), forKey: storageKey)
    }
    private func record(_ text: String) {
        var safe = text
        if !password.isEmpty { safe = safe.replacingOccurrences(of: password, with: "••••") }
        logs.insert("\(Date().formatted(date: .omitted, time: .standard))  \(safe)", at: 0)
        logs = Array(logs.prefix(100))
        detail = safe
    }

    func save() {
        cancel()
        config.account = config.account.trimmingCharacters(in: .whitespacesAndNewlines)
        config.customSuffix = config.customSuffix.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !config.account.isEmpty, !password.isEmpty, let profile = config.profile else {
            status = "配置未完整"; record("请填写账号、密码，并选择门户档案"); return
        }
        do {
            try profile.validate()
            try Keychain.write(password)
            try persist()
            policy.resume()
            record("配置已保存，密码存入本机钥匙串")
            if config.autoLogin { start(manual: false) } else { status = "已保存" }
        } catch { status = "保存失败"; record(error.localizedDescription) }
    }

    func addProfile(name: String, host: String) {
        do {
            let profile = PortalProfile.standard(name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                host: host.trimmingCharacters(in: .whitespacesAndNewlines))
            try profile.validate()
            cancel(); policy.pause(); online = false; status = "请确认配置"
            config.profiles.append(profile); config.selectedID = profile.id
            try persist()
            record("已添加门户，请确认账号信息后保存配置")
        } catch { record(error.localizedDescription) }
    }

    func importProfiles(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let values = try PortalProfile.imported(from: Data(contentsOf: url))
            cancel(); policy.pause(); online = false; status = "请确认配置"
            for value in values {
                if let index = config.profiles.firstIndex(where: { $0.id == value.id }) { config.profiles[index] = value }
                else { config.profiles.append(value) }
            }
            config.selectedID = values[0].id
            try persist()
            record("已导入 \(values.count) 个门户档案，未导入账号密码")
        } catch { record("导入失败：\(error.localizedDescription)") }
    }

    func removeSelected() {
        cancel(); policy.pause(); online = false; status = "请确认配置"
        config.profiles.removeAll { $0.id == config.selectedID }
        config.selectedID = config.profiles.first?.id ?? ""
        do { try persist(); record("档案已删除") } catch { record(error.localizedDescription) }
    }

    func sceneActive(_ value: Bool) {
        #if os(macOS)
        active = true
        #else
        active = value
        #endif
        #if os(iOS)
        if !value { cancel(); return }
        #endif
        if value && config.autoLogin && !policy.halted && operation == nil { start(manual: false) }
    }

    private func cancel() {
        generation = UUID()
        operation?.cancel(); operation = nil; working = false; isMonitoring = false
    }

    func pause() {
        cancel(); policy.pause(); status = "已暂停"; record("已暂停自动检查，点击立即登录可恢复")
    }

    func edited(accountChanged: Bool = false) {
        cancel(); online = false
        if accountChanged { config.learnedSuffix = "" }
        status = "配置已修改"
        detail = "请保存配置后恢复自动检查"
        policy.pause()
    }

    func start(manual: Bool = true, probeOnly: Bool = false) {
        guard !working else { return }
        cancel()
        if manual && !probeOnly { policy.resume() }
        guard (probeOnly || !policy.halted), let profile = config.profile else {
            status = "请选择门户"; return
        }
        guard available else { status = "等待校园网络"; record("请连接 Wi-Fi 或以太网后重试"); return }
        guard probeOnly || (!config.account.isEmpty && !password.isEmpty) else {
            status = "未配置"; record("请填写账号和密码"); return
        }
        let token = generation
        let base = config.account, secret = password
        let auto = config.autoLogin && !probeOnly
        isMonitoring = auto
        operation = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.generation == token { self.working = false; self.operation = nil; self.isMonitoring = false }
            }
            repeat {
                self.working = true
                let delay = await self.cycle(profile: profile, account: self.config.fullAccount, base: base, password: secret,
                    allowLogin: !probeOnly && (manual || auto))
                if Task.isCancelled || self.generation != token { return }
                self.working = false
                guard auto, let delay, !self.policy.halted else { return }
                do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
                catch { return }
            } while !Task.isCancelled
        }
    }

    private func cycle(profile: PortalProfile, account: String, base: String,
                       password: String, allowLogin: Bool) async -> Double? {
        var attemptedLogin = false
        do {
            status = "正在检查"
            let probe = try await client.request(profile: profile, template: profile.probe)
            try Task.checkCancellation()
            let isOnline = ["result", "online", "status"].contains { PortalProtocol.text(probe, $0) == "1" }
            let uid = PortalProtocol.text(probe, "uid", "account", "user_account", "userid")
            let ip = PortalProtocol.text(probe, "v46ip", "wlan_user_ip", "user_ip")
            online = isOnline
            if isOnline {
                if !uid.isEmpty && !base.isEmpty && !PortalProtocol.ownsAccount(uid, base: base) {
                    policy.pause(); status = "已停止"; record("当前有其他账号在线，不执行登录或注销"); return nil
                }
                if config.carrier == "auto", PortalProtocol.ownsAccount(uid, base: base), uid.count > base.count {
                    config.learnedSuffix = String(uid.dropFirst(base.count)); try persist()
                }
                if allowLogin { policy.authenticated() }
                status = "已认证"
                record("校园网已在线" + (ip.isEmpty ? "" : " · \(ip)"))
                return Double.random(in: 45...75)
            }
            guard allowLogin else { status = "未认证"; record("门户可达，当前未认证"); return nil }
            let localIP = PortalProfile.isPrivateIPv4(ip) ? ip : LocalNetwork.ipv4(host: profile.host)
            if profile.login.rawParams.contains(where: { $0[1].contains("{{localIp}}") }) && localIP.isEmpty {
                throw PortalError.missingIP
            }
            status = "正在登录"
            attemptedLogin = true
            let response = try await client.request(profile: profile, template: profile.login,
                account: account, password: password, ip: localIP)
            try Task.checkCancellation()
            let message = PortalProtocol.text(response, "msg", "message", "error")
            if PortalProtocol.succeeded(response, template: profile.login) || message.contains("已经在线") {
                policy.authenticated(); online = true; status = "已认证"; record("登录成功")
                return Double.random(in: 45...75)
            }
            if policy.rejected(message: message) {
                status = "已停止"
                record("凭据或 AC 认证被拒绝，或连续三次登录失败，请检查配置后手动恢复")
                return nil
            }
            status = "未认证"; record("门户拒绝登录（第 \(policy.failures) 次），请在浏览器确认认证信息")
            return policy.nextDelay()
        } catch {
            if Task.isCancelled { return nil }
            if attemptedLogin {
                if policy.rejected() {
                    online = false; status = "已停止"
                    record("连续三次登录未能完成，已停止自动重试")
                    return nil
                }
            }
            online = false; status = "门户不可达"
            // Avoid logging request URLs: the portal protocol puts credentials in query parameters.
            record("网络或协议检查失败，请检查校园 Wi-Fi、门户地址及本地网络权限")
            return policy.nextDelay()
        }
    }

    func logout() {
        guard !working, let profile = config.profile, available, !config.account.isEmpty else { return }
        cancel(); policy.pause(); working = true
        let token = generation, base = config.account
        operation = Task {
            defer { if generation == token { working = false; operation = nil } }
            do {
                let probe = try await client.request(profile: profile, template: profile.probe)
                try Task.checkCancellation()
                let uid = PortalProtocol.text(probe, "uid", "account", "user_account", "userid")
                guard PortalProtocol.ownsAccount(uid, base: base) else {
                    status = "未注销"; record("未能确认当前会话属于你的账号，已停止注销"); return
                }
                let response = try await client.request(profile: profile, template: profile.logout)
                try Task.checkCancellation()
                guard PortalProtocol.succeeded(response, template: profile.logout) else {
                    status = "注销失败"; record("门户拒绝注销，自动重连保持暂停"); return
                }
                online = false; status = "已注销"; record("已注销，自动重连暂停；点击立即登录可恢复")
            } catch {
                if !Task.isCancelled { status = "注销失败"; record("无法完成注销，请在浏览器确认当前会话") }
            }
        }
    }

    #if os(macOS)
    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            launchAtLogin = SMAppService.mainApp.status == .enabled
            record(launchAtLogin ? "已启用登录时启动" : "登录项已更新；如需授权，请在系统设置的登录项中确认")
        } catch { record("登录项设置失败，请在已安装的签名应用中重试") }
    }
    #endif
}
