import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const tauriConfig = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
const cargoToml = await readFile('src-tauri/Cargo.toml', 'utf8')
const infoPlist = await readFile('src-tauri/Info.plist', 'utf8')

const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
const failures = []

if (packageJson.version !== tauriConfig.version || packageJson.version !== cargoVersion) {
  failures.push(`version mismatch: package=${packageJson.version}, tauri=${tauriConfig.version}, cargo=${cargoVersion}`)
}
if (!/^[a-z][a-z0-9.-]+\.[a-z0-9-]+$/i.test(tauriConfig.identifier)) {
  failures.push(`invalid bundle identifier: ${tauriConfig.identifier}`)
}
if (!tauriConfig.bundle?.macOS?.entitlements) failures.push('macOS entitlements are not configured')
if (!infoPlist.includes('NSMicrophoneUsageDescription')) failures.push('microphone privacy copy is missing from Info.plist')
if (!infoPlist.includes('NSScreenCaptureUsageDescription')) failures.push('screen-capture privacy copy is missing from Info.plist')

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`release check: ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`release metadata valid for Minute ${packageJson.version}\n`)
}
