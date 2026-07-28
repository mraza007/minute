import { spawn, spawnSync } from 'node:child_process'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const root = process.cwd()
const baselineDir = path.join(root, 'tests', 'visual', 'baselines')
const actualDir = path.join(root, 'tests', 'visual', 'actual')
const diffDir = path.join(root, 'tests', 'visual', 'diff')
const update = process.env.UPDATE_VISUAL_BASELINES === '1'
const port = 4173

const scenarios = [
  { name: 'note-light', url: 'screenshot-app.html?state=note&tab=overview&theme=light', width: 1440, height: 900 },
  { name: 'note-dark', url: 'screenshot-app.html?state=note&tab=overview&theme=dark', width: 1440, height: 900 },
  { name: 'recording-reduced-motion', url: 'screenshot-app.html?state=recording&theme=light&motion=reduced', width: 1440, height: 900 },
  { name: 'note-minimum-width', url: 'screenshot-app.html?state=note&theme=light&sidebar=collapsed', width: 1180, height: 820 },
  { name: 'settings-enlarged-text', url: 'screenshot-app.html?state=settings&theme=light', width: 720, height: 450 },
]

await Promise.all([baselineDir, actualDir, diffDir].map(directory => mkdir(directory, { recursive: true })))

const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
})

async function waitForServer() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/screenshot-app.html`)
      if (response.ok) return
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('visual regression server did not become ready')
}

function browser(args, session) {
  const result = spawnSync('npx', ['agent-browser', '--session', session, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`agent-browser ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
}

function comparePngs(baselinePath, actualPath) {
  const baseline = PNG.sync.read(readFileSync(baselinePath))
  const actual = PNG.sync.read(readFileSync(actualPath))
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    throw new Error(`dimension mismatch: expected ${baseline.width}×${baseline.height}, got ${actual.width}×${actual.height}`)
  }
  const diff = new PNG({ width: baseline.width, height: baseline.height })
  const changed = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    baseline.width,
    baseline.height,
    { threshold: 0.12 },
  )
  return { changed, total: baseline.width * baseline.height, diff }
}

let failures = 0
try {
  await waitForServer()
  for (const scenario of scenarios) {
    const session = `minute-visual-${scenario.name}`
    const actualPath = path.join(actualDir, `${scenario.name}.png`)
    const baselinePath = path.join(baselineDir, `${scenario.name}.png`)
    const diffPath = path.join(diffDir, `${scenario.name}.png`)
    try {
      browser(['set', 'viewport', String(scenario.width), String(scenario.height)], session)
      browser(['open', `http://127.0.0.1:${port}/${scenario.url}`], session)
      browser(['wait', 'html[data-screenshot-ready="true"]'], session)
      browser(['screenshot', actualPath], session)
      if (update) {
        await copyFile(actualPath, baselinePath)
        process.stdout.write(`updated ${scenario.name}\n`)
        continue
      }
      if (!existsSync(baselinePath)) {
        throw new Error(`missing visual baseline: ${baselinePath}`)
      }
      const { changed, total, diff } = comparePngs(baselinePath, actualPath)
      const ratio = changed / total
      if (ratio > 0.01) {
        await writeFile(diffPath, PNG.sync.write(diff))
        failures += 1
        process.stderr.write(`${scenario.name}: ${(ratio * 100).toFixed(2)}% pixels changed\n`)
      } else {
        process.stdout.write(`${scenario.name}: ${(ratio * 100).toFixed(3)}% pixels changed\n`)
      }
    } finally {
      try {
        browser(['close'], session)
      } catch {
        // Cleanup should not hide the capture result.
      }
    }
  }
} finally {
  server.kill('SIGTERM')
}

if (failures > 0) process.exitCode = 1
