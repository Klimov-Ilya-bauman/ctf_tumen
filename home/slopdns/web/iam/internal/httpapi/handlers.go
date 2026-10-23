package httpapi

import (
	"net/http"
	"time"

	"slopdns/web/iam/internal/core"
	"slopdns/web/iam/internal/store"
	"slopdns/web/pkg/httpx"
	"slopdns/web/pkg/rbac"
)

type userJSON struct {
	ID        string    `json:"id"`
	Username  string    `json:"username"`
	CreatedAt time.Time `json:"created_at"`
}

func userView(u store.User) userJSON {
	return userJSON{ID: u.ID.String(), Username: u.Username, CreatedAt: u.CreatedAt.UTC()}
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (a *API) register(w http.ResponseWriter, r *http.Request) error {
	var in credentials
	if err := decode(w, r, &in); err != nil {
		return err
	}
	u, err := a.svc.Register(r.Context(), in.Username, in.Password)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, userView(u))
	return nil
}

type loginSuccess struct {
	MFARequired bool     `json:"mfa_required"`
	User        userJSON `json:"user"`
}

type loginMFA struct {
	MFARequired  bool      `json:"mfa_required"`
	MFAToken     string    `json:"mfa_token"`
	MFAExpiresAt time.Time `json:"mfa_expires_at"`
}

func (a *API) writeLogin(w http.ResponseWriter, res core.LoginResult) {
	if res.MFARequired {
		httpx.WriteJSON(w, http.StatusOK, loginMFA{MFARequired: true, MFAToken: res.MFAToken, MFAExpiresAt: res.MFAExpiresAt.UTC()})
		return
	}
	maxAge := int(res.SessionMaxAge / time.Second)
	if maxAge < 1 {
		maxAge = 1
	}
	http.SetCookie(w, a.sessionCookie(res.SessionToken, maxAge))
	httpx.WriteJSON(w, http.StatusOK, loginSuccess{MFARequired: false, User: userView(res.User)})
}

func (a *API) login(w http.ResponseWriter, r *http.Request) error {
	var in credentials
	if err := decode(w, r, &in); err != nil {
		return err
	}
	res, err := a.svc.Login(r.Context(), in.Username, in.Password)
	if err != nil {
		return err
	}
	a.writeLogin(w, res)
	return nil
}

type loginTOTPRequest struct {
	MFAToken     string      `json:"mfa_token"`
	Code         opt[string] `json:"code"`
	RecoveryCode opt[string] `json:"recovery_code"`
}

func (a *API) loginTOTP(w http.ResponseWriter, r *http.Request) error {
	var in loginTOTPRequest
	if err := decode(w, r, &in); err != nil {
		return err
	}
	res, err := a.svc.LoginTOTP(r.Context(), in.MFAToken, in.Code.ptr(), in.RecoveryCode.ptr())
	if err != nil {
		return err
	}
	a.writeLogin(w, res)
	return nil
}

func (a *API) logout(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	if err := a.svc.Logout(r.Context(), c); err != nil {
		return err
	}
	if _, err := r.Cookie(CookieName); err == nil && r.Header.Get("Authorization") == "" {
		http.SetCookie(w, a.sessionCookie("", -1))
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type userMe struct {
	PrincipalType          string    `json:"principal_type"`
	ID                     string    `json:"id"`
	Username               string    `json:"username"`
	TOTPEnabled            bool      `json:"totp_enabled"`
	RecoveryCodesRemaining int       `json:"recovery_codes_remaining"`
	CreatedAt              time.Time `json:"created_at"`
}

type serviceAccountMe struct {
	PrincipalType string    `json:"principal_type"`
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	OrgID         string    `json:"org_id"`
	CreatedAt     time.Time `json:"created_at"`
}

func (a *API) me(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	me, err := a.svc.Me(r.Context(), c)
	if err != nil {
		return err
	}
	if me.ServiceAccount != nil {
		sa := me.ServiceAccount
		httpx.WriteJSON(w, http.StatusOK, serviceAccountMe{PrincipalType: string(rbac.PrincipalServiceAccount), ID: sa.ID.String(), Name: sa.Name, OrgID: sa.OrgID.String(), CreatedAt: sa.CreatedAt.UTC()})
		return nil
	}
	u := me.User
	httpx.WriteJSON(w, http.StatusOK, userMe{PrincipalType: string(rbac.PrincipalUser), ID: u.ID.String(), Username: u.Username, TOTPEnabled: u.TOTPEnabled, RecoveryCodesRemaining: me.RecoveryCodesRemaining, CreatedAt: u.CreatedAt.UTC()})
	return nil
}

type totpSetupResponse struct {
	Secret     string `json:"secret"`
	OTPAuthURI string `json:"otpauth_uri"`
}

func (a *API) totpSetup(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	res, err := a.svc.TOTPSetup(r.Context(), c)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, totpSetupResponse{Secret: res.Secret, OTPAuthURI: res.URI})
	return nil
}

type recoveryCodesResponse struct {
	RecoveryCodes []string `json:"recovery_codes"`
}

type codeRequest struct {
	Code string `json:"code"`
}

func (a *API) totpEnable(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	var in codeRequest
	if err := decode(w, r, &in); err != nil {
		return err
	}
	codes, err := a.svc.TOTPEnable(r.Context(), c, in.Code)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, recoveryCodesResponse{RecoveryCodes: codes})
	return nil
}

type disableRequest struct {
	Password     string      `json:"password"`
	Code         opt[string] `json:"code"`
	RecoveryCode opt[string] `json:"recovery_code"`
}

func (a *API) totpDisable(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	var in disableRequest
	if err := decode(w, r, &in); err != nil {
		return err
	}
	if err := a.svc.TOTPDisable(r.Context(), c, in.Password, in.Code.ptr(), in.RecoveryCode.ptr()); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type regenerateRequest struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}

func (a *API) recoveryCodes(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	var in regenerateRequest
	if err := decode(w, r, &in); err != nil {
		return err
	}
	codes, err := a.svc.RegenerateRecoveryCodes(r.Context(), c, in.Password, in.Code)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, recoveryCodesResponse{RecoveryCodes: codes})
	return nil
}

type tokenJSON struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Kind       string     `json:"kind"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
}

type createdTokenJSON struct {
	tokenJSON
	Token string `json:"token"`
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

func tokenView(t store.APIToken) tokenJSON {
	return tokenJSON{ID: t.ID.String(), Name: t.Name, Kind: string(t.OwnerType), CreatedAt: t.CreatedAt.UTC(), ExpiresAt: utcPtr(t.ExpiresAt), LastUsedAt: utcPtr(t.LastUsedAt)}
}

func tokenViews(ts []store.APIToken) []tokenJSON {
	out := make([]tokenJSON, 0, len(ts))
	for _, t := range ts {
		out = append(out, tokenView(t))
	}
	return out
}

func (a *API) listMyTokens(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	p, err := page(r)
	if err != nil {
		return err
	}
	ts, total, err := a.svc.ListMyTokens(r.Context(), c, p)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, newPage(tokenViews(ts), total, p))
	return nil
}

type userTokenCreate struct {
	Name          string      `json:"name"`
	ExpiresInDays opt[int]    `json:"expires_in_days"`
	NoExpiry      opt[bool]   `json:"no_expiry"`
	TOTPCode      opt[string] `json:"totp_code"`
}

func (a *API) createMyToken(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	var in userTokenCreate
	if err := decode(w, r, &in); err != nil {
		return err
	}
	t, err := a.svc.CreateMyToken(r.Context(), c, core.TokenRequest{Name: in.Name, ExpiresInDays: in.ExpiresInDays.ptr(), NoExpiry: in.NoExpiry.Value, TOTPCode: in.TOTPCode.ptr()})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, createdTokenJSON{tokenJSON: tokenView(t.APIToken), Token: t.Token})
	return nil
}

func (a *API) revokeMyToken(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	id, err := pathID(r, "token_id")
	if err != nil {
		return err
	}
	if err := a.svc.RevokeMyToken(r.Context(), c, id); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type userRef struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

type serviceAccountJSON struct {
	ID          string    `json:"id"`
	OrgID       string    `json:"org_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedBy   userRef   `json:"created_by"`
	MyRole      string    `json:"my_role"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func saView(v core.ServiceAccountView) serviceAccountJSON {
	return serviceAccountJSON{
		ID: v.ID.String(), OrgID: v.OrgID.String(), Name: v.Name, Description: v.Description,
		CreatedBy: userRef{ID: v.CreatedBy.String(), Username: v.CreatedByUsername},
		MyRole:    v.MyRole.String(), CreatedAt: v.CreatedAt.UTC(), UpdatedAt: v.UpdatedAt.UTC(),
	}
}

func (a *API) listServiceAccounts(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	raw, err := queryValue(r, "org_id")
	if err != nil {
		return err
	}
	if raw == nil {
		return httpx.Validation("org_id", "is required")
	}
	org, err := core.ParseID("org_id", *raw)
	if err != nil {
		return err
	}
	p, err := page(r)
	if err != nil {
		return err
	}
	list, total, err := a.svc.ListServiceAccounts(r.Context(), c, org, p)
	if err != nil {
		return err
	}
	out := make([]serviceAccountJSON, 0, len(list))
	for _, v := range list {
		out = append(out, saView(v))
	}
	httpx.WriteJSON(w, http.StatusOK, newPage(out, total, p))
	return nil
}

type serviceAccountCreate struct {
	OrgID       string      `json:"org_id"`
	Name        string      `json:"name"`
	Description opt[string] `json:"description"`
}

func (a *API) createServiceAccount(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	var in serviceAccountCreate
	if err := decode(w, r, &in); err != nil {
		return err
	}
	org, err := core.ParseID("org_id", in.OrgID)
	if err != nil {
		return err
	}
	v, err := a.svc.CreateServiceAccount(r.Context(), c, org, in.Name, in.Description.Value)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, saView(v))
	return nil
}

func (a *API) getServiceAccount(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	id, err := pathID(r, "service_account_id")
	if err != nil {
		return err
	}
	v, err := a.svc.GetServiceAccount(r.Context(), c, id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, saView(v))
	return nil
}

type serviceAccountUpdate struct {
	Name        opt[string] `json:"name"`
	Description opt[string] `json:"description"`
}

func (a *API) updateServiceAccount(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	id, err := pathID(r, "service_account_id")
	if err != nil {
		return err
	}
	var in serviceAccountUpdate
	if err := decode(w, r, &in); err != nil {
		return err
	}
	v, err := a.svc.UpdateServiceAccount(r.Context(), c, id, core.ServiceAccountUpdate{Name: in.Name.ptr(), Description: in.Description.ptr()})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, saView(v))
	return nil
}

func (a *API) deleteServiceAccount(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	id, err := pathID(r, "service_account_id")
	if err != nil {
		return err
	}
	if err := a.svc.DeleteServiceAccount(r.Context(), c, id); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (a *API) listSATokens(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	id, err := pathID(r, "service_account_id")
	if err != nil {
		return err
	}
	p, err := page(r)
	if err != nil {
		return err
	}
	ts, total, err := a.svc.ListServiceAccountTokens(r.Context(), c, id, p)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, newPage(tokenViews(ts), total, p))
	return nil
}

type saTokenCreate struct {
	Name string `json:"name"`
}

func (a *API) createSAToken(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	id, err := pathID(r, "service_account_id")
	if err != nil {
		return err
	}
	var in saTokenCreate
	if err := decode(w, r, &in); err != nil {
		return err
	}
	t, err := a.svc.CreateServiceAccountToken(r.Context(), c, id, in.Name)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, createdTokenJSON{tokenJSON: tokenView(t.APIToken), Token: t.Token})
	return nil
}

func (a *API) revokeSAToken(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	id, err := pathID(r, "service_account_id")
	if err != nil {
		return err
	}
	tid, err := pathID(r, "token_id")
	if err != nil {
		return err
	}
	if err := a.svc.RevokeServiceAccountToken(r.Context(), c, id, tid); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type roleBindingJSON struct {
	ID              string    `json:"id"`
	PrincipalType   string    `json:"principal_type"`
	PrincipalID     string    `json:"principal_id"`
	PrincipalName   string    `json:"principal_name"`
	ResourceType    string    `json:"resource_type"`
	ResourceID      string    `json:"resource_id"`
	OrgID           string    `json:"org_id"`
	Role            string    `json:"role"`
	GrantedByUserID *string   `json:"granted_by_user_id"`
	CreatedAt       time.Time `json:"created_at"`
}

func bindingView(b core.BindingView) roleBindingJSON {
	out := roleBindingJSON{
		ID: b.ID.String(), PrincipalType: string(b.Principal.Type), PrincipalID: b.Principal.ID.String(), PrincipalName: b.PrincipalName,
		ResourceType: string(b.ResourceType), ResourceID: b.ResourceID.String(), OrgID: b.OrgID.String(), Role: b.Role.String(), CreatedAt: b.CreatedAt.UTC(),
	}
	if b.GrantedBy != nil {
		s := b.GrantedBy.String()
		out.GrantedByUserID = &s
	}
	return out
}

func (a *API) listRoleBindings(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	var f core.BindingFilter
	var err error
	if f.ResourceType, err = queryValue(r, "resource_type"); err != nil {
		return err
	}
	if f.ResourceID, err = queryValue(r, "resource_id"); err != nil {
		return err
	}
	if f.OrgID, err = queryValue(r, "org_id"); err != nil {
		return err
	}
	p, err := page(r)
	if err != nil {
		return err
	}
	list, total, err := a.svc.ListRoleBindings(r.Context(), c, f, p)
	if err != nil {
		return err
	}
	out := make([]roleBindingJSON, 0, len(list))
	for _, b := range list {
		out = append(out, bindingView(b))
	}
	httpx.WriteJSON(w, http.StatusOK, newPage(out, total, p))
	return nil
}

type roleBindingCreate struct {
	PrincipalType opt[string] `json:"principal_type"`
	PrincipalID   opt[string] `json:"principal_id"`
	Username      opt[string] `json:"username"`
	ResourceType  opt[string] `json:"resource_type"`
	ResourceID    opt[string] `json:"resource_id"`
	Role          opt[string] `json:"role"`
}

func (a *API) createRoleBinding(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	var in roleBindingCreate
	if err := decode(w, r, &in); err != nil {
		return err
	}
	for _, req := range []struct {
		name string
		set  bool
	}{{"resource_type", in.ResourceType.Set}, {"resource_id", in.ResourceID.Set}, {"role", in.Role.Set}} {
		if !req.set {
			return httpx.Validation(req.name, "is required")
		}
	}
	b, err := a.svc.CreateRoleBinding(r.Context(), c, core.BindingInput{
		PrincipalType: in.PrincipalType.ptr(), PrincipalID: in.PrincipalID.ptr(), Username: in.Username.ptr(),
		ResourceType: in.ResourceType.Value, ResourceID: in.ResourceID.Value, Role: in.Role.Value,
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, bindingView(b))
	return nil
}

type roleBindingUpdate struct {
	Role string `json:"role"`
}

func (a *API) updateRoleBinding(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	id, err := pathID(r, "binding_id")
	if err != nil {
		return err
	}
	var in roleBindingUpdate
	if err := decode(w, r, &in); err != nil {
		return err
	}
	b, err := a.svc.UpdateRoleBinding(r.Context(), c, id, in.Role)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, bindingView(b))
	return nil
}

func (a *API) deleteRoleBinding(w http.ResponseWriter, r *http.Request, c core.Caller) error {
	id, err := pathID(r, "binding_id")
	if err != nil {
		return err
	}
	if err := a.svc.DeleteRoleBinding(r.Context(), c, id); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
