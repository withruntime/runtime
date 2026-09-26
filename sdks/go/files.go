package withruntime

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const chunkBytes = 1 << 20

// Files reads and writes files in a sandbox. Paths are absolute; any path the
// sandbox user may use.
type Files struct {
	c       *Client
	sandbox *Sandbox
	Watches *WatchService
}

func (f *Files) path(suffix string) string { return f.sandbox.path(suffix) }

// Read returns a file's bytes, any size.
func (f *Files) Read(ctx context.Context, name string) ([]byte, error) {
	return f.c.bytes(ctx, &call{
		method: http.MethodGet,
		path:   f.path("/files/content"),
		query:  url.Values{"path": {name}},
		accept: "application/octet-stream",
	})
}

// ReadText returns a file's contents as text.
func (f *Files) ReadText(ctx context.Context, name string) (string, error) {
	data, err := f.Read(ctx, name)
	return string(data), err
}

// FileWriteOptions sets permissions and an optional logical-write retry key.
// Mode is nil for the default; a pointer preserves explicit mode 000.
type FileWriteOptions struct {
	Mode           *uint32
	IdempotencyKey string
}

// Write writes a file atomically, including large checked chunk uploads.
// Current images need write_file only; older images need exec for mode fallback.
func (f *Files) Write(ctx context.Context, name string, data []byte, options ...*FileWriteOptions) error {
	if len(options) > 1 {
		return errors.New("withruntime: only one file options value is allowed")
	}
	opts := &FileWriteOptions{}
	if len(options) > 0 && options[0] != nil {
		opts = options[0]
	}
	octal := ""
	if opts.Mode != nil {
		if *opts.Mode > 0o777 {
			return errors.New("withruntime: mode must be 000 to 777")
		}
		octal = fmt.Sprintf("%03o", *opts.Mode)
	}
	if len(data) <= chunkBytes {
		query := url.Values{"path": {name}}
		if octal != "" {
			query.Set("mode", octal)
		}
		_, err := f.c.bytes(ctx, &call{method: http.MethodPut, path: f.path("/files/content"), query: query, raw: data, key: opts.IdempotencyKey})
		return err
	}
	root := opts.IdempotencyKey
	if root == "" {
		root = newKey()
	}
	phase := func(value string) string {
		sum := sha256.Sum256([]byte("files.write:" + root + ":" + value))
		return hex.EncodeToString(sum[:])
	}
	sum := sha256.Sum256(data)
	body := map[string]any{"path": name, "size": len(data), "sha256": hex.EncodeToString(sum[:])}
	if octal != "" {
		body["mode"] = octal
	}
	var begin struct {
		UploadID   string `json:"uploadId"`
		ChunkBytes int    `json:"chunkBytes"`
		Mode       string `json:"mode"`
		Replayed   bool   `json:"replayed"`
	}
	err := f.c.do(ctx, &call{method: http.MethodPost, path: f.path("/uploads"), body: body, key: phase("begin")}, &begin)
	if err != nil {
		var failure *Error
		if octal == "" || !errors.As(err, &failure) || failure.Code != "guest_upgrade_required" {
			return err
		}
		delete(body, "mode")
		if err = f.c.do(ctx, &call{method: http.MethodPost, path: f.path("/uploads"), body: body, key: phase("legacy-begin")}, &begin); err != nil {
			return err
		}
	}
	if begin.ChunkBytes <= 0 || begin.UploadID == "" {
		return errors.New("withruntime: the upload omitted its ID or chunk size")
	}
	upload := f.path("/uploads/" + url.PathEscape(begin.UploadID))
	commit := func() error {
		return f.c.do(ctx, &call{method: http.MethodPost, path: upload + ":commit", body: map[string]any{}, key: phase("commit")}, nil)
	}
	committed := false
	if begin.Replayed {
		if err = commit(); err == nil {
			committed = true
		} else {
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != "upload_incomplete" {
				return err
			}
		}
	}
	if !committed {
		offsets := make(chan int)
		var wg sync.WaitGroup
		var once sync.Once
		var failure error
		sending, cancel := context.WithCancel(ctx)
		for range 4 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for offset := range offsets {
					end := min(len(data), offset+begin.ChunkBytes)
					if _, err := f.c.bytes(sending, &call{method: http.MethodPut, path: upload, query: url.Values{"offset": {strconv.Itoa(offset)}}, raw: data[offset:end]}); err != nil {
						once.Do(func() { failure = err; cancel() })
					}
				}
			}()
		}
	send:
		for offset := 0; offset < len(data); offset += begin.ChunkBytes {
			select {
			case offsets <- offset:
			case <-sending.Done():
				break send
			}
		}
		close(offsets)
		wg.Wait()
		cancel()
		if failure == nil {
			failure = commit()
		}
		if failure != nil {
			cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer stop()
			_ = f.c.do(cleanup, &call{method: http.MethodPost, path: upload + ":abort", body: map[string]any{}, key: phase("abort")}, nil)
			return failure
		}
	}
	if octal != "" && begin.Mode != octal {
		return f.c.do(ctx, &call{method: http.MethodPost, path: f.path("/files:chmod"), body: map[string]any{"path": name, "mode": octal}, key: phase("chmod")}, nil)
	}
	return nil
}

// Chmod sets permissions through the sandbox user's exec grant.
func (f *Files) Chmod(ctx context.Context, name string, mode uint32) error {
	if mode > 0o777 {
		return errors.New("withruntime: mode must be 000 to 777")
	}
	return f.c.do(ctx, &call{method: http.MethodPost, path: f.path("/files:chmod"), body: map[string]any{"path": name, "mode": fmt.Sprintf("%03o", mode)}}, nil)
}

// ListOptions for Files.List: Depth goes deeper, Glob filters (e.g.
// "**/*.py").
type FileListOptions struct {
	Depth  int
	Glob   string
	Hidden bool
	Limit  int
}

// List returns a directory's entries. dir defaults to /workspace.
func (f *Files) List(ctx context.Context, dir string, opts *FileListOptions) ([]FileEntry, error) {
	if dir == "" {
		dir = "/workspace"
	}
	query := url.Values{"path": {dir}}
	if opts != nil {
		if opts.Depth > 0 {
			query.Set("depth", strconv.Itoa(opts.Depth))
		}
		if opts.Glob != "" {
			query.Set("glob", opts.Glob)
		}
		if opts.Hidden {
			query.Set("hidden", "true")
		}
		if opts.Limit > 0 {
			query.Set("limit", strconv.Itoa(opts.Limit))
		}
	}
	var body struct {
		Data []FileEntry `json:"data"`
	}
	if err := f.c.do(ctx, &call{method: http.MethodGet, path: f.path("/files/list"), query: query}, &body); err != nil {
		return nil, err
	}
	return body.Data, nil
}

// Glob returns the files under root (default /workspace) matching pattern.
func (f *Files) Glob(ctx context.Context, pattern, root string) ([]FileEntry, error) {
	return f.List(ctx, root, &FileListOptions{Glob: pattern})
}

// Stat returns a file's entry, or nil when it does not exist.
func (f *Files) Stat(ctx context.Context, name string) (*FileEntry, error) {
	var body struct {
		FileEntry
		Exists bool `json:"exists"`
	}
	if err := f.c.do(ctx, &call{method: http.MethodGet, path: f.path("/files/stat"), query: url.Values{"path": {name}}}, &body); err != nil {
		return nil, err
	}
	if !body.Exists {
		return nil, nil
	}
	return &body.FileEntry, nil
}

// Exists reports whether a path exists.
func (f *Files) Exists(ctx context.Context, name string) (bool, error) {
	entry, err := f.Stat(ctx, name)
	return entry != nil, err
}

// Mkdir makes a directory; parents makes the ones above it too.
func (f *Files) Mkdir(ctx context.Context, name string, parents bool) error {
	body := map[string]any{"path": name}
	if parents {
		body["parents"] = true
	}
	return f.c.do(ctx, &call{method: http.MethodPost, path: f.path("/files:mkdir"), body: body}, nil)
}

// Remove removes a file, or a directory with recursive. It reports whether
// anything was there.
func (f *Files) Remove(ctx context.Context, name string, recursive bool) (bool, error) {
	body := map[string]any{"path": name}
	if recursive {
		body["recursive"] = true
	}
	var reply struct {
		Removed bool `json:"removed"`
	}
	err := f.c.do(ctx, &call{method: http.MethodPost, path: f.path("/files:remove"), body: body}, &reply)
	return reply.Removed, err
}

// Rename moves a file or directory; overwrite replaces what is at to.
func (f *Files) Rename(ctx context.Context, from, to string, overwrite bool) error {
	body := map[string]any{"from": from, "to": to}
	if overwrite {
		body["overwrite"] = true
	}
	return f.c.do(ctx, &call{method: http.MethodPost, path: f.path("/files:rename"), body: body}, nil)
}

// Upload copies a local file or directory into the sandbox. A directory
// travels as one gzipped tar and is unpacked in place.
func (f *Files) Upload(ctx context.Context, local, remote string) error {
	info, err := os.Stat(local)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		data, err := os.ReadFile(local)
		if err != nil {
			return err
		}
		return f.Write(ctx, remote, data)
	}
	archive, err := packDirectory(local)
	if err != nil {
		return err
	}
	staging := "/tmp/.runtime-upload-" + newKey() + ".tar.gz"
	if err := f.Write(ctx, staging, archive); err != nil {
		return err
	}
	result, err := f.sandbox.ExecArgv(ctx, []string{
		"sh", "-c", `mkdir -p "$1" && tar -xzf "$2" -C "$1"; code=$?; rm -f "$2"; exit $code`,
		"sh", remote, staging,
	}, nil)
	if err != nil {
		return err
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		return commandError(result)
	}
	return nil
}

// Download copies a file or directory out of the sandbox.
func (f *Files) Download(ctx context.Context, remote, local string) error {
	entry, err := f.Stat(ctx, remote)
	if err != nil {
		return err
	}
	if entry == nil {
		return &Error{Code: "file_not_found", Status: 404, Message: remote + " does not exist."}
	}
	if entry.Type != "directory" {
		data, err := f.Read(ctx, remote)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
			return err
		}
		return os.WriteFile(local, data, 0o644)
	}
	staging := "/tmp/.runtime-download-" + newKey() + ".tar.gz"
	packed, err := f.sandbox.ExecArgv(ctx, []string{"tar", "-czf", staging, "-C", remote, "."}, nil)
	if err != nil {
		return err
	}
	if packed.ExitCode == nil || *packed.ExitCode != 0 {
		return commandError(packed)
	}
	defer func() { _, _ = f.Remove(context.WithoutCancel(ctx), staging, false) }()
	archive, err := f.Read(ctx, staging)
	if err != nil {
		return err
	}
	return unpackArchive(archive, local)
}

func packDirectory(root string) ([]byte, error) {
	var buffer bytes.Buffer
	zipped := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(zipped)
	err := filepath.WalkDir(root, func(full string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, full)
		if err != nil || relative == "." {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() && !info.IsDir() {
			return nil // links and devices stay behind
		}
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(relative)
		if info.IsDir() {
			header.Name += "/"
		}
		if err := archive.WriteHeader(header); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		file, err := os.Open(full)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = io.Copy(archive, file)
		return err
	})
	if err != nil {
		return nil, err
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	if err := zipped.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// unpackArchive unpacks a gzipped tar into dir, refusing any entry that would
// land outside it, and any link.
func unpackArchive(data []byte, dir string) error {
	zipped, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	archive := tar.NewReader(zipped)
	base, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(base, 0o755); err != nil {
		return err
	}
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		clean := path.Clean("/" + header.Name)
		if clean == "/" {
			continue
		}
		target := filepath.Join(base, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
		if !strings.HasPrefix(target, base+string(os.PathSeparator)) {
			return fmt.Errorf("withruntime: archive entry %q is outside %s", header.Name, dir)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			file, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fs.FileMode(header.Mode)&0o777)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(file, archive)
			closeErr := file.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		}
	}
}
