// Command palcon is a self-hosted RCON/REST management server for
// Palworld dedicated servers.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/safwyls/palcon/internal/api"
	"github.com/safwyls/palcon/internal/config"
	"github.com/safwyls/palcon/internal/crypto"
	"github.com/safwyls/palcon/internal/db"
	"github.com/safwyls/palcon/internal/palsave"
	"github.com/safwyls/palcon/internal/store"
	"github.com/safwyls/palcon/web"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	if err := run(logger); err != nil {
		logger.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	sqlDB, err := db.Open(cfg.DBPath())
	if err != nil {
		return err
	}
	defer sqlDB.Close()

	box, err := crypto.New(cfg.EncryptionKey)
	if err != nil {
		return err
	}
	st := store.New(sqlDB, box)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if err := api.BootstrapAdmin(ctx, st, cfg.AdminUsername, cfg.AdminPassword); err != nil {
		return err
	}

	distFS, err := web.Dist()
	if err != nil {
		return err
	}

	// Materializes the embedded save-extractor script into the data dir;
	// actually using it also requires python3 + palworld-save-tools in the
	// runtime environment (both present in the Docker image).
	palReader, err := palsave.NewReader(cfg.DataDir)
	if err != nil {
		return err
	}

	apiServer := api.New(st, cfg.JWTSecret, logger, palReader)
	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           apiServer.Routes(distFS),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", cfg.HTTPAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutting down")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		return httpServer.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}
