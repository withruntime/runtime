package withruntime

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Image is a custom image to start sandboxes from.
type Image struct {
	ID string `json:"id"`
	// State is queued, building, ready, failed, deleting or deleted.
	State       string            `json:"state"`
	Status      string            `json:"status"`
	Name        *string           `json:"name"`
	Version     *int              `json:"version"`
	Tags        []string          `json:"tags"`
	PendingTags []string          `json:"pendingTags,omitempty"`
	Labels      map[string]string `json:"labels"`
	Region      string            `json:"region"`
	Source      struct {
		Kind   string `json:"kind"`
		Digest string `json:"digest"`
		Steps  int    `json:"steps"`
	} `json:"source"`
	Start        *ImageStart       `json:"start,omitempty"`
	SizeBytes    *int64            `json:"sizeBytes"`
	SizeMiB      *int64            `json:"sizeMiB"`
	StoredBytes  *int64            `json:"storedBytes"`
	RootfsSHA256 *string           `json:"rootfsSha256"`
	Env          map[string]string `json:"env"`
	Workdir      string            `json:"workdir"`
	Error        *string           `json:"error"`
	Logs         struct {
		Bytes     int64 `json:"bytes"`
		Lines     int   `json:"lines"`
		Truncated bool  `json:"truncated"`
	} `json:"logs"`
	CreatedAt time.Time  `json:"createdAt"`
	ReadyAt   *time.Time `json:"readyAt"`
	// Notes are what the source asked for that an image does not carry (on create).
	Notes []string `json:"notes,omitempty"`
	// Raw is the whole answer, for fields newer than this SDK.
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON keeps the raw answer alongside the typed fields.
func (i *Image) UnmarshalJSON(data []byte) error {
	type plain Image
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*i = Image(decoded)
	i.Raw = append(json.RawMessage(nil), data...)
	return nil
}

// ImageFile is a file of a small build context sent inline, or of a recipe.
type ImageFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	// Encoding is "utf8" (the default) or "base64".
	Encoding string `json:"encoding,omitempty"`
	Mode     int    `json:"mode,omitempty"`
}

// ImageRecipe is packages, commands and files on top of a base.
type ImageRecipe struct {
	// Base is "runtime" (the default) or an image reference.
	Base     string            `json:"base,omitempty"`
	Apt      []string          `json:"apt,omitempty"`
	Pip      []string          `json:"pip,omitempty"`
	Npm      []string          `json:"npm,omitempty"`
	Commands []string          `json:"commands,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
	Files    []ImageFile       `json:"files,omitempty"`
	Workdir  string            `json:"workdir,omitempty"`
}

// ImageStart is what a sandbox from the image runs as it starts, and when its
// create answers: once ReadyPort is listened on, or ReadyCommand exits 0.
type ImageStart struct {
	Command             string            `json:"command,omitempty"`
	Argv                []string          `json:"argv,omitempty"`
	Cwd                 string            `json:"cwd,omitempty"`
	Env                 map[string]string `json:"env,omitempty"`
	ReadyCommand        string            `json:"readyCommand,omitempty"`
	ReadyPort           int               `json:"readyPort,omitempty"`
	ReadyTimeoutSeconds int               `json:"readyTimeoutSeconds,omitempty"`
}

// ImageBuildLimits bound a build.
type ImageBuildLimits struct {
	VCPU           int `json:"vcpu,omitempty"`
	MemoryMiB      int `json:"memoryMiB,omitempty"`
	DiskMiB        int `json:"diskMiB,omitempty"`
	MaxImageMiB    int `json:"maxImageMiB,omitempty"`
	TimeoutSeconds int `json:"timeoutSeconds,omitempty"`
	CacheMiB       int `json:"cacheMiB,omitempty"`
}

// ImageContext is an uploaded build context: its archive's chunks and files.
type ImageContext struct {
	Archive struct {
		SHA256 string   `json:"sha256"`
		Size   int      `json:"size"`
		Chunks []string `json:"chunks"`
	} `json:"archive"`
	Files []ContextFile `json:"files"`
}

// ContextFile is one file of a build context.
type ContextFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Mode   int    `json:"mode"`
}

// CreateImageOptions are a build's fields: exactly one of Image, Dockerfile
// or Recipe. With Dockerfile, the context is Files (small, inline), ContextDir
// (a folder, packed and uploaded for you) or Context (already uploaded).
type CreateImageOptions struct {
	// Name: each build of a name is its next version.
	Name       string            `json:"name,omitempty"`
	Tags       []string          `json:"tags,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	Region     string            `json:"region,omitempty"`
	Image      string            `json:"image,omitempty"`
	Dockerfile string            `json:"dockerfile,omitempty"`
	Recipe     *ImageRecipe      `json:"recipe,omitempty"`
	Files      []ImageFile       `json:"files,omitempty"`
	// ContextDir is a local folder to send as the context, with its
	// .dockerignore. Only the chunks the server does not have are uploaded.
	ContextDir   string            `json:"-"`
	Context      *ImageContext     `json:"context,omitempty"`
	Dockerignore string            `json:"dockerignore,omitempty"`
	BuildArgs    map[string]string `json:"buildArgs,omitempty"`
	Target       string            `json:"target,omitempty"`
	Env          map[string]string `json:"env,omitempty"`
	Start        *ImageStart       `json:"start,omitempty"`
	Build        *ImageBuildLimits `json:"build,omitempty"`
	// NoCache builds every step afresh and keeps no cache.
	NoCache        bool   `json:"-"`
	IdempotencyKey string `json:"-"`
}

// ImageLogLine is one line of build output.
type ImageLogLine struct {
	Seq    int       `json:"seq"`
	At     time.Time `json:"at"`
	Stream string    `json:"stream"`
	Text   string    `json:"text"`
}

// ImageLogs is a page of build output.
type ImageLogs struct {
	Lines     []ImageLogLine `json:"lines"`
	NextAfter int            `json:"nextAfter"`
	State     string         `json:"state"`
	Truncated bool           `json:"truncated"`
	Done      bool           `json:"done"`
}

// ImageListOptions filter a list.
type ImageListOptions struct {
	State string
	Name  string
	Limit int
}

// ImageService is client.Images: custom images. Build one, then start
// sandboxes from it with CreateOptions.Image.
type ImageService struct {
	c *Client
	// Registries holds credentials for pulling private images.
	Registries *RegistryService
}

var uuidPattern = regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func imagePath(id, verb string) string { return "/v1/images/" + url.PathEscape(id) + verb }

func (s *ImageService) prepare(ctx context.Context, opts *CreateImageOptions) (any, error) {
	if opts.ContextDir != "" {
		if opts.Context != nil {
			return nil, errors.New("withruntime: give ContextDir or Context, not both")
		}
		uploaded, dockerignore, err := s.UploadContext(ctx, opts.ContextDir, opts.Dockerignore)
		if err != nil {
			return nil, err
		}
		copied := *opts
		copied.Context = uploaded
		copied.Dockerignore = dockerignore
		opts = &copied
	}
	if !opts.NoCache {
		return opts, nil
	}
	return withExtra(opts, map[string]any{"cache": false})
}

// Create queues a build and returns at once, in state "queued".
func (s *ImageService) Create(ctx context.Context, opts CreateImageOptions) (*Image, error) {
	body, err := s.prepare(ctx, &opts)
	if err != nil {
		return nil, err
	}
	var image Image
	return &image, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/images", body: body, key: opts.IdempotencyKey}, &image)
}

// Build builds an image and waits until it is ready, sending each log line
// to onLog (which may be nil). A failed build is an *Error whose Code is
// image_failed, with the build's own error as its message.
func (s *ImageService) Build(ctx context.Context, opts CreateImageOptions, onLog func(ImageLogLine)) (*Image, error) {
	image, err := s.Create(ctx, opts)
	if err != nil {
		return nil, err
	}
	if onLog != nil {
		if image, err = s.FollowLogs(ctx, image.ID, 0, onLog); err != nil {
			return nil, err
		}
	}
	for image.State == "queued" || image.State == "building" {
		if err := sleep(ctx, time.Second); err != nil {
			return nil, err
		}
		if image, err = s.Get(ctx, image.ID); err != nil {
			return nil, err
		}
	}
	if image.State != "ready" {
		message := "no error given"
		if image.Error != nil {
			message = *image.Error
		}
		return image, &Error{Code: "image_failed", Message: fmt.Sprintf("Image %s %s: %s", image.ID, image.State, message), Hint: "Read the build log with client.Images.Logs."}
	}
	return image, nil
}

// Get reads an image by id.
func (s *ImageService) Get(ctx context.Context, id string) (*Image, error) {
	var image Image
	return &image, s.c.do(ctx, &call{method: http.MethodGet, path: imagePath(id, "")}, &image)
}

// Resolve reads an image by id, name (its latest tag), name:tag or name@version.
func (s *ImageService) Resolve(ctx context.Context, ref string) (*Image, error) {
	if uuidPattern.MatchString(ref) {
		return s.Get(ctx, ref)
	}
	var image Image
	return &image, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/images/resolve", query: url.Values{"ref": {ref}}}, &image)
}

func (s *ImageService) idOf(ctx context.Context, ref string) (string, error) {
	if uuidPattern.MatchString(ref) {
		return ref, nil
	}
	image, err := s.Resolve(ctx, ref)
	if err != nil {
		return "", err
	}
	return image.ID, nil
}

// Logs returns build output after line after.
func (s *ImageService) Logs(ctx context.Context, id string, after int) (*ImageLogs, error) {
	var logs ImageLogs
	return &logs, s.c.do(ctx, &call{method: http.MethodGet, path: imagePath(id, "/logs"), query: url.Values{"after": {strconv.Itoa(after)}}}, &logs)
}

// FollowLogs sends build output after line after to onLog as it is written,
// until the build ends, and returns the image as it ended. It streams, and
// polls when a stream breaks.
func (s *ImageService) FollowLogs(ctx context.Context, id string, after int, onLog func(ImageLogLine)) (*Image, error) {
	type event struct {
		ImageLogLine
		Type  string          `json:"type"`
		After int             `json:"after"`
		Image json.RawMessage `json:"image"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
stream:
	for {
		resume := false
		for e, err := range events[event](ctx, s.c, &call{method: http.MethodGet, path: imagePath(id, "/logs"), query: url.Values{"after": {strconv.Itoa(after)}, "follow": {"true"}}, timeout: 3 * time.Minute}) {
			if err != nil {
				if ctx.Err() != nil {
					return nil, err
				}
				break stream
			}
			switch e.Type {
			case "line":
				onLog(e.ImageLogLine)
				after = e.Seq
			case "done":
				var image Image
				if err := json.Unmarshal(e.Image, &image); err != nil || image.ID == "" {
					return s.Get(ctx, id)
				}
				return &image, nil
			case "continue":
				after = e.After
				resume = true
			case "error":
				if e.Error != nil {
					return nil, &Error{Code: e.Error.Code, Message: e.Error.Message}
				}
			}
		}
		if !resume {
			break
		}
	}
	for {
		page, err := s.Logs(ctx, id, after)
		if err != nil {
			return nil, err
		}
		for _, line := range page.Lines {
			onLog(line)
		}
		after = page.NextAfter
		image, err := s.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		if page.Done || (image.State != "queued" && image.State != "building") {
			if !page.Done {
				if rest, err := s.Logs(ctx, id, after); err == nil {
					for _, line := range rest.Lines {
						onLog(line)
					}
				}
			}
			return image, nil
		}
		if err := sleep(ctx, time.Second); err != nil {
			return nil, err
		}
	}
}

// List returns the first page of images.
func (s *ImageService) List(ctx context.Context, opts *ImageListOptions) (*Page[Image], error) {
	query := url.Values{}
	if opts != nil {
		setQuery(query, "state", opts.State, "name", opts.Name, "limit", itoa(opts.Limit))
	}
	return listPage[Image](ctx, s.c, "/v1/images", query, "")
}

// All walks every image a list with these options finds.
func (s *ImageService) All(ctx context.Context, opts *ImageListOptions) iter.Seq2[Image, error] {
	return walk(ctx, func() (*Page[Image], error) { return s.List(ctx, opts) })
}

// Versions returns every version of a name, newest first.
func (s *ImageService) Versions(ctx context.Context, name string) (*Page[Image], error) {
	return s.List(ctx, &ImageListOptions{Name: name, Limit: 100})
}

// Tag points tag of the image's name at this version (ref is an id,
// name:tag or name@version).
func (s *ImageService) Tag(ctx context.Context, ref, tag string) (*Image, error) {
	return s.verb(ctx, ref, ":tag", map[string]any{"tag": tag})
}

// Untag removes a tag.
func (s *ImageService) Untag(ctx context.Context, ref, tag string) (*Image, error) {
	return s.verb(ctx, ref, ":untag", map[string]any{"tag": tag})
}

// Delete deletes one version and its tags.
func (s *ImageService) Delete(ctx context.Context, ref string) (*Image, error) {
	return s.verb(ctx, ref, ":delete", map[string]any{})
}

func (s *ImageService) verb(ctx context.Context, ref, verb string, body map[string]any) (*Image, error) {
	id, err := s.idOf(ctx, ref)
	if err != nil {
		return nil, err
	}
	var image Image
	return &image, s.c.do(ctx, &call{method: http.MethodPost, path: imagePath(id, verb), body: body}, &image)
}

// UploadContext packs folder as a build context, the way docker build does
// (its .dockerignore applied, .git left out when there is none), and uploads
// the chunks the server does not have yet. dockerignore, when not empty,
// replaces the folder's own. It returns the context to build with and the
// .dockerignore that was applied.
func (s *ImageService) UploadContext(ctx context.Context, folder, dockerignore string) (*ImageContext, string, error) {
	archive, files, applied, err := packContext(folder, dockerignore)
	if err != nil {
		return nil, "", err
	}
	var chunks [][]byte
	var digests []string
	for at := 0; at < len(archive); at += chunkBytes {
		chunk := archive[at:min(len(archive), at+chunkBytes)]
		sum := sha256.Sum256(chunk)
		chunks = append(chunks, chunk)
		digests = append(digests, hex.EncodeToString(sum[:]))
	}
	var missing struct {
		Missing []string `json:"missing"`
	}
	if err := s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/images/context/missing", body: map[string]any{"digests": digests}}, &missing); err != nil {
		return nil, "", err
	}
	wanted := map[string]bool{}
	for _, digest := range missing.Missing {
		wanted[digest] = true
	}
	queue := make(chan int)
	var wg sync.WaitGroup
	var once sync.Once
	var failure error
	uploadCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range queue {
				if err := s.c.do(uploadCtx, &call{method: http.MethodPut, path: "/v1/images/context/" + digests[i], raw: chunks[i]}, nil); err != nil {
					once.Do(func() { failure = err; cancel() })
				}
			}
		}()
	}
send:
	for i, digest := range digests {
		if !wanted[digest] {
			continue
		}
		select {
		case queue <- i:
		case <-uploadCtx.Done():
			break send
		}
	}
	close(queue)
	wg.Wait()
	if failure != nil {
		return nil, "", failure
	}
	total := sha256.Sum256(archive)
	uploaded := &ImageContext{Files: files}
	uploaded.Archive.SHA256 = hex.EncodeToString(total[:])
	uploaded.Archive.Size = len(archive)
	uploaded.Archive.Chunks = digests
	return uploaded, applied, nil
}

// Context limits, as the server's.
const (
	contextMaxBytes = 100 << 20
	contextMaxFiles = 20_000
)

// packContext makes a deterministic gzipped tar of folder (sorted, no times,
// no owners, no links) and lists its files with their SHA-256.
func packContext(folder, dockerignore string) ([]byte, []ContextFile, string, error) {
	root, err := filepath.Abs(folder)
	if err != nil {
		return nil, nil, "", err
	}
	if dockerignore == "" {
		if text, err := os.ReadFile(filepath.Join(root, ".dockerignore")); err == nil {
			dockerignore = string(text)
		}
	}
	rules := dockerignore
	if rules == "" {
		rules = ".git\n"
	}
	ignored, err := dockerignoreFilter(rules)
	if err != nil {
		return nil, nil, "", err
	}
	reincludes := regexp.MustCompile(`(?m)^\s*!`).MatchString(dockerignore)
	var buffer bytes.Buffer
	zipped, _ := gzip.NewWriterLevel(&buffer, 6)
	archive := tar.NewWriter(zipped)
	var files []ContextFile
	var walkDir func(dir string) error
	walkDir = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		sort.Slice(entries, func(a, b int) bool { return entries[a].Name() < entries[b].Name() })
		for _, entry := range entries {
			full := filepath.Join(dir, entry.Name())
			relative, _ := filepath.Rel(root, full)
			name := filepath.ToSlash(relative)
			info, err := os.Lstat(full)
			if err != nil {
				return err
			}
			switch {
			case info.IsDir():
				if ignored(name) && !reincludes {
					continue
				}
				if err := walkDir(full); err != nil {
					return err
				}
			case info.Mode().IsRegular():
				if ignored(name) {
					continue
				}
				if len(files) >= contextMaxFiles {
					return &Error{Code: "context_too_large", Message: fmt.Sprintf("The build context has more than %d files.", contextMaxFiles), Hint: "Leave some out with a .dockerignore."}
				}
				data, err := os.ReadFile(full)
				if err != nil {
					return err
				}
				mode := int(info.Mode().Perm())
				sum := sha256.Sum256(data)
				files = append(files, ContextFile{Path: name, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(data)), Mode: mode})
				if err := archive.WriteHeader(&tar.Header{Name: name, Mode: int64(mode), Size: int64(len(data)), Typeflag: tar.TypeReg, Format: tar.FormatUSTAR, ModTime: time.Unix(0, 0)}); err != nil {
					return err
				}
				if _, err := archive.Write(data); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walkDir(root); err != nil {
		return nil, nil, "", err
	}
	if err := archive.Close(); err != nil {
		return nil, nil, "", err
	}
	if err := zipped.Close(); err != nil {
		return nil, nil, "", err
	}
	if buffer.Len() > contextMaxBytes {
		return nil, nil, "", &Error{Code: "context_too_large", Message: fmt.Sprintf("The build context is %d MiB compressed; the most is %d MiB.", buffer.Len()>>20+1, contextMaxBytes>>20), Hint: "Leave build outputs and dependencies out with a .dockerignore."}
	}
	return buffer.Bytes(), files, dockerignore, nil
}

// dockerignoreFilter reads a .dockerignore as Docker does: # comments, !
// re-includes, ** crosses directories, a pattern naming a directory excludes
// what is in it, and the last matching pattern decides. The same rules as the
// server's and the JavaScript SDK's.
func dockerignoreFilter(text string) (func(string) bool, error) {
	type rule struct {
		negate bool
		regex  *regexp.Regexp
	}
	var rules []rule
	for _, raw := range strings.Split(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		negate := strings.HasPrefix(line, "!")
		if negate {
			line = strings.TrimSpace(line[1:])
		}
		line = strings.TrimRight(normalizePath(strings.TrimLeft(line, "/")), "/")
		if line == "" || line == "." {
			continue
		}
		var source strings.Builder
		for i := 0; i < len(line); i++ {
			char := line[i]
			switch {
			case char == '*' && i+1 < len(line) && line[i+1] == '*':
				if i+2 < len(line) && line[i+2] == '/' {
					source.WriteString("(?:.*/)?")
					i += 2
				} else {
					source.WriteString(".*")
					i++
				}
			case char == '*':
				source.WriteString("[^/]*")
			case char == '?':
				source.WriteString("[^/]")
			case char == '[':
				end := strings.IndexByte(line[i+1:], ']')
				if end < 0 {
					source.WriteString(`\[`)
				} else {
					class := line[i+1 : i+1+end]
					if strings.HasPrefix(class, "!") {
						class = "^" + class[1:]
					}
					source.WriteString("[" + strings.ReplaceAll(class, `\`, `\\`) + "]")
					i += end + 1
				}
			case char == '\\' && i+1 < len(line):
				i++
				source.WriteString(regexp.QuoteMeta(string(line[i])))
			default:
				source.WriteString(regexp.QuoteMeta(string(char)))
			}
		}
		compiled, err := regexp.Compile("^" + source.String() + "$")
		if err != nil {
			return nil, fmt.Errorf("withruntime: .dockerignore: invalid pattern %q", strings.TrimSpace(raw))
		}
		rules = append(rules, rule{negate: negate, regex: compiled})
	}
	return func(path string) bool {
		parts := strings.Split(path, "/")
		excluded := false
		for _, r := range rules {
			hit := false
			for n := len(parts); n >= 1 && !hit; n-- {
				hit = r.regex.MatchString(strings.Join(parts[:n], "/"))
			}
			if hit {
				excluded = !r.negate
			}
		}
		return excluded
	}, nil
}

func normalizePath(path string) string {
	var out []string
	for _, part := range strings.Split(path, "/") {
		switch part {
		case "", ".":
		case "..":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
		default:
			out = append(out, part)
		}
	}
	if len(out) == 0 {
		return "."
	}
	return strings.Join(out, "/")
}

// ImageRegistry is saved credentials for a private registry. The secret is
// never returned.
type ImageRegistry struct {
	ID        string    `json:"id"`
	Registry  string    `json:"registry"`
	Kind      string    `json:"kind"`
	Username  string    `json:"username"`
	Region    *string   `json:"region"`
	CreatedAt time.Time `json:"createdAt"`
}

// RegistryCredentials are a user name and token or password (Docker Hub,
// GitHub, Google with username _json_key), or an AWS access key for Amazon
// ECR. They are sealed on arrival.
type RegistryCredentials struct {
	Registry        string `json:"registry"`
	Username        string `json:"username,omitempty"`
	Password        string `json:"password,omitempty"`
	AccessKeyID     string `json:"accessKeyId,omitempty"`
	SecretAccessKey string `json:"secretAccessKey,omitempty"`
}

// RegistryService is client.Images.Registries.
type RegistryService struct{ c *Client }

// List returns the saved registries.
func (s *RegistryService) List(ctx context.Context) ([]ImageRegistry, error) {
	var body struct {
		Data []ImageRegistry `json:"data"`
	}
	err := s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/images/registries"}, &body)
	return body.Data, err
}

// Set saves or replaces a registry's credentials.
func (s *RegistryService) Set(ctx context.Context, credentials RegistryCredentials) (*ImageRegistry, error) {
	var registry ImageRegistry
	return &registry, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/images/registries", body: credentials}, &registry)
}

// Delete forgets a registry's credentials.
func (s *RegistryService) Delete(ctx context.Context, registry string) (bool, error) {
	var reply struct {
		Deleted bool `json:"deleted"`
	}
	err := s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/images/registries:delete", body: map[string]any{"registry": registry}}, &reply)
	return reply.Deleted, err
}
