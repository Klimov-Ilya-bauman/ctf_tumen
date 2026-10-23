FROM bufbuild/buf:1.73.0 AS buf

FROM golang:1.26 AS gen
ENV GOBIN=/usr/local/bin CGO_ENABLED=0
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12 \
 && go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.6.2
COPY --from=buf /usr/local/bin/buf /usr/local/bin/buf
WORKDIR /src
COPY buf.yaml buf.gen.yaml ./
COPY proto ./proto
RUN buf generate

FROM golang:1.26 AS source
ENV GOFLAGS=-buildvcs=false
WORKDIR /src/web
COPY web/go.mod web/go.sum ./
RUN go mod download
COPY web/ ./
COPY proto/testdata /src/proto/testdata
COPY --from=gen /src/web/gen ./gen

FROM source AS test
COPY --from=golangci/golangci-lint:v2.14.0 /usr/bin/golangci-lint /usr/local/bin/golangci-lint
RUN --mount=type=cache,target=/root/.cache/go-build go vet ./pkg/... ./internal/... ./iam/... ./backend/... ./gateway/...
RUN --mount=type=cache,target=/root/.cache/go-build go test -race -count=1 ./internal/... \
 && go test -race -count=1 -coverprofile=/tmp/pkg.cover ./pkg/... \
 && go tool cover -func=/tmp/pkg.cover | awk '/^total:/ { sub("%", "", $3); print "web/pkg coverage " $3 "%"; if ($3 + 0 < 80) exit 1 }'
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/root/.cache/golangci-lint golangci-lint run ./pkg/... ./internal/... ./iam/... ./backend/... ./gateway/...
RUN --mount=type=cache,target=/root/.cache/go-build go test -race -count=1 -coverpkg=./gateway/internal/... -coverprofile=/tmp/gateway.cover ./gateway/... \
 && go tool cover -func=/tmp/gateway.cover | awk '/^total:/ { sub("%", "", $3); print "web/gateway/internal coverage " $3 "%"; if ($3 + 0 < 80) exit 1 }'

FROM source AS build
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/gateway ./gateway/cmd/gateway

FROM gcr.io/distroless/static:nonroot AS runtime
COPY --from=build /out/gateway /usr/local/bin/gateway
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/gateway"]
CMD ["serve"]
