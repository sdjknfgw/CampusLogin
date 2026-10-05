#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/evidence

device=$(xcrun simctl list devices available -j | node -e '
let data = ""; process.stdin.on("data", d => data += d);
process.stdin.on("end", () => {
  const devices = Object.values(JSON.parse(data).devices).flat();
  const iphone = devices.find(d => d.isAvailable && d.name.startsWith("iPhone"));
  if (!iphone) process.exit(1);
  process.stdout.write(iphone.udid);
});')
timeout 60 xcrun simctl boot "$device"
timeout 120 xcrun simctl bootstatus "$device" -b
timeout 60 xcrun simctl install "$device" build/iOS/Build/Products/Debug-iphonesimulator/CampusLogin.app
launch=$(timeout 30 xcrun simctl launch --terminate-running-process "$device" com.campuslogin.app.ios)
printf '%s\n' "$launch" > build/evidence/ios-launch.txt
pid=${launch##*: }
sleep 8
kill -0 "$pid"
timeout 30 xcrun simctl io "$device" screenshot build/evidence/ios-launch.png
timeout 20 xcrun simctl terminate "$device" com.campuslogin.app.ios

mkdir -p build/smoke/macOS
ditto build/macOS/Build/Products/Debug/CampusLogin.app build/smoke/macOS/CampusLogin.app
codesign --force --deep --sign - --entitlements Config/macOS.entitlements build/smoke/macOS/CampusLogin.app
build/smoke/macOS/CampusLogin.app/Contents/MacOS/CampusLogin > build/evidence/macos-runtime.log 2>&1 &
mac_pid=$!
trap 'if [[ -n "$mac_pid" ]]; then kill "$mac_pid" 2>/dev/null || true; fi' EXIT
sleep 8
if [[ -z "$mac_pid" ]] || ! kill -0 "$mac_pid"; then
  echo 'macOS app did not remain running after launch.' >&2
  exit 1
fi
printf 'macOS app remained running after launch (PID %s).\n' "$mac_pid" > build/evidence/macos-launch.txt
timeout 20 screencapture -x build/evidence/macos-launch.png || echo 'macOS screenshot is unavailable on this runner.'
echo 'iOS Simulator and macOS launch smoke checks passed.'
