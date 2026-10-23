package httpapi

import (
	"context"
	"encoding/base64"
	"net/http"
	"strconv"

	"homomorphicgo/store"
)

const boardLen = 361

type userRef struct {
	ID        int64   `json:"id"`
	Username  string  `json:"username"`
	PubkeyB64 *string `json:"pubkey_b64,omitempty"`
}

func gameID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not found")
		return 0, false
	}
	return id, true
}

// loadGame resolves {id} to a game, writing 404 when it is malformed or absent.
func (a *API) loadGame(w http.ResponseWriter, r *http.Request) (*store.Game, bool) {
	id, ok := gameID(w, r)
	if !ok {
		return nil, false
	}
	g, err := a.Store.GetGame(r.Context(), id)
	if err != nil {
		writeStoreErr(w, err)
		return nil, false
	}
	return g, true
}

func isParticipant(g *store.Game, uid int64) bool {
	return g.BlackID == uid || (g.WhiteID != nil && *g.WhiteID == uid)
}

func (a *API) userRef(ctx context.Context, id int64, withKey bool) (*userRef, error) {
	u, err := a.Store.UserByID(ctx, id)
	if err != nil {
		return nil, err
	}
	ref := &userRef{ID: u.ID, Username: u.Username}
	if withKey {
		k := b64(u.Pubkey)
		ref.PubkeyB64 = &k
	}
	return ref, nil
}

func (a *API) players(ctx context.Context, g *store.Game, withKey bool) (black, white *userRef, err error) {
	if black, err = a.userRef(ctx, g.BlackID, withKey); err != nil {
		return nil, nil, err
	}
	if g.WhiteID != nil {
		if white, err = a.userRef(ctx, *g.WhiteID, withKey); err != nil {
			return nil, nil, err
		}
	}
	return black, white, nil
}

func (a *API) listGames(w http.ResponseWriter, r *http.Request) {
	games, err := a.Store.ListGames(r.Context())
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	out := make([]map[string]any, 0, len(games))
	for i := range games {
		black, white, err := a.players(r.Context(), &games[i], false)
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		out = append(out, map[string]any{"id": games[i].ID, "black": black, "white": white, "status": games[i].Status})
	}
	writeJSON(w, http.StatusOK, out)
}

// optionalPubkey decodes an optional pubkey (nil when absent); writes 400 on a bad body or key.
func optionalPubkey(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	var req pubkeyReq
	if !decodeJSON(w, r, &req) {
		return nil, false
	}
	pub, ok := decodePubkey(req.PubkeyB64)
	if !ok {
		writeErr(w, http.StatusBadRequest, "pubkey_b64 must decode to 19 bytes")
		return nil, false
	}
	return pub, true
}

func (a *API) storePubkey(w http.ResponseWriter, r *http.Request, pub []byte) bool {
	if pub == nil {
		return true
	}
	if err := a.Store.SetPubkey(r.Context(), userID(r), pub); err != nil {
		writeStoreErr(w, err)
		return false
	}
	return true
}

func (a *API) createGame(w http.ResponseWriter, r *http.Request) {
	pub, ok := optionalPubkey(w, r)
	if !ok || !a.storePubkey(w, r, pub) {
		return
	}
	id, err := a.Store.CreateGame(r.Context(), userID(r))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int64{"game_id": id})
}

// The pubkey is stored only after the join succeeds, so a 409 leaves it untouched.
func (a *API) joinGame(w http.ResponseWriter, r *http.Request) {
	g, ok := a.loadGame(w, r)
	if !ok {
		return
	}
	pub, ok := optionalPubkey(w, r)
	if !ok {
		return
	}
	if err := a.Store.JoinGame(r.Context(), g.ID, userID(r)); err != nil {
		writeStoreErr(w, err)
		return
	}
	if !a.storePubkey(w, r, pub) {
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

func (a *API) getGame(w http.ResponseWriter, r *http.Request) {
	g, ok := a.loadGame(w, r)
	if !ok {
		return
	}
	black, white, err := a.players(r.Context(), g, true)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": g.ID, "black": black, "white": white, "status": g.Status,
		"turn": g.Turn, "board_c_b64": b64(g.BoardC),
	})
}

func (a *API) move(w http.ResponseWriter, r *http.Request) {
	g, ok := a.loadGame(w, r)
	if !ok {
		return
	}
	if !isParticipant(g, userID(r)) {
		writeErr(w, http.StatusForbidden, "not a participant")
		return
	}
	if g.Status == "finished" {
		writeErr(w, http.StatusConflict, "game finished")
		return
	}
	var req struct {
		BoardCB64 string `json:"board_c_b64"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	board, err := base64.StdEncoding.DecodeString(req.BoardCB64)
	if err != nil || len(board) != boardLen {
		writeErr(w, http.StatusBadRequest, "board_c_b64 must decode to 361 bytes")
		return
	}
	if err := a.Store.ApplyMove(r.Context(), g.ID, board); err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}
