package connect

import (
	"context"
	"fmt"
	"sync"
)

type EntitlementChecker struct {
	client Client
	status *ConnectStatus
	mu     sync.RWMutex
}

func NewEntitlementChecker(client Client) *EntitlementChecker {
	return &EntitlementChecker{client: client}
}

func (e *EntitlementChecker) Refresh() {
	e.mu.Lock()
	defer e.mu.Unlock()

	status, err := e.client.Status(context.TODO())
	if err != nil {
		return
	}
	e.status = status
}

func (e *EntitlementChecker) Valid() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.status != nil && e.status.Connected
}

func (e *EntitlementChecker) Reason() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.status == nil {
		return "Not checked"
	}
	if !e.status.Connected {
		return "Not connected to LibreServ Connect"
	}
	return ""
}

func (e *EntitlementChecker) SupportLevel() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.status != nil && e.status.Plan != nil {
		return string(e.status.Plan.ID)
	}
	return ""
}

func (e *EntitlementChecker) LicenseID() string {
	if t := e.client.Token(); t != "" {
		return fmt.Sprintf("connect-%s", tokenHint(t))
	}
	return ""
}

func (e *EntitlementChecker) HasFeature(feature ServiceID) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.status == nil || !e.status.Connected {
		return false
	}
	svc, ok := e.status.Services[feature]
	return ok && svc.State == ServiceConnected
}

func (e *EntitlementChecker) ServiceState(feature ServiceID) ServiceState {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.status == nil {
		return ServiceDisabled
	}
	svc, ok := e.status.Services[feature]
	if !ok {
		return ServiceDisabled
	}
	return svc.State
}

func (e *EntitlementChecker) Plan() *ConnectPlan {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.status != nil {
		return e.status.Plan
	}
	return nil
}

func (e *EntitlementChecker) Token() string {
	return e.client.Token()
}

func (e *EntitlementChecker) Status() *ConnectStatus {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.status == nil {
		return &ConnectStatus{Connected: false, Services: defaultServiceStates()}
	}
	cp := *e.status
	return &cp
}
