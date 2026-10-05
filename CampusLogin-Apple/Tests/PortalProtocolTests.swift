import XCTest
@testable import CampusPortal

final class PortalProtocolTests: XCTestCase {
    func testOrderedParametersAndCredentialEncoding() throws {
        let profile = PortalProfile.standard(name: "Campus", host: "172.19.0.1")
        let url = try PortalProtocol.url(profile: profile, template: profile.login,
            account: "123@cmcc", password: "a&b+ {{epoch}}中文", ip: "172.19.1.2", milliseconds: 123000)
        XCTAssertTrue(url.absoluteString.contains("callback=dr1003&login_method=1&user_account=123%40cmcc&user_password=a%26b%2B%20%7B%7Bepoch%7D%7D"))
        XCTAssertTrue(url.absoluteString.hasSuffix("&v=123000&lang=zh-cn"))
        XCTAssertTrue(url.absoluteString.contains("wlan_user_ip=172.19.1.2"))
    }

    func testJSONAndJSONP() throws {
        for body in [#"{"result":1,"uid":"123@cmcc"}"#, #"jQuery123({"result":1,"uid":"123@cmcc"});"#] {
            let object = try PortalProtocol.parse(Data(body.utf8))
            XCTAssertEqual(PortalProtocol.text(object, "uid"), "123@cmcc")
            XCTAssertTrue(PortalProtocol.succeeded(object, template: PortalProfile.standard(name: "Test", host: "10.0.0.1").login))
        }
        XCTAssertThrowsError(try PortalProtocol.parse(Data("<html>Login</html>".utf8)))
    }

    func testAccountBoundaryProtectsOtherUsers() {
        XCTAssertTrue(PortalProtocol.ownsAccount("123@cmcc", base: "123"))
        XCTAssertTrue(PortalProtocol.ownsAccount("123", base: "123"))
        XCTAssertFalse(PortalProtocol.ownsAccount("1234@cmcc", base: "123"))
        XCTAssertFalse(PortalProtocol.ownsAccount("123@dx", base: "123@cmcc"))
        XCTAssertFalse(PortalProtocol.ownsAccount("123", base: ""))
    }

    func testImportWindowsEnvelopeAndRejectUnsafeHost() throws {
        let profile = PortalProfile.standard(name: "Test", host: "10.0.0.1")
        let data = try JSONEncoder().encode(["profiles": [profile]])
        XCTAssertEqual(try PortalProfile.imported(from: data), [profile])
        var bad = profile
        bad.host = "10.0.0.1@evil.example"
        XCTAssertThrowsError(try bad.validate())
        bad = profile
        bad.login.rawParams = [["broken"]]
        XCTAssertThrowsError(try bad.validate())
        bad = profile
        bad.login.method = "POST"
        XCTAssertThrowsError(try bad.validate())
        XCTAssertFalse(PortalProfile.isPrivateIPv4("010.0.0.1"))
        XCTAssertFalse(PortalProfile.isPrivateIPv4("127.0.0.1"))
        XCTAssertFalse(PortalProfile.isPrivateIPv4("172.32.0.1"))
        XCTAssertTrue(PortalProfile.isPrivateIPv4("192.168.1.1"))
    }
}
