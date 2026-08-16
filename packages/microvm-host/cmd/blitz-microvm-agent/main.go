package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	agent "github.com/blitzdotdev/blitz-core/microvm-host"
)

func main() {
	cfg := agent.Config{
		ListenAddr:         os.Getenv("BLITZ_MICROVM_LISTEN_ADDR"),
		PublicHostIP:       os.Getenv("BLITZ_MICROVM_PUBLIC_HOST_IP"),
		TokenFile:          os.Getenv("BLITZ_MICROVM_TOKEN_FILE"),
		StateDir:           os.Getenv("BLITZ_MICROVM_STATE_DIR"),
		FirecrackerBin:     os.Getenv("BLITZ_MICROVM_FIRECRACKER_BIN"),
		FirecrackerVersion: os.Getenv("BLITZ_MICROVM_FIRECRACKER_VERSION"),
		KernelImage:        os.Getenv("BLITZ_MICROVM_KERNEL_IMAGE"),
		KernelVersion:      os.Getenv("BLITZ_MICROVM_KERNEL_VERSION"),
		RootfsImage:        os.Getenv("BLITZ_MICROVM_ROOTFS_IMAGE"),
		SudoWrapper:        os.Getenv("BLITZ_MICROVM_SUDO_WRAPPER"),
		NetworkPrefix:      os.Getenv("BLITZ_MICROVM_NETWORK_PREFIX"),
	}
	if err := json.Unmarshal([]byte(os.Getenv("BLITZ_MICROVM_GUEST_DNS")), &cfg.GuestDNS); err != nil {
		log.Fatalf("BLITZ_MICROVM_GUEST_DNS: %v", err)
	}
	var err error
	if cfg.NetworkOctetBase, err = strconv.Atoi(os.Getenv("BLITZ_MICROVM_NETWORK_OCTET_BASE")); err != nil {
		log.Fatalf("BLITZ_MICROVM_NETWORK_OCTET_BASE: %v", err)
	}
	if cfg.SlotCount, err = strconv.Atoi(os.Getenv("BLITZ_MICROVM_SLOT_COUNT")); err != nil {
		log.Fatalf("BLITZ_MICROVM_SLOT_COUNT: %v", err)
	}
	if cfg.SSHPortBase, err = strconv.Atoi(os.Getenv("BLITZ_MICROVM_SSH_PORT_BASE")); err != nil {
		log.Fatalf("BLITZ_MICROVM_SSH_PORT_BASE: %v", err)
	}
	if cfg.UpperSizeBytes, err = strconv.ParseInt(os.Getenv("BLITZ_MICROVM_UPPER_SIZE_BYTES"), 10, 64); err != nil {
		log.Fatalf("BLITZ_MICROVM_UPPER_SIZE_BYTES: %v", err)
	}
	if cfg.TotalCPU, err = strconv.Atoi(os.Getenv("BLITZ_MICROVM_TOTAL_CPU")); err != nil {
		log.Fatalf("BLITZ_MICROVM_TOTAL_CPU: %v", err)
	}
	if cfg.CPUOvercommit, err = strconv.ParseFloat(os.Getenv("BLITZ_MICROVM_CPU_OVERCOMMIT"), 64); err != nil {
		log.Fatalf("BLITZ_MICROVM_CPU_OVERCOMMIT: %v", err)
	}
	if cfg.TotalMemMB, err = strconv.Atoi(os.Getenv("BLITZ_MICROVM_TOTAL_MEM_MB")); err != nil {
		log.Fatalf("BLITZ_MICROVM_TOTAL_MEM_MB: %v", err)
	}
	if cfg.MaxVMs, err = strconv.Atoi(os.Getenv("BLITZ_MICROVM_MAX_VMS")); err != nil {
		log.Fatalf("BLITZ_MICROVM_MAX_VMS: %v", err)
	}
	if cfg.ShutdownTimeoutSeconds, err = strconv.Atoi(os.Getenv("BLITZ_MICROVM_SHUTDOWN_TIMEOUT_SECONDS")); err != nil {
		log.Fatalf("BLITZ_MICROVM_SHUTDOWN_TIMEOUT_SECONDS: %v", err)
	}
	if err := cfg.Validate(); err != nil {
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
