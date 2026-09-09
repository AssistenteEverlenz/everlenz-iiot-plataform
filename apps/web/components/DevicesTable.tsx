'use client';
import { type Device, time } from './data';
export function DevicesTable({
  devices,
  onSelect,
}: {
  devices: Device[] | null;
  onSelect?: (device: Device) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>DISPOSITIVO</th>
            <th>FABRICANTE / MODELO</th>
            <th>ESTADO</th>
            <th>ÚLTIMA COMUNICAÇÃO</th>
            {onSelect && <th>AÇÕES</th>}
          </tr>
        </thead>
        <tbody>
          {devices?.map((d) => (
            <tr key={d.id}>
              <td>
                {onSelect ? (
                  <button className="device-link table-link-button" onClick={() => onSelect(d)}>
                    {d.name}
                  </button>
                ) : (
                  <strong>{d.name}</strong>
                )}
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
              {onSelect && (
                <td>
                  <button
                    className="icon-button"
                    title="Ver e editar equipamento"
                    onClick={() => onSelect(d)}
                  >
                    ✎
                  </button>
                </td>
              )}
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
