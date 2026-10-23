ARG DEBIAN_MIRROR=http://mirror.yandex.ru

FROM debian:trixie-slim AS runtime
ARG DEBIAN_MIRROR
RUN sed -i "s#http://deb.debian.org#${DEBIAN_MIRROR}#g" /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libgrpc++1.51t64 libprotobuf32t64 libssl3t64 \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 dns-server/dns-server /usr/local/bin/dns-server
USER 65532:65532
EXPOSE 53/udp 53/tcp 8080/tcp
ENTRYPOINT ["/usr/local/bin/dns-server"]
CMD ["serve"]
