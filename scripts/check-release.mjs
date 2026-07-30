import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const tauriConfig = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
const releaseConfig = JSON.parse(await readFile('src-tauri/tauri.release.conf.json', 'utf8'))
const cargoToml = await readFile('src-tauri/Cargo.toml', 'utf8')
const infoPlist = await readFile('src-tauri/Info.plist', 'utf8')
const releaseEntitlements = await readFile('src-tauri/Entitlements.release.plist', 'utf8')
const devEntitlements = await readFile('src-tauri/Entitlements.plist', 'utf8')

const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
const failures = []
const releaseMacOS = releaseConfig.bundle?.macOS

if (packageJson.version !== tauriConfig.version || packageJson.version !== cargoVersion) {
  failures.push(`version mismatch: package=${packageJson.version}, tauri=${tauriConfig.version}, cargo=${cargoVersion}`)
}
if (!/^[a-z][a-z0-9.-]+\.[a-z0-9-]+$/i.test(tauriConfig.identifier)) {
  failures.push(`invalid bundle identifier: ${tauriConfig.identifier}`)
}
if (tauriConfig.identifier !== 'dev.minute.app') {
  failures.push(`bundle identifier changed: expected dev.minute.app, got ${tauriConfig.identifier}`)
}
if (!tauriConfig.bundle?.macOS?.entitlements) failures.push('macOS entitlements are not configured')
if (tauriConfig.bundle?.macOS?.hardenedRuntime !== true) failures.push('macOS hardened runtime is not explicitly enabled')
if (!releaseMacOS?.signingIdentity?.startsWith('Developer ID Application:')) {
  failures.push('release signing identity is not a Developer ID Application identity')
}
if (releaseMacOS?.hardenedRuntime !== true) failures.push('release hardened runtime is not enabled')
if (releaseMacOS?.entitlements !== 'Entitlements.release.plist') {
  failures.push(`unexpected release entitlements file: ${releaseMacOS?.entitlements}`)
}
if (releaseEntitlements.includes('com.apple.security.cs.disable-library-validation')) {
  failures.push('release entitlements disable library validation')
}
if (releaseEntitlements.includes('com.apple.security.get-task-allow')) {
  failures.push('release entitlements enable get-task-allow')
}
if (!releaseEntitlements.includes('com.apple.security.device.audio-input')) {
  failures.push('release entitlements are missing com.apple.security.device.audio-input; the hardened runtime denies the microphone without prompting')
}
if (!devEntitlements.includes('com.apple.security.device.audio-input')) {
  failures.push('dev entitlements are missing com.apple.security.device.audio-input; the hardened runtime denies the microphone without prompting')
}
const mainCapability = JSON.parse(await readFile('src-tauri/capabilities/default.json', 'utf8'))
if (!mainCapability.permissions?.includes('core:window:allow-start-dragging')) {
  failures.push('main window capability is missing core:window:allow-start-dragging; core:default does not include it, and without it the window cannot be moved at all (issue #5)')
}
if (!infoPlist.includes('NSMicrophoneUsageDescription')) failures.push('microphone privacy copy is missing from Info.plist')
if (!infoPlist.includes('NSScreenCaptureUsageDescription')) failures.push('screen-capture privacy copy is missing from Info.plist')

// Auto-update (issue #4): a release without these ships an app that can
// never hear about the next release.
const updaterConfig = tauriConfig.plugins?.updater
if (!updaterConfig?.pubkey?.length) failures.push('updater public key is missing from tauri.conf.json plugins.updater.pubkey')
if (updaterConfig?.endpoints?.[0] !== 'https://github.com/mraza007/minute/releases/latest/download/latest.json') {
  failures.push(`unexpected updater endpoint: ${updaterConfig?.endpoints?.[0]}`)
}
if (tauriConfig.bundle?.createUpdaterArtifacts !== true) {
  failures.push('bundle.createUpdaterArtifacts is not enabled; releases would ship without updater archives')
}
if (!mainCapability.permissions?.includes('updater:default')) {
  failures.push('main window capability is missing updater:default')
}
if (!mainCapability.permissions?.includes('process:allow-restart')) {
  failures.push('main window capability is missing process:allow-restart; the app cannot relaunch after installing an update')
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`release check: ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`release metadata valid for Minute ${packageJson.version}\n`)
}
