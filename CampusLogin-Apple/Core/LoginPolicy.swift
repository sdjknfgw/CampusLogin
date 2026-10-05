import Foundation

/// Tracks retry limits independently of UI and platform lifecycle callbacks.
public struct LoginPolicy {
    public private(set) var failures = 0
    public private(set) var backoff = 0
    public private(set) var halted = false
    public init() {}

    public mutating func resume() {
        halted = false; failures = 0; backoff = 0
    }
    public mutating func pause() { halted = true }
    public mutating func authenticated() {
        failures = 0; backoff = 0
    }
    @discardableResult public mutating func rejected(message: String = "") -> Bool {
        failures += 1
        let fatal = message.range(of: "密码错误|密码不正确|用户名或密码|password.*(wrong|error|incorrect)|AC认证失败|AC验证失败|AC认证拒绝", options: [.regularExpression, .caseInsensitive]) != nil
        if fatal || failures >= 3 { halted = true }
        return halted
    }
    public mutating func nextDelay(jitter: Double = Double.random(in: 0.8...1.2)) -> Double {
        let sequence: [Double] = [10, 30, 60, 120, 300, 600]
        let delay = sequence[min(backoff, sequence.count - 1)]
        backoff = min(backoff + 1, sequence.count - 1)
        return delay * max(0.8, min(1.2, jitter))
    }
}
