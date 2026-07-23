# ---- frontend build ----
FROM node:24-alpine AS frontend
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---- backend build ----
FROM golang:1.22-alpine AS backend
WORKDIR /app
COPY go.mod go.sum* ./
COPY . .
COPY --from=frontend /app/web/dist ./web/dist
RUN go mod tidy && CGO_ENABLED=0 go build -o /out/palcon ./cmd/palcon

# ---- runtime ----
FROM alpine:3.20
# python3 + palworld-save-tools power the phase 5 Pal viewer (reading
# Level.sav). pyooz unwraps the newer Oodle-compressed ("PlM") save
# container that palworld-save-tools doesn't handle yet; it ships prebuilt
# musllinux abi3 wheels, so no compiler is needed here, and the published
# wheel is decompress-only — it structurally cannot write a save.
# --break-system-packages is fine: this image has no other Python consumers.
RUN apk add --no-cache python3 py3-pip \
    && pip install --no-cache-dir --break-system-packages \
        palworld-save-tools==0.24.0 \
        pyooz==0.0.8
RUN adduser -D -u 1000 palcon
WORKDIR /app
COPY --from=backend /out/palcon ./palcon
RUN mkdir -p /data && chown palcon:palcon /data
USER palcon
# The app otherwise defaults to ./data, which this non-root user can't
# create — so an image run without DATA_DIR set died with a confusing
# "permission denied" despite /data existing and being owned correctly.
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["./palcon"]
