export function ingestionHealth(state: {
  mqtt: boolean;
  subscribed: boolean;
  database: boolean;
  stopping: boolean;
  storageFailure: boolean;
}) {
  const ready =
    state.mqtt && state.subscribed && state.database && !state.stopping && !state.storageFailure;
  return {
    status: ready ? 'ok' : 'degraded',
    live: !state.stopping,
    ready,
    broker: state.mqtt,
    mqtt: state.mqtt,
    database: state.database,
    subscribed: state.subscribed,
  };
}
