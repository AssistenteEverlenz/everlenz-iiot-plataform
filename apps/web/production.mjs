// Next's server stays in this PID and receives SIGTERM directly.
console.log(
  JSON.stringify({
    service: 'web',
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'web_starting',
  }),
);
await import('./apps/web/server.js');
