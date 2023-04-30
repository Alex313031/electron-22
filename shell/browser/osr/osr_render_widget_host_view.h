// Copyright (c) 2016 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_OSR_OSR_RENDER_WIDGET_HOST_VIEW_H_
#define ELECTRON_SHELL_BROWSER_OSR_OSR_RENDER_WIDGET_HOST_VIEW_H_

#include <memory>
#include <set>
#include <string>
#include <vector>

#include "build/build_config.h"

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#endif

#include "base/process/kill.h"
#include "base/threading/thread.h"
#include "base/time/time.h"
#include "components/viz/common/quads/compositor_frame.h"
#include "components/viz/common/surfaces/parent_local_surface_id_allocator.h"
#include "content/browser/renderer_host/delegated_frame_host.h"  // nogncheck
#include "content/browser/renderer_host/input/mouse_wheel_phase_handler.h"  // nogncheck
#include "content/browser/renderer_host/render_widget_host_impl.h"  // nogncheck
#include "content/browser/renderer_host/render_widget_host_view_base.h"  // nogncheck
#include "content/browser/web_contents/web_contents_view.h"  // nogncheck
#include "shell/browser/osr/osr_host_display_client.h"
#include "shell/browser/osr/osr_video_consumer.h"
#include "shell/browser/osr/osr_view_proxy.h"
#include "third_party/blink/public/mojom/widget/record_content_to_visible_time_request.mojom-forward.h"
#include "third_party/blink/public/platform/web_vector.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/ime/text_input_client.h"
#include "ui/compositor/compositor.h"
#include "ui/compositor/layer_delegate.h"
#include "ui/compositor/layer_owner.h"
#include "ui/gfx/geometry/point.h"

#include "components/viz/host/host_display_client.h"

#if BUILDFLAG(IS_WIN)
#include "ui/gfx/win/window_impl.h"
#endif

namespace content {
class CursorManager;
}

namespace electron {

class ElectronCopyFrameGenerator;
class ElectronBeginFrameTimer;

class ElectronDelegatedFrameHostClient;

typedef base::RepeatingCallback<void(const gfx::Rect&, const SkBitmap&)>
    OnPaintCallback;
typedef base::RepeatingCallback<void(const gfx::Rect&)> OnPopupPaintCallback;

class OffScreenRenderWidgetHostView : public content::RenderWidgetHostViewBase,
                                      public ui::CompositorDelegate,
                                      public OffscreenViewProxyObserver {
 public:
  OffScreenRenderWidgetHostView(bool transparent,
                                bool painting,
                                int frame_rate,
                                const OnPaintCallback& callback,
                                content::RenderWidgetHost* render_widget_host,
                                OffScreenRenderWidgetHostView* parent_host_view,
                                gfx::Size initial_size);
  ~OffScreenRenderWidgetHostView() override;

  // disable copy
  OffScreenRenderWidgetHostView(const OffScreenRenderWidgetHostView&) = delete;
  OffScreenRenderWidgetHostView& operator=(
      const OffScreenRenderWidgetHostView&) = delete;

  // content::RenderWidgetHostView:
  void InitAsChild(gfx::NativeView) override;
  void SetSize(const gfx::Size&) override;
  void SetBounds(const gfx::Rect&) override;
  gfx::NativeView GetNativeView(void) override;
  gfx::NativeViewAccessible GetNativeViewAccessible(void) override;
  ui::TextInputClient* GetTextInputClient() override;
  void Focus(void) override;
  bool HasFocus(void) override;
  uint32_t GetCaptureSequenceNumber() const override;
  bool IsSurfaceAvailableForCopy(void) override;
  void Hide(void) override;
  bool IsShowing(void) override;
  void EnsureSurfaceSynchronizedForWebTest() override;
  gfx::Rect GetViewBounds(void) override;
  gfx::Size GetVisibleViewportSize() override;
  void SetInsets(const gfx::Insets&) override;
  void SetBackgroundColor(SkColor color) override;
  absl::optional<SkColor> GetBackgroundColor() override;
  void UpdateBackgroundColor() override;
  blink::mojom::PointerLockResult LockMouse(
      bool request_unadjusted_movement) override;
  blink::mojom::PointerLockResult ChangeMouseLock(
      bool request_unadjusted_movement) override;
  void UnlockMouse(void) override;
  void TakeFallbackContentFrom(content::RenderWidgetHostView* view) override;
#if BUILDFLAG(IS_MAC)
  void SetActive(bool active) override;
  void ShowDefinitionForSelection() override;
  void SpeakSelection() override;
  void SetWindowFrameInScreen(const gfx::Rect& rect) override;
  void ShowSharePicker(
      const std::string& title,
      const std::string& text,
      const std::string& url,
      const std::vector<std::string>& file_paths,
      blink::mojom::ShareService::ShareCallback callback) override;
  bool UpdateNSViewAndDisplay();
#endif  // BUILDFLAG(IS_MAC)

  // content::RenderWidgetHostViewBase:

  void ResetFallbackToFirstNavigationSurface() override;
  void InitAsPopup(content::RenderWidgetHostView* parent_host_view,
                   const gfx::Rect& bounds,
                   const gfx::Rect& anchor_rect) override;
  void UpdateCursor(const content::WebCursor&) override;
  void SetIsLoading(bool is_loading) override;
  void TextInputStateChanged(const ui::mojom::TextInputState& params) override;
  void ImeCancelComposition(void) override;
  void RenderProcessGone() override;
  void ShowWithVisibility(content::PageVisibilityState page_visibility) final;
  void Destroy(void) override;
  void UpdateTooltipUnderCursor(const std::u16string&) override;
  content::CursorManager* GetCursorManager() override;
  void CopyFromSurface(
      const gfx::Rect& src_rect,
      const gfx::Size& output_size,
      base::OnceCallback<void(const SkBitmap&)> callback) override;
  display::ScreenInfo GetScreenInfo() const override;
  void TransformPointToRootSurface(gfx::PointF* point) override;
  gfx::Rect GetBoundsInRootWindow(void) override;
  absl::optional<content::DisplayFeature> GetDisplayFeature() override;
  void SetDisplayFeatureForTesting(
      const content::DisplayFeature* display_feature) override;
  void NotifyHostAndDelegateOnWasShown(
      blink::mojom::RecordContentToVisibleTimeRequestPtr) final;
  void RequestPresentationTimeFromHostOrDelegate(
      blink::mojom::RecordContentToVisibleTimeRequestPtr) final;
  void CancelPresentationTimeRequestForHostAndDelegate() final;
  viz::SurfaceId GetCurrentSurfaceId() const override;
  std::unique_ptr<content::SyntheticGestureTarget>
  CreateSyntheticGestureTarget() override;
  void ImeCompositionRangeChanged(const gfx::Range&,
                                  const std::vector<gfx::Rect>&) override;
  gfx::Size GetCompositorViewportPixelSize() override;
  ui::Compositor* GetCompositor() override;

  content::RenderWidgetHostViewBase* CreateViewForWidget(
      content::RenderWidgetHost*,
      content::RenderWidgetHost*,
      content::WebContentsView*) override;

  const viz::LocalSurfaceId& GetLocalSurfaceId() const override;
  const viz::FrameSinkId& GetFrameSinkId() const override;

  void DidNavigate() override;

  bool TransformPointToCoordSpaceForView(
      const gfx::PointF& point,
      RenderWidgetHostViewBase* target_view,
      gfx::PointF* transformed_point) override;

  // ui::CompositorDelegate:
  bool IsOffscreen() const override;
  std::unique_ptr<viz::HostDisplayClient> CreateHostDisplayClient(
      ui::Compositor* compositor) override;

  bool InstallTransparency();

  void CancelWidget();
  void AddGuestHostView(OffScreenRenderWidgetHostView* guest_host);
  void RemoveGuestHostView(OffScreenRenderWidgetHostView* guest_host);
  void AddViewProxy(OffscreenViewProxy* proxy);
  void RemoveViewProxy(OffscreenViewProxy* proxy);
  void ProxyViewDestroyed(OffscreenViewProxy* proxy) override;

  void OnPaint(const gfx::Rect& damage_rect, const SkBitmap& bitmap);
  void OnPopupPaint(const gfx::Rect& damage_rect);
  void OnProxyViewPaint(const gfx::Rect& damage_rect) override;

  gfx::Size SizeInPixels();

  void CompositeFrame(const gfx::Rect& damage_rect);

  bool IsPopupWidget() const {
    return widget_type_ == content::WidgetType::kPopup;
  }

  const SkBitmap& GetBacking() { return *backing_.get(); }

  void HoldResize();
  void ReleaseResize();
  void SynchronizeVisualProperties();

  void SendMouseEvent(const blink::WebMouseEvent& event);
  void SendMouseWheelEvent(const blink::WebMouseWheelEvent& event);

  void SetPainting(bool painting);
  bool IsPainting() const;

  void SetFrameRate(int frame_rate);
  int GetFrameRate() const;

  ui::Layer* GetRootLayer() const;

  content::DelegatedFrameHost* GetDelegatedFrameHost() const;

  void Invalidate();
  void InvalidateBounds(const gfx::Rect&);

  content::RenderWidgetHostImpl* render_widget_host() const {
    return render_widget_host_;
  }

  gfx::Size size() const { return size_; }

  void set_popup_host_view(OffScreenRenderWidgetHostView* popup_view) {
    popup_host_view_ = popup_view;
  }

  void set_child_host_view(OffScreenRenderWidgetHostView* child_view) {
    child_host_view_ = child_view;
  }

 private:
  void SetupFrameRate(bool force);
  void ResizeRootLayer(bool force);

  viz::FrameSinkId AllocateFrameSinkId();

  // Applies background color without notifying the RenderWidget about
  // opaqueness changes.
  void UpdateBackgroundColorFromRenderer(SkColor color);

  // Weak ptrs.
  content::RenderWidgetHostImpl* render_widget_host_;

  OffScreenRenderWidgetHostView* parent_host_view_ = nullptr;
  OffScreenRenderWidgetHostView* popup_host_view_ = nullptr;
  OffScreenRenderWidgetHostView* child_host_view_ = nullptr;
  std::set<OffScreenRenderWidgetHostView*> guest_host_views_;
  std::set<OffscreenViewProxy*> proxy_views_;

  const bool transparent_;
  OnPaintCallback callback_;
  OnPopupPaintCallback parent_callback_;

  int frame_rate_ = 0;
  int frame_rate_threshold_us_ = 0;

  base::Time last_time_ = base::Time::Now();

  gfx::Vector2dF last_scroll_offset_;
  gfx::Size size_;
  bool painting_;

  bool is_showing_ = false;
  bool is_destroyed_ = false;
  gfx::Rect popup_position_;

  bool hold_resize_ = false;
  bool pending_resize_ = false;

  bool paint_callback_running_ = false;

  viz::LocalSurfaceId delegated_frame_host_surface_id_;
  viz::ParentLocalSurfaceIdAllocator delegated_frame_host_allocator_;

  viz::LocalSurfaceId compositor_surface_id_;
  viz::ParentLocalSurfaceIdAllocator compositor_allocator_;

  std::unique_ptr<ui::Layer> root_layer_;
  std::unique_ptr<ui::Compositor> compositor_;
  std::unique_ptr<content::DelegatedFrameHost> delegated_frame_host_;

  std::unique_ptr<content::CursorManager> cursor_manager_;

  OffScreenHostDisplayClient* host_display_client_;
  std::unique_ptr<OffScreenVideoConsumer> video_consumer_;

  std::unique_ptr<ElectronDelegatedFrameHostClient>
      delegated_frame_host_client_;

  content::MouseWheelPhaseHandler mouse_wheel_phase_handler_;

  // Latest capture sequence number which is incremented when the caller
  // requests surfaces be synchronized via
  // EnsureSurfaceSynchronizedForWebTest().
  uint32_t latest_capture_sequence_number_ = 0u;

  SkColor background_color_ = SkColor();

  std::unique_ptr<SkBitmap> backing_;

  base::WeakPtrFactory<OffScreenRenderWidgetHostView> weak_ptr_factory_{this};
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_OSR_OSR_RENDER_WIDGET_HOST_VIEW_H_
