import Foundation

public struct PortalTemplate: Codable, Equatable {
    public var port: Int
    public var method: String
    public var path: String
    public var rawParams: [[String]]
    public var resultField: String?
    public var okValue: JSONValue?
}

public enum JSONValue: Codable, Equatable {
    case integer(Int), string(String)
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let value = try? c.decode(Int.self) { self = .integer(value) }
        else { self = .string(try c.decode(String.self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .integer(let value): try c.encode(value)
        case .string(let value): try c.encode(value)
        }
    }
    var text: String {
        switch self { case .integer(let v): return String(v); case .string(let v): return v }
    }
}

public struct PortalProfile: Codable, Identifiable, Equatable {
    public var id: String
    public var name: String
    public var host: String
    public var probe: PortalTemplate
    public var login: PortalTemplate
    public var logout: PortalTemplate

    public static func standard(name: String, host: String) -> PortalProfile {
        PortalProfile(id: UUID().uuidString, name: name, host: host,
            probe: PortalTemplate(port: 80, method: "GET", path: "/drcom/chkstatus",
                rawParams: [["callback", "{{randomCb}}"], ["v", "{{epochMs}}"], ["lang", "zh"]]),
            login: PortalTemplate(port: 801, method: "GET", path: "/eportal/portal/login", rawParams: [
                ["callback", "dr1003"], ["login_method", "1"],
                ["user_account", "{{account}}"], ["user_password", "{{password}}"],
                ["wlan_user_ip", "{{localIp}}"], ["wlan_user_ipv6", ""],
                ["wlan_user_mac", "000000000000"], ["wlan_ac_ip", ""], ["wlan_ac_name", ""],
                ["jsVersion", "4.1.3"], ["terminal_type", "1"],
                ["v", "{{epochMs}}"], ["lang", "zh-cn"]], resultField: "result", okValue: .integer(1)),
            logout: PortalTemplate(port: 801, method: "GET", path: "/eportal/portal/logout",
                rawParams: [["callback", "dr1003"], ["v", "{{epochMs}}"], ["lang", "zh-cn"]]))
    }

    public func validate() throws {
        guard Self.isPrivateIPv4(host) else { throw PortalError.invalidProfile("门户必须是校园局域网的 IPv4 地址") }
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !id.isEmpty else {
            throw PortalError.invalidProfile("档案名称或标识为空")
        }
        for template in [probe, login, logout] {
            guard template.method == "GET", (1...65535).contains(template.port),
                  template.path.hasPrefix("/"), !template.path.hasPrefix("//"),
                  !template.path.contains("?"), !template.path.contains("#"),
                  template.rawParams.allSatisfy({ $0.count == 2 }) else {
                throw PortalError.invalidProfile("仅支持有效的 GET 接口模板")
            }
            let supported = ["{{account}}", "{{password}}", "{{localIp}}", "{{randomCb}}", "{{epoch}}", "{{epochMs}}"]
            for pair in template.rawParams {
                var value = pair[1]
                supported.forEach { value = value.replacingOccurrences(of: $0, with: "") }
                guard !value.contains("{{") else { throw PortalError.invalidProfile("模板包含不支持的占位符") }
            }
        }
    }

    public static func isPrivateIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ !$0.isEmpty && ($0.count == 1 || !$0.hasPrefix("0")) && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }),
              let a = Int(parts[0]), let b = Int(parts[1]),
              parts.allSatisfy({ (0...255).contains(Int($0) ?? -1) }) else { return false }
        return a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168)
    }

    public static func imported(from data: Data) throws -> [PortalProfile] {
        let decoder = JSONDecoder()
        let profiles: [PortalProfile]
        if let list = try? decoder.decode([PortalProfile].self, from: data) { profiles = list }
        else if let profile = try? decoder.decode(PortalProfile.self, from: data) { profiles = [profile] }
        else {
            struct Envelope: Decodable { let profiles: [PortalProfile] }
            profiles = try decoder.decode(Envelope.self, from: data).profiles
        }
        guard !profiles.isEmpty, Set(profiles.map(\.id)).count == profiles.count else {
            throw PortalError.invalidProfile("档案为空或标识重复")
        }
        try profiles.forEach { try $0.validate() }
        return profiles
    }
}

public enum PortalError: LocalizedError {
    case invalidProfile(String), invalidResponse, http(Int), missingIP, redirect
    public var errorDescription: String? {
        switch self {
        case .invalidProfile(let message): return message
        case .invalidResponse: return "门户返回了无法识别的响应"
        case .http(let code): return "门户返回 HTTP \(code)"
        case .missingIP: return "无法确定校园网 IPv4，请确认 Wi-Fi 连接并关闭代理后重试"
        case .redirect: return "门户接口发生重定向，已停止请求"
        }
    }
}
