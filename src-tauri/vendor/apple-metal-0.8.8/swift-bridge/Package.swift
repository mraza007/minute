// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AppleMetalBridge",
    platforms: [
        .macOS(.v11)
    ],
    products: [
        .library(
            name: "AppleMetalBridge",
            type: .static,
            targets: ["AppleMetalBridge"])
    ],
    targets: [
        .target(
            name: "AppleMetalBridge",
            path: "Sources/AppleMetalBridge")
    ]
)
