FROM nginx:1.27-alpine
COPY infrastructure/mqtt-legacy/nginx.conf /etc/nginx/nginx.conf
COPY infrastructure/mqtt-legacy/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/sh","/entrypoint.sh"]
