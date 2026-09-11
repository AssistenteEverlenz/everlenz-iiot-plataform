#!/bin/sh
set -eu
# Certificate for port 8884. Legacy HMI TLS stacks choke on the Let's Encrypt chain (RSA 4096,
# cross-signed roots), so a dedicated, simple certificate can be supplied through Coolify
# secrets (base64 PEM): MQTT_LEGACY_CERT_B64 (server + CA) and MQTT_LEGACY_KEY_B64. Without them
# the broker's Let's Encrypt certificate, provisioned on the host, is used.
mkdir -p /run/mqtt-legacy
install_certs() {
  if [ -n "${MQTT_LEGACY_CERT_B64:-}" ] && [ -n "${MQTT_LEGACY_KEY_B64:-}" ]; then
    printf '%s' "$MQTT_LEGACY_CERT_B64" | base64 -d > /run/mqtt-legacy/fullchain.pem
    printf '%s' "$MQTT_LEGACY_KEY_B64" | base64 -d > /run/mqtt-legacy/privkey.pem
    echo 'service=mqtt-legacy event=certificate source=dedicated'
  else
    until [ -s /certs/fullchain.pem ] && [ -s /certs/privkey.pem ]; do
      echo 'service=mqtt-legacy event=waiting_for_certificate'
      sleep 10
    done
    cp /certs/fullchain.pem /run/mqtt-legacy/fullchain.pem
    cp /certs/privkey.pem /run/mqtt-legacy/privkey.pem
    echo 'service=mqtt-legacy event=certificate source=letsencrypt'
  fi
  chmod 600 /run/mqtt-legacy/privkey.pem
}
install_certs
# Refuse to start on a broken configuration instead of restarting in a loop: the error is
# printed once and the container stays down (restart policy on-failure with a low limit).
nginx -t
# The Let's Encrypt certificate is renewed weeks before expiry; reloading twice a day picks up
# the new one in time. A dedicated certificate is simply reinstalled unchanged.
( while sleep 43200; do install_certs && nginx -s reload || true; done ) &
echo 'service=mqtt-legacy event=proxy_starting port=8884'
exec nginx -g 'daemon off;'
