import Foundation

public struct Configuration: Codable {
    public var account = ""
    public var carrier = "campus"
    public var customSuffix = ""
    public var learnedSuffix = ""
    public var autoLogin = false
    public var profiles: [PortalProfile] = []
    public var selectedID = ""
    public init() {}

    public var fullAccount: String {
        let suffix: String
        switch carrier {
        case "auto": suffix = learnedSuffix
        case "custom": suffix = customSuffix
        case "cmcc": suffix = "@cmcc"
        case "dx": suffix = "@dx"
        case "lt": suffix = "@lt"
        default: suffix = ""
        }
        return suffix.isEmpty || account.lowercased().hasSuffix(suffix.lowercased()) ? account : account + suffix
    }
    public var profile: PortalProfile? { profiles.first { $0.id == selectedID } }
}
