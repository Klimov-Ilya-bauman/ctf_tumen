package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"

	"slopdns/web/pkg/edkey"
	"slopdns/web/pkg/pki"
)

func (g *Generator) preflight() error {
	ca, err := g.preflightCA()
	if err != nil {
		return err
	}
	for _, d := range ServiceDirs()[1:] {
		path := g.path(d, "ca.crt")
		ok, err := exists(path)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		if ca == nil {
			return fmt.Errorf("%s exists but the CA is missing, refusing to create a new CA", g.rel(path))
		}
		if err := g.sameContent(path, ca.CertPEM); err != nil {
			return err
		}
	}
	for _, def := range g.leaves() {
		if err := g.preflightLeaf(ca, def); err != nil {
			return err
		}
	}
	legacy, err := g.preflightLegacy()
	if err != nil {
		return err
	}
	for _, def := range g.signingKeys() {
		if err := g.preflightSigningKey(def, legacy); err != nil {
			return err
		}
	}
	return g.preflightTOTP()
}

func (g *Generator) sameContent(path string, want []byte) error {
	cur, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(cur, want) {
		return fmt.Errorf("%s does not match its source, refusing to overwrite", g.rel(path))
	}
	return nil
}

func (g *Generator) preflightCA() (*pki.CA, error) {
	certPath, keyPath := g.path("ca", "ca.crt"), g.path("ca", "ca.key")
	have, err := g.pair(certPath, keyPath)
	if err != nil || !have {
		return nil, err
	}
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
	return ca, nil
}

func (g *Generator) preflightLeaf(ca *pki.CA, def leafDef) error {
	certPath, keyPath := g.path(def.dir, def.name+".crt"), g.path(def.dir, def.name+".key")
	have, err := g.pair(certPath, keyPath)
	if err != nil || !have {
		return err
	}
	if ca == nil {
		return fmt.Errorf("%s exists but the CA is missing, refusing to create a new CA", g.rel(certPath))
	}
	return g.checkLeaf(ca, def, certPath, keyPath)
}

func (g *Generator) checkLeaf(ca *pki.CA, def leafDef, certPath, keyPath string) error {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return err
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return err
	}
	if err := ca.VerifyLeaf(certPEM, keyPEM, g.Now()); err != nil {
		return fmt.Errorf("existing %s is not valid for the current CA: %w", g.rel(certPath), err)
	}
	cert, err := pki.ParseCertificatePEM(certPEM)
	if err != nil {
		return err
	}
	if err := matchIdentity(cert, def.spec); err != nil {
		return fmt.Errorf("existing %s has the wrong identity (%v); inconsistent PKI state, remove the volume or the file to regenerate", g.rel(certPath), err)
	}
	return nil
}

func (g *Generator) preflightLegacy() (map[string][]byte, error) {
	legacyKey := g.path("backend", "backend-sync.key")
	ok, err := exists(legacyKey)
	if err != nil || !ok {
		return nil, err
	}
	data, err := os.ReadFile(legacyKey)
	if err != nil {
		return nil, err
	}
	if _, err := edkey.ParsePrivateKeyPEM(data); err != nil {
		return nil, fmt.Errorf("legacy %s: %w", g.rel(legacyKey), err)
	}
	target := g.path("dns-sync", "backend-sync.key")
	have, err := exists(target)
	if err != nil {
		return nil, err
	}
	if have {
		if err := g.sameContent(target, data); err != nil {
			return nil, err
		}
	}
	return map[string][]byte{"backend-sync": data}, nil
}

func (g *Generator) preflightSigningKey(def signingKeyDef, legacy map[string][]byte) error {
	keyPath := g.path(def.owner, def.name+".key")
	ok, err := exists(keyPath)
	if err != nil {
		return err
	}
	var keyPEM []byte
	switch {
	case ok:
		if keyPEM, err = os.ReadFile(keyPath); err != nil {
			return err
		}
	case legacy[def.name] != nil:
		keyPEM = legacy[def.name]
	default:
		for _, dir := range append([]string{def.owner}, def.consumers...) {
			path := g.path(dir, def.name+".pub")
			have, err := exists(path)
			if err != nil {
				return err
			}
			if have {
				return fmt.Errorf("%s exists but its private key %s is missing, refusing to generate a new key", g.rel(path), g.rel(keyPath))
			}
		}
		return nil
	}
	priv, err := edkey.ParsePrivateKeyPEM(keyPEM)
	if err != nil {
		return fmt.Errorf("%s: %w", g.rel(keyPath), err)
	}
	pubPEM, err := edkey.MarshalPublicKeyPEM(priv.Public().(ed25519.PublicKey))
	if err != nil {
		return err
	}
	for _, dir := range append([]string{def.owner}, def.consumers...) {
		path := g.path(dir, def.name+".pub")
		have, err := exists(path)
		if err != nil {
			return err
		}
		if have {
			if err := g.sameContent(path, pubPEM); err != nil {
				return err
			}
		}
	}
	return nil
}

func (g *Generator) preflightTOTP() error {
	path := g.path("iam", "iam-totp.key")
	ok, err := exists(path)
	if err != nil || !ok {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	raw, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(data)))
	if err != nil || len(raw) != totpKeySize {
		return fmt.Errorf("existing %s is not a base64-encoded %d-byte key", g.rel(path), totpKeySize)
	}
	return nil
}
