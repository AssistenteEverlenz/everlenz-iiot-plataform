export type NavIconName =
  | 'home'
  | 'panels'
  | 'device'
  | 'users'
  | 'brand'
  | 'mqtt'
  | 'production'
  | 'map'
  | 'edit'
  | 'report'
  | 'pin'
  | 'more';

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
      {name === 'map' && (
        <>
          <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z" />
          <path d="M9 3v15m6-12v15" />
          <circle cx="15" cy="11" r="2.2" fill="currentColor" stroke="none" />
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
      {name === 'production' && (
        <>
          <path d="M4 20V10l5 3V10l5 3V6l6 4v10Z" />
          <path d="M8 17h2m4 0h2" />
        </>
      )}
      {name === 'edit' && (
        <>
          <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z" />
          <path d="m14.5 7.5 2 2" />
        </>
      )}
      {/* Production report: a clipboard with two ticked lines and a plain one. */}
      {name === 'report' && (
        <>
          <rect x="4" y="4" width="16" height="17" rx="2" />
          <path d="M9 2.8h6a1 1 0 0 1 1 1V5H8V3.8a1 1 0 0 1 1-1Z" />
          <path d="m7.5 10.5 1.2 1.2 2-2M7.5 15l1.2 1.2 2-2" />
          <path d="M13.5 10h3m-3 5h3" />
        </>
      )}
      {name === 'pin' && (
        <>
          <path d="M12 21.5s7-6.4 7-11.5a7 7 0 1 0-14 0c0 5.1 7 11.5 7 11.5Z" />
          <circle cx="12" cy="10" r="2.6" />
        </>
      )}
      {name === 'more' && (
        <>
          <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
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
