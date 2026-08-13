package agent

import "time"

type VMStatus string

const (
	StatusCreating VMStatus = "creating"
	StatusRunning  VMStatus = "running"
	StatusDeleting VMStatus = "deleting"
)

type VM struct {
	VMID        string    `json:"vm_id"`
	WorkspaceID string    `json:"workspace_id"`
	Slot        int       `json:"slot"`
	CPU         int       `json:"cpu"`
	MemMB       int       `json:"mem_mb"`
	HostIP      string    `json:"host_ip"`
	GuestIP     string    `json:"guest_ip"`
	SSHPort     int       `json:"ssh_port"`
	PID         int       `json:"pid,omitempty"`
	Status      VMStatus  `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
}

type CreateRequest struct {
	WorkspaceID      string `json:"workspace_id"`
	CPU              int    `json:"cpu"`
	MemMB            int    `json:"mem_mb"`
	SSHAuthorizedKey string `json:"ssh_authorized_key"`
	PhoneHomeURL     string `json:"phone_home_url"`
	CPOrigin         string `json:"cp_origin"`
}

type CreateResponse struct {
	VMID    string `json:"vm_id"`
	HostIP  string `json:"host_ip"`
	SSHPort int    `json:"ssh_port"`
}

type Capacity struct {
	TotalCPU   int `json:"total_cpu"`
	TotalMemMB int `json:"total_mem_mb"`
	UsedCPU    int `json:"used_cpu"`
	UsedMemMB  int `json:"used_mem_mb"`
	VMCount    int `json:"vm_count"`
	MaxVMs     int `json:"max_vms"`
}

type Health struct {
	OK       bool              `json:"ok"`
	Versions map[string]string `json:"versions"`
}
