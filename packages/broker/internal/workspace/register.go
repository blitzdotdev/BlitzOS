package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/atomicfile"
	"github.com/blitzdotdev/blitz-core/broker/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

const (
	MintKeyFile       = "mint_key"
	DepositKeyFile    = "deposit_key"
	BrokerFile        = "broker.json"
	KnownHostsFile    = "known_hosts"
	credentialMaxSize = 1_048_576
)

type BrokerConfig struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	Member string `json:"member"`
}

// registerAttempts is how many times key registration is tried before giving
// up. A workspace boots at the same moment its network does, so the first call
// routinely races DNS or a tunnel coming up; one attempt turns that race into
// a workspace with no broker for its whole life, because nothing retries
// afterwards.
const registerAttempts = 3

// registerRetryDelay is the pause between attempts. Deliberately short: this
// runs on the boot path with other services waiting behind it, and the failure
// it covers is a few hundred milliseconds of network, not an outage. An outage
// is what the no-broker path below is for.
const registerRetryDelay = 500 * time.Millisecond

// Register enrols this workspace with the credential broker and points the
// harnesses at it.
//
// It generates the workspace's keypairs and registers only the PUBLIC halves;
// the private halves are written here and never leave. It is idempotent —
// existing keys are reused — so a re-attach does not invalidate the lines the
// broker already has.
//
// NOTHING ABOUT IT IS FATAL BY DESIGN. The broker is optional: no enrolled
// broker, or every broker full, means the feature is off for this box, and the
// right outcome is a workspace that runs signed out with no stale wiring left
// behind. See ErrNoBrokerCapacity.
func Register(ctx context.Context, stateDir string) error {
	origin, err := store.LoadOrigin(stateDir)
	if err != nil {
		return err
	}
	client, err := controlplane.New(origin, stateDir)
	if err != nil {
		return err
	}
	mintPublic, err := ensureKeyPair(stateDir, MintKeyFile)
	if err != nil {
		return err
	}
	depositPublic, err := ensureKeyPair(stateDir, DepositKeyFile)
	if err != nil {
		return err
	}
	keys := []feed.Key{
		{Pubkey: mintPublic, Op: "mint"},
		{Pubkey: depositPublic, Op: "deposit"},
	}
	var registered controlplane.KeyRegistration
	for attempt := 1; ; attempt++ {
		registered, err = client.RegisterKeys(ctx, keys)
		if err == nil || errors.Is(err, controlplane.ErrNoBrokerCapacity) {
			break
		}
		// Not retryable: a refusal is the same refusal next time, and the
		// caller's context going away means the box is shutting down.
		if attempt >= registerAttempts || ctx.Err() != nil {
			break
		}
		timer := time.NewTimer(registerRetryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	if errors.Is(err, controlplane.ErrNoBrokerCapacity) {
		// Remove the wiring rather than leaving it: a broker.json pointing at
		// a box this workspace is no longer a member of would make every mint
		// fail slowly, on a host that has no account for it. Gone is honest.
		return clearBrokerWiring(stateDir)
	}
	if err != nil {
		return err
	}
	knownHost := registered.Host
	if registered.Port != 22 {
		knownHost = "[" + strings.Trim(registered.Host, "[]") + "]:" + strconv.Itoa(registered.Port)
	}
	if err := atomicfile.Write(filepath.Join(stateDir, KnownHostsFile), []byte(knownHost+" "+registered.SSHHostPublicKey+"\n"), 0o600); err != nil {
		return err
	}
	config, err := json.Marshal(BrokerConfig{Host: registered.Host, Port: registered.Port, Member: registered.MemberUnixName})
	if err != nil {
		return err
	}
	if err := atomicfile.Write(filepath.Join(stateDir, BrokerFile), append(config, '\n'), 0o600); err != nil {
		return err
	}
	return wireHarnesses(homeDir(stateDir))
}

// clearBrokerWiring removes everything that says "there is a broker" — the
// config the mint path reads, the pinned host key, and the harness-side
// wiring. The keypairs stay: they are this workspace's identity, they are
// registered nowhere yet, and regenerating them on the next boot would only
// churn.
func clearBrokerWiring(stateDir string) error {
	var failures []error
	for _, name := range []string{BrokerFile, KnownHostsFile} {
		if err := os.Remove(filepath.Join(stateDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
		}
	}
	if err := unwireHarnesses(homeDir(stateDir)); err != nil {
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}

// homeDir is where the workspace account's dotfiles live. The box runs the
// register oneshot with HOME already pointed here, so honour it and fall back
// to the state directory's own home only when it is unset.
func homeDir(stateDir string) string {
	if home := os.Getenv("HOME"); home != "" {
		return home
	}
	return filepath.Join(stateDir, "home")
}

func ensureKeyPair(stateDir, name string) (string, error) {
	if err := store.EnsureDir(stateDir); err != nil {
		return "", err
	}
	privatePath := filepath.Join(stateDir, name)
	publicPath := privatePath + ".pub"
	privateInfo, privateErr := os.Stat(privatePath)
	publicData, publicErr := os.ReadFile(publicPath)
	if privateErr == nil {
		if !privateInfo.Mode().IsRegular() {
			return "", errors.New("SSH private key is not a regular file")
		}
		derived, err := derivePublic(privatePath)
		if err != nil {
			return "", err
		}
		if publicErr == nil {
			if !samePublicKey(derived, string(publicData)) {
				return "", errors.New("SSH public key does not match its private key")
			}
		} else if errors.Is(publicErr, os.ErrNotExist) {
			if err := atomicfile.Write(publicPath, []byte(derived+"\n"), 0o600); err != nil {
				return "", err
			}
		} else {
			return "", publicErr
		}
		if err := os.Chmod(privatePath, 0o600); err != nil {
			return "", err
		}
		if err := os.Chmod(publicPath, 0o600); err != nil {
			return "", err
		}
		return strings.TrimSpace(derived), nil
	}
	if !errors.Is(privateErr, os.ErrNotExist) {
		return "", privateErr
	}
	stage, err := os.MkdirTemp(stateDir, ".keygen-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	stagedPrivate := filepath.Join(stage, "key")
	cmd := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "blitz-credential", "-f", stagedPrivate)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return "", errors.New("ssh-keygen failed")
	}
	privateData, err := os.ReadFile(stagedPrivate)
	if err != nil {
		return "", err
	}
	publicData, err = os.ReadFile(stagedPrivate + ".pub")
	if err != nil {
		return "", err
	}
	public := strings.TrimSpace(string(publicData))
	if !feed.ValidPublicKey(public) {
		return "", errors.New("ssh-keygen produced an invalid public key")
	}
	if err := atomicfile.Write(publicPath, []byte(public+"\n"), 0o600); err != nil {
		return "", err
	}
	if err := atomicfile.Write(privatePath, privateData, 0o600); err != nil {
		return "", err
	}
	return public, nil
}

func derivePublic(privatePath string) (string, error) {
	cmd := exec.Command("ssh-keygen", "-y", "-f", privatePath)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return "", errors.New("existing SSH private key is invalid")
	}
	if output.Len() > credentialMaxSize {
		return "", errors.New("SSH public key is too large")
	}
	public := strings.TrimSpace(output.String())
	if !feed.ValidPublicKey(public) {
		return "", errors.New("existing SSH private key produced an invalid public key")
	}
	return public, nil
}

func samePublicKey(left, right string) bool {
	leftFields := strings.Fields(left)
	rightFields := strings.Fields(right)
	return len(leftFields) >= 2 && len(rightFields) >= 2 && leftFields[0] == rightFields[0] && leftFields[1] == rightFields[1]
}

func LoadBroker(stateDir string) (BrokerConfig, error) {
	data, err := os.ReadFile(filepath.Join(stateDir, BrokerFile))
	if err != nil {
		return BrokerConfig{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var config BrokerConfig
	if err := decoder.Decode(&config); err != nil {
		return BrokerConfig{}, errors.New("invalid broker config")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return BrokerConfig{}, errors.New("invalid broker config")
	}
	if config.Host == "" || strings.ContainsAny(config.Host, " \t\r\n") || config.Port < 1 || config.Port > 65535 || !feed.ValidUnixName(config.Member) {
		return BrokerConfig{}, errors.New("invalid broker config")
	}
	return config, nil
}

func keyPath(stateDir, operation string) (string, error) {
	switch operation {
	case "mint":
		return filepath.Join(stateDir, MintKeyFile), nil
	case "deposit":
		return filepath.Join(stateDir, DepositKeyFile), nil
	default:
		return "", fmt.Errorf("unknown broker operation %q", operation)
	}
}
