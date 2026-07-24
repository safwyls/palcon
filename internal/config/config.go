package config

import (
	"fmt"
	"os"
	"path/filepath"
)

// Config holds all runtime configuration, sourced entirely from environment
// variables so the container can be configured without a config file.
type Config struct {
	// HTTPAddr is the address the HTTP server listens on, e.g. ":8080".
	HTTPAddr string

	// DataDir is where the sqlite database lives. Mount this as a volume.
	DataDir string

	// JWTSecret signs session cookies. Must stay stable across restarts or
	// existing sessions are invalidated.
	JWTSecret []byte

	// EncryptionKey encrypts stored RCON/REST passwords at rest. Must be
	// exactly 32 bytes. Losing this key makes stored server credentials
	// unrecoverable, so back it up alongside the database.
	EncryptionKey []byte

	// Bootstrap admin, only used the first time the app starts (when the
	// users table is empty).
	AdminUsername string
	AdminPassword string

	// DockerHost points at a scoped docker socket proxy used to start and
	// stop game server containers. Empty disables power control entirely —
	// Palcon should never require access to a docker socket to run.
	DockerHost string
}

func (c *Config) DBPath() string {
	return filepath.Join(c.DataDir, "palcon.db")
}

// Load reads configuration from the environment. Required variables are
// JWT_SECRET and ENCRYPTION_KEY; everything else has a sane default for
// local development.
func Load() (*Config, error) {
	cfg := &Config{
		HTTPAddr:      getEnv("HTTP_ADDR", ":8080"),
		DataDir:       getEnv("DATA_DIR", "./data"),
		AdminUsername: getEnv("ADMIN_USERNAME", "admin"),
		AdminPassword: os.Getenv("ADMIN_PASSWORD"),
		DockerHost:    os.Getenv("DOCKER_HOST"),
	}

	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET is required")
	}
	cfg.JWTSecret = []byte(jwtSecret)

	encKey := os.Getenv("ENCRYPTION_KEY")
	if len(encKey) != 32 {
		return nil, fmt.Errorf("ENCRYPTION_KEY is required and must be exactly 32 bytes, got %d", len(encKey))
	}
	cfg.EncryptionKey = []byte(encKey)

	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating data dir: %w", err)
	}

	return cfg, nil
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
