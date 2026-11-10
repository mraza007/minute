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
const port = Number(process.env.VISUAL_PORT ?? 4173)
// VISUAL_ONLY=name,name limits the run to those scenarios, so one unit's
// baselines can be refreshed without rewriting every other PNG.
const only = process.env.VISUAL_ONLY ? new Set(process.env.VISUAL_ONLY.split(',')) : null

const scenarios = [
  { name: 'note-light', url: 'screenshot-app.html?state=note&theme=light', width: 1440, height: 900 },
  { name: 'note-dark', url: 'screenshot-app.html?state=note&theme=dark', width: 1440, height: 900 },
  { name: 'note-narrow', url: 'screenshot-app.html?state=note&theme=light', width: 860, height: 640 },
  { name: 'note-ask', url: 'screenshot-app.html?state=note&theme=light&ask=open', width: 1440, height: 900 },
  { name: 'note-menu', url: 'screenshot-app.html?state=note&theme=light&menu=note', width: 1440, height: 900 },
  { name: 'note-speaker-rename', url: 'screenshot-app.html?state=note&theme=light&rename=Speaker%203&suggest=1', width: 1440, height: 900 },
  { name: 'recording-reduced-motion', url: 'screenshot-app.html?state=recording&theme=light&motion=reduced', width: 1440, height: 900 },
  { name: 'recording-preflight', url: 'screenshot-app.html?state=preflight&theme=light', width: 1440, height: 900 },
  { name: 'recording-live', url: 'screenshot-app.html?state=recording&theme=light&motion=reduced&sysaudio=1&marker=Download%20step%20follow-up', width: 1440, height: 900 },
  { name: 'recording-live-dark', url: 'screenshot-app.html?state=recording&theme=dark&motion=reduced&sysaudio=1&message=autostop', width: 1440, height: 900 },
  { name: 'recording-auto-start', url: 'screenshot-app.html?state=recording&theme=light&motion=reduced&sysaudio=1&origin=auto', width: 1440, height: 900 },
  { name: 'recording-messages', url: 'screenshot-app.html?state=messages&theme=light', width: 880, height: 640 },
  { name: 'recording-processing', url: 'screenshot-app.html?state=recording&theme=light&motion=reduced&sysaudio=1&processing=finalizing', width: 1440, height: 900 },
  { name: 'note-processing', url: 'screenshot-app.html?state=recording&theme=light&motion=reduced&sysaudio=1&processing=note', width: 1440, height: 900 },
  { name: 'library-empty', url: 'screenshot-app.html?state=empty&theme=light', width: 1440, height: 900 },
  { name: 'sidebar-select-mode', url: 'screenshot-app.html?state=note&theme=light&select=3&summarizing=1', width: 1440, height: 900 },
  { name: 'sidebar-filter-menu', url: 'screenshot-app.html?state=note&theme=light&menu=open&summarizing=1', width: 1440, height: 900 },
  { name: 'popup-ask-light', url: 'screenshot-app.html?state=popup&kind=ask&theme=light', width: 486, height: 68 },
  { name: 'popup-started-light', url: 'screenshot-app.html?state=popup&kind=started&theme=light', width: 486, height: 68 },
  { name: 'settings-enlarged-text', url: 'screenshot-app.html?state=settings&theme=light', width: 720, height: 450 },
  { name: 'settings-recording', url: 'screenshot-app.html?state=settings&section=recording&theme=light', width: 1440, height: 900 },
  { name: 'settings-summaries', url: 'screenshot-app.html?state=settings&section=summaries&theme=light', width: 1440, height: 900 },
  { name: 'settings-speakers', url: 'screenshot-app.html?state=settings&section=speakers&theme=light', width: 1440, height: 900 },
  { name: 'settings-models', url: 'screenshot-app.html?state=settings&section=models&downloading=1&theme=light', width: 1440, height: 900 },
  { name: 'settings-models-dark', url: 'screenshot-app.html?state=settings&section=models&theme=dark', width: 1440, height: 900 },
  { name: 'settings-integrations', url: 'screenshot-app.html?state=settings&section=integrations&theme=light', width: 1440, height: 900 },
  { name: 'settings-integrations-vault-missing', url: 'screenshot-app.html?state=settings&section=integrations&vault=missing&theme=light', width: 1440, height: 900 },
  { name: 'settings-storage', url: 'screenshot-app.html?state=settings&section=storage&theme=light', width: 1440, height: 900 },
  { name: 'settings-about', url: 'screenshot-app.html?state=settings&section=about&theme=light', width: 1440, height: 900 },
  { name: 'onboarding', url: 'screenshot-app.html?state=onboarding&theme=light', width: 1440, height: 900 },
  { name: 'onboarding-downloading', url: 'screenshot-app.html?state=onboarding&downloading=1&theme=light', width: 1440, height: 900 },
  { name: 'search-palette', url: 'screenshot-app.html?state=palette&theme=light', width: 1440, height: 900 },
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
    if (only && !only.has(scenario.name)) continue
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
