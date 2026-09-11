#!/bin/sh
set -eu
# The certificate is the one Mosquitto uses, provisioned on the host by sync-traefik-cert.py.
until [ -s /certs/fullchain.pem ] && [ -s /certs/privkey.pem ]; do
  echo 'service=mqtt-legacy event=waiting_for_certificate'
  sleep 10
done
# The certificate sync only signals the mosquitto container. Let's Encrypt renews weeks before
# expiry, so reloading twice a day picks up the new certificate well in time.
( while sleep 43200; do nginx -s reload || true; done ) &
echo 'service=mqtt-legacy event=proxy_starting port=8884'
exec nginx -g 'daemon off;'
