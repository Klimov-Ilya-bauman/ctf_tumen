package httpapi

import (
	"net/http"
	"time"
)

const maxCiphertext = 8192

func (a *API) moves(w http.ResponseWriter, r *http.Request) {
	g, ok := a.loadGame(w, r)
	if !ok {
		return
	}
	ms, err := a.Store.Moves(r.Context(), g.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		out = append(out, map[string]any{
			"seq": m.Seq, "board_c_b64": b64(m.BoardC), "created_at": m.CreatedAt.Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) messages(w http.ResponseWriter, r *http.Request) {
	g, ok := a.loadGame(w, r)
	if !ok {
		return
	}
	ms, err := a.Store.Messages(r.Context(), g.ID)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		out = append(out, map[string]any{
			"sender_id": m.SenderID, "ciphertext": m.Ciphertext, "created_at": m.CreatedAt.Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) postMessage(w http.ResponseWriter, r *http.Request) {
	g, ok := a.loadGame(w, r)
	if !ok {
		return
	}
	if !isParticipant(g, userID(r)) {
		writeErr(w, http.StatusForbidden, "not a participant")
		return
	}
	var req struct {
		Ciphertext string `json:"ciphertext"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Ciphertext == "" || len(req.Ciphertext) > maxCiphertext {
		writeErr(w, http.StatusBadRequest, "ciphertext must be 1-8192 chars")
		return
	}
	if err := a.Store.AddMessage(r.Context(), g.ID, userID(r), req.Ciphertext); err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, struct{}{})
}
