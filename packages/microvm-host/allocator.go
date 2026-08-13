package agent

import "fmt"

func AllocateSlot(vms map[string]*VM, slotCount int) (int, error) {
	used := make(map[int]bool, len(vms))
	for _, vm := range vms {
		if vm.Status != StatusDeleting {
			used[vm.Slot] = true
		}
	}
	for slot := 1; slot <= slotCount; slot++ {
		if !used[slot] {
			return slot, nil
		}
	}
	return 0, fmt.Errorf("no free microVM slots")
}

func NetworkFor(cfg Config, slot int) (hostIP, guestIP, tap string, sshPort int, err error) {
	if slot < 1 || slot > cfg.SlotCount {
		return "", "", "", 0, fmt.Errorf("slot %d is out of range", slot)
	}
	octet := cfg.NetworkOctetBase + slot
	return fmt.Sprintf("%s.%d.1", cfg.NetworkPrefix, octet),
		fmt.Sprintf("%s.%d.2", cfg.NetworkPrefix, octet),
		fmt.Sprintf("blitz-tap%d", slot), cfg.SSHPortBase + slot, nil
}
