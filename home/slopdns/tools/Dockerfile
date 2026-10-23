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
WORKDIR /src
COPY web/go.mod web/go.sum web/
COPY tools/go.mod tools/go.su[m] tools/
RUN cd tools && go mod download
COPY web/ web/
COPY tools/ tools/
COPY --from=gen /src/web/gen web/gen
WORKDIR /src/tools

FROM source AS test
COPY --from=golangci/golangci-lint:v2.14.0 /usr/bin/golangci-lint /usr/local/bin/golangci-lint
RUN --mount=type=cache,target=/root/.cache/go-build go vet ./...
RUN --mount=type=cache,target=/root/.cache/go-build go test -race -count=1 -cover ./...
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/root/.cache/golangci-lint golangci-lint run ./...

FROM source AS build
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pkigen ./pkigen \
 && mkdir -p /out/pki

FROM gcr.io/distroless/static:nonroot AS pkigen
COPY --from=build /out/pkigen /usr/local/bin/pkigen
COPY --from=build --chown=65532:65532 /out/pki /pki
USER 65532:65532
ENV PKI_DIR=/pki
ENTRYPOINT ["/usr/local/bin/pkigen"]
