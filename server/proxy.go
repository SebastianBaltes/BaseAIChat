// Package aichat provides the server half of a reusable chat component:
// an HTTP proxy that lets a browser-side AI SDK talk to an LLM provider
// without the API key ever reaching the client.
//
// The browser sends its provider-shaped request to this handler; the handler
// checks it against the configured guardrails (auth hook, rate limit, body
// size, model allowlist), injects the credential server-side, and streams the
// upstream response back untouched.
//
// Embed it in an existing Go server:
//
//	proxy, err := aichat.NewProxy(aichat.Config{
//	    Provider:      "google",
//	    APIKey:        os.Getenv("AI_API_KEY"),
//	    AllowedModels: []string{"gemini-3-flash-preview"},
//	    Authorize:     func(r *http.Request) error { return mySession.Check(r) },
//	})
//	mux.Handle("/aichat/", http.StripPrefix("/aichat", proxy))
package aichat

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// TargetPathHeader lets the browser tell the proxy which upstream endpoint it
// means, without that path being part of the proxy's own URL. The AI SDK builds
// provider-specific paths (e.g. "/v1beta/models/x:streamGenerateContent"); the
// client sends them here so the host app can mount the proxy anywhere.
const TargetPathHeader = "X-Target-Path"

// ErrUnauthorized can be returned by Config.Authorize to reject a request with
// 401 instead of the default 403.
var ErrUnauthorized = errors.New("unauthorized")

// Config configures a proxy handler. Only Provider (or BaseURL) and APIKey are
// required; every other field has a usable default.
type Config struct {
	// Provider selects an entry from the provider registry ("google", "openai",
	// "anthropic", "openrouter").
	Provider string
	// APIKey is injected server-side on every upstream request.
	APIKey string
	// BaseURL overrides the provider's default upstream base URL. Required when
	// Provider is not in the registry (e.g. a self-hosted gateway).
	BaseURL string
	// Providers overrides or extends the built-in registry.
	Providers map[string]Provider

	// AllowedModels restricts which models clients may request. Entries may end
	// in "*" to match a prefix. Empty means "no restriction" – which also means
	// a client could request your most expensive model, so set it in production.
	AllowedModels []string

	// MaxBodyBytes caps the request body (default 4 MiB). Chat histories with
	// inline images get large, so this is generous by design.
	MaxBodyBytes int64
	// Timeout bounds a single upstream request (default 5 min). Long tool-calling
	// turns with reasoning models can legitimately run for minutes.
	Timeout time.Duration

	// RateLimit is the number of requests one client may make per RateWindow.
	// Zero disables rate limiting.
	RateLimit int
	// RateWindow defaults to one minute.
	RateWindow time.Duration
	// ClientKey identifies the caller for rate limiting (default: remote IP).
	// Host apps with sessions should key on the user ID instead.
	ClientKey func(*http.Request) string
	// TrustForwardedFor makes the default ClientKey read X-Forwarded-For. Only
	// enable it behind a reverse proxy you control: any client can set that
	// header itself, and a rotating value defeats the rate limiter.
	TrustForwardedFor bool

	// Authorize runs before anything else. Return a non-nil error to reject the
	// request; return ErrUnauthorized for a 401. Nil means the proxy is open to
	// anyone who can reach it.
	Authorize func(*http.Request) error

	// Logger defaults to slog.Default().
	Logger *slog.Logger
	// Client is the HTTP client used upstream (default: a client with Timeout).
	Client *http.Client
}

// hopByHop headers are connection-scoped and must not be forwarded.
// The client's Authorization is dropped too: the browser sends a dummy key
// (the AI SDKs insist on one) and the real credential is injected here.
var hopByHop = map[string]bool{
	"connection":                      true,
	"keep-alive":                      true,
	"proxy-authenticate":              true,
	"proxy-authorization":             true,
	"te":                              true,
	"trailer":                         true,
	"transfer-encoding":               true,
	"upgrade":                         true,
	"host":                            true,
	"content-length":                  true,
	"authorization":                   true,
	"x-api-key":                       true,
	strings.ToLower(TargetPathHeader): true,
}

type proxy struct {
	provider Provider
	cfg      Config
	limiter  *rateLimiter
	log      *slog.Logger
	client   *http.Client
	baseURL  *url.URL
}

// NewProxy validates cfg and returns the handler.
func NewProxy(cfg Config) (http.Handler, error) {
	registry := Providers
	if cfg.Providers != nil {
		registry = cfg.Providers
	}
	provider, known := registry[cfg.Provider]
	if !known {
		if cfg.BaseURL == "" {
			return nil, fmt.Errorf("aichat: unknown provider %q and no BaseURL given", cfg.Provider)
		}
		// Unknown provider with an explicit BaseURL: assume an OpenAI-compatible
		// gateway, which is what almost every such endpoint speaks.
		provider = Provider{Auth: AuthBearer, ModelSource: ModelInBody}
	}
	if cfg.BaseURL != "" {
		provider.BaseURL = cfg.BaseURL
	}
	if cfg.APIKey == "" {
		return nil, errors.New("aichat: APIKey is required")
	}

	base, err := url.Parse(strings.TrimRight(provider.BaseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("aichat: invalid BaseURL %q: %w", provider.BaseURL, err)
	}

	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = 4 << 20
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Minute
	}
	if cfg.RateWindow <= 0 {
		cfg.RateWindow = time.Minute
	}
	if cfg.ClientKey == nil {
		trustXFF := cfg.TrustForwardedFor
		cfg.ClientKey = func(r *http.Request) string { return clientIP(r, trustXFF) }
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	client := cfg.Client
	if client == nil {
		client = &http.Client{Timeout: cfg.Timeout}
	}

	p := &proxy{
		provider: provider,
		cfg:      cfg,
		log:      cfg.Logger,
		client:   client,
		baseURL:  base,
	}
	if cfg.RateLimit > 0 {
		p.limiter = newRateLimiter(cfg.RateLimit, cfg.RateWindow)
	}
	return p, nil
}

func (p *proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if p.cfg.Authorize != nil {
		if err := p.cfg.Authorize(r); err != nil {
			status := http.StatusForbidden
			if errors.Is(err, ErrUnauthorized) {
				status = http.StatusUnauthorized
			}
			writeError(w, status, err.Error())
			return
		}
	}

	if p.limiter != nil && !p.limiter.allow(p.cfg.ClientKey(r)) {
		w.Header().Set("Retry-After", fmt.Sprint(int(p.cfg.RateWindow.Seconds())))
		writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, p.cfg.MaxBodyBytes))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("request body exceeds %d bytes", p.cfg.MaxBodyBytes))
		return
	}

	targetPath, err := resolveTargetPath(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	model := p.provider.modelOf(targetPath, body)
	if !modelAllowed(p.cfg.AllowedModels, model) {
		p.log.Warn("aichat: model rejected", "model", model, "path", targetPath)
		writeError(w, http.StatusForbidden, fmt.Sprintf("model %q is not allowed", model))
		return
	}

	upstream, err := p.buildUpstreamRequest(r, targetPath, body)
	if err != nil {
		p.log.Error("aichat: cannot build upstream request", "err", err)
		writeError(w, http.StatusInternalServerError, "cannot build upstream request")
		return
	}

	resp, err := p.client.Do(upstream)
	if err != nil {
		p.log.Error("aichat: upstream failed", "err", err, "model", model)
		writeError(w, http.StatusBadGateway, "upstream request failed")
		return
	}
	defer resp.Body.Close()

	for key, values := range resp.Header {
		if hopByHop[strings.ToLower(key)] {
			continue
		}
		for _, v := range values {
			w.Header().Add(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	p.stream(w, resp.Body)
}

// stream copies the upstream body to the client, flushing after every chunk so
// server-sent events arrive token by token instead of in one lump at the end.
func (p *proxy) stream(w http.ResponseWriter, body io.Reader) {
	flusher, canFlush := w.(http.Flusher)
	buf := make([]byte, 8<<10)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return // client hung up
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if err != nil {
			if err != io.EOF {
				p.log.Warn("aichat: stream interrupted", "err", err)
			}
			return
		}
	}
}

func (p *proxy) buildUpstreamRequest(r *http.Request, targetPath string, body []byte) (*http.Request, error) {
	target := *p.baseURL
	target.Path = strings.TrimRight(p.baseURL.Path, "/") + "/" + targetPath

	query := target.Query()
	for key, values := range r.URL.Query() {
		for _, v := range values {
			query.Set(key, v)
		}
	}
	if p.provider.Auth == AuthQuery {
		query.Set("key", p.cfg.APIKey)
	}
	target.RawQuery = query.Encode()

	ctx := r.Context()
	upstream, err := http.NewRequestWithContext(ctx, r.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	for key, values := range r.Header {
		if hopByHop[strings.ToLower(key)] {
			continue
		}
		for _, v := range values {
			upstream.Header.Add(key, v)
		}
	}
	for key, value := range p.provider.ExtraHeaders {
		if upstream.Header.Get(key) == "" {
			upstream.Header.Set(key, value)
		}
	}

	switch p.provider.Auth {
	case AuthBearer:
		upstream.Header.Set("Authorization", "Bearer "+p.cfg.APIKey)
	case AuthHeader:
		upstream.Header.Set(p.provider.AuthHeader, p.cfg.APIKey)
	}

	return upstream, nil
}

// resolveTargetPath determines the upstream path from the X-Target-Path header,
// falling back to the request's own path when the proxy is mounted with
// http.StripPrefix. The result is cleaned and confined: a client must not be
// able to escape the provider's base path or point the proxy at another host.
func resolveTargetPath(r *http.Request) (string, error) {
	raw := r.Header.Get(TargetPathHeader)
	if raw == "" {
		raw = r.URL.Path
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("missing target path")
	}
	if strings.Contains(raw, "://") || strings.HasPrefix(raw, "//") {
		return "", errors.New("target path must be relative")
	}
	if strings.ContainsAny(raw, "\r\n") {
		return "", errors.New("target path contains control characters")
	}

	// Reject ".." outright rather than letting path.Clean quietly resolve it:
	// no AI SDK ever emits a traversal segment, so one means the client is
	// probing, and a silently rewritten path is a bad thing to forward.
	for _, segment := range strings.Split(raw, "/") {
		if segment == ".." {
			return "", errors.New("target path must not contain '..'")
		}
	}

	cleaned := path.Clean("/" + strings.TrimPrefix(raw, "/"))
	if cleaned == "/" {
		return "", errors.New("invalid target path")
	}
	return strings.TrimPrefix(cleaned, "/"), nil
}

func clientIP(r *http.Request, trustForwardedFor bool) string {
	if trustForwardedFor {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			first, _, _ := strings.Cut(forwarded, ",")
			return strings.TrimSpace(first)
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// The AI SDKs surface this body in the browser console, so keep it shaped
	// like a provider error rather than plain text.
	fmt.Fprintf(w, `{"error":{"type":"proxy_error","message":%q}}`, message)
}
