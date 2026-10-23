package mtls

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const TrustDomain = "spiffe://slopdns/"

const DNSServerURIPrefix = TrustDomain + "dns-server/"

var ErrPeerIdentity = errors.New("peer certificate identity not allowed")

type Files struct {
	CA   string
	Cert string
	Key  string
}

type Material struct {
	CAs  *x509.CertPool
	Cert tls.Certificate
}

func FilesIn(dir, name string) Files {
	return Files{
		CA:   filepath.Join(dir, "ca.crt"),
		Cert: filepath.Join(dir, name+".crt"),
		Key:  filepath.Join(dir, name+".key"),
	}
}

func ServiceURI(service string) string {
	return TrustDomain + service
}

func DNSNodeURI(nodeID string) string {
	return DNSServerURIPrefix + nodeID
}

func Load(f Files) (*Material, error) {
	caPEM, err := os.ReadFile(f.CA)
	if err != nil {
		return nil, fmt.Errorf("read CA: %w", err)
	}
	certPEM, err := os.ReadFile(f.Cert)
	if err != nil {
		return nil, fmt.Errorf("read certificate: %w", err)
	}
	keyPEM, err := os.ReadFile(f.Key)
	if err != nil {
		return nil, fmt.Errorf("read key: %w", err)
	}
	return Parse(caPEM, certPEM, keyPEM)
}

func Parse(caPEM, certPEM, keyPEM []byte) (*Material, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("CA bundle contains no certificates")
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("load key pair: %w", err)
	}
	if cert.Leaf == nil {
		leaf, err := x509.ParseCertificate(cert.Certificate[0])
		if err != nil {
			return nil, fmt.Errorf("parse leaf: %w", err)
		}
		cert.Leaf = leaf
	}
	if _, err := cert.Leaf.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err != nil {
		return nil, fmt.Errorf("certificate is not signed by the configured CA: %w", err)
	}
	return &Material{CAs: pool, Cert: cert}, nil
}

type PeerVerifier func(leaf *x509.Certificate) error

func URIs(cert *x509.Certificate) []string {
	out := make([]string, 0, len(cert.URIs))
	for _, u := range cert.URIs {
		out = append(out, u.String())
	}
	return out
}

func AllowURIs(allowed ...string) PeerVerifier {
	return func(leaf *x509.Certificate) error {
		for _, u := range URIs(leaf) {
			if slices.Contains(allowed, u) {
				return nil
			}
		}
		return fmt.Errorf("%w: URI SANs %v, allowed %v", ErrPeerIdentity, URIs(leaf), allowed)
	}
}

func AllowURIPrefix(prefix string) PeerVerifier {
	return func(leaf *x509.Certificate) error {
		for _, u := range URIs(leaf) {
			if rest, ok := strings.CutPrefix(u, prefix); ok && ValidNodeID(rest) {
				return nil
			}
		}
		return fmt.Errorf("%w: URI SANs %v, want prefix %s", ErrPeerIdentity, URIs(leaf), prefix)
	}
}

func DNSNodeID(leaf *x509.Certificate) (string, error) {
	var found []string
	for _, u := range URIs(leaf) {
		if rest, ok := strings.CutPrefix(u, DNSServerURIPrefix); ok && ValidNodeID(rest) {
			found = append(found, rest)
		}
	}
	if len(found) != 1 {
		return "", fmt.Errorf("%w: expected exactly one %s<node-id> URI SAN", ErrPeerIdentity, DNSServerURIPrefix)
	}
	return found[0], nil
}

func ValidNodeID(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
			return false
		}
	}
	return s[0] != '-' && s[len(s)-1] != '-'
}

func ServerConfig(m *Material, verify PeerVerifier) (*tls.Config, error) {
	if verify == nil {
		return nil, errors.New("mtls: server requires a peer verifier")
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{m.Cert},
		ClientCAs:    m.CAs,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		NextProtos:   []string{"h2"},
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return fmt.Errorf("%w: no client certificate", ErrPeerIdentity)
			}
			return verify(cs.PeerCertificates[0])
		},
	}, nil
}

func ClientConfig(m *Material, serverName string, verify PeerVerifier) (*tls.Config, error) {
	if serverName == "" {
		return nil, errors.New("mtls: client requires a server name")
	}
	cfg := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{m.Cert},
		RootCAs:      m.CAs,
		ServerName:   serverName,
		NextProtos:   []string{"h2"},
	}
	if verify != nil {
		cfg.VerifyConnection = func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return fmt.Errorf("%w: no server certificate", ErrPeerIdentity)
			}
			return verify(cs.PeerCertificates[0])
		}
	}
	return cfg, nil
}

func PeerLeaf(cs *tls.ConnectionState) (*x509.Certificate, error) {
	if cs == nil || len(cs.VerifiedChains) == 0 || len(cs.VerifiedChains[0]) == 0 {
		return nil, fmt.Errorf("%w: no verified peer certificate", ErrPeerIdentity)
	}
	return cs.VerifiedChains[0][0], nil
}
