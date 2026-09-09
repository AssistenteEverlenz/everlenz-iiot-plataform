#!/bin/sh
set -eu

mkdir -p /mosquitto/provision/requests /mosquitto/provision/done
chown -R 1000:1000 /mosquitto/provision
chmod 770 /mosquitto/provision /mosquitto/provision/requests /mosquitto/provision/done

while kill -0 "$1" 2>/dev/null; do
  for request in /mosquitto/provision/requests/*.request; do
    [ -f "$request" ] || continue
    request_id="$(basename "$request" .request)"
    username="$(sed -n '1p' "$request" | base64 -d)"
    password="$(sed -n '2p' "$request" | base64 -d)"
    topic="$(sed -n '3p' "$request" | base64 -d)"
    case "$username" in (*[!a-z0-9-]*|'') mv "$request" "/mosquitto/provision/done/$request_id.error"; continue;; esac
    case "$topic" in (iiot/*/telemetry) ;; (*) mv "$request" "/mosquitto/provision/done/$request_id.error"; continue;; esac
    mosquitto_passwd -b /mosquitto/auth/passwords "$username" "$password"
    {
      echo ""
      echo "# managed-device $username"
      echo "user $username"
      echo "topic write $topic"
    } >> /mosquitto/config/acl
    chown 1883:1883 /mosquitto/auth/passwords /mosquitto/config/acl
    chmod 600 /mosquitto/auth/passwords
    kill -HUP "$1"
    mv "$request" "/mosquitto/provision/done/$request_id.done"
  done
  sleep 1
done
