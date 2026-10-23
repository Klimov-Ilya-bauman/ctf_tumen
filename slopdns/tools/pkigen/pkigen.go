package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"time"

	"slopdns/web/pkg/edkey"
	"slopdns/web/pkg/mtls"
	"slopdns/web/pkg/pki"
)

const (
	dirMode     = 0o700
	privateMode = 0o600
	publicMode  = 0o644
	totpKeySize = 32
)

type leafDef struct {
	dir  string
	name string
	spec pki.LeafSpec
}

type signingKeyDef struct {
	owner     string
	name      string
	consumers []string
}

type Generator struct {
	Dir    string
	NodeID string
	Now    func() time.Time
	Out    io.Writer

	created []string
	kept    []string
	removed []string
}

func (g *Generator) leaves() []leafDef {
	return []leafDef{
		{"iam", "iam", pki.LeafSpec{CommonName: "iam", DNSNames: []string{"iam"}, URIs: []string{mtls.ServiceURI("iam")}, Server: true, Client: true}},
		{"backend", "backend", pki.LeafSpec{CommonName: "backend", DNSNames: []string{"backend"}, URIs: []string{mtls.ServiceURI("backend")}, Server: true, Client: true}},
		{"gateway", "gateway", pki.LeafSpec{CommonName: "gateway", URIs: []string{mtls.ServiceURI("gateway")}, Client: true}},
		{"dns-sync", "dns-sync", pki.LeafSpec{CommonName: "dns-sync", DNSNames: []string{"dns-sync"}, URIs: []string{mtls.ServiceURI("dns-sync")}, Server: true}},
		{"dns-server", "dns-server", pki.LeafSpec{CommonName: "dns-" + g.NodeID, URIs: []string{mtls.DNSNodeURI(g.NodeID)}, Client: true}},
	}
}

func (g *Generator) signingKeys() []signingKeyDef {
	return []signingKeyDef{
		{owner: "iam", name: "iam-assertion", consumers: []string{"backend"}},
		{owner: "dns-sync", name: "backend-sync", consumers: []string{"dns-server"}},
		{owner: "dns-server", name: "dns-" + g.NodeID, consumers: []string{"dns-sync"}},
	}
}

func ServiceDirs() []string {
	return []string{"ca", "iam", "backend", "gateway", "dns-sync", "dns-server"}
}

func (g *Generator) path(parts ...string) string {
	return filepath.Join(append([]string{g.Dir}, parts...)...)
}

func (g *Generator) rel(path string) string {
	r, err := filepath.Rel(g.Dir, path)
	if err != nil {
		return path
	}
	return r
}

func exists(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func writeNew(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".pkigen-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Link(tmpName, path)
}

func (g *Generator) create(path string, data []byte, mode os.FileMode) error {
	if err := writeNew(path, data, mode); err != nil {
		return fmt.Errorf("write %s: %w", g.rel(path), err)
	}
	g.created = append(g.created, g.rel(path))
	return nil
}

func (g *Generator) ensureCopy(path string, data []byte, mode os.FileMode) error {
	ok, err := exists(path)
	if err != nil {
		return err
	}
	if !ok {
		return g.create(path, data, mode)
	}
	cur, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(cur, data) {
		return fmt.Errorf("%s does not match its source, refusing to overwrite", g.rel(path))
	}
	g.kept = append(g.kept, g.rel(path))
	return nil
}

func (g *Generator) pair(certPath, keyPath string) (bool, error) {
	certOK, err := exists(certPath)
	if err != nil {
		return false, err
	}
	keyOK, err := exists(keyPath)
	if err != nil {
		return false, err
	}
	if certOK != keyOK {
		return false, fmt.Errorf("only one of %s and %s exists, refusing to regenerate", g.rel(certPath), g.rel(keyPath))
	}
	return certOK, nil
}

func (g *Generator) ensureCA() (*pki.CA, error) {
	certPath, keyPath := g.path("ca", "ca.crt"), g.path("ca", "ca.key")
	have, err := g.pair(certPath, keyPath)
	if err != nil {
		return nil, err
	}
	if have {
		certPEM, err := os.ReadFile(certPath)
		if err != nil {
			return nil, err
		}
		keyPEM, err := os.ReadFile(keyPath)
		if err != nil {
			return nil, err
		}
		ca, err := pki.ParseCA(certPEM, keyPEM)
		if err != nil {
			return nil, fmt.Errorf("existing CA: %w", err)
		}
		g.kept = append(g.kept, g.rel(certPath), g.rel(keyPath))
		return ca, nil
	}
	ca, err := pki.NewCA("SlopDNS Internal CA", pki.CAValidity, g.Now())
	if err != nil {
		return nil, err
	}
	if err := g.create(keyPath, ca.KeyPEM, privateMode); err != nil {
		return nil, err
	}
	if err := g.create(certPath, ca.CertPEM, publicMode); err != nil {
		return nil, err
	}
	return ca, nil
}

func (g *Generator) ensureLeaf(ca *pki.CA, def leafDef) error {
	certPath, keyPath := g.path(def.dir, def.name+".crt"), g.path(def.dir, def.name+".key")
	have, err := g.pair(certPath, keyPath)
	if err != nil {
		return err
	}
	if have {
		if err := g.checkLeaf(ca, def, certPath, keyPath); err != nil {
			return err
		}
		g.kept = append(g.kept, g.rel(certPath), g.rel(keyPath))
		return nil
	}
	leaf, err := ca.Issue(def.spec, g.Now())
	if err != nil {
		return err
	}
	if err := g.create(keyPath, leaf.KeyPEM, privateMode); err != nil {
		return err
	}
	return g.create(certPath, leaf.CertPEM, publicMode)
}

func (g *Generator) ensureSigningKey(def signingKeyDef) error {
	keyPath := g.path(def.owner, def.name+".key")
	ok, err := exists(keyPath)
	if err != nil {
		return err
	}
	var priv ed25519.PrivateKey
	if ok {
		priv, err = edkey.LoadPrivateKey(keyPath)
		if err != nil {
			return err
		}
		g.kept = append(g.kept, g.rel(keyPath))
	} else {
		_, priv, err = ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		keyPEM, err := edkey.MarshalPrivateKeyPEM(priv)
		if err != nil {
			return err
		}
		if err := g.create(keyPath, keyPEM, privateMode); err != nil {
			return err
		}
	}
	pubPEM, err := edkey.MarshalPublicKeyPEM(priv.Public().(ed25519.PublicKey))
	if err != nil {
		return err
	}
	for _, dir := range append([]string{def.owner}, def.consumers...) {
		if err := g.ensureCopy(g.path(dir, def.name+".pub"), pubPEM, publicMode); err != nil {
			return err
		}
	}
	return nil
}

func (g *Generator) ensureTOTPKey() error {
	path := g.path("iam", "iam-totp.key")
	ok, err := exists(path)
	if err != nil {
		return err
	}
	if ok {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		raw, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(data)))
		if err != nil || len(raw) != totpKeySize {
			return fmt.Errorf("existing %s is not a base64-encoded %d-byte key", g.rel(path), totpKeySize)
		}
		g.kept = append(g.kept, g.rel(path))
		return nil
	}
	key := make([]byte, totpKeySize)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	return g.create(path, []byte(base64.StdEncoding.EncodeToString(key)+"\n"), privateMode)
}

func (g *Generator) Run() error {
	if g.Dir == "" {
		return errors.New("output directory is required")
	}
	if !mtls.ValidNodeID(g.NodeID) {
		return fmt.Errorf("invalid DNS node id %q: use 1-63 lower-case letters, digits and inner hyphens", g.NodeID)
	}
	if g.Now == nil {
		g.Now = time.Now
	}
	if g.Out == nil {
		g.Out = io.Discard
	}
	g.created, g.kept, g.removed = nil, nil, nil
	if err := g.preflight(); err != nil {
		return err
	}
	for _, d := range ServiceDirs() {
		if err := os.MkdirAll(g.path(d), dirMode); err != nil {
			return err
		}
	}
	ca, err := g.ensureCA()
	if err != nil {
		return err
	}
	for _, d := range ServiceDirs()[1:] {
		if err := g.ensureCopy(g.path(d, "ca.crt"), ca.CertPEM, publicMode); err != nil {
			return err
		}
	}
	for _, def := range g.leaves() {
		if err := g.ensureLeaf(ca, def); err != nil {
			return err
		}
	}
	if err := g.migrateLegacySyncKeys(); err != nil {
		return err
	}
	for _, def := range g.signingKeys() {
		if err := g.ensureSigningKey(def); err != nil {
			return err
		}
	}
	if err := g.ensureTOTPKey(); err != nil {
		return err
	}
	sort.Strings(g.created)
	for _, p := range g.created {
		_, _ = fmt.Fprintf(g.Out, "created %s\n", p)
	}
	for _, p := range g.removed {
		_, _ = fmt.Fprintf(g.Out, "removed legacy %s\n", p)
	}
	_, _ = fmt.Fprintf(g.Out, "pkigen: %d files created, %d kept in %s\n", len(g.created), len(g.kept), g.Dir)
	return nil
}

func expectedEKU(spec pki.LeafSpec) []x509.ExtKeyUsage {
	var out []x509.ExtKeyUsage
	if spec.Server {
		out = append(out, x509.ExtKeyUsageServerAuth)
	}
	if spec.Client {
		out = append(out, x509.ExtKeyUsageClientAuth)
	}
	return out
}

func sortedEqual(a, b []string) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}

func matchIdentity(cert *x509.Certificate, spec pki.LeafSpec) error {
	if cert.IsCA {
		return errors.New("certificate is a CA")
	}
	if cert.PublicKeyAlgorithm != x509.Ed25519 {
		return fmt.Errorf("key type %v, want Ed25519", cert.PublicKeyAlgorithm)
	}
	if cert.Subject.CommonName != spec.CommonName {
		return fmt.Errorf("common name %q, want %q", cert.Subject.CommonName, spec.CommonName)
	}
	if !sortedEqual(cert.DNSNames, spec.DNSNames) {
		return fmt.Errorf("DNS SANs %v, want %v", cert.DNSNames, spec.DNSNames)
	}
	if !sortedEqual(mtls.URIs(cert), spec.URIs) {
		return fmt.Errorf("URI SANs %v, want %v", mtls.URIs(cert), spec.URIs)
	}
	if len(cert.IPAddresses) != 0 || len(cert.EmailAddresses) != 0 {
		return errors.New("unexpected IP or email SANs")
	}
	want := expectedEKU(spec)
	got := slices.Clone(cert.ExtKeyUsage)
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) || len(cert.UnknownExtKeyUsage) != 0 {
		return fmt.Errorf("extended key usages %v, want %v", cert.ExtKeyUsage, want)
	}
	return nil
}

func (g *Generator) remove(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", g.rel(path), err)
	}
	g.removed = append(g.removed, g.rel(path))
	return nil
}

func (g *Generator) migrateLegacySyncKeys() error {
	legacyKey := g.path("backend", "backend-sync.key")
	have, err := exists(legacyKey)
	if err != nil {
		return err
	}
	if have {
		legacy, err := os.ReadFile(legacyKey)
		if err != nil {
			return err
		}
		if _, err := edkey.ParsePrivateKeyPEM(legacy); err != nil {
			return fmt.Errorf("legacy %s: %w", g.rel(legacyKey), err)
		}
		if err := g.ensureCopy(g.path("dns-sync", "backend-sync.key"), legacy, privateMode); err != nil {
			return err
		}
		if err := g.remove(legacyKey); err != nil {
			return err
		}
	}
	matches, err := filepath.Glob(g.path("backend", "backend-sync.pub"))
	if err != nil {
		return err
	}
	nodePubs, err := filepath.Glob(g.path("backend", "dns-*.pub"))
	if err != nil {
		return err
	}
	for _, p := range append(matches, nodePubs...) {
		if err := g.remove(p); err != nil {
			return err
		}
	}
	return nil
}
