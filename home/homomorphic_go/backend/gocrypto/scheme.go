package gocrypto

import "crypto/sha256"

// PubKey returns g^secret in the GF(251)[x]/(x^N-1) ring.
func PubKey(secret int) [N]byte { return Pow(G, secret) }

// Shared returns peerPub^secret, the shared secret S.
func Shared(peerPub [N]byte, secret int) [N]byte { return Pow(peerPub, secret) }

// Encrypt computes C[i][j] = S[i] * M[i][j] mod P.
func Encrypt(M [N][N]byte, S [N]byte) [N][N]byte {
	var C [N][N]byte
	for i := 0; i < N; i++ {
		for j := 0; j < N; j++ {
			C[i][j] = byte(int(S[i]) * int(M[i][j]) % P)
		}
	}
	return C
}

// Decrypt inverts Encrypt: M[i][j] = C[i][j] * S[i]^-1 mod P.
func Decrypt(C [N][N]byte, S [N]byte) [N][N]byte {
	var M [N][N]byte
	for i := 0; i < N; i++ {
		inv := int(InvScalar(S[i]))
		for j := 0; j < N; j++ {
			M[i][j] = byte(int(C[i][j]) * inv % P)
		}
	}
	return M
}

// MsgKey derives a 16-byte message key as SHA-256(S)[0:16].
func MsgKey(S [N]byte) [16]byte {
	h := sha256.Sum256(S[:])
	var k [16]byte
	copy(k[:], h[:16])
	return k
}

// FlattenC serialises the N x N board row-major into N*N bytes.
func FlattenC(C [N][N]byte) [N * N]byte {
	var f [N * N]byte
	for i := 0; i < N; i++ {
		for j := 0; j < N; j++ {
			f[i*N+j] = C[i][j]
		}
	}
	return f
}

// UnflattenC is the inverse of FlattenC.
func UnflattenC(f [N * N]byte) [N][N]byte {
	var C [N][N]byte
	for i := 0; i < N; i++ {
		for j := 0; j < N; j++ {
			C[i][j] = f[i*N+j]
		}
	}
	return C
}
