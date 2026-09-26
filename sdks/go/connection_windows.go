//go:build windows

package withruntime

import (
	"io/fs"
	"os"
)

func ownedByMe(fs.FileInfo) bool { return true }

func openNoFollow(path string) (*os.File, error) {
	if info, err := os.Lstat(path); err == nil && info.Mode()&fs.ModeSymlink != 0 {
		return nil, fs.ErrPermission
	}
	return os.Open(path)
}
