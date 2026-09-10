# filex slim image, backend only — pure Go, no embedded frontend, no thumbnail
# tools. Build from this directory: `docker build -f Dockerfile .`
# The shipping recipe is ../docker/Dockerfile, which also embeds the UI.
FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
ARG COMMIT=unknown
# Symbol path read from go.mod so a renamed module still gets a version stamped.
RUN MODULE="$(go list -m)" && \
    CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags="-s -w \
        -X ${MODULE}/internal/version.Version=${VERSION} \
        -X ${MODULE}/internal/version.Commit=${COMMIT}" \
    -o /out/filex \
    ./cmd/filex

FROM alpine:3.20
RUN apk --no-cache add ca-certificates tzdata
COPY --from=builder /out/filex /usr/local/bin/filex
EXPOSE 5212
VOLUME ["/data"]
ENV FILEX_DATA_DIR=/data
ENTRYPOINT ["/usr/local/bin/filex"]
CMD ["serve"]
