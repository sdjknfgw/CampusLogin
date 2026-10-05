import XCTest
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import CampusPortal

private final class PortalStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        let code = path == "/redirect" ? 302 : path == "/failure" ? 503 : 200
        let headers = path == "/redirect" ? ["Location": "https://example.invalid/"] : [:]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: code,
            httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
        let body = path == "/malformed" ? "<html>Login</html>" : "jQuery1({\"result\":1,\"uid\":\"123@cmcc\"});"
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class PortalClientTests: XCTestCase {
    private func client() -> PortalClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PortalStub.self]
        return PortalClient(configuration: config)
    }
    func testProbeThroughURLSessionWithoutRealCampusTraffic() async throws {
        let profile = PortalProfile.standard(name: "Test", host: "10.0.0.1")
        let response = try await client().request(profile: profile, template: profile.probe)
        XCTAssertEqual(PortalProtocol.text(response, "uid"), "123@cmcc")
    }
    func testRejectsHTTPFailureRedirectAndMalformedResponse() async throws {
        for path in ["/failure", "/redirect", "/malformed"] {
            var profile = PortalProfile.standard(name: "Test", host: "10.0.0.1")
            profile.probe.path = path
            do {
                _ = try await client().request(profile: profile, template: profile.probe)
                XCTFail("Expected rejection for \(path)")
            } catch let error as PortalError {
                switch (path, error) {
                case ("/failure", .http(503)), ("/redirect", .redirect), ("/malformed", .invalidResponse): break
                default: XCTFail("Unexpected error \(error)")
                }
            }
        }
    }
}
