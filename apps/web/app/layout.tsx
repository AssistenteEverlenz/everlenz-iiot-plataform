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
            POC INDUSTRIAL <small>Laboratório · operação conectada</small>
          </div>
          <nav>
            <Link href="/">◫ &nbsp; Centro de comando</Link>
            <Link href="/dashboards">▦ &nbsp; Painéis</Link>
            <Link href="/devices">▤ &nbsp; Dispositivos</Link>
            <Link href="/integrations">⇄ &nbsp; Integrações</Link>
            <Link href="/mqtt-inspector">⌁ &nbsp; MQTT Inspector</Link>
          </nav>
          <div className="aside-foot">
            <span className="dot" /> Operação conectada
            <small>MQTT TLS · Supabase · Haiwell</small>
          </div>
        </aside>
        <main>
          <header>
            <span>PLATAFORMA IIoT</span>
            <span className="pill">INDUSTRIAL CLOUD</span>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
