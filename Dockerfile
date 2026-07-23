# ---- frontend build ----
FROM node:20-alpine AS frontend
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
RUN adduser -D -u 1000 palcon
WORKDIR /app
COPY --from=backend /out/palcon ./palcon
RUN mkdir -p /data && chown palcon:palcon /data
USER palcon
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["./palcon"]
