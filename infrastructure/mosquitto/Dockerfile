FROM eclipse-mosquitto:2
COPY infrastructure/mosquitto/init.sh /init/init.sh
COPY infrastructure/mosquitto/production-entrypoint.sh /init/production-entrypoint.sh
COPY infrastructure/mosquitto/provision-watcher.sh /init/provision-watcher.sh
COPY infrastructure/mosquitto/config/mosquitto-tls.conf /defaults/mosquitto.conf
COPY infrastructure/mosquitto/config/acl /defaults/acl
ENTRYPOINT ["/bin/sh","/init/production-entrypoint.sh"]
