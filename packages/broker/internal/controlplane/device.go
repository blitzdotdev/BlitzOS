package controlplane

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code"

type DeviceFlow struct {
	HTTP  *http.Client
	Sleep func(context.Context, time.Duration) error
}

type deviceAuthorization struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

func (flow DeviceFlow) Enroll(ctx context.Context, rawOrigin, clientID string, output io.Writer) (store.Credential, error) {
	origin, err := ValidateOrigin(rawOrigin)
	if err != nil {
		return store.Credential{}, err
	}
	if clientID == "" {
		return store.Credential{}, errors.New("client_id is required")
	}
	httpClient := flow.HTTP
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	sleep := flow.Sleep
	if sleep == nil {
		sleep = sleepContext
	}
	authorization, err := requestDeviceAuthorization(ctx, httpClient, origin, clientID)
	if err != nil {
		return store.Credential{}, err
	}
	if _, err := fmt.Fprintf(output, "%s\n%s\n", authorization.VerificationURI, authorization.UserCode); err != nil {
		return store.Credential{}, err
	}
	interval := time.Duration(authorization.Interval) * time.Second
	deadline := time.Now().Add(time.Duration(authorization.ExpiresIn) * time.Second)
	for {
		if !time.Now().Before(deadline) {
			return store.Credential{}, errors.New("device authorization expired")
		}
		if err := sleep(ctx, interval); err != nil {
			return store.Credential{}, err
		}
		issued, pending, slowDown, err := pollDeviceToken(ctx, httpClient, origin, clientID, authorization.DeviceCode)
		if err != nil {
			return store.Credential{}, err
		}
		if pending {
			if slowDown {
				interval += 5 * time.Second
			}
			continue
		}
		return store.Credential{BoxID: issued.BoxID, AccessToken: issued.AccessToken, RefreshToken: issued.RefreshToken}, nil
	}
}

func requestDeviceAuthorization(ctx context.Context, client *http.Client, origin, clientID string) (deviceAuthorization, error) {
	response, err := postForm(ctx, client, origin+"/oauth/device_authorization", url.Values{"client_id": {clientID}})
	if err != nil {
		return deviceAuthorization{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return deviceAuthorization{}, statusError(response.StatusCode, "device authorization failed")
	}
	data, err := readLimited(response.Body, responseMaxBytes)
	if err != nil {
		return deviceAuthorization{}, err
	}
	var authorization deviceAuthorization
	if err := decodeStrict(data, &authorization); err != nil || authorization.DeviceCode == "" || authorization.UserCode == "" || authorization.VerificationURI == "" || authorization.VerificationURIComplete == "" || authorization.ExpiresIn <= 0 || authorization.Interval < 0 {
		return deviceAuthorization{}, errors.New("invalid device authorization response")
	}
	if _, err := url.ParseRequestURI(authorization.VerificationURI); err != nil {
		return deviceAuthorization{}, errors.New("invalid verification URI")
	}
	return authorization, nil
}

func pollDeviceToken(ctx context.Context, client *http.Client, origin, clientID, deviceCode string) (issuedTokens, bool, bool, error) {
	response, err := postForm(ctx, client, origin+"/oauth/token", url.Values{
		"grant_type":  {deviceGrant},
		"device_code": {deviceCode},
		"client_id":   {clientID},
	})
	if err != nil {
		return issuedTokens{}, false, false, err
	}
	defer response.Body.Close()
	data, err := readLimited(response.Body, responseMaxBytes)
	if err != nil {
		return issuedTokens{}, false, false, err
	}
	if response.StatusCode == http.StatusOK {
		issued, err := decodeIssued(data)
		return issued, false, false, err
	}
	var oauthError struct {
		Error string `json:"error"`
	}
	if err := decodeStrict(data, &oauthError); err == nil {
		switch oauthError.Error {
		case "authorization_pending":
			return issuedTokens{}, true, false, nil
		case "slow_down":
			return issuedTokens{}, true, true, nil
		}
	}
	return issuedTokens{}, false, false, statusError(response.StatusCode, "device token request failed")
}

func postForm(ctx context.Context, client *http.Client, endpoint string, values url.Values) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return client.Do(request)
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
