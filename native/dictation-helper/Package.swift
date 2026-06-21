// swift-tools-version: 5.9
import Foundation
import PackageDescription

let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let fluidAudioURL = packageDirectory.appendingPathComponent("vendor/FluidAudio.git").absoluteString

let package = Package(
    name: "BlitzDictation",
    platforms: [.macOS("15.0")],
    products: [
        .executable(name: "BlitzDictation", targets: ["BlitzDictation"])
    ],
    dependencies: [
        .package(
            url: fluidAudioURL,
            revision: "ba6e4359fbb0d00b63e789354acc3f005641cfe4"
        )
    ],
    targets: [
        .executableTarget(
            name: "BlitzDictation",
            dependencies: ["FluidAudio"]
        )
    ]
)
