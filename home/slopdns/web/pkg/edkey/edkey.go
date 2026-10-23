package edkey

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
)

const (
	privateBlock = "PRIVATE KEY"
	publicBlock  = "PUBLIC KEY"
)

func decodeSingle(data []byte, blockType string) ([]byte, error) {
	block, rest := pem.Decode(data)
	if block == nil {
		return nil, errors.New("no PEM block found")
	}
	if block.Type != blockType {
		return nil, fmt.Errorf("unexpected PEM block %q, want %q", block.Type, blockType)
	}
	if next, _ := pem.Decode(rest); next != nil {
		return nil, errors.New("unexpected extra PEM block")
	}
	return block.Bytes, nil
}

func ParsePrivateKeyPEM(data []byte) (ed25519.PrivateKey, error) {
	der, err := decodeSingle(data, privateBlock)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse PKCS#8 private key: %w", err)
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("private key is %T, want Ed25519", key)
	}
	return priv, nil
}

func ParsePublicKeyPEM(data []byte) (ed25519.PublicKey, error) {
	der, err := decodeSingle(data, publicBlock)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse PKIX public key: %w", err)
	}
	pub, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("public key is %T, want Ed25519", key)
	}
	return pub, nil
}

func MarshalPrivateKeyPEM(key ed25519.PrivateKey) ([]byte, error) {
	if len(key) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid Ed25519 private key length")
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: privateBlock, Bytes: der}), nil
}

func MarshalPublicKeyPEM(key ed25519.PublicKey) ([]byte, error) {
	if len(key) != ed25519.PublicKeySize {
		return nil, errors.New("invalid Ed25519 public key length")
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: publicBlock, Bytes: der}), nil
}

func LoadPrivateKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	key, err := ParsePrivateKeyPEM(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return key, nil
}

func LoadPublicKey(path string) (ed25519.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	key, err := ParsePublicKeyPEM(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return key, nil
}
