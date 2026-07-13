package aichat

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newTestProxy wires a proxy against a fake upstream and returns both the
// handler and a pointer to the last request the upstream saw.
func newTestProxy(t *testing.T, cfg Config, upstream http.HandlerFunc) (http.Handler, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)

	cfg.BaseURL = server.URL
	if cfg.APIKey == "" {
		cfg.APIKey = "secret-key"
	}
	handler, err := NewProxy(cfg)
	if err != nil {
		t.Fatalf("NewProxy: %v", err)
	}
	return handler, server
}

func post(handler http.Handler, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.RemoteAddr = "10.0.0.1:1234"
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestInjectsBearerKeyAndDropsClientCredentials(t *testing.T) {
	var got *http.Request
	handler, _ := newTestProxy(t, Config{Provider: "openrouter"},
		func(w http.ResponseWriter, r *http.Request) {
			got = r.Clone(r.Context())
			_, _ = w.Write([]byte(`{"ok":true}`))
		})

	rec := post(handler, "/chat/completions", `{"model":"anthropic/claude-sonnet-5"}`, map[string]string{
		"Authorization": "Bearer dummy-key-from-browser",
		"X-Target-Path": "chat/completions",
		"HTTP-Referer":  "http://localhost:5173",
		"X-Title":       "Demo",
		"X-CSRF-Token":  "csrf123",
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body)
	}
	if auth := got.Header.Get("Authorization"); auth != "Bearer secret-key" {
		t.Errorf("Authorization = %q, want the server-side key, not the browser's dummy", auth)
	}
	if got.Header.Get("X-Target-Path") != "" {
		t.Error("X-Target-Path leaked upstream")
	}
	// Ranking headers are the reason OpenRouter attribution works – keep them.
	if got.Header.Get("X-Title") != "Demo" {
		t.Error("X-Title was not forwarded")
	}
}

func TestGoogleUsesQueryKeyAndPathModel(t *testing.T) {
	var gotURL string
	handler, _ := newTestProxy(t, Config{
		Provider:      "google",
		AllowedModels: []string{"gemini-3-flash-preview"},
	}, func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.String()
		_, _ = w.Write([]byte(`{}`))
	})

	rec := post(handler, "/proxy", `{"contents":[]}`, map[string]string{
		"X-Target-Path": "/v1beta/models/gemini-3-flash-preview:streamGenerateContent",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body)
	}
	if !strings.Contains(gotURL, "/v1beta/models/gemini-3-flash-preview:streamGenerateContent") {
		t.Errorf("upstream path = %q, want the target path", gotURL)
	}
	if !strings.Contains(gotURL, "key=secret-key") {
		t.Errorf("upstream URL = %q, want the API key as a query param", gotURL)
	}
}

func TestAnthropicUsesApiKeyHeaderAndVersion(t *testing.T) {
	var got *http.Request
	handler, _ := newTestProxy(t, Config{Provider: "anthropic"},
		func(w http.ResponseWriter, r *http.Request) {
			got = r.Clone(r.Context())
			_, _ = w.Write([]byte(`{}`))
		})

	post(handler, "/v1/messages", `{"model":"claude-sonnet-5"}`, map[string]string{
		"X-Target-Path": "v1/messages",
		"X-Api-Key":     "browser-dummy",
	})

	if key := got.Header.Get("x-api-key"); key != "secret-key" {
		t.Errorf("x-api-key = %q, want the server-side key", key)
	}
	if v := got.Header.Get("anthropic-version"); v != "2023-06-01" {
		t.Errorf("anthropic-version = %q, want the default to be filled in", v)
	}
}

func TestModelAllowlistRejectsUnlistedModel(t *testing.T) {
	called := false
	handler, _ := newTestProxy(t, Config{
		Provider:      "openrouter",
		AllowedModels: []string{"anthropic/claude-haiku-4-5", "google/*"},
	}, func(w http.ResponseWriter, r *http.Request) { called = true })

	rec := post(handler, "/chat/completions", `{"model":"openai/o3-pro"}`, map[string]string{
		"X-Target-Path": "chat/completions",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if called {
		t.Error("upstream was called for a disallowed model")
	}

	rec = post(handler, "/chat/completions", `{"model":"google/gemini-3-flash-preview"}`, map[string]string{
		"X-Target-Path": "chat/completions",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("wildcard match: status = %d, want 200", rec.Code)
	}
}

func TestModelListingWorksWithAnAllowlistSet(t *testing.T) {
	// Inference is POST; GET is metadata. A GET names no model, so checking it
	// against the allowlist would make "which models may I use?" unanswerable
	// through the very proxy that decides the answer.
	handler, _ := newTestProxy(t, Config{
		Provider:      "openrouter",
		AllowedModels: []string{"google/gemini-3-flash-preview"},
	}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"google/gemini-3-flash-preview"}]}`))
	})

	req := httptest.NewRequest(http.MethodGet, "/models", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	req.Header.Set("X-Target-Path", "models")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "gemini-3-flash-preview") {
		t.Errorf("model list was not forwarded: %s", rec.Body)
	}
}

func TestUnknownModelIsRejectedWhenAllowlistIsSet(t *testing.T) {
	handler, _ := newTestProxy(t, Config{
		Provider:      "openrouter",
		AllowedModels: []string{"google/*"},
	}, func(w http.ResponseWriter, r *http.Request) {})

	// No "model" field: the proxy cannot verify it, so it must not pass through.
	rec := post(handler, "/chat/completions", `{"messages":[]}`, map[string]string{
		"X-Target-Path": "chat/completions",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for an unverifiable model", rec.Code)
	}
}

func TestTargetPathCannotEscapeUpstreamOrigin(t *testing.T) {
	handler, _ := newTestProxy(t, Config{Provider: "openrouter"},
		func(w http.ResponseWriter, r *http.Request) {})

	for _, bad := range []string{
		"http://evil.example/steal",
		"//evil.example/steal",
		"../../../admin",
		"/../admin",
	} {
		rec := post(handler, "/proxy", `{"model":"x"}`, map[string]string{"X-Target-Path": bad})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("target path %q: status = %d, want 400", bad, rec.Code)
		}
	}
}

func TestAuthorizeHookBlocksRequest(t *testing.T) {
	handler, _ := newTestProxy(t, Config{
		Provider:  "openrouter",
		Authorize: func(r *http.Request) error { return ErrUnauthorized },
	}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream must not be reached when Authorize fails")
	})

	rec := post(handler, "/chat/completions", `{"model":"x"}`, map[string]string{
		"X-Target-Path": "chat/completions",
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRateLimit(t *testing.T) {
	handler, _ := newTestProxy(t, Config{
		Provider:   "openrouter",
		RateLimit:  2,
		RateWindow: time.Minute,
	}, func(w http.ResponseWriter, r *http.Request) {})

	headers := map[string]string{"X-Target-Path": "chat/completions"}
	for i := 1; i <= 2; i++ {
		if rec := post(handler, "/p", `{"model":"x"}`, headers); rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200", i, rec.Code)
		}
	}
	rec := post(handler, "/p", `{"model":"x"}`, headers)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("third request: status = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("429 response is missing Retry-After")
	}
}

func TestBodySizeLimit(t *testing.T) {
	handler, _ := newTestProxy(t, Config{
		Provider:     "openrouter",
		MaxBodyBytes: 64,
	}, func(w http.ResponseWriter, r *http.Request) {
		t.Error("upstream must not see an oversized body")
	})

	big := `{"model":"x","pad":"` + strings.Repeat("a", 200) + `"}`
	rec := post(handler, "/p", big, map[string]string{"X-Target-Path": "chat/completions"})
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestStreamsChunksAsTheyArrive(t *testing.T) {
	release := make(chan struct{})
	handler, _ := newTestProxy(t, Config{Provider: "openrouter"},
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			flusher := w.(http.Flusher)
			_, _ = io.WriteString(w, "data: first\n\n")
			flusher.Flush()
			<-release // hold the connection open after the first chunk
			_, _ = io.WriteString(w, "data: second\n\n")
		})

	front := httptest.NewServer(handler)
	defer front.Close()

	req, err := http.NewRequest(http.MethodPost, front.URL+"/p", strings.NewReader(`{"model":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Target-Path", "chat/completions")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// The first chunk must be readable while the upstream is still writing –
	// that is the difference between a streaming chat and a frozen one.
	first := make([]byte, len("data: first\n\n"))
	if _, err := io.ReadFull(resp.Body, first); err != nil {
		t.Fatalf("first chunk was buffered instead of flushed: %v", err)
	}
	if string(first) != "data: first\n\n" {
		t.Fatalf("first chunk = %q", first)
	}

	close(release)
	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rest), "second") {
		t.Errorf("second chunk never arrived, got %q", rest)
	}
}

func TestNewProxyValidatesConfig(t *testing.T) {
	if _, err := NewProxy(Config{Provider: "google"}); err == nil {
		t.Error("expected an error when APIKey is missing")
	}
	if _, err := NewProxy(Config{Provider: "nonsense", APIKey: "k"}); err == nil {
		t.Error("expected an error for an unknown provider without BaseURL")
	}
	if _, err := NewProxy(Config{Provider: "nonsense", APIKey: "k", BaseURL: "https://gateway.internal"}); err != nil {
		t.Errorf("unknown provider with BaseURL should work: %v", err)
	}
}
