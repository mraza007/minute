// Composes the static updater manifest (latest.json) the installed app
// polls via `plugins.updater.endpoints` — attach it to the GitHub release
// alongside the two updater archives. Run AFTER both architectures have
// been built by build-macos-release.sh:
//
//   node scripts/make-update-manifest.mjs
//
// Reads the version from package.json, requires both arch's
// `Minute-<version>-<arch>.app.tar.gz` + `.sig` to exist, and writes
// `src-tauri/target/latest.json`. Fails loudly if anything is missing —
// a manifest pointing at assets that were never built would brick the
// update check for every installed copy.
import { readFile, writeFile } from 'node:fs/promises'

const version = JSON.parse(await readFile('package.json', 'utf8')).version
const releaseBase = `https://github.com/mraza007/minute/releases/download/v${version}`

const targets = [
  { platform: 'darwin-aarch64', triple: 'aarch64-apple-darwin', arch: 'arm64' },
  { platform: 'darwin-x86_64', triple: 'x86_64-apple-darwin', arch: 'x86_64' },
]

const platforms = {}
for (const { platform, triple, arch } of targets) {
  const name = `Minute-${version}-${arch}.app.tar.gz`
  const signaturePath = `src-tauri/target/${triple}/release/bundle/macos/${name}.sig`
  const signature = (await readFile(signaturePath, 'utf8')).trim()
  if (!signature) throw new Error(`empty updater signature at ${signaturePath}`)
  platforms[platform] = { signature, url: `${releaseBase}/${name}` }
}

const manifest = {
  version,
  notes: `https://github.com/mraza007/minute/releases/tag/v${version}`,
  pub_date: new Date().toISOString(),
  platforms,
}

await writeFile('src-tauri/target/latest.json', `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`update manifest written for Minute ${version} (src-tauri/target/latest.json)\n`)
