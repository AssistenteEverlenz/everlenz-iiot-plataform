import Link from 'next/link';
import './globals.css';
export const metadata = { title: 'Everlenz • IIoT', description: 'Monitoramento industrial MQTT' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <aside>
          <Link className="brand" href="/">
            everlenz<span>INDUSTRIAL INTELLIGENCE</span>
          </Link>
          <div className="workspace">
            POC INDUSTRIAL <small>Laboratório · ambiente local</small>
          </div>
          <nav>
            <Link href="/">◫ &nbsp; Visão geral</Link>
            <Link href="/devices">▤ &nbsp; Dispositivos</Link>
            <Link href="/mqtt-inspector">⌁ &nbsp; MQTT Inspector</Link>
          </nav>
          <div className="aside-foot">
            <span className="dot" /> Monitoramento / leitura
            <small>MQTT · PostgreSQL · Haiwell A7</small>
          </div>
        </aside>
        <main>
          <header>
            <span>PLATAFORMA IIoT</span>
            <span className="pill">DESENVOLVIMENTO LOCAL</span>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
