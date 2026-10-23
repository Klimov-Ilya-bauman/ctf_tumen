module slopdns/tools

go 1.26.0

require (
	github.com/miekg/dns v1.1.73
	go.yaml.in/yaml/v3 v3.0.5
	google.golang.org/grpc v1.84.0
	google.golang.org/protobuf v1.36.12
	slopdns/web v0.0.0
)

require (
	golang.org/x/net v0.61.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.43.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20261005182115-fad411399dd8 // indirect
)

replace slopdns/web => ../web
