package withruntime

import (
	"context"
	"encoding/json"
	"errors"
	"iter"
	"net/http"
	"net/url"
	"time"
)

// Volume is a persistent disk with off-host backup status and policy.
type Volume struct {
	ID string `json:"id"`
	// State is creating, ready, failed, deleting or deleted.
	State        string            `json:"state"`
	Status       string            `json:"status"`
	Name         *string           `json:"name"`
	Labels       map[string]string `json:"labels"`
	Region       string            `json:"region"`
	SizeMiB      int               `json:"sizeMiB"`
	Filesystem   string            `json:"filesystem"`
	UsedMiB      *int              `json:"usedMiB"`
	MeasuredAt   *time.Time        `json:"measuredAt"`
	BackedUp     bool              `json:"backedUp"`
	Backups      BackupPolicy      `json:"backups"`
	RestoredFrom *string           `json:"restoredFrom"`
	// Resize is the newest growth of this volume, nil if it was never grown.
	Resize *VolumeResize `json:"resize"`
	// Attachments are the sandboxes it is attached to now.
	Attachments []struct {
		SandboxID  string    `json:"sandboxId"`
		Mode       string    `json:"mode"`
		Path       string    `json:"path"`
		AttachedAt time.Time `json:"attachedAt"`
	} `json:"attachments"`
	Error     *string    `json:"error"`
	CreatedAt time.Time  `json:"createdAt"`
	ReadyAt   *time.Time `json:"readyAt"`
}

// CreateVolumeOptions requires SizeMiB unless restoring FromBackup.
type CreateVolumeOptions struct {
	SizeMiB        int               `json:"sizeMiB,omitempty"`
	FromBackup     string            `json:"fromBackup,omitempty"`
	Name           string            `json:"name,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
	Region         string            `json:"region,omitempty"`
	IdempotencyKey string            `json:"-"`
}

// VolumeResize is a volume's growth: State is pending, running, completed
// or failed. SizeMiB is the size asked for; Volume.SizeMiB changes once the
// grown disk has been checked.
type VolumeResize struct {
	ID          string  `json:"id"`
	OperationID string  `json:"operationId"`
	SizeMiB     int     `json:"sizeMiB"`
	State       string  `json:"state"`
	Generation  int     `json:"generation"`
	Error       *string `json:"error"`
}

// ResizeVolumeOptions grow a volume to SizeMiB, which must be larger than
// its size now. Wait is how many seconds to wait for it (10 unless set).
type ResizeVolumeOptions struct {
	SizeMiB        int    `json:"sizeMiB"`
	IdempotencyKey string `json:"-"`
	Wait           *int   `json:"-"`
}

// VolumeListOptions filter a list, every field optional.
type VolumeListOptions struct {
	State string
	Name  string
	Limit int
}

// VolumeService is client.Volumes: persistent disks. Create one, then attach
// it when creating a sandbox with CreateOptions.Volumes.
type VolumeService struct{ c *Client }

// Create makes a volume and waits (up to 10 seconds) until it is ready.
func (s *VolumeService) Create(ctx context.Context, opts CreateVolumeOptions) (*Volume, error) {
	var volume Volume
	return &volume, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/volumes", body: opts, wait: 10, key: opts.IdempotencyKey}, &volume)
}

// Get reads a volume.
func (s *VolumeService) Get(ctx context.Context, id string) (*Volume, error) {
	var volume Volume
	return &volume, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/volumes/" + url.PathEscape(id)}, &volume)
}

// List returns the first page of volumes.
func (s *VolumeService) List(ctx context.Context, opts *VolumeListOptions) (*Page[Volume], error) {
	query := url.Values{}
	if opts != nil {
		setQuery(query, "state", opts.State, "name", opts.Name, "limit", itoa(opts.Limit))
	}
	return listPage[Volume](ctx, s.c, "/v1/volumes", query, "")
}

// All walks every volume a list with these options finds.
func (s *VolumeService) All(ctx context.Context, opts *VolumeListOptions) iter.Seq2[Volume, error] {
	return walk(ctx, func() (*Page[Volume], error) { return s.List(ctx, opts) })
}

// Resize grows a volume no sandbox holds, on its host, and waits (up to 10
// seconds unless opts.Wait says otherwise) for it. Its Resize field shows
// how far it has got.
func (s *VolumeService) Resize(ctx context.Context, id string, opts ResizeVolumeOptions) (*Volume, error) {
	wait := 10
	if opts.Wait != nil {
		wait = *opts.Wait
	}
	var volume Volume
	return &volume, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/volumes/" + url.PathEscape(id) + ":resize", body: opts, wait: wait, key: opts.IdempotencyKey}, &volume)
}

// Delete deletes a volume and everything on it.
func (s *VolumeService) Delete(ctx context.Context, id string) (*Volume, error) {
	var volume Volume
	return &volume, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/volumes/" + url.PathEscape(id) + ":delete", body: map[string]any{}}, &volume)
}

// VolumeBackup is a checked point-in-time copy kept off the volume's host.
type VolumeBackup struct {
	ID            string            `json:"id"`
	Kind          string            `json:"kind"`
	State         string            `json:"state"`
	Status        string            `json:"status"`
	Name          *string           `json:"name"`
	Labels        map[string]string `json:"labels"`
	Region        string            `json:"region"`
	VolumeID      string            `json:"volumeId"`
	SizeMiB       int               `json:"sizeMiB"`
	// Trigger is manual, daily, or scheduled: made on the volume's own
	// schedule and kept as its keep counts say.
	Trigger string `json:"trigger"`
	// RetentionDays is 0 while the volume's keep counts decide.
	RetentionDays int               `json:"retentionDays"`
	LogicalBytes  *int64            `json:"logicalBytes"`
	StoredBytes   *int64            `json:"storedBytes"`
	MeteredBytes  *int64            `json:"meteredBytes"`
	Error         *string           `json:"error"`
	ErrorCode     *string           `json:"errorCode"` // backup_stalled: its copy had not begun 15 minutes after CreatedAt
	CreatedAt     time.Time         `json:"createdAt"`
	CopyStartedAt *time.Time        `json:"copyStartedAt"` // when its copy off the volume's server began; nil until then
	ReadyAt       *time.Time        `json:"readyAt"`
	// ExpiresAt is the zero time while the volume's keep counts decide.
	ExpiresAt time.Time `json:"expiresAt"`
}
type BackupVolumeOptions struct {
	Name           string            `json:"name,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
	RetentionDays  int               `json:"retentionDays,omitempty"`
	IdempotencyKey string            `json:"-"`
	Wait           *int              `json:"-"`
}
// BackupPolicy is a volume's automatic backups: daily, each kept
// RetentionDays, or on its own Schedule keeping the Keep counts.
type BackupPolicy struct {
	Daily         bool            `json:"daily"`
	RetentionDays int             `json:"retentionDays"`
	Schedule      *BackupSchedule `json:"schedule"`
	Keep          *BackupKeep     `json:"keep"`
	// NextAt is when the schedule next makes a backup; nil when daily or off.
	NextAt      *time.Time `json:"nextAt"`
	LastReadyAt *time.Time `json:"lastReadyAt"`
}

// BackupSchedule backs a volume up every EveryMinutes minutes (15 or more,
// from 1970-01-01 UTC) or on Cron, five fields in UTC such as "0 */6 * * *".
// Give one.
type BackupSchedule struct {
	EveryMinutes int    `json:"everyMinutes,omitempty"`
	Cron         string `json:"cron,omitempty"`
}

// BackupKeep says which scheduled backups stay: the Last N, and the newest
// in each of the newest N hours, days, weeks (from Monday), months and
// years. Any backup a count keeps is kept; the newest ready one always is.
type BackupKeep struct {
	Last    int `json:"last,omitempty"`
	Hourly  int `json:"hourly,omitempty"`
	Daily   int `json:"daily,omitempty"`
	Weekly  int `json:"weekly,omitempty"`
	Monthly int `json:"monthly,omitempty"`
	Yearly  int `json:"yearly,omitempty"`
}

// SetBackupPolicyOptions turns automatic backups on or off, sets the days a
// daily backup is kept, or gives the volume a Schedule of its own with Keep
// counts. NoSchedule takes the schedule off: back to daily backups.
type SetBackupPolicyOptions struct {
	Daily         *bool           `json:"daily,omitempty"`
	RetentionDays int             `json:"retentionDays,omitempty"`
	Schedule      *BackupSchedule `json:"schedule,omitempty"`
	Keep          *BackupKeep     `json:"keep,omitempty"`
	NoSchedule    bool            `json:"-"`
}

// MarshalJSON sends NoSchedule as "schedule": null.
func (o SetBackupPolicyOptions) MarshalJSON() ([]byte, error) {
	type plain SetBackupPolicyOptions
	body, err := json.Marshal(plain(o))
	if err != nil || !o.NoSchedule {
		return body, err
	}
	if o.Schedule != nil {
		return nil, errors.New("runtime: give Schedule or NoSchedule, not both")
	}
	var fields map[string]any
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	fields["schedule"] = nil
	return json.Marshal(fields)
}
type BackupListOptions struct {
	VolumeID string
	State    string
	Limit    int
}

func (s *VolumeService) Backup(ctx context.Context, id string, opts *BackupVolumeOptions) (*VolumeBackup, error) {
	if opts == nil {
		opts = &BackupVolumeOptions{}
	}
	wait := 60
	if opts.Wait != nil {
		wait = *opts.Wait
	}
	var out VolumeBackup
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/volumes/" + url.PathEscape(id) + ":backup", body: opts, key: opts.IdempotencyKey, wait: wait}, &out)
}
func (s *VolumeService) SetBackupPolicy(ctx context.Context, id string, opts SetBackupPolicyOptions) (*Volume, error) {
	var out Volume
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/volumes/" + url.PathEscape(id) + ":backup-policy", body: opts}, &out)
}
func (s *VolumeService) Backups(ctx context.Context, opts *BackupListOptions) (*Page[VolumeBackup], error) {
	query := url.Values{}
	if opts != nil {
		setQuery(query, "volumeId", opts.VolumeID, "state", opts.State, "limit", itoa(opts.Limit))
	}
	return listPage[VolumeBackup](ctx, s.c, "/v1/volume-backups", query, "")
}
func (s *VolumeService) GetBackup(ctx context.Context, id string) (*VolumeBackup, error) {
	var out VolumeBackup
	return &out, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/volume-backups/" + url.PathEscape(id)}, &out)
}
func (s *VolumeService) DeleteBackup(ctx context.Context, id string) (*VolumeBackup, error) {
	var out VolumeBackup
	return &out, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/volume-backups/" + url.PathEscape(id) + ":delete", body: map[string]any{}}, &out)
}
func (s *VolumeService) Restore(ctx context.Context, id string, opts *CreateVolumeOptions) (*Volume, error) {
	input := CreateVolumeOptions{}
	if opts != nil {
		input = *opts
	}
	input.FromBackup = id
	return s.Create(ctx, input)
}
