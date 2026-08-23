package controlplane

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

func TestDeviceFlowPendingThenSuccess(t *testing.T) {
	var polls atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := request.ParseForm(); err != nil {
			t.Error(err)
		}
		switch request.URL.Path {
		case "/oauth/device_authorization":
			if request.Form.Get("client_id") != "blitz-cred" {
				t.Errorf("client_id = %q", request.Form.Get("client_id"))
			}
			fmt.Fprintf(writer, `{"device_code":"device","user_code":"ABCD-EFGH","verification_uri":"%s/verify","verification_uri_complete":"%s/verify?user_code=ABCD-EFGH","expires_in":60,"interval":0}`, server.URL, server.URL)
		case "/oauth/token":
			if request.Form.Get("grant_type") != deviceGrant || request.Form.Get("device_code") != "device" || request.Form.Get("client_id") != "blitz-cred" {
				t.Errorf("unexpected token form: %#v", request.Form)
			}
			if polls.Add(1) == 1 {
				writer.WriteHeader(http.StatusBadRequest)
				io.WriteString(writer, `{"error":"authorization_pending"}`)
				return
			}
			io.WriteString(writer, `{"box_id":"box","access_token":"access","refresh_token":"refresh","token_type":"Bearer","expires_in":900}`)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	// The production caller (internal/enroll.Run) hands Enroll a validated
	// origin; go through the same gate here.
	origin, err := ValidateOrigin(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	credential, err := (DeviceFlow{HTTP: server.Client(), Sleep: func(context.Context, time.Duration) error { return nil }}).Enroll(context.Background(), origin, "blitz-cred", &output)
	if err != nil {
		t.Fatal(err)
	}
	if credential != (store.Credential{BoxID: "box", AccessToken: "access", RefreshToken: "refresh"}) {
		t.Fatalf("credential = %#v", credential)
	}
	if output.String() != server.URL+"/verify\nABCD-EFGH\n" {
		t.Fatalf("device output = %q", output.String())
	}
}

func TestFeedETagAnd401RefreshRetry(t *testing.T) {
	stateDir := t.TempDir()
	if err := store.SaveCredential(stateDir, store.Credential{BoxID: "box", AccessToken: "old-access", RefreshToken: "old-refresh"}); err != nil {
		t.Fatal(err)
	}
	var feedCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/oauth/token":
			body, _ := io.ReadAll(request.Body)
			form, _ := url.ParseQuery(string(body))
			if form.Get("grant_type") != "refresh_token" || form.Get("refresh_token") != "old-refresh" {
				t.Errorf("refresh form = %#v", form)
			}
			io.WriteString(writer, `{"box_id":"box","access_token":"new-access","refresh_token":"new-refresh","token_type":"Bearer","expires_in":900}`)
		case "/boxes/box/feed":
			feedCalls.Add(1)
			if request.Header.Get("Authorization") == "Bearer old-access" {
				writer.WriteHeader(http.StatusUnauthorized)
				io.WriteString(writer, `{"secret":"must-not-leak"}`)
				return
			}
			if request.Header.Get("Authorization") != "Bearer new-access" {
				t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
			}
			writer.Header().Set("ETag", `"v1"`)
			if request.Header.Get("If-None-Match") == `"v1"` {
				writer.WriteHeader(http.StatusNotModified)
				return
			}
			io.WriteString(writer, `{"version":"v1","members":[]}`)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client, err := New(server.URL, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	body, etag, unchanged, err := client.FetchFeed(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"version":"v1","members":[]}` || etag != `"v1"` || unchanged {
		t.Fatalf("body=%q etag=%q unchanged=%v", body, etag, unchanged)
	}
	credential, err := store.LoadCredential(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if credential.AccessToken != "new-access" || credential.RefreshToken != "new-refresh" {
		t.Fatalf("credential was not rotated: %#v", credential)
	}
	body, etag, unchanged, err = client.FetchFeed(context.Background(), etag)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil || etag != `"v1"` || !unchanged {
		t.Fatalf("304 result body=%q etag=%q unchanged=%v", body, etag, unchanged)
	}
	if feedCalls.Load() != 3 {
		t.Fatalf("feed calls = %d, want old + retry + 304", feedCalls.Load())
	}
}

func TestOversizedFeedIsRejected(t *testing.T) {
	stateDir := t.TempDir()
	if err := store.SaveCredential(stateDir, store.Credential{BoxID: "box", AccessToken: "access", RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("ETag", `"large"`)
		io.WriteString(writer, strings.Repeat("x", feed.MaxBytes+1))
	}))
	defer server.Close()
	client, err := New(server.URL, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, err = client.FetchFeed(context.Background(), "")
	if err == nil {
		t.Fatal("oversized feed was accepted")
	}
}

func TestHTTPErrorDoesNotEchoResponseBody(t *testing.T) {
	stateDir := t.TempDir()
	if err := store.SaveCredential(stateDir, store.Credential{BoxID: "box", AccessToken: "access", RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusForbidden)
		io.WriteString(writer, `{"access_token":"body-secret"}`)
	}))
	defer server.Close()
	client, err := New(server.URL, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, err = client.FetchFeed(context.Background(), "")
	if err == nil || strings.Contains(err.Error(), "body-secret") {
		t.Fatalf("unsafe error = %v", err)
	}
}

func TestOriginRequiresHTTPSExceptLoopback(t *testing.T) {
	for _, accepted := range []string{"https://cp.example", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"} {
		if _, err := ValidateOrigin(accepted); err != nil {
			t.Errorf("ValidateOrigin(%q): %v", accepted, err)
		}
	}
	for _, rejected := range []string{"http://cp.example", "https://cp.example/path", "https://user@cp.example", "https://cp.example?x=1"} {
		if _, err := ValidateOrigin(rejected); err == nil {
			t.Errorf("ValidateOrigin(%q) succeeded", rejected)
		}
	}
}
