// swift-tools-version:6.2
import PackageDescription

/// The platform-neutral core of the phone-code Apple apps: protocol models,
/// WebSocket transport, pairing, the session/transcript store and the Mac
/// workspace layout. Foundation (and Observation) only, so it builds and its
/// end-to-end tests run on Linux as well as on macOS.
let package = Package(
  name: "PhoneCodeCore",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "PhoneCodeCore", targets: ["PhoneCodeCore"])
  ],
  targets: [
    .target(name: "PhoneCodeCore"),
    // End-to-end only (project policy): every test drives a real daemon with
    // the scripted fake agents from e2e/fakes.
    .testTarget(name: "PhoneCodeCoreE2E", dependencies: ["PhoneCodeCore"]),
  ],
  swiftLanguageModes: [.v6]
)
