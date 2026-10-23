package gocrypto

const (
	P = 251
	N = 19
)

var G = [N]byte{7, 3, 11, 2, 5, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67}

func Delta() [N]byte {
	var d [N]byte
	d[0] = 1
	return d
}

func Conv(u, v [N]byte) [N]byte {
	var out [N]byte
	for k := 0; k < N; k++ {
		var acc int
		for i := 0; i < N; i++ {
			acc += int(u[i]) * int(v[((k-i)%N+N)%N])
		}
		out[k] = byte(acc % P)
	}
	return out
}

func Pow(v [N]byte, e int) [N]byte {
	r := Delta()
	b := v
	for e > 0 {
		if e&1 == 1 {
			r = Conv(r, b)
		}
		b = Conv(b, b)
		e >>= 1
	}
	return r
}

func InvScalar(x byte) byte {
	if x == 0 {
		panic("no inverse for 0")
	}
	res, base, e := 1, int(x), P-2 // Fermat: x^(P-2) mod P
	for e > 0 {
		if e&1 == 1 {
			res = res * base % P
		}
		base = base * base % P
		e >>= 1
	}
	return byte(res)
}
