package connect

import (
	"context"
	"fmt"
	"sync"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
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

	var status *ConnectStatus
	if e.status == nil {
		status = &ConnectStatus{Connected: false, Services: defaultServiceStates()}
	} else {
		cp := *e.status
		status = &cp
	}

	cfg := config.Get()
	if cfg != nil {
		for id, raw := range cfg.Connect.ServiceStates {
			svcID := ServiceID(id)
			state := ServiceState(raw)
			if _, ok := status.Services[svcID]; !ok {
				continue
			}
			switch state {
			case ServiceConnected:
				// Leave the server-provided state untouched.
			case ServiceBYO, ServiceDisabled:
				status.Services[svcID] = ServiceStatus{State: state, Label: status.Services[svcID].Label}
			}
		}
	}

	return status
}
