/**
 * [Open-Box Patch] 取自 zashboard `src/helper/theme.ts`。
 *
 * 面板用 daisyUI，主题切换会写 `color-scheme`；直接读它即可与面板外观同步。
 */
export type ThemeColorScheme = 'dark' | 'light'

export const readColorScheme = (): ThemeColorScheme => {
  const value = getComputedStyle(document.documentElement).getPropertyValue('color-scheme').trim()

  return value.split(/\s+/).includes('dark') ? 'dark' : 'light'
}

/** 主题变化回调（daisyUI 切主题会改 <html data-theme> 与 color-scheme） */
export const watchColorScheme = (onChange: (scheme: ThemeColorScheme) => void) => {
  let current = readColorScheme()
  const observer = new MutationObserver(() => {
    const next = readColorScheme()
    if (next === current) return
    current = next
    onChange(next)
  })

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class', 'style'],
  })

  return () => observer.disconnect()
}
