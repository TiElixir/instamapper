import { useEffect, useState } from 'react'

function readStoredTheme(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const stored = window.localStorage?.getItem('instarl-dark')
    if (stored !== null && stored !== undefined) return stored === 'true'
  } catch {
    // Storage may be unavailable in sandboxed/test environments.
  }
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

export function useDarkMode() {
  const [dark, setDark] = useState(readStoredTheme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try {
      window.localStorage?.setItem('instarl-dark', String(dark))
    } catch {
      // Ignore unavailable storage; the in-memory preference still works.
    }
  }, [dark])

  return [dark, setDark] as const
}
