export type NavIconName = 'home' | 'panels' | 'device' | 'users' | 'brand' | 'mqtt';

export function NavIcon({ name }: { name: NavIconName }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" {...common}>
      {name === 'home' && (
        <>
          <path d="M4 10.5 12 4l8 6.5V20H4Z" />
          <path d="M9 20v-6h6v6" />
        </>
      )}
      {name === 'panels' && (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M7 16v-3m5 3V8m5 8v-6" />
        </>
      )}
      {name === 'device' && (
        <>
          <rect x="3" y="4" width="18" height="14" rx="2" />
          <path d="M8 21h8m-4-3v3M7 8h10" />
        </>
      )}
      {name === 'users' && (
        <>
          <path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
          <circle cx="9.5" cy="7" r="4" />
          <path d="M17 11a3 3 0 1 0 0-6m4 15v-2a4 4 0 0 0-3-3.7" />
        </>
      )}
      {name === 'brand' && (
        <>
          <path d="M12 3a9 9 0 1 0 0 18h1.4a1.6 1.6 0 0 0 0-3.2h-.8a1.7 1.7 0 0 1 0-3.4H15A6 6 0 0 0 12 3Z" />
          <circle cx="7.5" cy="10" r=".8" fill="currentColor" />
          <circle cx="10" cy="6.8" r=".8" fill="currentColor" />
          <circle cx="14" cy="7" r=".8" fill="currentColor" />
        </>
      )}
      {name === 'mqtt' && (
        <>
          <path d="M5 19a10 10 0 0 1 10-10m-10 5a5 5 0 0 1 5-5" />
          <circle cx="5" cy="19" r="1.5" fill="currentColor" />
          <path d="M5 5a14 14 0 0 1 14 14" />
        </>
      )}
    </svg>
  );
}
