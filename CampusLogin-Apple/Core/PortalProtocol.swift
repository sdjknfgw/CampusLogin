import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum PortalProtocol {
    // Match encodeURIComponent and preserve the captured parameter order.
    public static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters:
            CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"))!
    }

    public static func url(profile: PortalProfile, template: PortalTemplate,
                           account: String = "", password: String = "", ip: String = "",
                           milliseconds: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws -> URL {
        try profile.validate()
        let values = ["{{account}}": account, "{{password}}": password, "{{localIp}}": ip,
                      "{{randomCb}}": "jQuery\(Int.random(in: 1..<1_000_000_000))",
                      "{{epoch}}": String(milliseconds / 1000), "{{epochMs}}": String(milliseconds)]
        var pairs = template.rawParams.map { pair -> [String] in
            var value = pair[1]
            // Scan placeholders once so credentials containing '{{...}}' stay literal.
            let pattern = #"\{\{(?:account|password|localIp|randomCb|epochMs|epoch)\}\}"#
            let regex = try! NSRegularExpression(pattern: pattern)
            let matches = regex.matches(in: value, range: NSRange(value.startIndex..., in: value))
            for match in matches.reversed() {
                if let range = Range(match.range, in: value), let replacement = values[String(value[range])] {
                    value.replaceSubrange(range, with: replacement)
                }
            }
            return [pair[0], value]
        }
        if !pairs.contains(where: { $0[0] == "v" }) { pairs.append(["v", String(milliseconds)]) }
        let query = pairs.map { encode($0[0]) + "=" + encode($0[1]) }.joined(separator: "&")
        guard let url = URL(string: "http://\(profile.host):\(template.port)\(template.path)?\(query)") else {
            throw PortalError.invalidProfile("接口地址无效")
        }
        return url
    }

    public static func parse(_ data: Data) throws -> [String: Any] {
        guard let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            throw PortalError.invalidResponse
        }
        let payload: Data
        if text.hasPrefix("{") { payload = data }
        else if let start = text.firstIndex(of: "("), let end = text.lastIndex(of: ")"), start < end {
            payload = Data(text[text.index(after: start)..<end].utf8)
        } else { throw PortalError.invalidResponse }
        guard let object = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            throw PortalError.invalidResponse
        }
        return object
    }

    public static func text(_ object: [String: Any], _ keys: String...) -> String {
        for key in keys {
            if let value = object[key] as? String, !value.isEmpty { return value }
            if let value = object[key] as? NSNumber { return value.stringValue }
        }
        return ""
    }

    public static func succeeded(_ response: [String: Any], template: PortalTemplate) -> Bool {
        text(response, template.resultField ?? "result") == (template.okValue ?? .integer(1)).text
    }

    public static func ownsAccount(_ uid: String, base: String) -> Bool {
        guard !base.isEmpty else { return false }
        let uid = uid.lowercased(), base = base.lowercased()
        return uid == base || (!base.contains("@") && uid.hasPrefix(base + "@"))
    }
}

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public final class PortalClient {
    private let delegate = NoRedirect()
    private let configuration: URLSessionConfiguration
    private lazy var session: URLSession = {
        let config = configuration
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 10
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.urlCache = nil
        #if os(iOS) || os(macOS)
        config.allowsCellularAccess = false
        #endif
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }()

    public init() { configuration = .ephemeral }
    init(configuration: URLSessionConfiguration) { self.configuration = configuration }
    deinit { session.invalidateAndCancel() }

    public func request(profile: PortalProfile, template: PortalTemplate,
                        account: String = "", password: String = "", ip: String = "") async throws -> [String: Any] {
        let url = try PortalProtocol.url(profile: profile, template: template, account: account, password: password, ip: ip)
        var request = URLRequest(url: url)
        request.timeoutInterval = template == profile.probe ? 3 : 8
        request.setValue("http://\(profile.host)/", forHTTPHeaderField: "Referer")
        request.setValue("CampusLogin/1.0.5 (Apple)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw PortalError.invalidResponse }
        if (300...399).contains(http.statusCode) { throw PortalError.redirect }
        guard http.statusCode == 200 else { throw PortalError.http(http.statusCode) }
        return try PortalProtocol.parse(data)
    }
}
