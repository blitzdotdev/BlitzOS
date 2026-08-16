package agent

import (
	"errors"
	"fmt"
	"math"
	"net"
	"path/filepath"
)

const Version = "m2"

// Config contains host-level settings. Per-VM authorization material is never persisted.
type Config struct {
	ListenAddr             string
	PublicHostIP           string
	TokenFile              string
	StateDir               string
	FirecrackerBin         string
	FirecrackerVersion     string
	GuestDNS               []string
	KernelImage            string
	KernelVersion          string
	RootfsImage            string
	SudoWrapper            string
	NetworkPrefix          string
	NetworkOctetBase       int
	SlotCount              int
	SSHPortBase            int
	UpperSizeBytes         int64
	TotalCPU               int
	CPUOvercommit          float64
	TotalMemMB             int
	MaxVMs                 int
	ShutdownTimeoutSeconds int
}

func (c Config) Validate() error {
	if c.ListenAddr == "" || c.PublicHostIP == "" {
		return errors.New("listen_addr and public_host_ip are required")
	}
	if len(c.GuestDNS) == 0 || len(c.GuestDNS) > 3 {
		return errors.New("guest_dns must contain one to three IPv4 addresses")
	}
	seenDNS := make(map[string]bool, len(c.GuestDNS))
	for _, address := range c.GuestDNS {
		parsed := net.ParseIP(address)
		if parsed == nil || parsed.To4() == nil || seenDNS[address] {
			return errors.New("guest_dns must contain distinct IPv4 addresses")
		}
		seenDNS[address] = true
	}
	paths := map[string]string{
		"token_file": c.TokenFile, "state_dir": c.StateDir,
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
	overcommit := c.CPUOvercommit
	if overcommit <= 0 || math.IsNaN(overcommit) || math.IsInf(overcommit, 0) {
		return errors.New("cpu_overcommit must be finite and greater than zero")
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
	return c.CPUOvercommit
}

func (c Config) effectiveCPU() int {
	return int(float64(c.TotalCPU) * c.cpuOvercommit())
}
