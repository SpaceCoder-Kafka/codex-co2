#!/usr/bin/env python3
"""Build the Finder installation window without scripting the user's Finder."""
from pathlib import Path
import sys
from unittest.mock import patch

import dmgbuild
import dmgbuild.core

stage, artwork, output = map(Path, sys.argv[1:4])
volume_name = sys.argv[4]


settings = {
    "format": "UDZO",
    "filesystem": "HFS+",
    "files": [str(stage / name) for name in [
        "Codex Co².app", "打开隐私与安全性.inetloc", "安装说明.html", "RELEASE.txt",
    ]],
    "symlinks": {"Applications": "/Applications"},
    "hide": ["RELEASE.txt"],
    "hide_extensions": ["打开隐私与安全性.inetloc", "安装说明.html"],
    "background": str(artwork / "background.tiff"),
    "icon": str(stage / "Codex Co².app/Contents/Resources/AppIcon.icns"),
    "window_rect": ((180, 180), (760, 640)),
    "default_view": "icon-view",
    "show_status_bar": False,
    "show_tab_view": False,
    "show_toolbar": False,
    "show_pathbar": False,
    "show_sidebar": False,
    "show_icon_preview": False,
    "include_icon_view_settings": True,
    "include_list_view_settings": False,
    "arrange_by": None,
    "grid_spacing": 80,
    "icon_size": 128,
    "text_size": 13,
    "icon_locations": {
        ".background.tiff": (1400, 100),
        ".VolumeIcon.icns": (1400, 220),
        ".DS_Store": (1400, 340),
        "RELEASE.txt": (1400, 460),
        "Codex Co².app": (210, 215),
        "Applications": (550, 215),
        "打开隐私与安全性.inetloc": (250, 465),
        "安装说明.html": (510, 465),
    },
}
# Backport dmgbuild #275 while retaining Python 3.9 compatibility with the
# pinned build-only toolchain. Tahoe rejects the legacy pBBk background
# bookmark; keep the standard volume-relative Alias and never create pBBk.
# Deleting an entry afterward with ds_store 1.3.1 did not work in native Finder.
# https://github.com/dmgbuild/dmgbuild/pull/275
with patch.object(dmgbuild.core.Bookmark, "for_file", return_value=None):
    dmgbuild.build_dmg(str(output), volume_name, settings=settings)
print(f"Built Finder installation window: {output}")
