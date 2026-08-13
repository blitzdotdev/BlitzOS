package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	agent "github.com/blitzdotdev/blitz-core/microvm-host"
)

func main() {
	configPath := flag.String("config", "", "absolute path to agent JSON config")
	flag.Parse()
	if *configPath == "" {
		log.Fatal("-config is required")
	}
	cfg, err := agent.LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	token, err := agent.ReadBearerToken(cfg.TokenFile)
	if err != nil {
		log.Fatalf("token: %v", err)
	}
	backend := agent.NewLinuxBackend(cfg)
	manager, err := agent.NewManager(cfg, agent.NewStateStore(cfg.StateDir), backend)
	if err != nil {
		log.Fatalf("state: %v", err)
	}
	if err := manager.Reconcile(context.Background()); err != nil {
		log.Fatalf("reconcile: %v", err)
	}
	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           agent.NewHandler(manager, token),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	done := make(chan os.Signal, 1)
	signal.Notify(done, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-done
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	log.Printf("blitz microVM agent %s listening on %s", agent.Version, cfg.ListenAddr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}
