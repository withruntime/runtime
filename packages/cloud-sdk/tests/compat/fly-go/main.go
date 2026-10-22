// Fly's own Go client (github.com/superfly/fly-go, flaps) against Runtime:
// the only switch is FLY_FLAPS_BASE_URL, pointed at `npx withruntime fly-api`.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	fly "github.com/superfly/fly-go"
	"github.com/superfly/fly-go/flaps"
	"github.com/superfly/fly-go/tokens"
)

func must(step string, err error) {
	if err != nil {
		fmt.Printf("FAIL %s: %v\n", step, err)
		os.Exit(1)
	}
	fmt.Printf("ok   %s\n", step)
}

func main() {
	ctx := context.Background()
	app := "fly-go-check"
	client, err := flaps.NewWithOptions(ctx, flaps.NewClientOpts{Tokens: tokens.Parse(os.Getenv("FLY_API_TOKEN"))})
	must("flaps.NewWithOptions", err)
	machine, err := client.Launch(ctx, app, fly.LaunchMachineInput{
		Region: "iad",
		Config: &fly.MachineConfig{
			Image:    "registry-1.docker.io/library/ubuntu:latest",
			Init:     fly.MachineInit{Exec: []string{"/bin/sleep", "inf"}},
			Env:      map[string]string{"GREETING": "hello from fly-go"},
			Guest:    &fly.MachineGuest{CPUKind: "shared", CPUs: 1, MemoryMB: 256},
			Restart:  &fly.MachineRestart{Policy: fly.MachineRestartPolicyOnFailure},
			Metadata: map[string]string{"team": "agents"},
		},
	})
	must("Launch", err)
	fmt.Printf("     machine %s in %s, state %s\n", machine.ID, machine.Region, machine.State)
	defer client.Destroy(ctx, app, fly.RemoveMachineInput{ID: machine.ID, Kill: true}, "")
	must("Wait started", client.Wait(ctx, app, machine.ID, flaps.WithWaitStates("started"), flaps.WithWaitTimeout(60*time.Second)))
	out, err := client.Exec(ctx, app, machine.ID, &fly.MachineExecRequest{Cmd: "sh -c 'echo $GREETING'"})
	must("Exec", err)
	fmt.Printf("     stdout %q exit %d\n", out.StdOut, out.ExitCode)
	must("SetMetadata", client.SetMetadata(ctx, app, machine.ID, "stage", "live"))
	meta, err := client.GetMetadata(ctx, app, machine.ID)
	must("GetMetadata", err)
	fmt.Printf("     metadata %v\n", meta)
	ttl := 30
	lease, err := client.AcquireLease(ctx, app, machine.ID, &ttl)
	must("AcquireLease", err)
	nonce := lease.Data.Nonce
	must("Suspend", client.Suspend(ctx, app, machine.ID, nonce))
	_, err = client.Start(ctx, app, machine.ID, nonce)
	must("Start (from suspended)", err)
	must("Stop", client.Stop(ctx, app, fly.StopMachineInput{ID: machine.ID}, nonce))
	must("Wait stopped", client.Wait(ctx, app, machine.ID, flaps.WithWaitStates("stopped"), flaps.WithWaitTimeout(60*time.Second)))
	must("ReleaseLease", client.ReleaseLease(ctx, app, machine.ID, nonce))
	list, err := client.List(ctx, app, "")
	must("List", err)
	fmt.Printf("     %d machine(s)\n", len(list))
	must("Destroy", client.Destroy(ctx, app, fly.RemoveMachineInput{ID: machine.ID, Kill: true}, ""))
}
