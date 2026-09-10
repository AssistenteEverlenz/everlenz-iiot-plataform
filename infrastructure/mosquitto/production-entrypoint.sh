#!/bin/sh
set -eu
mkdir -p /mosquitto/config /mosquitto/data /mosquitto/log
# The upstream image can pre-populate a fresh volume with its demo config. On the
# first managed startup, preserve that file and install the authenticated config.
# The marker keeps later operator changes intact across redeployments.
if [ ! -f /mosquitto/config/.everlenz-managed-v1 ]; then
  if [ -f /mosquitto/config/mosquitto.conf ]; then
    cp /mosquitto/config/mosquitto.conf /mosquitto/config/mosquitto.conf.pre-everlenz
  fi
  cp /defaults/mosquitto.conf /mosquitto/config/mosquitto.conf
  cp /defaults/acl /mosquitto/config/acl
  touch /mosquitto/config/.everlenz-managed-v1
fi
# Existing volumes keep their ACL (devices are appended to it at runtime), so rules added to
# the default ACL later are appended here once. The leading blank line keeps the
# provisioner's delete step, which skips the line after a device block, off these rules.
if ! grep -q '^user commander$' /mosquitto/config/acl; then
  cat >> /mosquitto/config/acl <<'ACL'

# Platform commands ("Zerar contador" on the PLC): the API may only publish on command topics.
user commander
topic write iiot/+/+/+/command

# Each device may read only the command topic named after its own MQTT user.
pattern read iiot/+/+/%u/command
ACL
fi
/bin/sh /init/init.sh
test -s /mosquitto/certs/fullchain.pem && test -s /mosquitto/certs/privkey.pem || {
  echo 'service=mosquitto event=tls_files_missing' >&2; exit 1;
}
chown -R 1883:1883 /mosquitto/config /mosquitto/data /mosquitto/log
echo 'service=mosquitto event=broker_starting'
mosquitto -c /mosquitto/config/mosquitto.conf &
broker_pid=$!
trap 'kill -TERM "$broker_pid" 2>/dev/null || true' TERM INT
/bin/sh /init/provision-watcher.sh "$broker_pid" &
wait "$broker_pid"
