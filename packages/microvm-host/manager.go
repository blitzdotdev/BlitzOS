package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrCapacity = errors.New("insufficient microVM capacity")
	ErrInvalid  = errors.New("invalid create request")
)

type Backend interface {
	Boot(context.Context, *VM, CreateRequest) (int, error)
	Inspect(context.Context, *VM) (running bool, intact bool)
	Stop(context.Context, *VM) error
	Cleanup(context.Context, *VM) error
	CleanupOrphans(context.Context, map[int]string) error
	Versions(context.Context) map[string]string
}

type Manager struct {
	mu      sync.Mutex
	cfg     Config
	store   *StateStore
	backend Backend
	vms     map[string]*VM
}

func NewManager(cfg Config, store *StateStore, backend Backend) (*Manager, error) {
	vms, err := store.Load()
	if err != nil {
		return nil, err
	}
	return &Manager{cfg: cfg, store: store, backend: backend, vms: vms}, nil
}

// Reconcile adopts intact Firecracker processes and removes incomplete or dead records.
func (m *Manager) Reconcile(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var errs []error
	for id, vm := range m.vms {
		running, intact := m.backend.Inspect(ctx, vm)
		if running && intact {
			vm.Status = StatusRunning
			if err := m.store.Save(vm); err != nil {
				errs = append(errs, err)
			}
			continue
		}
		if running {
			if err := m.backend.Stop(ctx, vm); err != nil {
				errs = append(errs, fmt.Errorf("stop incomplete VM %s: %w", id, err))
			}
		}
		if err := m.backend.Cleanup(ctx, vm); err != nil {
			errs = append(errs, fmt.Errorf("clean incomplete VM %s: %w", id, err))
			continue
		}
		if err := m.store.Delete(id); err != nil {
			errs = append(errs, err)
			continue
		}
		delete(m.vms, id)
	}
	active := make(map[int]string, len(m.vms))
	for _, vm := range m.vms {
		active[vm.Slot] = vm.VMID
	}
	if err := m.backend.CleanupOrphans(ctx, active); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (m *Manager) Create(ctx context.Context, req CreateRequest) (CreateResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := validateCreate(req); err != nil {
		return CreateResponse{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	capacity := m.capacityLocked()
	if capacity.VMCount >= capacity.MaxVMs || capacity.UsedCPU+req.CPU > capacity.TotalCPU || capacity.UsedMemMB+req.MemMB > capacity.TotalMemMB {
		return CreateResponse{}, ErrCapacity
	}
	slot, err := AllocateSlot(m.vms, m.cfg.SlotCount)
	if err != nil {
		return CreateResponse{}, ErrCapacity
	}
	_, guestIP, _, sshPort, err := NetworkFor(m.cfg, slot)
	if err != nil {
		return CreateResponse{}, err
	}
	id, err := newVMID(slot)
	if err != nil {
		return CreateResponse{}, err
	}
	vm := &VM{VMID: id, WorkspaceID: req.WorkspaceID, Slot: slot, CPU: req.CPU, MemMB: req.MemMB,
		HostIP: m.cfg.PublicHostIP, GuestIP: guestIP, SSHPort: sshPort,
		Status: StatusCreating, CreatedAt: time.Now().UTC()}
	m.vms[id] = vm
	if err := m.store.Save(vm); err != nil {
		delete(m.vms, id)
		return CreateResponse{}, err
	}
	pid, err := m.backend.Boot(ctx, vm, req)
	if err != nil {
		_ = m.backend.Stop(context.Background(), vm)
		_ = m.backend.Cleanup(context.Background(), vm)
		_ = m.store.Delete(id)
		delete(m.vms, id)
		return CreateResponse{}, fmt.Errorf("boot VM: %w", err)
	}
	vm.PID = pid
	vm.Status = StatusRunning
	if err := m.store.Save(vm); err != nil {
		_ = m.backend.Stop(context.Background(), vm)
		_ = m.backend.Cleanup(context.Background(), vm)
		_ = m.store.Delete(id)
		delete(m.vms, id)
		return CreateResponse{}, err
	}
	return CreateResponse{VMID: id, HostIP: vm.HostIP, SSHPort: vm.SSHPort}, nil
}

func (m *Manager) Delete(ctx context.Context, vmID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	vm, ok := m.vms[vmID]
	if !ok {
		return nil
	}
	vm.Status = StatusDeleting
	if err := m.store.Save(vm); err != nil {
		return err
	}
	stopErr := m.backend.Stop(ctx, vm)
	cleanupErr := m.backend.Cleanup(ctx, vm)
	if cleanupErr != nil {
		return errors.Join(stopErr, cleanupErr)
	}
	if err := m.store.Delete(vmID); err != nil {
		return errors.Join(stopErr, err)
	}
	delete(m.vms, vmID)
	return stopErr
}

func (m *Manager) List() []VM {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]VM, 0, len(m.vms))
	for _, vm := range m.vms {
		result = append(result, *vm)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.Before(result[j].CreatedAt) })
	return result
}

func (m *Manager) Capacity() Capacity {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.capacityLocked()
}

func (m *Manager) capacityLocked() Capacity {
	c := Capacity{TotalCPU: m.cfg.TotalCPU, TotalMemMB: m.cfg.TotalMemMB, MaxVMs: m.cfg.MaxVMs}
	for _, vm := range m.vms {
		c.VMCount++
		c.UsedCPU += vm.CPU
		c.UsedMemMB += vm.MemMB
	}
	return c
}

func (m *Manager) Health(ctx context.Context) Health {
	versions := m.backend.Versions(ctx)
	versions["agent"] = Version
	return Health{OK: true, Versions: versions}
}

func validateCreate(req CreateRequest) error {
	if strings.TrimSpace(req.WorkspaceID) == "" || strings.ContainsAny(req.WorkspaceID, "\r\n") {
		return errors.New("workspace_id is required and must be one line")
	}
	if req.CPU < 1 || req.CPU > 32 || req.MemMB < 128 {
		return errors.New("cpu or mem_mb is out of range")
	}
	key := strings.TrimSpace(req.SSHAuthorizedKey)
	if strings.ContainsAny(key, "\r\n") || !(strings.HasPrefix(key, "ssh-ed25519 ") || strings.HasPrefix(key, "ssh-rsa ") || strings.HasPrefix(key, "ecdsa-sha2-")) {
		return errors.New("ssh_authorized_key must contain one supported public key")
	}
	for name, raw := range map[string]string{"phone_home_url": req.PhoneHomeURL, "cp_origin": req.CPOrigin} {
		u, err := url.ParseRequestURI(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("%s must be an absolute HTTP(S) URL", name)
		}
	}
	return nil
}

func newVMID(slot int) (string, error) {
	random := make([]byte, 6)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return fmt.Sprintf("vm-%d-%s", slot, hex.EncodeToString(random)), nil
}
