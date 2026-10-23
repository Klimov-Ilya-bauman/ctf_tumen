package rrdata

import (
	"encoding/hex"
	"strconv"
	"strings"
)

type GenericData struct {
	Rdata *string `json:"rdata"`
}

func FormatGeneric(wire []byte) string {
	if len(wire) == 0 {
		return `\# 0`
	}
	return `\# ` + strconv.Itoa(len(wire)) + " " + strings.ToUpper(hex.EncodeToString(wire))
}
