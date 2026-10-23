package pki

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"time"

	"slopdns/web/pkg/edkey"
)

const (
	CAValidity   = 10 * 365 * 24 * time.Hour
	LeafValidity = 2 * 365 * 24 * time.Hour
	Organization = "SlopDNS"
	backdate     = 5 * time.Minute
)

type CA struct {
	Cert    *x509.Certificate
	Key     ed25519.PrivateKey
	CertPEM []byte
	KeyPEM  []byte
}

type LeafSpec struct {
	CommonName string
	DNSNames   []string
	URIs       []string
	Server     bool
	Client     bool
	Validity   time.Duration
}

type Leaf struct {
	Cert    *x509.Certificate
	CertPEM []byte
	KeyPEM  []byte
}

func serial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
}

func NewCA(commonName string, validity time.Duration, now time.Time) (*CA, error) {
	if validity <= 0 {
		validity = CAValidity
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	sn, err := serial()
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          sn,
		Subject:               pkix.Name{CommonName: commonName, Organization: []string{Organization}},
		NotBefore:             now.Add(-backdate),
		NotAfter:              now.Add(validity),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, priv)
	if err != nil {
		return nil, err
	}
	keyPEM, err := edkey.MarshalPrivateKeyPEM(priv)
	if err != nil {
		return nil, err
	}
	return ParseCA(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), keyPEM)
}

func ParseCertificatePEM(data []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("no CERTIFICATE PEM block found")
	}
	return x509.ParseCertificate(block.Bytes)
}

func ParseCA(certPEM, keyPEM []byte) (*CA, error) {
	cert, err := ParseCertificatePEM(certPEM)
	if err != nil {
		return nil, fmt.Errorf("CA certificate: %w", err)
	}
	if !cert.IsCA {
		return nil, errors.New("certificate is not a CA")
	}
	key, err := edkey.ParsePrivateKeyPEM(keyPEM)
	if err != nil {
		return nil, fmt.Errorf("CA key: %w", err)
	}
	pub, ok := cert.PublicKey.(ed25519.PublicKey)
	if !ok || !pub.Equal(key.Public()) {
		return nil, errors.New("CA key does not match CA certificate")
	}
	return &CA{Cert: cert, Key: key, CertPEM: certPEM, KeyPEM: keyPEM}, nil
}

func (ca *CA) Issue(spec LeafSpec, now time.Time) (*Leaf, error) {
	if spec.CommonName == "" {
		return nil, errors.New("leaf common name is required")
	}
	if !spec.Server && !spec.Client {
		return nil, errors.New("leaf must allow server or client authentication")
	}
	validity := spec.Validity
	if validity <= 0 {
		validity = LeafValidity
	}
	notAfter := now.Add(validity)
	if notAfter.After(ca.Cert.NotAfter) {
		notAfter = ca.Cert.NotAfter
	}
	uris := make([]*url.URL, 0, len(spec.URIs))
	for _, raw := range spec.URIs {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme == "" {
			return nil, fmt.Errorf("invalid URI SAN %q", raw)
		}
		uris = append(uris, u)
	}
	var usages []x509.ExtKeyUsage
	if spec.Server {
		usages = append(usages, x509.ExtKeyUsageServerAuth)
	}
	if spec.Client {
		usages = append(usages, x509.ExtKeyUsageClientAuth)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	sn, err := serial()
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          sn,
		Subject:               pkix.Name{CommonName: spec.CommonName, Organization: []string{Organization}},
		NotBefore:             now.Add(-backdate),
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           usages,
		BasicConstraintsValid: true,
		DNSNames:              spec.DNSNames,
		URIs:                  uris,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.Cert, pub, ca.Key)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	keyPEM, err := edkey.MarshalPrivateKeyPEM(priv)
	if err != nil {
		return nil, err
	}
	return &Leaf{Cert: cert, CertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), KeyPEM: keyPEM}, nil
}

func (ca *CA) VerifyLeaf(certPEM, keyPEM []byte, now time.Time) error {
	cert, err := ParseCertificatePEM(certPEM)
	if err != nil {
		return err
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca.Cert)
	if _, err := cert.Verify(x509.VerifyOptions{Roots: pool, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err != nil {
		return err
	}
	key, err := edkey.ParsePrivateKeyPEM(keyPEM)
	if err != nil {
		return err
	}
	pub, ok := cert.PublicKey.(ed25519.PublicKey)
	if !ok || !pub.Equal(key.Public()) {
		return errors.New("key does not match certificate")
	}
	return nil
}
