// swift-tools-version: 5.9
import PackageDescription

let package = Package(name: "CampusPortal", platforms: [.macOS(.v13), .iOS(.v16)], products: [
    .library(name: "CampusPortal", targets: ["CampusPortal"])
], targets: [
    .target(name: "CampusPortal", path: "Core"),
    .testTarget(name: "CampusPortalTests", dependencies: ["CampusPortal"], path: "Tests")
])
