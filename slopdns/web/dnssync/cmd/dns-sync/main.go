package main

import (
	"os"

	"slopdns/web/dnssync/internal/service"
	"slopdns/web/pkg/app"
)

func main() {
	app.Main(service.Name, service.Commands(os.LookupEnv, os.Stderr)...)
}
