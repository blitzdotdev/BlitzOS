package broker

import (
	"fmt"
	"os/user"
	"path/filepath"
	"reflect"
	"testing"
)

type fakeAccountProvisioner struct {
	users       map[string]*user.User
	groups      map[string]*user.Group
	commands    [][]string
	chownUIDGID [][2]int
}

func (fake *fakeAccountProvisioner) lookupUser(name string) (*user.User, error) {
	if account, ok := fake.users[name]; ok {
		copy := *account
		return &copy, nil
	}
	return nil, user.UnknownUserError(name)
}

func (fake *fakeAccountProvisioner) lookupGroup(name string) (*user.Group, error) {
	if group, ok := fake.groups[name]; ok {
		copy := *group
		return &copy, nil
	}
	return nil, user.UnknownGroupError(name)
}

func (fake *fakeAccountProvisioner) run(command string, args ...string) error {
	fake.commands = append(fake.commands, append([]string{command}, args...))
	if command != "useradd" {
		return fmt.Errorf("unexpected command %q", command)
	}
	name := args[len(args)-1]
	home := flagValue(args, "--home-dir")
	gid := flagValue(args, "--gid")
	if gid == "" {
		gid = "2001"
		fake.groups[name] = &user.Group{Name: name, Gid: gid}
	}
	fake.users[name] = &user.User{Username: name, Uid: "1001", Gid: gid, HomeDir: home}
	return nil
}

func (fake *fakeAccountProvisioner) lchown(_ string, uid, gid int) error {
	fake.chownUIDGID = append(fake.chownUIDGID, [2]int{uid, gid})
	return nil
}

func flagValue(args []string, flag string) string {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == flag {
			return args[index+1]
		}
	}
	return ""
}

func TestSystemAccountsEnsure(t *testing.T) {
	for _, test := range []struct {
		name         string
		unixName     string
		existingGID  string
		existingUser bool
		reruns       int
		wantCommand  []string
		wantUIDGID   [2]int
	}{
		{
			name:        "fresh_name",
			unixName:    "alice",
			reruns:      1,
			wantCommand: []string{"useradd", "--create-home", "--home-dir", "HOME", "--shell", "/bin/sh", "--", "alice"},
			wantUIDGID:  [2]int{1001, 2001},
		},
		{
			name:        "existing_group",
			unixName:    "operator",
			existingGID: "37",
			reruns:      1,
			wantCommand: []string{"useradd", "--create-home", "--home-dir", "HOME", "--shell", "/bin/sh", "--gid", "37", "--", "operator"},
			wantUIDGID:  [2]int{1001, 37},
		},
		{
			name:         "existing_user_idempotent_rerun",
			unixName:     "bob",
			existingUser: true,
			reruns:       2,
			wantUIDGID:   [2]int{3001, 3002},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := filepath.Join(t.TempDir(), test.unixName)
			fake := &fakeAccountProvisioner{
				users:  make(map[string]*user.User),
				groups: make(map[string]*user.Group),
			}
			if test.existingGID != "" {
				fake.groups[test.unixName] = &user.Group{Name: test.unixName, Gid: test.existingGID}
			}
			if test.existingUser {
				fake.users[test.unixName] = &user.User{
					Username: test.unixName,
					Uid:      "3001",
					Gid:      "3002",
					HomeDir:  home,
				}
			}
			accounts := SystemAccounts{
				lookupUser:  fake.lookupUser,
				lookupGroup: fake.lookupGroup,
				run:         fake.run,
				lchown:      fake.lchown,
			}
			for range test.reruns {
				if err := accounts.Ensure(test.unixName, home); err != nil {
					t.Fatal(err)
				}
			}

			wantCommands := [][]string(nil)
			if test.wantCommand != nil {
				command := append([]string(nil), test.wantCommand...)
				command[3] = home
				wantCommands = [][]string{command}
			}
			if !reflect.DeepEqual(fake.commands, wantCommands) {
				t.Fatalf("system commands = %#v; want %#v", fake.commands, wantCommands)
			}
			if len(fake.chownUIDGID) == 0 || fake.chownUIDGID[len(fake.chownUIDGID)-1] != test.wantUIDGID {
				t.Fatalf("last chown uid/gid = %#v; want %#v", fake.chownUIDGID, test.wantUIDGID)
			}
		})
	}
}
