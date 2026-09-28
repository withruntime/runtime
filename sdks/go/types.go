package withruntime

import (
	"encoding/json"
	"time"
)

// SandboxInfo is a sandbox as the API answers it. Money is integer
// microdollars (1,000,000 = $1).
type SandboxInfo struct {
	ID     string            `json:"id"`
	Kind   string            `json:"kind"`
	Name   *string           `json:"name"`
	Labels map[string]string `json:"labels"`
	Status string            `json:"status"`
	// State is starting, running, pausing, paused, resuming, stopping or stopped.
	State          string `json:"state"`
	Region         string `json:"region"`
	Funding        string `json:"funding"`
	VCPU           int    `json:"vcpu"`
	MemoryMiB      int    `json:"memoryMiB"`
	DiskMiB        int    `json:"diskMiB"`
	CPU            string `json:"cpu"`
	CPUFloorMillis int    `json:"cpuFloorMillis"`
	Pausable       bool   `json:"pausable"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	// IdlePauseSeconds pauses it after this many idle seconds; 0 is never.
	IdlePauseSeconds int `json:"idlePauseSeconds"`
	// AutoWake: a request (exec, files, a visit to a shared port) wakes it
	// when paused.
	AutoWake bool `json:"autoWake"`
	// Persistent: its lease renews itself while credit lasts, and its disk is
	// kept after a stop.
	Persistent bool `json:"persistent"`
	// LastActiveAt is the last exec, file, terminal, desktop or preview
	// request, to within a minute.
	LastActiveAt *time.Time `json:"lastActiveAt"`
	OnLeaseEnd   string     `json:"onLeaseEnd"`
	CreatedAt    time.Time  `json:"createdAt"`
	ReadyAt      *time.Time `json:"readyAt"`
	ExpiresAt    *time.Time `json:"expiresAt"`
	EndedAt      *time.Time `json:"endedAt"`
	// StopReason says why a sandbox stopped, when it did.
	StopReason      *string    `json:"stopReason"`
	PausedAt        *time.Time `json:"pausedAt"`
	PausedExpiresAt *time.Time `json:"pausedExpiresAt"`
	ChargedMicros   int64      `json:"chargedMicros"`
	HeldMicros      int64      `json:"heldMicros"`
	// Replayed is true when the answer repeats an earlier call with the same
	// idempotency key.
	Replayed bool `json:"replayed"`
	// Reused is true when GetOrCreate answered a sandbox that already had
	// the name.
	Reused bool `json:"reused"`
	// Start says, on a create from an image with a start command, whether
	// it started, became ready, timed out or exited first.
	Start *struct {
		State     string `json:"state"`
		ProcessID string `json:"processId,omitempty"`
		ExitCode  *int   `json:"exitCode,omitempty"`
		ReadyMs   *int64 `json:"readyMs,omitempty"`
	} `json:"start,omitempty"`
	// Raw is the whole answer, for fields newer than this SDK.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON keeps the raw answer alongside the typed fields.
func (s *SandboxInfo) UnmarshalJSON(data []byte) error {
	type plain SandboxInfo
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*s = SandboxInfo(decoded)
	s.Raw = append(json.RawMessage(nil), data...)
	return nil
}

// Network is a sandbox's network rules, as on create and sbx.network.set.
type Network struct {
	Internet bool     `json:"internet"`
	Allow    []string `json:"allow,omitempty"`
	Deny     []string `json:"deny,omitempty"`
	Connect  []string `json:"connect,omitempty"`
}

// VolumeMount attaches a volume at create: "rw" (one sandbox at a time) or a
// read-only "snapshot" copy.
type VolumeMount struct {
	VolumeID string `json:"volumeId"`
	Path     string `json:"path"`
	Mode     string `json:"mode,omitempty"`
}

// CreateOptions are a create's fields, every one optional. With none you get
// the free trial while it lasts, the default region and a 2 vCPU / 4 GiB
// machine for up to 30 minutes.
type CreateOptions struct {
	Name   string            `json:"name,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`
	// Funding is "trial" or "paid". Omitted: the trial while it lasts, then
	// prepaid credit. Explicit trial funding never falls back to paid credit.
	Funding        string `json:"funding,omitempty"`
	Region         string `json:"region,omitempty"`
	VCPU           int    `json:"vcpu,omitempty"`
	MemoryMiB      int    `json:"memoryMiB,omitempty"`
	DiskMiB        int    `json:"diskMiB,omitempty"`
	CPU            string `json:"cpu,omitempty"`
	CPUFloorMillis int    `json:"cpuFloorMillis,omitempty"`
	// TimeoutSeconds is how long it may run before its lease ends. Default 1800.
	TimeoutSeconds int   `json:"timeoutSeconds,omitempty"`
	Pausable       *bool `json:"pausable,omitempty"`
	// OnLeaseEnd is "pause" (the default) or "stop".
	OnLeaseEnd string `json:"onLeaseEnd,omitempty"`
	// IdlePauseSeconds pauses it after this many seconds in which nothing
	// happens in it: no request, no command or terminal running, no open
	// connection, no network traffic and no CPU use (10 to 86400). Left 0, a
	// pausable sandbox pauses after 60. To never pause it, pass
	// Extra: map[string]any{"idlePauseSeconds": 0}. A request wakes it.
	IdlePauseSeconds int `json:"idlePauseSeconds,omitempty"`
	// AutoWake: a request to a paused sandbox wakes it. Default true.
	AutoWake *bool `json:"autoWake,omitempty"`
	// Persistent keeps it running while credit lasts and keeps its disk after
	// a stop, for Restart. Paid only.
	Persistent bool `json:"persistent,omitempty"`
	// MaxTotalCostMicros is the most it may cost over its whole life.
	MaxTotalCostMicros int64 `json:"maxTotalCostMicros,omitempty"`
	// GetOrCreate, with Name, returns the sandbox that already has the name,
	// woken if paused. Sandboxes.GetOrCreate sets it for you.
	GetOrCreate   bool          `json:"getOrCreate,omitempty"`
	MaxCostMicros int64         `json:"maxCostMicros,omitempty"`
	Network       *Network      `json:"network,omitempty"`
	Image         string        `json:"image,omitempty"`
	Snapshot      string        `json:"snapshot,omitempty"`
	Volumes       []VolumeMount `json:"volumes,omitempty"`

	// IdempotencyKey: leave it empty and the client makes one per call and
	// keeps it across its own retries. Pass your own only to retry a create
	// yourself after your process restarted.
	IdempotencyKey string `json:"-"`
	// NoWait returns as soon as the create is accepted instead of waiting
	// until the sandbox runs.
	NoWait bool `json:"-"`
	// WaitForCapacity replaces the client's for this create; a pointer to 0
	// fails at once when the trial, quota or region is full.
	WaitForCapacity *time.Duration `json:"-"`
	// Extra carries fields newer than this SDK. They are merged into the body.
	Extra map[string]any `json:"-"`
}

// CommandResult is a finished command. A timeout is a result (TimedOut, with
// the output so far), not an error.
type CommandResult struct {
	ExitCode        *int   `json:"exitCode"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	TimedOut        bool   `json:"timedOut"`
	StdoutTruncated bool   `json:"stdoutTruncated"`
	StderrTruncated bool   `json:"stderrTruncated"`
	DurationMs      *int64 `json:"durationMs"`
	ProcessID       string `json:"processId,omitempty"`
	Replayed        bool   `json:"replayed"`
}

// OutputEvent is one event of a command's or a process's output: start,
// stdout, stderr, exit, truncated, continue or error.
type OutputEvent struct {
	Type      string `json:"type"`
	ProcessID string `json:"processId,omitempty"`
	// Data is the text of a stdout or stderr event; Offset is its first
	// byte's position in the stream.
	Data   string `json:"data,omitempty"`
	Offset int64  `json:"offset,omitempty"`
	// ExitCode, State, TimedOut and DurationMs are an exit event's.
	ExitCode   *int   `json:"exitCode,omitempty"`
	State      string `json:"state,omitempty"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	DurationMs *int64 `json:"durationMs,omitempty"`
	// DroppedBytes and ResumeAt are a truncated event's: the reader fell more
	// than the sandbox's output buffer behind.
	DroppedBytes int64 `json:"droppedBytes,omitempty"`
	ResumeAt     int64 `json:"resumeAt,omitempty"`
	// Cursor is a continue event's: where to resume following.
	Cursor int64 `json:"cursor,omitempty"`
	Error  *struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"requestId"`
	} `json:"error,omitempty"`
	Replayed bool `json:"replayed,omitempty"`
}

// ProcessInfo is a background process.
type ProcessInfo struct {
	ID          string     `json:"id"`
	Kind        string     `json:"kind"`
	State       string     `json:"state"`
	ExitCode    *int       `json:"exitCode"`
	Command     string     `json:"command"`
	Cwd         string     `json:"cwd"`
	PTY         bool       `json:"pty"`
	StdinOpen   bool       `json:"stdinOpen"`
	StdinOffset int64      `json:"stdinOffset"`
	StartedAt   time.Time  `json:"startedAt"`
	EndedAt     *time.Time `json:"endedAt"`
	TimeoutMs   *int64     `json:"timeoutMs"`
	OutputBytes int64      `json:"outputBytes"`
	FirstOffset int64      `json:"firstOffset"`
}

// FileEntry is a file, directory or link in a sandbox.
type FileEntry struct {
	Name       string    `json:"name"`
	Path       string    `json:"path"`
	Type       string    `json:"type"`
	Size       int64     `json:"size"`
	Mode       string    `json:"mode"`
	ModifiedAt time.Time `json:"modifiedAt"`
}

// Me is who a key is.
type Me struct {
	OrgID        string  `json:"orgId"`
	PrincipalID  string  `json:"principalId"`
	CredentialID *string `json:"credentialId"`
	APIVersion   string  `json:"apiVersion"`
	// OrgName is the account's name.
	OrgName *string `json:"orgName"`
	// Role is the role of the member who made this key: owner, admin,
	// developer or billing.
	Role *string `json:"role"`
}

// SandboxSettings are what Sandbox.Update changes; nil fields stay as they
// are.
type SandboxSettings struct {
	Name   *string           `json:"name,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`
	// AutoWake: a request to a paused sandbox wakes it.
	AutoWake *bool `json:"autoWake,omitempty"`
	// IdlePauseSeconds pauses it after this many idle seconds, counted from
	// now; 0 never, otherwise 10 to 86400.
	IdlePauseSeconds *int `json:"idlePauseSeconds,omitempty"`
	// Persistent keeps it running while credit lasts. Paid only.
	Persistent *bool `json:"persistent,omitempty"`
	// MaxTotalCostMicros is a lifetime cap; RemoveMaxTotalCost removes it.
	MaxTotalCostMicros *int64 `json:"-"`
	RemoveMaxTotalCost bool   `json:"-"`
}

// Usage is the account's money and trial time. Money is integer microdollars
// in strings, exact past 2^53: Available = Credited - Spent - Expired - Held.
type Usage struct {
	OrgID     string `json:"orgId"`
	Unit      string `json:"unit"`
	Credited  string `json:"credited"`
	Spent     string `json:"spent"`
	Held      string `json:"held"`
	Expired   string `json:"expired"`
	Available string `json:"available"`
	TakenBack string `json:"takenBack"`
	Trial     *struct {
		TotalMs     int64 `json:"totalMs"`
		UsedMs      int64 `json:"usedMs"`
		ReservedMs  int64 `json:"reservedMs"`
		AvailableMs int64 `json:"availableMs"`
	} `json:"trial"`
	Resources []map[string]any `json:"resources"`
}

// KeyLimits is whether a key is read-only and its agent's daily limit. Money
// is integer microdollars in strings.
type KeyLimits struct {
	// Access is "full", "read" or "selected".
	Access *string `json:"access"`
	Daily  struct {
		LimitMicros     *string `json:"limitMicros"`
		UsedMicros      string  `json:"usedMicros"`
		RemainingMicros *string `json:"remainingMicros"`
		Window          string  `json:"window"`
	} `json:"daily"`
}
