# Go conventions and syntax, via this codebase

A working reference for Go, using palcon's own code as examples. Every section links to the real file/line it's drawn from.

## 1. Packages and directories

In Go, **one directory = one package**. There's no per-file import list to maintain like JS's module graph — every `.go` file in a directory shares the same package namespace automatically.

- [internal/store/store.go](../internal/store/store.go), [internal/store/servers.go](../internal/store/servers.go), and [internal/store/users.go](../internal/store/users.go) are three files, one package (`store`). They freely reference each other's types with no imports between them.
- `internal/` is a special directory name the Go toolchain enforces: anything under `internal/` can only be imported by code inside the parent of that `internal/` directory (here, anything under the module root). Other modules importing yours as a dependency couldn't reach `internal/palworld` even if they wanted to. It's Go's built-in way of marking "not part of the public API."

## 2. Import paths and the module system

Covered in depth earlier in this conversation, briefly: [go.mod:1](../go.mod#L1) declares `module github.com/safwyls/palcon`, and every subdirectory is importable by appending its path, e.g. [cmd/palcon/main.go:15-20](../cmd/palcon/main.go#L15-L20):

```go
import (
	"github.com/safwyls/palcon/internal/api"
	"github.com/safwyls/palcon/internal/config"
	...
)
```

Import blocks are conventionally grouped and blank-line-separated: standard library first, then third-party, then your own module — see [internal/api/server.go:6-15](../internal/api/server.go#L6-L15) for all three groups in one place. `gofmt`/`goimports` sorts and groups these automatically; you rarely hand-format an import block.

## 3. Exported vs. unexported — capitalization is the access modifier

Go has no `public`/`private` keywords. **Capitalized identifiers are exported** (visible outside the package); **lowercase ones are package-private**. This applies to types, functions, struct fields, and constants alike.

- [internal/api/server.go:17-21](../internal/api/server.go#L17-L21): the `Server` type is exported (other packages construct it), but its fields (`store`, `jwtSecret`, `logger`) are all lowercase — callers outside `api` can hold a `*Server` but can't reach into its internals.
- [internal/store/servers.go:16-25](../internal/store/servers.go#L16-L25): `Server` (the store's own type, unrelated to `api.Server`) has all-exported fields like `Name`, `Host`, `RCONPassword` — because `api` needs to read/write them directly.
- Struct tags don't change this — [internal/api/servers.go:16-26](../internal/api/servers.go#L16-L26)'s `serverDTO` has exported Go fields (`ID`, `Name`) with lowercase JSON keys (`"id"`, `"name"`) via tags. The tag only controls the *JSON* shape, not Go visibility.

This is why you'll see two `Server` types in this codebase ([api.Server](../internal/api/server.go#L17) and [store.Server](../internal/store/servers.go#L16)) — same name, different packages, no collision, because you always reference them qualified (`store.Server`) from outside their own package.

## 4. Methods and receivers

A "method" in Go is just a function with a receiver argument before its name. There's no `class` keyword — you attach methods to any named type.

```go
func (s *Store) GetServer(ctx context.Context, id int64) (*Server, error) {
```
— [internal/store/servers.go:91](../internal/store/servers.go#L91)

- `(s *Store)` is the **receiver**. `s` is just a variable name (by convention, a short abbreviation of the type — `s` for `Store`/`Server`, `c` for `Client`, `b` for `Box`).
- **Pointer receiver** (`*Store`) vs **value receiver** (`Store`, no star): pointer receivers can mutate the underlying value and avoid copying; value receivers get their own copy. The convention in this codebase (and most Go code) is: use a pointer receiver if *any* method on the type needs one, for consistency. Every method here uses pointer receivers — [RCONClient](../internal/palworld/rcon.go#L20), [Store](../internal/store/store.go#L11), [Server](../internal/api/server.go#L17), [Box](../internal/crypto/secretbox.go#L15) — all called as `c.exec(...)`, `s.store.GetServer(...)`, etc.

## 5. Interfaces are satisfied implicitly

No `implements` keyword. A type satisfies an interface just by having the right methods — this is Go's version of duck typing, checked at compile time.

[internal/palworld/client.go:29-38](../internal/palworld/client.go#L29-L38) defines:
```go
type Client interface {
	Info(ctx context.Context) (*ServerInfo, error)
	Players(ctx context.Context) ([]Player, error)
	...
}
```
Nothing in [rest.go](../internal/palworld/rest.go), [rcon.go](../internal/palworld/rcon.go), or [fallback.go](../internal/palworld/fallback.go) says "`RESTClient` implements `Client`" anywhere. It just does, because `*RESTClient`, `*RCONClient`, and `*fallbackClient` each happen to have all six methods with matching signatures. [client.go:55](../internal/palworld/client.go#L55)'s `New()` function returns the plain `Client` interface type, and callers (like [internal/api/actions.go](../internal/api/actions.go)) never know or care which concrete type they got.

This is the idiomatic Go way to get polymorphism/swappable implementations — define the interface at the *consumer* side (small, just what's needed), not attached to the implementation.

## 6. Error handling — no exceptions

Go has no `try`/`catch`. Functions that can fail return an `error` as their last return value, and the caller checks it immediately:

```go
sqlDB, err := db.Open(cfg.DBPath())
if err != nil {
	return err
}
```
— [cmd/palcon/main.go:35-38](../cmd/palcon/main.go#L35-L38)

This `if err != nil { ... }` block appears constantly — it's not boilerplate to minimize, it's the idiom. A few refinements you'll see throughout:

- **Wrapping errors for context**, keeping the original inspectable via `%w`:
  ```go
  return fmt.Errorf("rcon dial %s: %w", c.addr, err)
  ```
  — [internal/palworld/rcon.go:45](../internal/palworld/rcon.go#L45). This is why the error you saw during smoke-testing read `"rcon dial 127.0.0.1:25575: dial tcp ...: connection refused"` — each layer added its own context and wrapped the one below it.
- **Sentinel errors** — plain values you compare against directly, for expected/known failure cases:
  ```go
  var ErrNotFound = errors.New("not found")
  ```
  — [internal/store/servers.go:10](../internal/store/servers.go#L10), checked with `if err == store.ErrNotFound` in [internal/api/servers.go:77](../internal/api/servers.go#L77). (The standard library's stricter idiom is `errors.Is(err, store.ErrNotFound)`, which also matches wrapped errors — `==` only works here because this error is never wrapped before comparison. Worth switching to `errors.Is` if you start wrapping it later.)

## 7. Multiple return values, and the "comma-ok" idiom

Any function can return more than one value — no tuple/object wrapping needed. `value, err` is the most common pair, but the same shape shows up for other "did this work?" checks:

```go
v, ok := ctx.Value(usernameContextKey).(string)
```
— [internal/api/middleware.go:16](../internal/api/middleware.go#L16)

That's a **type assertion** (`x.(string)`) combined with comma-ok: instead of panicking if the value isn't actually a `string`, the two-value form gives you `ok = false` and a zero value. You'll also see this pattern with map lookups (`v, ok := myMap[key]`) and channel receives (`v, ok := <-ch`) elsewhere in Go, though not in this codebase yet.

## 8. `context.Context` — threaded through everything

`context.Context` carries cancellation signals, deadlines, and small request-scoped values through a call chain. Convention: it's always the **first parameter**, always named `ctx`.

- [cmd/palcon/main.go:49](../cmd/palcon/main.go#L49): `signal.NotifyContext` builds a context that cancels when the process receives SIGINT/SIGTERM.
- Every store method takes one: [internal/store/servers.go:69](../internal/store/servers.go#L69) `ListServers(ctx context.Context, ...)`, and passes it straight through to the underlying `sql.DB` calls, so a cancelled request stops the SQL query too.
- [internal/api/middleware.go:34](../internal/api/middleware.go#L34) shows the other use — attaching a value to the context (`context.WithValue`) so a downstream handler can read it back (`usernameFromContext` in the same file), without changing every function signature in between to pass `username` explicitly.

## 9. Struct embedding

Putting a type inside another struct with no field name "embeds" it — the outer struct promotes the inner type's fields/methods as if they were its own:

```go
type sessionClaims struct {
	Username string `json:"username"`
	jwt.RegisteredClaims
}
```
— [internal/api/auth.go:18-21](../internal/api/auth.go#L18-L21)

`sessionClaims` gets all of `jwt.RegisteredClaims`'s fields (`ExpiresAt`, `IssuedAt`, etc.) directly accessible, and — importantly — satisfies the `jwt.Claims` interface that `RegisteredClaims` already satisfies, without `sessionClaims` needing to implement it itself. This is Go's substitute for inheritance: composition, not subclassing.

## 10. Goroutines and channels

`go` before a function call runs it concurrently, returning immediately. A `chan` is a typed pipe for passing values between goroutines.

```go
errCh := make(chan error, 1)
go func() {
	logger.Info("listening", "addr", cfg.HTTPAddr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		errCh <- err
	}
}()

select {
case <-ctx.Done():
	...
case err := <-errCh:
	return err
}
```
— [cmd/palcon/main.go:69-83](../cmd/palcon/main.go#L69-L83)

The server runs in a background goroutine; the main goroutine blocks on `select`, waking up on *whichever comes first* — a shutdown signal (`ctx.Done()`) or the server dying on its own (`errCh`). This pattern (goroutine + buffered error channel + `select`) is the standard way to run something in the background while still being able to react to its failure.

## 11. `defer`

`defer` schedules a call to run when the *enclosing function* returns, regardless of which return path is taken (early return, panic, or falling off the end). Universally used for cleanup:

- [cmd/palcon/main.go:42](../cmd/palcon/main.go#L42): `defer sqlDB.Close()` — the DB connection closes no matter how `run()` exits.
- [internal/store/servers.go:74](../internal/store/servers.go#L74): `defer rows.Close()` right after a successful query — a very common Go idiom, deferring the close immediately next to the open/acquire, so it's never forgotten in a later edit.
- [internal/palworld/rcon.go:47](../internal/palworld/rcon.go#L47): `defer conn.Close()` on a raw TCP connection.

Rule of thumb: whenever you acquire something that needs releasing (file handle, DB rows, network conn, mutex lock), `defer` the release on the very next line.

## 12. Naming conventions

- **MixedCaps, not snake_case** — `RCONPort`, `handleListServers`, never `rcon_port` in Go identifiers (only in JSON tags or SQL column names, which are a different naming domain — compare [internal/store/servers.go:20](../internal/store/servers.go#L20) `RCONPort int` to its SQL column `rcon_port` in [internal/db/migrations/0001_init.sql](../internal/db/migrations/0001_init.sql)).
- **Acronyms stay fully capitalized**: `RCONPort` not `RconPort`, `HTTPAddr` not `HttpAddr`, `JWTSecret` not `JwtSecret` — see [internal/config/config.go](../internal/config/config.go).
- **Short names in short scopes**: `s` for a receiver, `r`/`w` for an HTTP request/response writer, `err`, `ctx` — these are so standard that spelling them out (`request`, `response`, `error1`) would look *unidiomatic*, not clearer. Longer, descriptive names are reserved for package-level exported identifiers and anything with a wide scope.

## 13. Constructors are a convention, not a language feature

There's no `constructor` keyword. The convention is a plain function named `New` (or `NewThing` if a package has several constructible types), returning the type — see [internal/store/store.go:16](../internal/store/store.go#L16) `func New(db *sql.DB, box *crypto.Box) *Store`, [internal/crypto/secretbox.go:19](../internal/crypto/secretbox.go#L19) `func New(key []byte) (*Box, error)`, [internal/palworld/client.go:55](../internal/palworld/client.go#L55) `func New(cfg Config) Client`.

Structs are also usable directly via zero values or struct literals with no constructor at all when there's nothing to validate — e.g. [internal/palworld/rest.go:15-19](../internal/palworld/rest.go#L15-L19)'s `RESTClient{baseURL: ..., password: ...}` literal in [client.go:63-66](../internal/palworld/client.go#L63-L66), no `NewRESTClient` needed.

## 14. `go build`, `go vet`, `gofmt` — the toolchain does the nagging

- `gofmt` (or `goimports`) reformats code to Go's one canonical style — indentation, brace placement, import grouping — so style arguments mostly don't happen in Go codebases. Most editors run it on save.
- `go vet ./...` catches suspicious-but-compiling code (format-string/argument mismatches, unreachable code, etc.) — cheap to run before every commit.
- `go build ./...` compiles every package in the module without producing a binary for each — good fast sanity check.

We ran all three against this repo already; worth making it a habit as you add code for phases 2–4.
