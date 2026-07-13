// Command aichat-proxy runs the chat proxy as a standalone service.
//
// It exists so a frontend can be developed against a real provider without the
// host application being ready yet. In production you normally embed
// aichat.NewProxy directly in your own Go server instead of running this.
//
//	AI_PROVIDER=google AI_API_KEY=... go run ./cmd/aichat-proxy
package main

import (
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	aichat "github.com/SebastianBaltes/BaseAIChat/server"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	apiKey := os.Getenv("AI_API_KEY")
	if apiKey == "" {
		log.Error("AI_API_KEY is required")
		os.Exit(1)
	}

	provider := envOr("AI_PROVIDER", "google")
	mountPath := envOr("AI_PROXY_PATH", "/aichat")

	proxy, err := aichat.NewProxy(aichat.Config{
		Provider:      provider,
		APIKey:        apiKey,
		BaseURL:       os.Getenv("AI_BASE_URL"),
		AllowedModels: splitList(os.Getenv("AI_ALLOWED_MODELS")),
		RateLimit:     envInt("AI_RATE_LIMIT", 60),
		RateWindow:    time.Minute,
		Logger:        log,
	})
	if err != nil {
		log.Error("cannot start proxy", "err", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.Handle(mountPath+"/", http.StripPrefix(mountPath, proxy))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// The dev frontend runs on its own Vite origin, so it needs CORS. Set
	// AI_CORS_ORIGIN to that origin (e.g. http://localhost:5173); leave it empty
	// when frontend and proxy are served from the same origin, as in production.
	handler := withCORS(mux, os.Getenv("AI_CORS_ORIGIN"))

	addr := envOr("AI_PROXY_ADDR", ":8090")
	log.Info("aichat proxy listening",
		"addr", addr, "provider", provider, "path", mountPath,
		"allowedModels", envOr("AI_ALLOWED_MODELS", "(all)"))

	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := server.ListenAndServe(); err != nil {
		log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func withCORS(next http.Handler, origin string) http.Handler {
	if origin == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers",
			"Content-Type, Authorization, X-Target-Path, X-CSRF-Token, HTTP-Referer, X-Title, anthropic-version, anthropic-dangerous-direct-browser-access")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return v
}

func splitList(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
