#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Apple app builds require macOS and Xcode 16 or newer.' >&2
  exit 1
fi
xcodebuild -version
swift test
xcodebuild -project CampusLogin.xcodeproj -scheme CampusLogin-iOS \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/iOS CODE_SIGNING_ALLOWED=NO build
xcodebuild -project CampusLogin.xcodeproj -scheme CampusLogin-macOS \
  -configuration Debug -destination 'generic/platform=macOS' \
  -derivedDataPath build/macOS CODE_SIGNING_ALLOWED=NO build
ditto -c -k --sequesterRsrc --keepParent build/iOS/Build/Products/Debug-iphonesimulator/CampusLogin.app \
  build/CampusLogin-iOS-Simulator.zip
ditto -c -k --sequesterRsrc --keepParent build/macOS/Build/Products/Debug/CampusLogin.app \
  build/CampusLogin-macOS-unsigned.zip
echo 'Built iOS Simulator and unsigned macOS apps under CampusLogin-Apple/build.'
