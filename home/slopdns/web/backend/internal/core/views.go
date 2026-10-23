package core

import (
	"encoding/json"
	"time"

	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/conv"
	"slopdns/web/backend/internal/rrdata"
	"slopdns/web/backend/internal/store"
)

const unknownUsername = "unknown"

type Page[T any] struct {
	Items  []T `json:"items"`
	Total  int `json:"total"`
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}

type PageReq struct {
	Limit  int
	Offset int
}

func newPage[T any](items []T, total int, pr PageReq) Page[T] {
	if items == nil {
		items = []T{}
	}
	return Page[T]{Items: items, Total: total, Limit: pr.Limit, Offset: pr.Offset}
}

func paginate[T any](all []T, pr PageReq) Page[T] {
	total := len(all)
	start := min(pr.Offset, total)
	end := min(start+pr.Limit, total)
	return newPage(all[start:end], total, pr)
}

type UserRef struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

func userRef(id string, names map[string]string) UserRef {
	name, ok := names[id]
	if !ok || name == "" {
		name = unknownUsername
	}
	return UserRef{ID: id, Username: name}
}

func utc(t time.Time) time.Time {
	return t.UTC()
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	v := t.UTC()
	return &v
}

func rolePtr(r authz.Role) *string {
	if r == authz.RoleNone {
		return nil
	}
	s := authz.RoleName(r)
	return &s
}

type OrgView struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Owner     UserRef   `json:"owner"`
	MyRole    *string   `json:"my_role"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type MemberView struct {
	PrincipalType string  `json:"principal_type"`
	PrincipalID   string  `json:"principal_id"`
	Name          string  `json:"name"`
	OrgRole       *string `json:"org_role"`
}

type OrgRef struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Owner UserRef `json:"owner"`
}

type InvitationView struct {
	ID        string     `json:"id"`
	Org       OrgRef     `json:"org"`
	Invitee   UserRef    `json:"invitee"`
	InvitedBy UserRef    `json:"invited_by"`
	Role      string     `json:"role"`
	Status    string     `json:"status"`
	CreatedAt time.Time  `json:"created_at"`
	ExpiresAt time.Time  `json:"expires_at"`
	DecidedAt *time.Time `json:"decided_at"`
}

func invitationView(v store.Invitation, names map[string]string, owner UserRef) InvitationView {
	return InvitationView{
		ID: v.ID, Org: OrgRef{ID: v.OrgID, Name: v.OrgName, Owner: owner},
		Invitee: userRef(v.InviteeUserID, names), InvitedBy: userRef(v.InvitedBy, names),
		Role: v.Role, Status: v.Status, CreatedAt: utc(v.CreatedAt), ExpiresAt: utc(v.ExpiresAt), DecidedAt: utcPtr(v.DecidedAt),
	}
}

type SOAView struct {
	MName   string `json:"mname"`
	RName   string `json:"rname"`
	Serial  int64  `json:"serial"`
	Refresh int32  `json:"refresh"`
	Retry   int32  `json:"retry"`
	Expire  int32  `json:"expire"`
	Minimum int32  `json:"minimum"`
}

type ZoneView struct {
	ID                string    `json:"id"`
	OrgID             string    `json:"org_id"`
	Name              string    `json:"name"`
	DefaultTTL        int32     `json:"default_ttl"`
	SOA               SOAView   `json:"soa"`
	MyRole            string    `json:"my_role"`
	PendingTransferID *string   `json:"pending_transfer_id"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

func zoneView(z store.Zone, role authz.Role) ZoneView {
	return ZoneView{
		ID: z.ID, OrgID: z.OrgID, Name: z.Name, DefaultTTL: z.DefaultTTL,
		SOA:    SOAView{MName: z.SOAMName, RName: z.SOARName, Serial: z.SOASerial, Refresh: z.SOARefresh, Retry: z.SOARetry, Expire: z.SOAExpire, Minimum: z.SOAMinimum},
		MyRole: authz.RoleName(role), PendingTransferID: z.PendingTransferID,
		CreatedAt: utc(z.CreatedAt), UpdatedAt: utc(z.UpdatedAt),
	}
}

type RecordView struct {
	ID        string          `json:"id"`
	ZoneID    string          `json:"zone_id"`
	Name      string          `json:"name"`
	Type      string          `json:"type"`
	TypeCode  int32           `json:"type_code"`
	TTL       int32           `json:"ttl"`
	Data      json.RawMessage `json:"data"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

func recordView(r store.Record) RecordView {
	return RecordView{
		ID: r.ID, ZoneID: r.ZoneID, Name: r.Owner, Type: rrdata.Mnemonic(conv.U16(int64(r.Type))), TypeCode: r.Type, TTL: r.TTL,
		Data: json.RawMessage(rrdata.NormalizeData(conv.U16(int64(r.Type)), r.Data)), CreatedAt: utc(r.CreatedAt), UpdatedAt: utc(r.UpdatedAt),
	}
}

type ZoneRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type TransferView struct {
	ID          string     `json:"id"`
	Zone        ZoneRef    `json:"zone"`
	FromOrgID   string     `json:"from_org_id"`
	FromUser    UserRef    `json:"from_user"`
	ToUser      UserRef    `json:"to_user"`
	TargetOrgID *string    `json:"target_org_id"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	ExpiresAt   time.Time  `json:"expires_at"`
	DecidedAt   *time.Time `json:"decided_at"`
}

func transferView(t store.Transfer, names map[string]string) TransferView {
	return TransferView{
		ID: t.ID, Zone: ZoneRef{ID: t.ZoneID, Name: t.ZoneName}, FromOrgID: t.FromOrgID,
		FromUser: userRef(t.FromUserID, names), ToUser: userRef(t.ToUserID, names), TargetOrgID: t.TargetOrgID,
		Status: t.Status, CreatedAt: utc(t.CreatedAt), ExpiresAt: utc(t.ExpiresAt), DecidedAt: utcPtr(t.DecidedAt),
	}
}
