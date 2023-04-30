// Copyright (c) 2016 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_UI_DRAG_UTIL_H_
#define ELECTRON_SHELL_BROWSER_UI_DRAG_UTIL_H_

#include <memory>
#include <vector>

#include "shell/common/api/api.mojom.h"
#include "third_party/skia/include/core/SkRegion.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/image/image.h"

namespace base {
class FilePath;
}

namespace electron {

void DragFileItems(const std::vector<base::FilePath>& files,
                   const gfx::Image& icon,
                   gfx::NativeView view);

std::vector<gfx::Rect> CalculateNonDraggableRegions(
    std::unique_ptr<SkRegion> draggable,
    int width,
    int height);

// Convert draggable regions in raw format to SkRegion format.
std::unique_ptr<SkRegion> DraggableRegionsToSkRegion(
    const std::vector<mojom::DraggableRegionPtr>& regions);

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_UI_DRAG_UTIL_H_
