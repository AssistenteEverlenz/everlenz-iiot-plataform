#!/bin/sh
set -eu
umask 077
# ACL below uses these service names; reject drift instead of silently denying data.
test "$MQTT_USERNAME" = ingestor || { echo 'MQTT_USERNAME must be ingestor; update ACL before changing it'; exit 1; }
test "$MQTT_SIMULATOR_USERNAME" = simulator || { echo 'MQTT_SIMULATOR_USERNAME must be simulator; update ACL before changing it'; exit 1; }
test "$MQTT_DEVICE_A7_USERNAME" = a7-001 || { echo 'MQTT_DEVICE_A7_USERNAME must be a7-001; update ACL before changing it'; exit 1; }
test "$MQTT_PASSWORD" != CHANGE_ME && test -n "$MQTT_PASSWORD"
test "$MQTT_SIMULATOR_PASSWORD" != CHANGE_ME && test -n "$MQTT_SIMULATOR_PASSWORD"
test "$MQTT_DEVICE_A7_PASSWORD" != CHANGE_ME && test -n "$MQTT_DEVICE_A7_PASSWORD"
mkdir -p /mosquitto/auth
if [ ! -f /mosquitto/auth/passwords ]; then
  mosquitto_passwd -b -c /mosquitto/auth/passwords "$MQTT_USERNAME" "$MQTT_PASSWORD"
else
  mosquitto_passwd -b /mosquitto/auth/passwords "$MQTT_USERNAME" "$MQTT_PASSWORD"
fi
mosquitto_passwd -b /mosquitto/auth/passwords "$MQTT_SIMULATOR_USERNAME" "$MQTT_SIMULATOR_PASSWORD"
mosquitto_passwd -b /mosquitto/auth/passwords "$MQTT_DEVICE_A7_USERNAME" "$MQTT_DEVICE_A7_PASSWORD"
# Optional: the API's command user exists only when its password is configured.
if [ -n "${MQTT_COMMAND_PASSWORD:-}" ]; then
  test "${MQTT_COMMAND_USERNAME:-commander}" = commander || { echo 'MQTT_COMMAND_USERNAME must be commander; update ACL before changing it'; exit 1; }
  test "$MQTT_COMMAND_PASSWORD" != CHANGE_ME
  mosquitto_passwd -b /mosquitto/auth/passwords commander "$MQTT_COMMAND_PASSWORD"
fi
chown -R 0:1883 /mosquitto/auth
chmod 750 /mosquitto/auth
chmod 640 /mosquitto/auth/passwords
