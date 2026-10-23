package core

import (
	"context"
	"strconv"

	"slopdns/web/backend/internal/dnsname"
	"slopdns/web/backend/internal/store"
	"slopdns/web/pkg/dnsdata"
	"slopdns/web/pkg/httpx"
)

const CodeQuotaExceeded = httpx.CodeQuotaExceeded

type Limits struct {
	MaxZonesPerOrg              int
	MaxRecordsPerZone           int
	MaxOrgsPerUser              int
	MaxPendingInvitationsPerOrg int
	MaxZoneBytes                int64
}

func DefaultLimits() Limits {
	return Limits{MaxZonesPerOrg: 50, MaxRecordsPerZone: 1000, MaxOrgsPerUser: 20, MaxPendingInvitationsPerOrg: 100, MaxZoneBytes: 4 << 20}
}

func (s *Service) SetLimits(l Limits) {
	s.limits = l
}

func (s *Service) Limits() Limits {
	return s.limits
}

func quotaExceeded(field, what string, limit int) error {
	return httpx.QuotaExceeded(field, what+" limit of "+strconv.Itoa(limit)+" reached")
}

func ReservedNames(d ZoneDefaults) []string {
	hosts := append([]string{d.MName, d.RName}, d.NameServers...)
	hosts = append(hosts, d.Reserved...)
	seen := map[string]bool{}
	var out []string
	for _, h := range hosts {
		name, err := dnsname.Parse(h, dnsname.HostPolicy)
		if err != nil {
			continue
		}
		for _, n := range append([]string{name}, dnsname.Ancestors(name, d.Suffix)...) {
			if dnsname.IsStrictSubdomain(n, d.Suffix) && !seen[n] {
				seen[n] = true
				out = append(out, n)
			}
		}
	}
	return out
}

func (s *Service) checkReserved(name string) error {
	for _, r := range s.reserved {
		if dnsname.IsSubdomain(name, r) || dnsname.IsSubdomain(r, name) {
			return invalid("name", "name "+name+" is reserved for the service infrastructure ("+r+")")
		}
	}
	return nil
}

func (s *Service) checkNesting(ctx context.Context, q *store.Q, name, orgID, exceptID string) error {
	nested, err := q.ForeignNestedZone(ctx, name, dnsname.Ancestors(name, dnsname.Root), orgID, exceptID)
	if err != nil {
		return err
	}
	if nested {
		return conflict("zone " + name + " would be nested with a zone of another organization")
	}
	return nil
}

func (s *Service) checkZoneBytes(ctx context.Context, q *store.Q, zoneID, exceptID, owner string, rdataLen int) error {
	n, err := q.ZoneWireBytes(ctx, zoneID, exceptID)
	if err != nil {
		return err
	}
	if n+int64(dnsdata.RRWireSize(owner, rdataLen)) > s.limits.MaxZoneBytes {
		return httpx.QuotaExceeded("data", "zone size limit of "+strconv.FormatInt(s.limits.MaxZoneBytes, 10)+" bytes of record wire data reached")
	}
	return nil
}

func (s *Service) checkZoneQuota(ctx context.Context, q *store.Q, orgID, field string) error {
	n, err := q.CountZonesInOrg(ctx, orgID)
	if err != nil {
		return err
	}
	if n >= s.limits.MaxZonesPerOrg {
		return quotaExceeded(field, "zones per organization", s.limits.MaxZonesPerOrg)
	}
	return nil
}
