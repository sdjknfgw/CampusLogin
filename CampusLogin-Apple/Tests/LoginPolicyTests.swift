import XCTest
@testable import CampusPortal

final class LoginPolicyTests: XCTestCase {
    func testThreeFailuresStopAndOnlyResumeClearsStop() {
        var policy = LoginPolicy()
        XCTAssertFalse(policy.rejected())
        XCTAssertFalse(policy.rejected(message: "暂时失败"))
        XCTAssertTrue(policy.rejected())
        XCTAssertEqual(policy.failures, 3)
        policy.authenticated()
        XCTAssertTrue(policy.halted, "A status probe must not clear an explicit stop")
        policy.resume()
        XCTAssertFalse(policy.halted)
        XCTAssertEqual(policy.failures, 0)
    }

    func testCredentialAndACRejectionStopsImmediately() {
        for message in ["密码错误", "用户名或密码不正确", "PASSWORD INCORRECT", "AC认证拒绝"] {
            var policy = LoginPolicy()
            XCTAssertTrue(policy.rejected(message: message), message)
            XCTAssertEqual(policy.failures, 1)
        }
    }

    func testProbeBackoffDoesNotConsumeLoginFailures() {
        var policy = LoginPolicy()
        XCTAssertEqual((0..<8).map { _ in policy.nextDelay(jitter: 1) }, [10, 30, 60, 120, 300, 600, 600, 600])
        XCTAssertEqual(policy.failures, 0)
        policy.authenticated()
        XCTAssertEqual(policy.nextDelay(jitter: 1), 10)
        policy.pause()
        _ = policy.nextDelay()
        XCTAssertTrue(policy.halted)
    }

    func testCarrierSuffixesAndConfigurationNeverEncodePassword() throws {
        var config = Configuration()
        config.account = "123"
        for (carrier, suffix) in [("campus", ""), ("cmcc", "@cmcc"), ("dx", "@dx"), ("lt", "@lt")] {
            config.carrier = carrier
            XCTAssertEqual(config.fullAccount, "123" + suffix)
        }
        config.account = "123@CMCC"; config.carrier = "cmcc"
        XCTAssertEqual(config.fullAccount, "123@CMCC")
        config.account = "123"; config.carrier = "auto"; config.learnedSuffix = "@dx"
        XCTAssertEqual(config.fullAccount, "123@dx")
        config.carrier = "custom"; config.customSuffix = "@custom"
        XCTAssertEqual(config.fullAccount, "123@custom")
        let data = try JSONEncoder().encode(config)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["password"])
        XCTAssertNil(object["passwordEncrypted"])
        XCTAssertEqual(try JSONDecoder().decode(Configuration.self, from: data).fullAccount, "123@custom")
    }
}
