package httpapi

import (
	"net/http"
	"strconv"
)

type pageRequest struct {
	Cursor int64
	Limit  int
}

func pagination(w http.ResponseWriter, r *http.Request, cursorName string) (pageRequest, bool) {
	page := pageRequest{Limit: 100}
	query := r.URL.Query()
	if raw := query.Get(cursorName); raw != "" {
		var err error
		page.Cursor, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || page.Cursor < 0 {
			writeErr(w, http.StatusBadRequest, "invalid pagination cursor")
			return page, false
		}
	}
	if raw := query.Get("limit"); raw != "" {
		var err error
		page.Limit, err = strconv.Atoi(raw)
		if err != nil || page.Limit < 1 || page.Limit > 100 {
			writeErr(w, http.StatusBadRequest, "limit must be between 1 and 100")
			return page, false
		}
	}
	return page, true
}
