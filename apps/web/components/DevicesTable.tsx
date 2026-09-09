'use client';
import Link from 'next/link';
import { type Device, time } from './data';
export function DevicesTable({ devices }: { devices: Device[] | null }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>DISPOSITIVO</th>
            <th>FABRICANTE / MODELO</th>
            <th>ESTADO</th>
            <th>ÚLTIMA COMUNICAÇÃO</th>
          </tr>
        </thead>
        <tbody>
          {devices?.map((d) => (
            <tr key={d.id}>
              <td>
                <Link className="device-link" href={`/devices/${d.id}`}>
                  {d.name} ↗
                </Link>
                <div className="subline">
                  <span className="code-chip">{d.device_code}</span> · {d.adapter_type}
                </div>
              </td>
              <td>
                {d.manufacturer} / {d.model}
              </td>
              <td>
                <span className={`badge ${d.online ? '' : 'offline'}`}>
                  {d.online ? 'Online' : 'Offline'}
                </span>
              </td>
              <td>{time(d.last_message_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!devices?.length && (
        <div className="empty">
          {devices ? 'Nenhum dispositivo cadastrado.' : 'Carregando dispositivos…'}
        </div>
      )}
    </div>
  );
}
