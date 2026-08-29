package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The gateway's half of the webApp ticket contract. The control plane mints
// against this same corpus, so a claim one side starts enforcing and the other
// still ignores fails here rather than quietly changing who may do what on a
// box.

type ticketFixtureContext struct {
	RootSecret     string `json:"rootSecret"`
	WorkspaceID    string `json:"workspaceId"`
	WorkspaceToken string `json:"workspaceToken"`
	NowSeconds     int64  `json:"nowSeconds"`
}

type ticketFixtureExpectation struct {
	Valid        bool   `json:"valid"`
	Kind         string `json:"kind"`
	Role         string `json:"role"`
	UserID       string `json:"userId"`
	MembershipID string `json:"membershipId"`
}

type ticketFixture struct {
	Credential string                   `json:"credential"`
	Expect     ticketFixtureExpectation `json:"expect"`
	Note       string                   `json:"note"`
}

func ticketFixtureDir(t *testing.T) string {
	t.Helper()
	return filepath.Join("..", "..", "schema", "fixtures", "webapp-ticket")
}

func readTicketContext(t *testing.T) ticketFixtureContext {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(ticketFixtureDir(t), "context.json"))
	if err != nil {
		t.Fatalf("read ticket context: %v", err)
	}
	var context ticketFixtureContext
	if err := json.Unmarshal(raw, &context); err != nil {
		t.Fatalf("parse ticket context: %v", err)
	}
	return context
}

func TestWebAppTicketFixtureConformance(t *testing.T) {
	context := readTicketContext(t)
	entries, err := os.ReadDir(filepath.Join(ticketFixtureDir(t), "tickets"))
	if err != nil {
		t.Fatalf("read ticket fixtures: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("no ticket fixtures found")
	}

	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		name := entry.Name()
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(ticketFixtureDir(t), "tickets", name))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			var fixture ticketFixture
			if err := json.Unmarshal(raw, &fixture); err != nil {
				t.Fatalf("parse fixture: %v", err)
			}

			request := httptest.NewRequest(http.MethodGet, "http://box/workspace/", nil)
			if fixture.Credential != "" {
				request.Header.Set(webAppTokenHeader, fixture.Credential)
			}
			identity, allowed := webAppCredential(
				request,
				context.WorkspaceToken,
				context.WorkspaceID,
				context.NowSeconds,
			)

			if !fixture.Expect.Valid {
				if allowed {
					t.Fatalf("%s: accepted a credential every verifier must refuse (%s)", name, fixture.Note)
				}
				return
			}
			if !allowed {
				t.Fatalf("%s: refused a credential every verifier must accept (%s)", name, fixture.Note)
			}
			if identity.Role != fixture.Expect.Role {
				t.Fatalf("%s: role = %q, want %q", name, identity.Role, fixture.Expect.Role)
			}
			if identity.UserID != fixture.Expect.UserID {
				t.Fatalf("%s: userId = %q, want %q", name, identity.UserID, fixture.Expect.UserID)
			}
			if identity.MembershipID != fixture.Expect.MembershipID {
				t.Fatalf("%s: membershipId = %q, want %q", name, identity.MembershipID, fixture.Expect.MembershipID)
			}
		})
	}
}
