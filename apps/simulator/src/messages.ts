export function simulatedMessage(
  mode: 'haiwell' | 'generic',
  step: number,
  timestamp = new Date().toISOString(),
) {
  const values = {
    temperatura: Number((70 + 10 * Math.sin(step / 8)).toFixed(2)),
    corrente_motor: Number((375 + 75 * Math.sin(step / 6)).toFixed(2)),
    velocidade: Number((42.5 + 7.5 * Math.sin(step / 10)).toFixed(2)),
    status: step % 10 < 8,
  };
  return mode === 'haiwell'
    ? {
        topic: 'data/POC/group1/A7-001',
        payload: JSON.stringify({
          _terminalTime: timestamp,
          _groupName: 'group1',
          ...Object.fromEntries(
            Object.entries(values).map(([k, v]) => [
              k,
              typeof v === 'boolean' ? (v ? '1' : '0') : String(v),
            ]),
          ),
        }),
      }
    : {
        topic: 'iiot/poc/laboratorio/generic-001/telemetry',
        payload: JSON.stringify({ timestamp, values }),
      };
}
