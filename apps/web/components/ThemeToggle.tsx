'use client';

import { useEffect, useState } from 'react';

// Light or dark, remembered per browser. The choice is applied before the first paint by the
// script in app/layout.tsx, so this button only reads it back and flips it.
export const THEME_KEY = 'everlenz-theme';
type Theme = 'light' | 'dark';

export function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode: the theme still switches, it just is not remembered.
    }
    setTheme(next);
  }

  const label = theme === 'dark' ? 'Tema claro' : 'Tema escuro';
  return (
    <button
      type="button"
      className={`theme-toggle${withLabel ? ' with-label' : ''}`}
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      {withLabel && <span>{label}</span>}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </svg>
  );
}
