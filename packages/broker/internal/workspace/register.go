package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

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

func Register(ctx context.Context, stateDir string, httpClient *http.Client) error {
	origin, err := store.LoadOrigin(stateDir)
	if err != nil {
		return err
	}
	client, err := controlplane.New(origin, stateDir, httpClient)
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
	registered, err := client.RegisterKeys(ctx, []feed.Key{
		{Pubkey: mintPublic, Op: "mint"},
		{Pubkey: depositPublic, Op: "deposit"},
	})
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
	return atomicfile.Write(filepath.Join(stateDir, BrokerFile), append(config, '\n'), 0o600)
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
