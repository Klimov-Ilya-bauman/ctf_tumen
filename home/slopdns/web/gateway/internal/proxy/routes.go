package proxy

import (
	"net/http"
	"strings"
)

const (
	APIPrefix    = "/api/v1/"
	CookieName   = "slopdns_session"
	CSRFHeader   = "X-SlopDNS-CSRF"
	RealIPHeader = "X-Real-IP"

	SessionTokenPrefix        = "sdses_"
	UserTokenPrefix           = "sdpat_"
	ServiceAccountTokenPrefix = "sdsat_"
)

type Upstream string

const (
	UpstreamIAM     Upstream = "iam"
	UpstreamBackend Upstream = "backend"
)

var routeTable = map[string]Upstream{
	"auth":             UpstreamIAM,
	"users":            UpstreamIAM,
	"service-accounts": UpstreamIAM,
	"role-bindings":    UpstreamIAM,
	"orgs":             UpstreamBackend,
	"zones":            UpstreamBackend,
	"records":          UpstreamBackend,
	"zone-transfers":   UpstreamBackend,
	"invitations":      UpstreamBackend,
}

var publicPaths = map[string]bool{
	APIPrefix + "auth/register":   true,
	APIPrefix + "auth/login":      true,
	APIPrefix + "auth/login/totp": true,
}

var allowedMethods = map[string]bool{
	http.MethodGet:     true,
	http.MethodHead:    true,
	http.MethodPost:    true,
	http.MethodPut:     true,
	http.MethodPatch:   true,
	http.MethodDelete:  true,
	http.MethodOptions: true,
}

func Route(path string) (Upstream, bool) {
	rest, ok := strings.CutPrefix(path, APIPrefix)
	if !ok {
		return "", false
	}
	first, _, _ := strings.Cut(rest, "/")
	u, ok := routeTable[first]
	return u, ok
}

func IsPublic(path string) bool {
	return publicPaths[path]
}

func IsMutating(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	}
	return true
}

func CanonicalRequestURI(requestURI string) bool {
	path, _, _ := strings.Cut(requestURI, "?")
	if path == "" || path[0] != '/' {
		return false
	}
	for i := 0; i < len(path); i++ {
		if !pathByte(path[i]) {
			return false
		}
	}
	if strings.Contains(path, "//") {
		return false
	}
	for _, seg := range strings.Split(path[1:], "/") {
		if seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

func pathByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("-._~!$&'()*+,;=:@/", c) >= 0
}

func CanonicalQuery(raw string) bool {
	for i := 0; i < len(raw); i++ {
		switch raw[i] {
		case ';':
			return false
		case '%':
			if i+2 >= len(raw) || !isHex(raw[i+1]) || !isHex(raw[i+2]) {
				return false
			}
			i += 2
		}
	}
	return true
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}
