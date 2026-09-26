package withruntime

import (
	"context"
	"net/http"
	"net/url"
)

// DesktopStart is a started desktop.
type DesktopStart struct {
	OK      bool   `json:"ok"`
	Display string `json:"display"`
	Size    string `json:"size"`
	// StreamURL opens the live desktop (noVNC) in a browser; it carries a
	// private preview token.
	StreamURL string  `json:"streamUrl"`
	Preview   Preview `json:"preview"`
}

// DesktopWindow is a window on the desktop.
type DesktopWindow struct {
	ID        string `json:"id"`
	Desktop   int    `json:"desktop"`
	PID       int    `json:"pid"`
	X         int    `json:"x"`
	Y         int    `json:"y"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	ClassName string `json:"className"`
	Title     string `json:"title"`
}

// Desktop is sbx.Desktop: a Linux desktop in the sandbox, driven like a person
// would. Coordinates are pixels from the top left of the screen.
type Desktop struct {
	sandbox    *Sandbox
	Recordings *RecordingService
}

func (d *Desktop) act(ctx context.Context, body map[string]any, out any) error {
	return d.sandbox.c.do(ctx, &call{method: http.MethodPost, path: d.sandbox.path("/desktop:act"), body: body}, out)
}

// Start starts the desktop; width and height of 0 are the default size.
func (d *Desktop) Start(ctx context.Context, width, height int) (*DesktopStart, error) {
	body := map[string]any{}
	if width > 0 {
		body["width"] = width
	}
	if height > 0 {
		body["height"] = height
	}
	var started DesktopStart
	return &started, d.sandbox.c.do(ctx, &call{method: http.MethodPost, path: d.sandbox.path("/desktop:start"), body: body}, &started)
}

// Stop stops the desktop.
func (d *Desktop) Stop(ctx context.Context) error {
	return d.sandbox.c.do(ctx, &call{method: http.MethodPost, path: d.sandbox.path("/desktop:stop"), body: map[string]any{}}, nil)
}

// Screenshot returns the screen as PNG, or as JPEG when format is "jpeg"
// (quality 1 to 100; 0 is the default).
func (d *Desktop) Screenshot(ctx context.Context, format string, quality int) ([]byte, error) {
	query := setQuery(url.Values{}, "format", format, "quality", itoa(quality))
	return d.sandbox.c.bytes(ctx, &call{method: http.MethodGet, path: d.sandbox.path("/desktop/screenshot"), query: query})
}

// Move moves the pointer.
func (d *Desktop) Move(ctx context.Context, x, y int) error {
	return d.act(ctx, map[string]any{"action": "move", "x": x, "y": y}, nil)
}

// Click clicks button ("left", "middle" or "right"; "" is left) at x, y.
func (d *Desktop) Click(ctx context.Context, x, y int, button string) error {
	body := map[string]any{"action": "click", "x": x, "y": y}
	if button != "" {
		body["button"] = button
	}
	return d.act(ctx, body, nil)
}

// DoubleClick double-clicks at x, y.
func (d *Desktop) DoubleClick(ctx context.Context, x, y int) error {
	return d.act(ctx, map[string]any{"action": "click", "double": true, "x": x, "y": y}, nil)
}

// RightClick right-clicks at x, y.
func (d *Desktop) RightClick(ctx context.Context, x, y int) error {
	return d.Click(ctx, x, y, "right")
}

// MouseDown presses a button and holds it.
func (d *Desktop) MouseDown(ctx context.Context, button string) error {
	if button == "" {
		button = "left"
	}
	return d.act(ctx, map[string]any{"action": "mouseDown", "button": button}, nil)
}

// MouseUp releases a button.
func (d *Desktop) MouseUp(ctx context.Context, button string) error {
	if button == "" {
		button = "left"
	}
	return d.act(ctx, map[string]any{"action": "mouseUp", "button": button}, nil)
}

// Drag drags from one point to another.
func (d *Desktop) Drag(ctx context.Context, fromX, fromY, toX, toY int) error {
	return d.act(ctx, map[string]any{"action": "drag", "from": []int{fromX, fromY}, "to": []int{toX, toY}}, nil)
}

// Scroll turns the wheel: positive dy scrolls down, positive dx right.
func (d *Desktop) Scroll(ctx context.Context, dy, dx int) error {
	body := map[string]any{"action": "scroll", "dy": dy}
	if dx != 0 {
		body["dx"] = dx
	}
	return d.act(ctx, body, nil)
}

// Type types text.
func (d *Desktop) Type(ctx context.Context, text string) error {
	return d.act(ctx, map[string]any{"action": "type", "text": text}, nil)
}

// Press presses keys, xdotool names space separated: "ctrl+l", "Return".
func (d *Desktop) Press(ctx context.Context, keys string) error {
	return d.act(ctx, map[string]any{"action": "key", "keys": keys}, nil)
}

// Cursor returns where the pointer is.
func (d *Desktop) Cursor(ctx context.Context) (x, y int, err error) {
	var at struct {
		X int `json:"x"`
		Y int `json:"y"`
	}
	err = d.act(ctx, map[string]any{"action": "cursor"}, &at)
	return at.X, at.Y, err
}

// Windows lists the desktop's windows.
func (d *Desktop) Windows(ctx context.Context) ([]DesktopWindow, error) {
	var reply struct {
		Windows []DesktopWindow `json:"windows"`
	}
	err := d.act(ctx, map[string]any{"action": "windows"}, &reply)
	return reply.Windows, err
}

// Focus brings a window to the front.
func (d *Desktop) Focus(ctx context.Context, windowID string) error {
	return d.act(ctx, map[string]any{"action": "focus", "windowId": windowID}, nil)
}

// Open opens url in Firefox on the desktop.
func (d *Desktop) Open(ctx context.Context, url string) error {
	return d.act(ctx, map[string]any{"action": "open", "url": url}, nil)
}

// Launch starts a program on the desktop, detached.
func (d *Desktop) Launch(ctx context.Context, argv ...string) error {
	return d.act(ctx, map[string]any{"action": "launch", "argv": argv}, nil)
}
