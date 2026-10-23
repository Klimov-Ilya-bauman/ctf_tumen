FROM scratch AS web
COPY build/web /web
COPY build/healthprobe /healthprobe
COPY frontend/dist /app/static
COPY configs/topology /app/config/topology
COPY --chown=65532:65532 data /var/lib/airqso-assets
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/web"]

FROM scratch AS radiod
COPY build/radiod /radiod
COPY build/radioctl /radioctl
COPY --chown=65532:65532 data /var/lib/airqso
USER 65532:65532
EXPOSE 9000 9001
ENTRYPOINT ["/radiod"]

FROM scratch AS migrate
COPY build/migrate /migrate
COPY migrations /app/migrations
USER 65532:65532
ENTRYPOINT ["/migrate"]
