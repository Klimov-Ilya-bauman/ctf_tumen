package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

func envOr(lookup func(string) (string, bool), name, def string) string {
	if v, ok := lookup(name); ok && v != "" {
		return v
	}
	return def
}

func run(args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("pkigen", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dir := fs.String("dir", envOr(lookup, "PKI_DIR", "/pki"), "output directory (env PKI_DIR)")
	node := fs.String("dns-node", envOr(lookup, "DNS_NODE_ID", "dns1"), "DNS server node id (env DNS_NODE_ID)")
	fs.Usage = func() {
		_, _ = fmt.Fprintf(stderr, "usage: pkigen [-dir DIR] [-dns-node ID]\n\n"+
			"Creates the SlopDNS internal CA, mTLS certificates, Ed25519 signing keys and the IAM TOTP key.\n"+
			"Existing files are never overwritten; inconsistent existing material is reported as an error.\n\n"+
			"Layout: DIR/{ca,iam,backend,gateway,dns-sync,dns-server}/, each service directory holds ca.crt,\n"+
			"its own <service>.crt and <service>.key and the signing keys it needs.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() > 0 {
		_, _ = fmt.Fprintf(stderr, "pkigen: unexpected arguments %q\n", fs.Args())
		return 2
	}
	g := &Generator{Dir: *dir, NodeID: *node, Out: stdout}
	if err := g.Run(); err != nil {
		_, _ = fmt.Fprintf(stderr, "pkigen: %v\n", err)
		return 1
	}
	return 0
}

func main() {
	os.Exit(run(os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr))
}
