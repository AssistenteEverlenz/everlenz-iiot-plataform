import './globals.css';
import { PlatformShell } from '../components/PlatformShell';

export const metadata = {
  title: 'Everlenz • IIoT',
  description: 'Monitoramento industrial MQTT',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <PlatformShell>{children}</PlatformShell>
      </body>
    </html>
  );
}
