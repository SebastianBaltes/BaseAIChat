package aichat

import (
	"encoding/json"
	"strings"
)

// AuthStyle describes how a provider expects its API credential.
type AuthStyle string

const (
	// AuthBearer sends the key as "Authorization: Bearer <key>".
	AuthBearer AuthStyle = "bearer"
	// AuthQuery sends the key as a "key=<key>" query parameter (Google).
	AuthQuery AuthStyle = "query"
	// AuthHeader sends the key in a provider-specific header (Anthropic: x-api-key).
	AuthHeader AuthStyle = "header"
)

// ModelSource says where the requested model name can be found in a request.
type ModelSource string

const (
	// ModelInBody: the JSON body carries a top-level "model" field.
	ModelInBody ModelSource = "body"
	// ModelInPath: the URL path carries it, e.g. /v1beta/models/<model>:generateContent.
	ModelInPath ModelSource = "path"
)

// Provider is the upstream description the proxy needs in order to talk to one
// LLM vendor. Registering a new vendor means adding one entry to Providers –
// no handler code changes.
type Provider struct {
	BaseURL     string
	Auth        AuthStyle
	AuthHeader  string // only used with AuthHeader
	ModelSource ModelSource
	// ExtraHeaders are set on every upstream request unless the client already
	// sent them (e.g. Anthropic's required API version).
	ExtraHeaders map[string]string
}

// Providers is the built-in registry. Callers may extend or override it via
// Config.Providers.
var Providers = map[string]Provider{
	"google": {
		BaseURL:     "https://generativelanguage.googleapis.com",
		Auth:        AuthQuery,
		ModelSource: ModelInPath,
	},
	"openai": {
		BaseURL:     "https://api.openai.com",
		Auth:        AuthBearer,
		ModelSource: ModelInBody,
	},
	"anthropic": {
		BaseURL:     "https://api.anthropic.com",
		Auth:        AuthHeader,
		AuthHeader:  "x-api-key",
		ModelSource: ModelInBody,
		ExtraHeaders: map[string]string{
			"anthropic-version": "2023-06-01",
		},
	},
	"openrouter": {
		BaseURL:     "https://openrouter.ai/api/v1",
		Auth:        AuthBearer,
		ModelSource: ModelInBody,
	},
}

// modelOf extracts the requested model name from a request, returning "" when
// it cannot be determined (e.g. a non-inference endpoint such as model listing).
func (p Provider) modelOf(path string, body []byte) string {
	switch p.ModelSource {
	case ModelInPath:
		// .../models/<model>:<action>   or   .../models/<model>
		idx := strings.LastIndex(path, "models/")
		if idx < 0 {
			return ""
		}
		rest := path[idx+len("models/"):]
		if colon := strings.Index(rest, ":"); colon >= 0 {
			rest = rest[:colon]
		}
		return strings.Trim(rest, "/")
	default:
		if len(body) == 0 {
			return ""
		}
		var probe struct {
			Model string `json:"model"`
		}
		if err := json.Unmarshal(body, &probe); err != nil {
			return ""
		}
		return probe.Model
	}
}

// modelAllowed reports whether model passes the allowlist. An empty allowlist
// permits everything. Patterns support a trailing "*" wildcard, so
// "gemini-2.5-*" matches "gemini-2.5-flash", and "*" matches anything.
//
// A request whose model cannot be determined ("") is only allowed when the
// allowlist is empty – otherwise a client could bypass the list by hiding the
// model somewhere the proxy does not look.
func modelAllowed(allow []string, model string) bool {
	if len(allow) == 0 {
		return true
	}
	if model == "" {
		return false
	}
	for _, pattern := range allow {
		if pattern == "*" {
			return true
		}
		if strings.HasSuffix(pattern, "*") {
			if strings.HasPrefix(model, strings.TrimSuffix(pattern, "*")) {
				return true
			}
			continue
		}
		if pattern == model {
			return true
		}
	}
	return false
}
