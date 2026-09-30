package withruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
)

var keyPattern = regexp.MustCompile(`^rtcloud_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$`)

var errOrigin = errors.New("withruntime: use an HTTPS API origin (or http://runtime.internal inside a sandbox, http://localhost for tests)")

// origin normalizes an API or sign-in origin exactly as the CLI does: HTTPS,
// plain HTTP to runtime.internal inside a sandbox, or plain HTTP to localhost
// for tests, with no path, query or credentials. runtime.internal is reserved
// and never resolves outside a sandbox, so a key sent there in plain HTTP
// never leaves the sandbox's host.
func origin(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" {
		return "", errOrigin
	}
	host := u.Hostname()
	internal := host == "runtime.internal"
	local := host == "localhost" || host == "127.0.0.1" || host == "::1" || internal
	if (u.Scheme != "https" && !(local && u.Scheme == "http")) || u.User != nil ||
		(internal && (u.Scheme != "http" || (u.Port() != "" && u.Port() != "80"))) ||
		u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errOrigin
	}
	if internal {
		return SandboxBaseURL, nil
	}
	return u.Scheme + "://" + u.Host, nil
}

// SandboxBaseURL is Runtime's API as code inside a Runtime sandbox reaches
// it: the sandbox's own host sends each request on to DefaultBaseURL over
// HTTPS. The API runs on that host, whose addresses a sandbox cannot reach
// directly. Plain HTTP because the hop never leaves the machine: from the
// program to the guest's own proxy, then over the sandbox's private channel
// to its host.
const SandboxBaseURL = "http://runtime.internal"

// sandboxMarker is a file every Runtime sandbox has; the guest keeps it current.
var sandboxMarker = "/run/runtime/environment.json"

func inRuntimeSandbox() bool {
	_, err := os.Stat(sandboxMarker)
	return err == nil
}

// reachable is the origin calls for apiOrigin are sent to from here. In a
// sandbox the public API is its own host, which it cannot reach directly, so
// calls for it go to runtime.internal; every other origin is left as it is.
func reachable(apiOrigin string, inSandbox func() bool) string {
	if apiOrigin == DefaultBaseURL && inSandbox() {
		return SandboxBaseURL
	}
	return apiOrigin
}

// savedConnection is the file `runtime login` writes. Its format is the CLI's
// (packages/cloud-sdk/src/credentials.ts) and must stay identical.
type savedConnection struct {
	Version      int     `json:"version"`
	APIOrigin    string  `json:"apiOrigin"`
	AuthOrigin   string  `json:"authOrigin"`
	Key          string  `json:"key"`
	ConnectionID *string `json:"connectionId"`
	OrgID        *string `json:"orgId"`
	AgentName    *string `json:"agentName"`
}

// connectionFile is where the CLI keeps this machine's connection for the two
// origins: $XDG_CONFIG_HOME/runtime-cloud (or ~/.config/runtime-cloud), named
// by the SHA-256 of "<sign-in origin>\n<API origin>".
func connectionFile(apiOrigin, authOrigin string) (string, string, error) {
	root := os.Getenv("XDG_CONFIG_HOME")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", "", err
		}
		root = filepath.Join(home, ".config")
	}
	if !filepath.IsAbs(root) {
		return "", "", errors.New("withruntime: XDG_CONFIG_HOME must be an absolute path")
	}
	sum := sha256.Sum256([]byte(authOrigin + "\n" + apiOrigin))
	directory := filepath.Join(root, "runtime-cloud")
	return directory, filepath.Join(directory, hex.EncodeToString(sum[:])+".json"), nil
}

// savedKey reads the key `runtime login` saved for this machine: only from a
// private file in a private directory, bound to both origins. It returns ""
// with no error when there is none.
func savedKey(apiOrigin string) (string, error) {
	authOrigin := "https://withruntime.com"
	if value := os.Getenv("RUNTIME_AUTH_URL"); value != "" {
		normalized, err := origin(value)
		if err != nil {
			return "", err
		}
		authOrigin = normalized
	}
	directory, file, err := connectionFile(apiOrigin, authOrigin)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(directory)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !info.IsDir() || !private(info) {
		return "", errors.New("withruntime: Runtime's credential directory must be private to your user")
	}
	handle, err := openNoFollow(file)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", errors.New("withruntime: could not safely open Runtime's saved connection")
	}
	defer handle.Close()
	stat, err := handle.Stat()
	if err != nil {
		return "", err
	}
	if !stat.Mode().IsRegular() || stat.Size() > 4096 || !private(stat) {
		return "", errors.New("withruntime: Runtime's saved connection must be private to your user")
	}
	text, err := io.ReadAll(io.LimitReader(handle, 4097))
	if err != nil {
		return "", err
	}
	var saved savedConnection
	invalid := errors.New("withruntime: Runtime's saved connection is invalid. Connect again with `npx withruntime login`")
	if json.Unmarshal(text, &saved) != nil {
		return "", invalid
	}
	if saved.Version != 1 || saved.APIOrigin != apiOrigin || saved.AuthOrigin != authOrigin ||
		!keyPattern.MatchString(saved.Key) || saved.ConnectionID == nil || saved.OrgID == nil ||
		saved.AgentName == nil {
		return "", invalid
	}
	return saved.Key, nil
}

// private reports whether a file or directory is readable by this user alone.
// Windows keeps its own access lists, so there the check is the file's.
func private(info fs.FileInfo) bool {
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode().Perm()&0o077 == 0 && ownedByMe(info)
}
