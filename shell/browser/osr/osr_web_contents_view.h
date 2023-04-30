// Copyright (c) 2016 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_OSR_OSR_WEB_CONTENTS_VIEW_H_
#define ELECTRON_SHELL_BROWSER_OSR_OSR_WEB_CONTENTS_VIEW_H_

#include "shell/browser/native_window.h"
#include "shell/browser/native_window_observer.h"

#include "content/browser/renderer_host/render_view_host_delegate_view.h"  // nogncheck
#include "content/browser/web_contents/web_contents_view.h"  // nogncheck
#include "content/public/browser/web_contents.h"
#include "shell/browser/osr/osr_render_widget_host_view.h"
#include "third_party/blink/public/common/page/drag_mojom_traits.h"

#if BUILDFLAG(IS_MAC)
#ifdef __OBJC__
@class OffScreenView;
#else
class OffScreenView;
#endif
#endif

namespace electron {

class OffScreenWebContentsView : public content::WebContentsView,
                                 public content::RenderViewHostDelegateView,
                                 public NativeWindowObserver {
 public:
  OffScreenWebContentsView(bool transparent, const OnPaintCallback& callback);
  ~OffScreenWebContentsView() override;

  void SetWebContents(content::WebContents*);
  void SetNativeWindow(NativeWindow* window);

  // NativeWindowObserver:
  void OnWindowResize() override;
  void OnWindowClosed() override;

  gfx::Size GetSize();

  // content::WebContentsView:
  gfx::NativeView GetNativeView() const override;
  gfx::NativeView GetContentNativeView() const override;
  gfx::NativeWindow GetTopLevelNativeWindow() const override;
  gfx::Rect GetContainerBounds() const override;
  void Focus() override;
  void SetInitialFocus() override;
  void StoreFocus() override;
  void RestoreFocus() override;
  void FocusThroughTabTraversal(bool reverse) override;
  content::DropData* GetDropData() const override;
  gfx::Rect GetViewBounds() const override;
  void CreateView(gfx::NativeView context) override;
  content::RenderWidgetHostViewBase* CreateViewForWidget(
      content::RenderWidgetHost* render_widget_host) override;
  content::RenderWidgetHostViewBase* CreateViewForChildWidget(
      content::RenderWidgetHost* render_widget_host) override;
  void SetPageTitle(const std::u16string& title) override;
  void RenderViewReady() override;
  void RenderViewHostChanged(content::RenderViewHost* old_host,
                             content::RenderViewHost* new_host) override;
  void SetOverscrollControllerEnabled(bool enabled) override;
  void OnCapturerCountChanged() override;
  void FullscreenStateChanged(bool is_fullscreen) override;

#if BUILDFLAG(IS_MAC)
  bool CloseTabAfterEventTrackingIfNeeded() override;
#endif

  // content::RenderViewHostDelegateView
  void StartDragging(const content::DropData& drop_data,
                     blink::DragOperationsMask allowed_ops,
                     const gfx::ImageSkia& image,
                     const gfx::Vector2d& cursor_offset,
                     const gfx::Rect& drag_obj_rect,
                     const blink::mojom::DragEventSourceInfo& event_info,
                     content::RenderWidgetHostImpl* source_rwh) override;
  void UpdateDragCursor(ui::mojom::DragOperation operation) override;
  void SetPainting(bool painting);
  bool IsPainting() const;
  void SetFrameRate(int frame_rate);
  int GetFrameRate() const;

 private:
#if BUILDFLAG(IS_MAC)
  void PlatformCreate();
  void PlatformDestroy();
#endif

  OffScreenRenderWidgetHostView* GetView() const;

  NativeWindow* native_window_ = nullptr;

  const bool transparent_;
  bool painting_ = true;
  int frame_rate_ = 60;
  OnPaintCallback callback_;

  // Weak refs.
  content::WebContents* web_contents_ = nullptr;

#if BUILDFLAG(IS_MAC)
  OffScreenView* offScreenView_;
#endif
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_OSR_OSR_WEB_CONTENTS_VIEW_H_
