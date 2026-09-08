#!/bin/sh
set -eu
mkdir -p /mosquitto/config /mosquitto/data /mosquitto/log
# Initialize once. Deployed config/ACL survive redeploy; upgrades are deliberate.
for file in mosquitto.conf acl; do
  if [ ! -f "/mosquitto/config/$file" ]; then cp "/defaults/$file" "/mosquitto/config/$file"; fi
done
/bin/sh /init/init.sh
test -s /mosquitto/certs/fullchain.pem && test -s /mosquitto/certs/privkey.pem || {
  echo 'service=mosquitto event=tls_files_missing' >&2; exit 1;
}
chown -R 1883:1883 /mosquitto/config /mosquitto/data /mosquitto/log
echo 'service=mosquitto event=broker_starting'
exec mosquitto -c /mosquitto/config/mosquitto.conf
