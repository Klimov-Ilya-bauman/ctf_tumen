package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"syscall"
	"time"

	"slopdns/web/pkg/config"
	"slopdns/web/pkg/health"
	slopLog "slopdns/web/pkg/log"
)

const (
	DefaultHTTPAddr        = ":8080"
	DefaultShutdownTimeout = 10 * time.Second
)

type Command struct {
	Name  string
	Usage string
	Run   func(ctx context.Context, args []string) error
}

type UsageError struct {
	Message string
}

func (e *UsageError) Error() string {
	return e.Message
}

func Main(name string, cmds ...Command) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := Run(ctx, name, os.Args[1:], os.Stderr, cmds)
	stop()
	os.Exit(code)
}

func Run(ctx context.Context, name string, args []string, stderr io.Writer, cmds []Command) int {
	usage := func() {
		_, _ = fmt.Fprintf(stderr, "usage: %s <command> [args]\n\ncommands:\n", name)
		sorted := append([]Command(nil), cmds...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
		for _, c := range sorted {
			_, _ = fmt.Fprintf(stderr, "  %-12s %s\n", c.Name, c.Usage)
		}
	}
	if len(args) == 0 {
		usage()
		return 2
	}
	if args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		usage()
		return 0
	}
	for _, c := range cmds {
		if c.Name != args[0] {
			continue
		}
		err := c.Run(ctx, args[1:])
		if err == nil {
			return 0
		}
		var ue *UsageError
		if errors.As(err, &ue) {
			_, _ = fmt.Fprintf(stderr, "%s %s: %s\n", name, c.Name, ue.Message)
			return 2
		}
		_, _ = fmt.Fprintf(stderr, "%s %s: %v\n", name, c.Name, err)
		return 1
	}
	_, _ = fmt.Fprintf(stderr, "%s: unknown command %q\n", name, args[0])
	usage()
	return 2
}

func NoArgs(args []string) error {
	if len(args) > 0 {
		return &UsageError{Message: fmt.Sprintf("unexpected arguments %q", args)}
	}
	return nil
}

type Base struct {
	HTTPAddr string
	LogLevel slog.Level
}

func LoadBase(env *config.Env) Base {
	b := Base{HTTPAddr: env.Addr("HTTP_ADDR", DefaultHTTPAddr)}
	levelName := env.OneOf("LOG_LEVEL", "info", "debug", "info", "warn", "error")
	b.LogLevel, _ = slopLog.ParseLevel(levelName)
	return b
}

func HealthcheckCommand(lookup config.LookupFunc) Command {
	return Command{
		Name:  "healthcheck",
		Usage: "probe the local /readyz endpoint and exit non-zero if not ready",
		Run: func(ctx context.Context, args []string) error {
			if err := NoArgs(args); err != nil {
				return err
			}
			env := config.New(lookup)
			addr := env.Addr("HTTP_ADDR", DefaultHTTPAddr)
			if err := env.Err(); err != nil {
				return err
			}
			url, err := health.LocalURL(addr, "/readyz")
			if err != nil {
				return err
			}
			return health.Probe(ctx, url, 3*time.Second)
		},
	}
}

func NoMigrationsCommand() Command {
	return Command{
		Name:  "migrate",
		Usage: "apply database migrations (this service has none)",
		Run: func(ctx context.Context, args []string) error {
			return NoArgs(args)
		},
	}
}

func Serve(ctx context.Context, logger *slog.Logger, srv *http.Server, ln net.Listener, shutdownTimeout time.Duration) error {
	if shutdownTimeout <= 0 {
		shutdownTimeout = DefaultShutdownTimeout
	}
	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.Serve(ln)
	}()
	logger.InfoContext(ctx, "http server listening", slog.String("addr", ln.Addr().String()))
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	logger.Info("shutting down http server")
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errCh; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func ListenAndServe(ctx context.Context, logger *slog.Logger, addr string, handler http.Handler) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	return Serve(ctx, logger, NewServer(handler, logger), ln, DefaultShutdownTimeout)
}

func NewServer(handler http.Handler, logger *slog.Logger) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
}
