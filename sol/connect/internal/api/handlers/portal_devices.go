package handlers

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
)

// Device lookups fail in three different ways, and the portal must not report
// one as another: a database outage is not a fact about the account's devices,
// and a device that vanished is not the same as one that belongs to someone
// else. Handlers pass these sentinels to respondDeviceLookupError.
var (
	// errNoActiveDevice means the account genuinely has no active device.
	errNoActiveDevice = errors.New("account has no active device")
	// errDeviceNotFound means no device with that id exists.
	errDeviceNotFound = errors.New("device not found")
	// errDeviceNotOwned means the device exists but belongs to another account.
	errDeviceNotOwned = errors.New("device belongs to another account")
)

// activeDeviceID returns the account's active device id, or errNoActiveDevice
// when it has none. Any other error is a real database failure and is returned
// unwrapped, so callers never dress it up as "no device linked".
func (h *PortalHandler) activeDeviceID(ctx context.Context, accountID string) (string, error) {
	var deviceID string
	err := h.db.QueryRowContext(ctx,
		"SELECT id FROM devices WHERE account_id = $1 AND is_active = TRUE LIMIT 1", accountID).Scan(&deviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errNoActiveDevice
	}
	if err != nil {
		return "", err
	}
	return deviceID, nil
}

// respondDeviceLookupError writes the honest answer for a failed device
// lookup. A genuine refusal keeps its sentence; a database failure is a 500
// that says the check failed instead of inventing a reason about the account.
func respondDeviceLookupError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, errNoActiveDevice):
		JSONError(w, http.StatusBadRequest, "no device linked to your account")
	case errors.Is(err, errDeviceNotFound):
		JSONError(w, http.StatusNotFound, "that device is not on your account")
	case errors.Is(err, errDeviceNotOwned):
		JSONError(w, http.StatusForbidden, "that device is not on your account")
	default:
		slog.Error("portal: could not look up device", "error", err, "path", r.URL.Path)
		JSONError(w, http.StatusInternalServerError, "could not check that device right now")
	}
}
