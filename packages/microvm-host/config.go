package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

const Version = "m2"

// Config contains host-level settings. Per-VM authorization material is never persisted.
type Config struct {
	ListenAddr             string  `json:"listen_addr"`
	PublicHostIP           string  `json:"public_host_ip"`
	TokenFile              string  `json:"token_file"`
	StateDir               string  `json:"state_dir"`
	LabDir                 string  `json:"lab_dir"`
	FirecrackerBin         string  `json:"firecracker_bin"`
	FirecrackerVersion     string  `json:"firecracker_version"`
	KernelImage            string  `json:"kernel_image"`
	KernelVersion          string  `json:"kernel_version"`
	RootfsImage            string  `json:"rootfs_image"`
	SudoWrapper            string  `json:"sudo_wrapper"`
	NetworkPrefix          string  `json:"network_prefix"`
	NetworkOctetBase       int     `json:"network_octet_base"`
	SlotCount              int     `json:"slot_count"`
	SSHPortBase            int     `json:"ssh_port_base"`
	UpperSizeBytes         int64   `json:"upper_size_bytes"`
	TotalCPU               int     `json:"total_cpu"`
	CPUOvercommit          float64 `json:"cpu_overcommit"`
	TotalMemMB             int     `json:"total_mem_mb"`
	MaxVMs                 int     `json:"max_vms"`
	ShutdownTimeoutSeconds int     `json:"shutdown_timeout_seconds"`
}

func LoadConfig(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, fmt.Errorf("decode config: %w", err)
	}
	if cfg.CPUOvercommit == 0 {
		cfg.CPUOvercommit = 1
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.ListenAddr == "" || c.PublicHostIP == "" {
		return errors.New("listen_addr and public_host_ip are required")
	}
	paths := map[string]string{
		"token_file": c.TokenFile, "state_dir": c.StateDir, "lab_dir": c.LabDir,
		"firecracker_bin": c.FirecrackerBin, "kernel_image": c.KernelImage,
		"rootfs_image": c.RootfsImage, "sudo_wrapper": c.SudoWrapper,
	}
	for name, path := range paths {
		if path == "" || !filepath.IsAbs(path) {
			return fmt.Errorf("%s must be an absolute path", name)
		}
	}
	if c.NetworkPrefix == "" || c.NetworkOctetBase < 0 || c.NetworkOctetBase+c.SlotCount > 254 {
		return errors.New("invalid network prefix, base, or slot count")
	}
	if c.SlotCount < 1 || c.SSHPortBase < 1024 || c.SSHPortBase+c.SlotCount > 65535 {
		return errors.New("invalid slot_count or ssh_port_base")
	}
	if c.TotalCPU < 1 || c.TotalMemMB < 1 || c.MaxVMs < 1 || c.MaxVMs > c.SlotCount {
		return errors.New("invalid capacity settings")
	}
	overcommit := c.cpuOvercommit()
	if overcommit <= 0 || math.IsNaN(overcommit) || math.IsInf(overcommit, 0) {
		return errors.New("cpu_overcommit must be finite and greater than zero, or zero for the default")
	}
	if effectiveCPU := float64(c.TotalCPU) * overcommit; effectiveCPU < 1 || math.IsInf(effectiveCPU, 0) {
		return errors.New("cpu_overcommit produces an invalid effective CPU capacity")
	}
	if c.UpperSizeBytes < 64*1024*1024 {
		return errors.New("upper_size_bytes is too small")
	}
	if c.ShutdownTimeoutSeconds < 1 || c.ShutdownTimeoutSeconds > 60 {
		return errors.New("shutdown_timeout_seconds must be between 1 and 60")
	}
	return nil
}

func (c Config) cpuOvercommit() float64 {
	if c.CPUOvercommit == 0 {
		return 1
	}
	return c.CPUOvercommit
}

func (c Config) effectiveCPU() int {
	return int(float64(c.TotalCPU) * c.cpuOvercommit())
}
