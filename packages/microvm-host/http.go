package agent

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

func ReadBearerToken(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("stat token file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return "", fmt.Errorf("token file must be a regular file with mode 0600")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read token file: %w", err)
	}
	token := strings.TrimSpace(string(b))
	if len(token) < 32 || strings.ContainsAny(token, " \t\r\n") {
		return "", fmt.Errorf("token must be at least 32 non-whitespace characters")
	}
	return token, nil
}

type API struct {
	manager *Manager
	token   string
}

func NewHandler(manager *Manager, token string) http.Handler {
	return &API{manager: manager, token: token}
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="blitz-microvm-agent"`)
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	switch {
	case r.URL.Path == "/v1/healthz" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, a.manager.Health(r.Context()))
	case r.URL.Path == "/v1/capacity" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, a.manager.Capacity())
	case r.URL.Path == "/v1/vms" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, a.manager.List())
	case r.URL.Path == "/v1/vms" && r.Method == http.MethodPost:
		a.create(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/vms/") && r.Method == http.MethodDelete:
		a.delete(w, r)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (a *API) authorized(r *http.Request) bool {
	want := "Bearer " + a.token
	got := r.Header.Get("Authorization")
	return len(got) == len(want) && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (a *API) create(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req CreateRequest
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := ensureJSONEOF(dec); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	resp, err := a.manager.Create(r.Context(), req)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalid):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, ErrCapacity):
			writeError(w, http.StatusConflict, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "VM creation failed")
		}
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

func (a *API) delete(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/v1/vms/")
	if id == "" || strings.Contains(id, "/") || !vmIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := a.manager.Delete(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "VM deletion failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func ensureJSONEOF(dec *json.Decoder) error {
	var extra any
	err := dec.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("multiple JSON values")
	}
	return err
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
