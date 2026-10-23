package api

import (
	"net/http"
	"regexp"

	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/core"
	"slopdns/web/pkg/httpx"
)

var (
	zoneNameFilterRe   = regexp.MustCompile(`^[^\s\\]+$`)
	recordTypeFilterRe = regexp.MustCompile(`^([A-Z]{1,10}|TYPE[1-9][0-9]{0,4})$`)
)

type nameBody struct {
	Name *string `json:"name"`
}

type usernameBody struct {
	Username *string `json:"username"`
}

type invitationBody struct {
	Username *string `json:"username"`
	Role     *string `json:"role"`
}

type userIDBody struct {
	UserID *string `json:"user_id"`
}

type acceptBody struct {
	TargetOrgID *string `json:"target_org_id"`
}

func (h *Handler) listOrgs(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	pr, err := pageReq(r)
	if err != nil {
		return err
	}
	page, err := h.svc.ListOrgs(r.Context(), p, pr)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, page)
}

func (h *Handler) createOrg(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	var body nameBody
	if err := decode(w, r, &body); err != nil {
		return err
	}
	name, err := requiredString(body.Name, "name")
	if err != nil {
		return err
	}
	org, err := h.svc.CreateOrg(r.Context(), p, name)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, org)
}

func (h *Handler) getOrg(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "org_id")
	if err != nil {
		return err
	}
	org, err := h.svc.GetOrg(r.Context(), p, id)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, org)
}

func (h *Handler) updateOrg(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "org_id")
	if err != nil {
		return err
	}
	var body nameBody
	if err := decode(w, r, &body); err != nil {
		return err
	}
	name, err := requiredString(body.Name, "name")
	if err != nil {
		return err
	}
	org, err := h.svc.RenameOrg(r.Context(), p, id, name)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, org)
}

func (h *Handler) deleteOrg(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "org_id")
	if err != nil {
		return err
	}
	if err := h.svc.DeleteOrg(r.Context(), p, id); err != nil {
		return err
	}
	return noContent(w)
}

func (h *Handler) listMembers(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "org_id")
	if err != nil {
		return err
	}
	pr, err := pageReq(r)
	if err != nil {
		return err
	}
	page, err := h.svc.ListMembers(r.Context(), p, id, pr)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, page)
}

func (h *Handler) removeMember(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "org_id")
	if err != nil {
		return err
	}
	userID, err := pathID(r, "user_id")
	if err != nil {
		return err
	}
	if err := h.svc.RemoveMember(r.Context(), p, id, userID); err != nil {
		return err
	}
	return noContent(w)
}

func (h *Handler) transferOwnership(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "org_id")
	if err != nil {
		return err
	}
	var body userIDBody
	if err := decode(w, r, &body); err != nil {
		return err
	}
	userID, err := requiredString(body.UserID, "user_id")
	if err != nil {
		return err
	}
	org, err := h.svc.TransferOwnership(r.Context(), p, id, userID)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, org)
}

func (h *Handler) listOrgInvitations(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "org_id")
	if err != nil {
		return err
	}
	pr, err := pageReq(r)
	if err != nil {
		return err
	}
	status, err := queryEnum(r, "status", core.ValidInvitationStatus)
	if err != nil {
		return err
	}
	page, err := h.svc.ListOrgInvitations(r.Context(), p, id, status, pr)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, page)
}

func (h *Handler) createInvitation(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "org_id")
	if err != nil {
		return err
	}
	var body invitationBody
	if err := decode(w, r, &body); err != nil {
		return err
	}
	username, err := requiredString(body.Username, "username")
	if err != nil {
		return err
	}
	role, err := requiredString(body.Role, "role")
	if err != nil {
		return err
	}
	inv, err := h.svc.CreateInvitation(r.Context(), p, id, username, role)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, inv)
}

func (h *Handler) listMyInvitations(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	status, err := queryEnum(r, "status", core.ValidInvitationStatus)
	if err != nil {
		return err
	}
	pr, err := pageReq(r)
	if err != nil {
		return err
	}
	page, err := h.svc.ListMyInvitations(r.Context(), p, status, pr)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, page)
}

func (h *Handler) invitationAction(w http.ResponseWriter, r *http.Request, p authz.Principal, fn func(*http.Request, authz.Principal, string) (core.InvitationView, error)) error {
	id, err := pathID(r, "invitation_id")
	if err != nil {
		return err
	}
	inv, err := fn(r, p, id)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, inv)
}

func (h *Handler) acceptInvitation(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	return h.invitationAction(w, r, p, func(r *http.Request, p authz.Principal, id string) (core.InvitationView, error) {
		return h.svc.AcceptInvitation(r.Context(), p, id)
	})
}

func (h *Handler) declineInvitation(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	return h.invitationAction(w, r, p, func(r *http.Request, p authz.Principal, id string) (core.InvitationView, error) {
		return h.svc.DeclineInvitation(r.Context(), p, id)
	})
}

func (h *Handler) revokeInvitation(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	return h.invitationAction(w, r, p, func(r *http.Request, p authz.Principal, id string) (core.InvitationView, error) {
		return h.svc.RevokeInvitation(r.Context(), p, id)
	})
}

func (h *Handler) listZones(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	q := r.URL.Query()
	orgID, has, err := queryValue(q, "org_id")
	if err != nil {
		return err
	}
	if has && !core.ValidUUID(orgID) {
		return httpx.Validation("org_id", "must be a lower-case UUID")
	}
	name, has, err := queryValue(q, "name")
	if err != nil {
		return err
	}
	if has && (len(name) < 1 || len(name) > maxZoneNameFlt || !zoneNameFilterRe.MatchString(name)) {
		return httpx.Validation("name", "must be 1-254 characters without whitespace or backslashes")
	}
	pr, err := pageReq(r)
	if err != nil {
		return err
	}
	page, err := h.svc.ListZones(r.Context(), p, orgID, name, pr)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, page)
}

func (h *Handler) createZone(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	var body core.ZoneCreateInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	z, err := h.svc.CreateZone(r.Context(), p, body)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, z)
}

func (h *Handler) getZone(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "zone_id")
	if err != nil {
		return err
	}
	z, err := h.svc.GetZone(r.Context(), p, id)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, z)
}

func (h *Handler) updateZone(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "zone_id")
	if err != nil {
		return err
	}
	var body core.ZoneUpdateInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	z, err := h.svc.UpdateZone(r.Context(), p, id, body)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, z)
}

func (h *Handler) deleteZone(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "zone_id")
	if err != nil {
		return err
	}
	if err := h.svc.DeleteZone(r.Context(), p, id); err != nil {
		return err
	}
	return noContent(w)
}

func (h *Handler) createTransfer(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "zone_id")
	if err != nil {
		return err
	}
	var body usernameBody
	if err := decode(w, r, &body); err != nil {
		return err
	}
	username, err := requiredString(body.Username, "username")
	if err != nil {
		return err
	}
	t, err := h.svc.CreateTransfer(r.Context(), p, id, username)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, t)
}

func (h *Handler) listRecords(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "zone_id")
	if err != nil {
		return err
	}
	q := r.URL.Query()
	name, has, err := queryValue(q, "name")
	if err != nil {
		return err
	}
	if has && (name == "" || len(name) > 254) {
		return httpx.Validation("name", "must be 1-254 characters")
	}
	typ, has, err := queryValue(q, "type")
	if err != nil {
		return err
	}
	if has && (len(typ) > maxRecordTypeLn || !recordTypeFilterRe.MatchString(typ)) {
		return httpx.Validation("type", "must be a type mnemonic or TYPEnnn")
	}
	pr, err := pageReq(r)
	if err != nil {
		return err
	}
	page, err := h.svc.ListRecords(r.Context(), p, id, name, typ, pr)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, page)
}

func (h *Handler) createRecord(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "zone_id")
	if err != nil {
		return err
	}
	var body core.RecordInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	rec, err := h.svc.CreateRecord(r.Context(), p, id, body)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusCreated, rec)
}

func (h *Handler) getRecord(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "record_id")
	if err != nil {
		return err
	}
	rec, err := h.svc.GetRecord(r.Context(), p, id)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, rec)
}

func (h *Handler) replaceRecord(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "record_id")
	if err != nil {
		return err
	}
	var body core.RecordInput
	if err := decode(w, r, &body); err != nil {
		return err
	}
	rec, err := h.svc.ReplaceRecord(r.Context(), p, id, body)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, rec)
}

func (h *Handler) deleteRecord(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "record_id")
	if err != nil {
		return err
	}
	if err := h.svc.DeleteRecord(r.Context(), p, id); err != nil {
		return err
	}
	return noContent(w)
}

func validDirection(s string) bool {
	return s == "incoming" || s == "outgoing"
}

func (h *Handler) listTransfers(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	direction, err := queryEnum(r, "direction", validDirection)
	if err != nil {
		return err
	}
	status, err := queryEnum(r, "status", core.ValidTransferStatus)
	if err != nil {
		return err
	}
	pr, err := pageReq(r)
	if err != nil {
		return err
	}
	page, err := h.svc.ListTransfers(r.Context(), p, direction, status, pr)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, page)
}

func (h *Handler) getTransfer(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "transfer_id")
	if err != nil {
		return err
	}
	t, err := h.svc.GetTransfer(r.Context(), p, id)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, t)
}

func (h *Handler) acceptTransfer(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "transfer_id")
	if err != nil {
		return err
	}
	var body acceptBody
	if err := decode(w, r, &body); err != nil {
		return err
	}
	target, err := requiredString(body.TargetOrgID, "target_org_id")
	if err != nil {
		return err
	}
	t, err := h.svc.AcceptTransfer(r.Context(), p, id, target)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, t)
}

func (h *Handler) declineTransfer(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "transfer_id")
	if err != nil {
		return err
	}
	t, err := h.svc.DeclineTransfer(r.Context(), p, id)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, t)
}

func (h *Handler) cancelTransfer(w http.ResponseWriter, r *http.Request, p authz.Principal) error {
	id, err := pathID(r, "transfer_id")
	if err != nil {
		return err
	}
	t, err := h.svc.CancelTransfer(r.Context(), p, id)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, t)
}
