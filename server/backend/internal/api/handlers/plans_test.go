package handlers

import (
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

func TestDetectPortCollisions(t *testing.T) {
	plans := []planResult{
		{AppID: "a", AppName: "Minecraft", Ports: []network.PortNeed{{Protocol: "tcp", Port: 25565}, {Protocol: "udp", Port: 25565}}},
		{AppID: "b", AppName: "OtherServer", Ports: []network.PortNeed{{Protocol: "tcp", Port: 25565}}},
		{AppID: "c", AppName: "Nextcloud", Ports: nil},
	}
	colls := detectPortCollisions(plans)
	if len(colls) != 1 {
		t.Fatalf("collisions = %d, want 1 (port 25565)", len(colls))
	}
	if colls[0]["port"] != 25565 {
		t.Errorf("port = %v, want 25565", colls[0]["port"])
	}
	apps := colls[0]["apps"].([]string)
	if len(apps) != 2 {
		t.Errorf("apps = %v, want [Minecraft OtherServer]", apps)
	}
}
