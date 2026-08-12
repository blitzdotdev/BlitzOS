package feed

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

const MaxBytes = 1_048_576

var unixNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

type Key struct {
	Pubkey string `json:"pubkey"`
	Op     string `json:"op"`
}

type Member struct {
	UnixName  string   `json:"unixName"`
	Harnesses []string `json:"harnesses"`
	Keys      []Key    `json:"keys"`
}

type Feed struct {
	Version  string
	Members  []Member
	Preserve map[string]bool
	Rejected int
}

func ReadLimited(reader io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, MaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxBytes {
		return nil, errors.New("broker feed exceeds 1 MiB")
	}
	return data, nil
}

func Decode(reader io.Reader) (Feed, error) {
	data, err := ReadLimited(reader)
	if err != nil {
		return Feed{}, err
	}
	var envelope struct {
		Version string            `json:"version"`
		Members []json.RawMessage `json:"members"`
	}
	if err := decodeStrict(data, &envelope); err != nil {
		return Feed{}, errors.New("invalid broker feed")
	}
	if envelope.Version == "" || envelope.Members == nil {
		return Feed{}, errors.New("invalid broker feed")
	}
	result := Feed{Version: envelope.Version, Preserve: make(map[string]bool)}
	seen := make(map[string]bool)
	for _, raw := range envelope.Members {
		var member Member
		if err := decodeStrict(raw, &member); err != nil {
			result.Rejected++
			continue
		}
		validName := unixNamePattern.MatchString(member.UnixName)
		if validName && !validHarnesses(member.Harnesses) {
			result.Preserve[member.UnixName] = true
			result.Rejected++
			continue
		}
		if !validName || !validKeys(member.Keys) || seen[member.UnixName] {
			if validName {
				result.Preserve[member.UnixName] = true
			}
			result.Rejected++
			continue
		}
		seen[member.UnixName] = true
		result.Members = append(result.Members, member)
	}
	return result, nil
}

func ValidUnixName(name string) bool {
	return unixNamePattern.MatchString(name)
}

func ValidHarness(name string) bool {
	return name == "claude" || name == "codex"
}

func validHarnesses(harnesses []string) bool {
	if harnesses == nil {
		return false
	}
	seen := make(map[string]bool)
	for _, harness := range harnesses {
		if !ValidHarness(harness) || seen[harness] {
			return false
		}
		seen[harness] = true
	}
	return true
}

func validKeys(keys []Key) bool {
	if keys == nil {
		return false
	}
	for _, key := range keys {
		if (key.Op != "mint" && key.Op != "deposit") || !ValidPublicKey(key.Pubkey) {
			return false
		}
	}
	return true
}

func ValidPublicKey(publicKey string) bool {
	if strings.ContainsAny(publicKey, "\r\n") {
		return false
	}
	fields := strings.Fields(publicKey)
	if len(fields) < 2 {
		return false
	}
	switch fields[0] {
	case "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com":
	default:
		return false
	}
	_, err := base64.StdEncoding.DecodeString(fields[1])
	return err == nil
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}
