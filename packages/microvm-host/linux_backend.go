package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type commandRunner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type realRunner struct{}

func (realRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return output, fmt.Errorf("%s failed: %w: %s", filepath.Base(name), err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

type LinuxBackend struct {
	cfg    Config
	runner commandRunner
	mu     sync.Mutex
}

func NewLinuxBackend(cfg Config) *LinuxBackend {
	return &LinuxBackend{cfg: cfg, runner: realRunner{}}
}

func (b *LinuxBackend) runtimeRoot() string      { return filepath.Join(b.cfg.StateDir, "runtime") }
func (b *LinuxBackend) runtimeDir(vm *VM) string { return filepath.Join(b.runtimeRoot(), vm.VMID) }
func (b *LinuxBackend) socketPath(vm *VM) string {
	return filepath.Join(b.runtimeDir(vm), "firecracker.sock")
}

func (b *LinuxBackend) Boot(ctx context.Context, vm *VM, req CreateRequest) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	runtimeDir := b.runtimeDir(vm)
	imageRoot := filepath.Join(runtimeDir, "image-root")
	if err := os.MkdirAll(filepath.Join(imageRoot, "seed"), 0700); err != nil {
		return 0, err
	}
	if err := writeAuthorizedKeySeed(imageRoot, req.SSHAuthorizedKey); err != nil {
		return 0, err
	}
	upper := filepath.Join(runtimeDir, "upper.ext4")
	f, err := os.OpenFile(upper, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return 0, err
	}
	if err := f.Truncate(b.cfg.UpperSizeBytes); err != nil {
		f.Close()
		return 0, err
	}
	if err := f.Close(); err != nil {
		return 0, err
	}
	if _, err := b.runner.Run(ctx, "mkfs.ext4", "-q", "-F", "-E", "lazy_itable_init=1,lazy_journal_init=1", "-d", imageRoot, upper); err != nil {
		return 0, err
	}
	hostIP, _, tap, _, err := NetworkFor(b.cfg, vm.Slot)
	if err != nil {
		return 0, err
	}
	if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, "ip", "tuntap", "add", "dev", tap, "mode", "tap", "user", currentUsername()); err != nil {
		return 0, err
	}
	if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, "ip", "addr", "add", hostIP+"/30", "dev", tap); err != nil {
		return 0, err
	}
	if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, "ip", "link", "set", "dev", tap, "up"); err != nil {
		return 0, err
	}
	if err := b.addRules(ctx, vm); err != nil {
		return 0, err
	}

	logFile, err := os.OpenFile(filepath.Join(runtimeDir, "console.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return 0, err
	}
	cmd := exec.Command(b.cfg.FirecrackerBin, "--api-sock", b.socketPath(vm))
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return 0, err
	}
	pid := cmd.Process.Pid
	go func() {
		_ = cmd.Wait()
		_ = logFile.Close()
	}()
	if err := os.WriteFile(filepath.Join(runtimeDir, "firecracker.pid"), []byte(strconv.Itoa(pid)+"\n"), 0600); err != nil {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		return 0, err
	}
	if err := waitForSocket(ctx, b.socketPath(vm), pid, 3*time.Second); err != nil {
		return 0, err
	}
	if err := b.configure(ctx, vm, req); err != nil {
		return 0, err
	}
	return pid, nil
}

func writeAuthorizedKeySeed(imageRoot string, sshAuthorizedKey *string) error {
	if sshAuthorizedKey == nil || strings.TrimSpace(*sshAuthorizedKey) == "" {
		return nil
	}
	key := strings.TrimSpace(*sshAuthorizedKey) + "\n"
	return os.WriteFile(filepath.Join(imageRoot, "seed", "authorized_key"), []byte(key), 0600)
}

func (b *LinuxBackend) configure(ctx context.Context, vm *VM, req CreateRequest) error {
	machine := map[string]any{"vcpu_count": vm.CPU, "mem_size_mib": vm.MemMB, "smt": false, "track_dirty_pages": false}
	if err := firecrackerPut(ctx, b.socketPath(vm), "/machine-config", machine); err != nil {
		return err
	}
	hostIP, guestIP, tap, _, _ := NetworkFor(b.cfg, vm.Slot)
	octet := b.cfg.NetworkOctetBase + vm.Slot
	encode := func(v string) string { return base64.RawURLEncoding.EncodeToString([]byte(v)) }
	bootArgs := strings.Join([]string{
		"console=ttyS0", "reboot=k", "panic=1", "pci=off", "root=/dev/vda", "ro", "init=/microvm-init",
		"random.trust_cpu=on", "ipv6.disable=1", "quiet", "blitz_ip=" + guestIP, "blitz_gw=" + hostIP,
		"blitz_prefix=30", "blitz_name=" + vm.VMID, "blitz_phone_home_b64=" + encode(req.PhoneHomeURL),
		"blitz_cp_origin_b64=" + encode(req.CPOrigin), "blitz_workspace_b64=" + encode(req.WorkspaceID),
	}, " ")
	if err := firecrackerPut(ctx, b.socketPath(vm), "/boot-source", map[string]any{"kernel_image_path": b.cfg.KernelImage, "boot_args": bootArgs}); err != nil {
		return err
	}
	if err := firecrackerPut(ctx, b.socketPath(vm), "/drives/rootfs", map[string]any{"drive_id": "rootfs", "path_on_host": b.cfg.RootfsImage, "is_root_device": true, "is_read_only": true, "cache_type": "Unsafe", "io_engine": "Sync"}); err != nil {
		return err
	}
	if err := firecrackerPut(ctx, b.socketPath(vm), "/drives/upper", map[string]any{"drive_id": "upper", "path_on_host": filepath.Join(b.runtimeDir(vm), "upper.ext4"), "is_root_device": false, "is_read_only": false, "cache_type": "Unsafe", "io_engine": "Sync"}); err != nil {
		return err
	}
	mac := fmt.Sprintf("06:00:ac:1e:%02x:02", octet)
	if err := firecrackerPut(ctx, b.socketPath(vm), "/network-interfaces/eth0", map[string]any{"iface_id": "eth0", "guest_mac": mac, "host_dev_name": tap}); err != nil {
		return err
	}
	return firecrackerPut(ctx, b.socketPath(vm), "/actions", map[string]string{"action_type": "InstanceStart"})
}

func (b *LinuxBackend) Inspect(ctx context.Context, vm *VM) (bool, bool) {
	pid := b.effectivePID(vm)
	if !b.processMatches(pid, vm) {
		return false, false
	}
	_, _, tap, _, err := NetworkFor(b.cfg, vm.Slot)
	if err != nil {
		return true, false
	}
	if _, err := os.Stat(filepath.Join("/sys/class/net", tap)); err != nil {
		return true, false
	}
	for _, rule := range b.rules(vm) {
		args := append([]string{"iptables", "-t", rule.table, "-C"}, rule.args...)
		if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, args...); err != nil {
			return true, false
		}
	}
	return true, true
}

func (b *LinuxBackend) Stop(ctx context.Context, vm *VM) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	pid := b.effectivePID(vm)
	if pid <= 0 || !processExists(pid) {
		return nil
	}
	if !b.processMatches(pid, vm) {
		return fmt.Errorf("refusing to signal PID %d: process identity mismatch", pid)
	}
	_ = firecrackerPut(ctx, b.socketPath(vm), "/actions", map[string]string{"action_type": "SendCtrlAltDel"})
	deadline := time.Now().Add(time.Duration(b.cfg.ShutdownTimeoutSeconds) * time.Second)
	for time.Now().Before(deadline) {
		if !processExists(pid) {
			return nil
		}
		time.Sleep(25 * time.Millisecond)
	}
	_ = syscall.Kill(pid, syscall.SIGTERM)
	for i := 0; i < 80 && processExists(pid); i++ {
		time.Sleep(25 * time.Millisecond)
	}
	if processExists(pid) {
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
	}
	return nil
}

func (b *LinuxBackend) Cleanup(ctx context.Context, vm *VM) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	var errs []error
	if err := b.removeRules(ctx, vm); err != nil {
		errs = append(errs, err)
	}
	_, _, tap, _, _ := NetworkFor(b.cfg, vm.Slot)
	if _, err := os.Stat(filepath.Join("/sys/class/net", tap)); err == nil {
		if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, "ip", "link", "delete", "dev", tap); err != nil {
			errs = append(errs, err)
		}
	}
	runtimeDir := b.runtimeDir(vm)
	if !pathWithin(runtimeDir, b.runtimeRoot()) {
		errs = append(errs, fmt.Errorf("unsafe runtime path %s", runtimeDir))
	} else if err := os.RemoveAll(runtimeDir); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (b *LinuxBackend) CleanupOrphans(ctx context.Context, active map[int]string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	var errs []error
	if raw, err := os.ReadFile("/proc/sys/net/ipv4/ip_forward"); err != nil {
		errs = append(errs, err)
	} else if strings.TrimSpace(string(raw)) != "1" {
		if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, "sysctl", "-q", "-w", "net.ipv4.ip_forward=1"); err != nil {
			errs = append(errs, err)
		}
	}
	root := b.runtimeRoot()
	_ = os.MkdirAll(root, 0700)
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	activeIDs := make(map[string]bool, len(active))
	for _, id := range active {
		activeIDs[id] = true
	}
	procEntries, _ := os.ReadDir("/proc")
	for _, entry := range procEntries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "cmdline"))
		if err != nil || !bytes.Contains(cmdline, []byte(b.cfg.FirecrackerBin)) || !bytes.Contains(cmdline, []byte(root+string(filepath.Separator))) {
			continue
		}
		tracked := false
		for id := range activeIDs {
			if bytes.Contains(cmdline, []byte(filepath.Join(root, id, "firecracker.sock"))) {
				tracked = true
				break
			}
		}
		if !tracked {
			if err := terminatePID(pid); err != nil {
				errs = append(errs, err)
			}
		}
	}
	for _, entry := range entries {
		if !entry.IsDir() || activeIDs[entry.Name()] {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		if pid := readPID(filepath.Join(dir, "firecracker.pid")); pid > 0 {
			cmdline, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
			if bytes.Contains(cmdline, []byte(b.cfg.FirecrackerBin)) && bytes.Contains(cmdline, []byte(dir)) {
				_ = terminatePID(pid)
			}
		}
		if pathWithin(dir, root) {
			if err := os.RemoveAll(dir); err != nil {
				errs = append(errs, err)
			}
		}
	}
	for slot := 1; slot <= b.cfg.SlotCount; slot++ {
		if _, ok := active[slot]; ok {
			continue
		}
		vm := &VM{VMID: fmt.Sprintf("orphan-slot-%d", slot), Slot: slot, SSHPort: b.cfg.SSHPortBase + slot}
		if err := b.removeRules(ctx, vm); err != nil {
			errs = append(errs, err)
		}
		_, _, tap, _, _ := NetworkFor(b.cfg, slot)
		if _, err := os.Stat(filepath.Join("/sys/class/net", tap)); err == nil {
			if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, "ip", "link", "delete", "dev", tap); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func (b *LinuxBackend) Versions(context.Context) map[string]string {
	return map[string]string{"firecracker": b.cfg.FirecrackerVersion, "kernel": b.cfg.KernelVersion}
}

type iptablesRule struct {
	table string
	args  []string
}

func (b *LinuxBackend) rules(vm *VM) []iptablesRule {
	_, guestIP, _, sshPort, _ := NetworkFor(b.cfg, vm.Slot)
	tag := fmt.Sprintf("blitz-microvm:slot-%d", vm.Slot)
	return []iptablesRule{
		{"nat", []string{"PREROUTING", "-p", "tcp", "--dport", strconv.Itoa(sshPort), "-m", "comment", "--comment", tag, "-j", "DNAT", "--to-destination", guestIP + ":22"}},
		{"filter", []string{"FORWARD", "-p", "tcp", "-d", guestIP, "--dport", "22", "-m", "comment", "--comment", tag, "-j", "ACCEPT"}},
		{"filter", []string{"FORWARD", "-p", "tcp", "-s", guestIP, "--sport", "22", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-m", "comment", "--comment", tag, "-j", "ACCEPT"}},
		{"nat", []string{"POSTROUTING", "-s", guestIP, "-m", "comment", "--comment", tag, "-j", "MASQUERADE"}},
		{"filter", []string{"FORWARD", "-s", guestIP, "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED,RELATED", "-m", "comment", "--comment", tag, "-j", "ACCEPT"}},
		{"filter", []string{"FORWARD", "-d", guestIP, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-m", "comment", "--comment", tag, "-j", "ACCEPT"}},
	}
}

func (b *LinuxBackend) addRules(ctx context.Context, vm *VM) error {
	for _, rule := range b.rules(vm) {
		check := append([]string{"iptables", "-t", rule.table, "-C"}, rule.args...)
		if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, check...); err == nil {
			continue
		}
		add := append([]string{"iptables", "-t", rule.table, "-A"}, rule.args...)
		if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, add...); err != nil {
			return err
		}
	}
	return nil
}

func (b *LinuxBackend) removeRules(ctx context.Context, vm *VM) error {
	var errs []error
	for _, rule := range b.rules(vm) {
		check := append([]string{"iptables", "-t", rule.table, "-C"}, rule.args...)
		if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, check...); err != nil {
			continue
		}
		remove := append([]string{"iptables", "-t", rule.table, "-D"}, rule.args...)
		if _, err := b.runner.Run(ctx, b.cfg.SudoWrapper, remove...); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (b *LinuxBackend) effectivePID(vm *VM) int {
	if vm.PID > 0 {
		return vm.PID
	}
	return readPID(filepath.Join(b.runtimeDir(vm), "firecracker.pid"))
}

func (b *LinuxBackend) processMatches(pid int, vm *VM) bool {
	if pid <= 0 {
		return false
	}
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	return err == nil && bytes.Contains(cmdline, []byte(b.cfg.FirecrackerBin)) && bytes.Contains(cmdline, []byte(b.socketPath(vm)))
}

func firecrackerPut(ctx context.Context, socketPath, path string, body any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}}
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://firecracker"+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		limited, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("firecracker %s returned %s: %s", path, resp.Status, strings.TrimSpace(string(limited)))
	}
	return nil
}

func waitForSocket(ctx context.Context, path string, pid int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return nil
		}
		if !processExists(pid) {
			return fmt.Errorf("firecracker exited before API socket became ready")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
	return fmt.Errorf("timed out waiting for firecracker API socket")
}

func readPID(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return pid
}

func processExists(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func terminatePID(pid int) error {
	if !processExists(pid) {
		return nil
	}
	_ = syscall.Kill(pid, syscall.SIGTERM)
	for i := 0; i < 80 && processExists(pid); i++ {
		time.Sleep(25 * time.Millisecond)
	}
	if processExists(pid) {
		return syscall.Kill(pid, syscall.SIGKILL)
	}
	return nil
}

func pathWithin(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func currentUsername() string {
	if user := os.Getenv("USER"); user != "" {
		return user
	}
	return strconv.Itoa(os.Getuid())
}
