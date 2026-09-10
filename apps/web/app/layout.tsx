import './globals.css';
import './theme-dark.css';
import './theme-dark-overrides.css';
import { PlatformShell } from '../components/PlatformShell';

export const metadata = {
  title: 'Everlenz • IIoT',
  description: 'Monitoramento industrial MQTT',
};

// Applies the saved theme before the first paint, so a dark-theme user never sees a flash of
// the light page. Kept in step with THEME_KEY in components/ThemeToggle.tsx.
const themeScript =
  "try{if(localStorage.getItem('everlenz-theme')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <PlatformShell>{children}</PlatformShell>
      </body>
    </html>
  );
}
