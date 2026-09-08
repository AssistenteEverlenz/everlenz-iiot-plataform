'use client';
import { useState } from 'react';
import { usePoll, type Device } from '../../components/data';
import { DevicesTable } from '../../components/DevicesTable';
export default function Devices() {
  const [offset, setOffset] = useState(0);
  const { data, error } = usePoll<Device[]>(`/devices?limit=50&offset=${offset}`);
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">ATIVOS INDUSTRIAIS</div>
          <h1>Dispositivos</h1>
          <p>Equipamentos e gateways cadastrados no laboratório.</p>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <section className="card">
        <DevicesTable devices={data} />
        <div className="pager">
          <button disabled={!offset} onClick={() => setOffset(offset - 50)}>
            Anterior
          </button>
          <span>Página {offset / 50 + 1}</span>
          <button disabled={!data || data.length < 50} onClick={() => setOffset(offset + 50)}>
            Próxima
          </button>
        </div>
      </section>
    </>
  );
}
