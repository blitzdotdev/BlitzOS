package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type inspection struct{ running, intact bool }

type mockBackend struct {
	mu           sync.Mutex
	nextPID      int
	inspections  map[string]inspection
	stopped      []string
	cleaned      []string
	orphanActive map[int]string
}

func (m *mockBackend) Boot(_ context.Context, vm *VM, _ CreateRequest) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextPID++
	if m.nextPID < 100 {
		m.nextPID = 100
	}
	if m.inspections == nil {
		m.inspections = make(map[string]inspection)
	}
	m.inspections[vm.VMID] = inspection{true, true}
	return m.nextPID, nil
}
func (m *mockBackend) Inspect(_ context.Context, vm *VM) (bool, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v := m.inspections[vm.VMID]
	return v.running, v.intact
}
func (m *mockBackend) Stop(_ context.Context, vm *VM) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopped = append(m.stopped, vm.VMID)
	return nil
}
func (m *mockBackend) Cleanup(_ context.Context, vm *VM) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleaned = append(m.cleaned, vm.VMID)
	return nil
}
func (m *mockBackend) CleanupOrphans(_ context.Context, active map[int]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.orphanActive = make(map[int]string, len(active))
	for k, v := range active {
		m.orphanActive[k] = v
	}
	return nil
}
func (m *mockBackend) Versions(context.Context) map[string]string {
	return map[string]string{"firecracker": "test", "kernel": "test"}
}

func testConfig(dir string) Config {
	return Config{
		ListenAddr: "127.0.0.1:0", PublicHostIP: "192.0.2.10", TokenFile: filepath.Join(dir, "token"),
		StateDir: filepath.Join(dir, "state"), LabDir: dir, FirecrackerBin: filepath.Join(dir, "firecracker"),
		FirecrackerVersion: "test", KernelImage: filepath.Join(dir, "vmlinux"), KernelVersion: "test",
		RootfsImage: filepath.Join(dir, "rootfs"), SudoWrapper: filepath.Join(dir, "sudo-run"),
		NetworkPrefix: "172.30", NetworkOctetBase: 20, SlotCount: 4, SSHPortBase: 22000,
		UpperSizeBytes: 8 << 30, TotalCPU: 4, TotalMemMB: 2048, MaxVMs: 2, ShutdownTimeoutSeconds: 10,
	}
}

func validRequest(workspace string, cpu, mem int) CreateRequest {
	return CreateRequest{WorkspaceID: workspace, CPU: cpu, MemMB: mem,
		SSHAuthorizedKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey test",
		PhoneHomeURL:     "http://172.30.21.1:39000/enroll", CPOrigin: "https://cp.example.test"}
}

func TestAllocateSlotAndNetwork(t *testing.T) {
	vms := map[string]*VM{
		"one":   {Slot: 1, Status: StatusRunning},
		"three": {Slot: 3, Status: StatusCreating},
	}
	slot, err := AllocateSlot(vms, 4)
	if err != nil || slot != 2 {
		t.Fatalf("AllocateSlot() = %d, %v; want 2, nil", slot, err)
	}
	cfg := testConfig(t.TempDir())
	host, guest, tap, port, err := NetworkFor(cfg, slot)
	if err != nil || host != "172.30.22.1" || guest != "172.30.22.2" || tap != "blitz-tap2" || port != 22002 {
		t.Fatalf("NetworkFor() = %q %q %q %d %v", host, guest, tap, port, err)
	}
	vms["two"] = &VM{Slot: 2, Status: StatusRunning}
	vms["four"] = &VM{Slot: 4, Status: StatusRunning}
	if _, err := AllocateSlot(vms, 4); err == nil {
		t.Fatal("AllocateSlot() succeeded with all slots occupied")
	}
}

func TestReconcileAdoptsAndCleans(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig(dir)
	store := NewStateStore(cfg.StateDir)
	now := time.Now().UTC()
	live := &VM{VMID: "vm-1-live", WorkspaceID: "live", Slot: 1, CPU: 2, MemMB: 1024, Status: StatusCreating, CreatedAt: now}
	dead := &VM{VMID: "vm-2-dead", WorkspaceID: "dead", Slot: 2, CPU: 1, MemMB: 512, Status: StatusRunning, CreatedAt: now}
	broken := &VM{VMID: "vm-3-broken", WorkspaceID: "broken", Slot: 3, CPU: 1, MemMB: 512, Status: StatusRunning, CreatedAt: now}
	for _, vm := range []*VM{live, dead, broken} {
		if err := store.Save(vm); err != nil {
			t.Fatal(err)
		}
	}
	backend := &mockBackend{inspections: map[string]inspection{
		live.VMID: {true, true}, dead.VMID: {false, false}, broken.VMID: {true, false},
	}}
	manager, err := NewManager(cfg, store, backend)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := manager.List()
	if len(got) != 1 || got[0].VMID != live.VMID || got[0].Status != StatusRunning {
		t.Fatalf("reconciled list = %#v", got)
	}
	if len(backend.stopped) != 1 || backend.stopped[0] != broken.VMID {
		t.Fatalf("stopped = %#v", backend.stopped)
	}
	if len(backend.cleaned) != 2 || backend.orphanActive[1] != live.VMID {
		t.Fatalf("cleaned=%#v active=%#v", backend.cleaned, backend.orphanActive)
	}
	reloaded, err := store.Load()
	if err != nil || len(reloaded) != 1 || reloaded[live.VMID].Status != StatusRunning {
		t.Fatalf("persisted reconcile = %#v, %v", reloaded, err)
	}
}

func TestCapacityMathAndLimit(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig(dir)
	backend := &mockBackend{}
	manager, err := NewManager(cfg, NewStateStore(cfg.StateDir), backend)
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.Create(context.Background(), validRequest("ws-1", 2, 1024))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Create(context.Background(), validRequest("ws-2", 1, 512)); err != nil {
		t.Fatal(err)
	}
	got := manager.Capacity()
	want := Capacity{TotalCPU: 4, TotalMemMB: 2048, UsedCPU: 3, UsedMemMB: 1536, VMCount: 2, MaxVMs: 2}
	if got != want {
		t.Fatalf("Capacity() = %#v; want %#v", got, want)
	}
	if _, err := manager.Create(context.Background(), validRequest("ws-3", 1, 256)); err != ErrCapacity {
		t.Fatalf("third Create() error = %v; want ErrCapacity", err)
	}
	if err := manager.Delete(context.Background(), first.VMID); err != nil {
		t.Fatal(err)
	}
	got = manager.Capacity()
	if got.UsedCPU != 1 || got.UsedMemMB != 512 || got.VMCount != 1 {
		t.Fatalf("Capacity() after delete = %#v", got)
	}
}

func TestBearerAuth(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig(dir)
	manager, err := NewManager(cfg, NewStateStore(cfg.StateDir), &mockBackend{})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(manager, "01234567890123456789012345678901")
	for _, tc := range []struct {
		name, auth string
		want       int
	}{
		{"missing", "", http.StatusUnauthorized},
		{"wrong", "Bearer 01234567890123456789012345678902", http.StatusUnauthorized},
		{"valid", "Bearer 01234567890123456789012345678901", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/healthz", nil)
			req.Header.Set("Authorization", tc.auth)
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)
			if res.Code != tc.want {
				t.Fatalf("status = %d, want %d", res.Code, tc.want)
			}
			if tc.want == http.StatusOK {
				var health Health
				if err := json.Unmarshal(res.Body.Bytes(), &health); err != nil || !health.OK {
					t.Fatalf("health response = %s, %v", res.Body.String(), err)
				}
			}
		})
	}
}

func TestReadBearerTokenRequires0600(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("01234567890123456789012345678901\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadBearerToken(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadBearerToken(path); err == nil {
		t.Fatal("ReadBearerToken accepted mode 0644")
	}
}
