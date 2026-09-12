'use client'

// Theme application — one place decides how a theme id lands on the
// document. data-sd-theme drives the CSS variable sets in globals.css;
// the tailwind `dark` class follows the same decision so `dark:` variants
// never fight a light theme. Midnight (dark) is the SSR default, so the
// html element ships class="dark" and this module keeps it in sync.

export const THEME_IDS = ['midnight', 'carbon', 'phosphor', 'amber', 'paper', 'arctic'] as const

const LIGHT_THEMES = new Set<string>(['paper', 'arctic'])

export function applySdTheme(theme: string): void {
  document.documentElement.dataset.sdTheme = theme
  document.documentElement.classList.toggle('dark', !LIGHT_THEMES.has(theme))
}
