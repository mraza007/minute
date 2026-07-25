// Forces a specific theme for the screenshot harness, independent of
// whatever `prefers-color-scheme` the machine actually running headless
// Chrome happens to report. The app themes purely via `@media
// (prefers-color-scheme: dark)` in src/index.css (see that file) — there's
// no JS theme toggle to call, and relying on the operator's own OS
// appearance setting would make captures non-deterministic (this is exactly
// what broke the first `?state=note` capture: it rendered dark because the
// capturing machine's Chrome profile was in dark mode).
//
// Instead: walk every loaded stylesheet, find the relevant `:root` rule
// (the plain one for light, the one nested in the dark `@media` block for
// dark), and re-inject its declarations as a plain unconditional `<style>`
// appended at the end of `<head>`. Appended last, at equal specificity, it
// always wins the cascade over whichever `:root` rule the browser's actual
// media-query evaluation would otherwise have picked — so this mirrors the
// real tokens exactly (see index.css's `--canvas`/`--accent`/etc. ramps)
// rather than a hand-copied, driftable duplicate of them, and produces the
// same output regardless of the host machine's own appearance setting.
export function applyThemeOverride(theme: 'light' | 'dark'): void {
  const ruleText: string[] = []

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // cross-origin sheet — never the case for our own bundled CSS, but skip defensively
    }
    for (const rule of Array.from(rules)) {
      if (theme === 'dark' && rule instanceof CSSMediaRule && /prefers-color-scheme:\s*dark/.test(rule.conditionText ?? rule.media.mediaText)) {
        for (const inner of Array.from(rule.cssRules)) ruleText.push(inner.cssText)
      } else if (theme === 'light' && rule instanceof CSSStyleRule && rule.selectorText === ':root') {
        // The plain, non-media-qualified `:root` rule — index.css's light
        // (default) token declarations.
        ruleText.push(rule.cssText)
      }
    }
  }

  if (ruleText.length === 0) return

  const style = document.createElement('style')
  style.setAttribute('data-screenshot-theme-override', theme)
  style.textContent = ruleText.join('\n')
  document.head.appendChild(style)
  document.documentElement.style.colorScheme = theme
}
