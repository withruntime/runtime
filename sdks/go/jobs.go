package withruntime

import (
	"context"
	"net/http"
)

// JobService is Runtime Jobs: a command run in a fresh sandbox, once or on a
// cron schedule. This SDK reads other platforms' jobs into Runtime jobs
// (ImportPlan); create and manage jobs with the CLI (`runtime jobs`), the
// TypeScript or Python SDK, or the HTTP API.
type JobService struct{ c *Client }

// JobImportFile is one of the files ImportPlan reads, with its name.
type JobImportFile struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

// JobImportRequest is a Google Cloud Run job's YAML (with the Cloud
// Scheduler job that runs it) or an AWS Batch job definition (API JSON,
// describe-job-definitions output or a CloudFormation template, with the
// EventBridge schedule or rule that submits it).
type JobImportRequest struct {
	Files []JobImportFile `json:"files"`
	// From is "cloud-run" or "aws-batch"; found from the files when empty.
	From string `json:"from,omitempty"`
	// Parameters are a CloudFormation template's values, such as
	// {"AWS::Region": "us-east-1"}.
	Parameters map[string]string `json:"parameters,omitempty"`
}

// JobImportSchedule is the schedule that ran a job: Kind "cron" with
// Expression, or "once" with At (a wall-clock time), in Timezone.
type JobImportSchedule struct {
	Kind       string `json:"kind"`
	Expression string `json:"expression,omitempty"`
	At         string `json:"at,omitempty"`
	Timezone   string `json:"timezone"`
}

// JobImportJob is one planned job. Its image is built from Dockerfile, and
// it runs the built image's start command.
type JobImportJob struct {
	Name        string            `json:"name"`
	File        string            `json:"file"`
	SourceImage string            `json:"sourceImage"`
	Dockerfile  string            `json:"dockerfile"`
	Command     []string          `json:"command"`
	Env         map[string]string `json:"env"`
	// Secrets are values it read from a secret store; each is bound from
	// the Runtime jobs secret of that name.
	Secrets []struct {
		Name string `json:"name"`
		From string `json:"from"`
	} `json:"secrets"`
	Compute struct {
		VCPU      int  `json:"vcpu"`
		MemoryMiB int  `json:"memoryMib"`
		DiskMiB   *int `json:"diskMib"`
	} `json:"compute"`
	TimeoutSeconds int `json:"timeoutSeconds"`
	Retry          struct {
		MaxAttempts    int `json:"maxAttempts"`
		BackoffSeconds int `json:"backoffSeconds"`
	} `json:"retry"`
	// Schedule is nil when no schedule ran it: it runs when triggered.
	Schedule *JobImportSchedule `json:"schedule"`
	// Blocked is why it cannot be created as planned; nil when it can.
	Blocked *string `json:"blocked"`
}

// JobImportNote is a setting not carried over as it was. Level is unmapped
// (left out), changed (carried over differently) or info.
type JobImportNote struct {
	Level   string `json:"level"`
	File    string `json:"file"`
	Key     string `json:"key"`
	Job     string `json:"job,omitempty"`
	Message string `json:"message"`
}

// JobImportPlan is what ImportPlan answers.
type JobImportPlan struct {
	From       string          `json:"from"`
	Read       []string        `json:"read"`
	Jobs       []JobImportJob  `json:"jobs"`
	Notes      []JobImportNote `json:"notes"`
	Importable bool            `json:"importable"`
}

// ImportPlan reads another platform's job files into the Runtime jobs that
// run the same container, and what could not be carried over. It changes
// nothing: `runtime jobs import` builds and creates the plan.
func (s *JobService) ImportPlan(ctx context.Context, req JobImportRequest) (*JobImportPlan, error) {
	var plan JobImportPlan
	return &plan, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/job-imports", body: req}, &plan)
}
