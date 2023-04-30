// Copyright (c) 2016 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/osr/osr_render_widget_host_view.h"

#include <algorithm>
#include <memory>
#include <utility>
#include <vector>

#include "base/callback_helpers.h"
#include "base/location.h"
#include "base/memory/ptr_util.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "components/viz/common/features.h"
#include "components/viz/common/frame_sinks/begin_frame_args.h"
#include "components/viz/common/frame_sinks/copy_output_request.h"
#include "components/viz/common/frame_sinks/delay_based_time_source.h"
#include "components/viz/common/quads/compositor_render_pass.h"
#include "content/browser/renderer_host/cursor_manager.h"  // nogncheck
#include "content/browser/renderer_host/input/synthetic_gesture_target.h"  // nogncheck
#include "content/browser/renderer_host/render_widget_host_delegate.h"  // nogncheck
#include "content/browser/renderer_host/render_widget_host_owner_delegate.h"  // nogncheck
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/context_factory.h"
#include "content/public/browser/gpu_data_manager.h"
#include "content/public/browser/render_process_host.h"
#include "gpu/command_buffer/client/gl_helper.h"
#include "media/base/video_frame.h"
#include "third_party/abseil-cpp/absl/types/optional.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/skia/include/core/SkCanvas.h"
#include "ui/compositor/compositor.h"
#include "ui/compositor/layer.h"
#include "ui/compositor/layer_type.h"
#include "ui/display/screen.h"
#include "ui/events/base_event_utils.h"
#include "ui/events/event_constants.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/geometry/dip_util.h"
#include "ui/gfx/geometry/size_conversions.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/gfx/native_widget_types.h"
#include "ui/gfx/skbitmap_operations.h"
#include "ui/latency/latency_info.h"

namespace electron {

namespace {

const float kDefaultScaleFactor = 1.0;

ui::MouseEvent UiMouseEventFromWebMouseEvent(blink::WebMouseEvent event) {
  ui::EventType type = ui::EventType::ET_UNKNOWN;
  switch (event.GetType()) {
    case blink::WebInputEvent::Type::kMouseDown:
      type = ui::EventType::ET_MOUSE_PRESSED;
      break;
    case blink::WebInputEvent::Type::kMouseUp:
      type = ui::EventType::ET_MOUSE_RELEASED;
      break;
    case blink::WebInputEvent::Type::kMouseMove:
      type = ui::EventType::ET_MOUSE_MOVED;
      break;
    case blink::WebInputEvent::Type::kMouseEnter:
      type = ui::EventType::ET_MOUSE_ENTERED;
      break;
    case blink::WebInputEvent::Type::kMouseLeave:
      type = ui::EventType::ET_MOUSE_EXITED;
      break;
    case blink::WebInputEvent::Type::kMouseWheel:
      type = ui::EventType::ET_MOUSEWHEEL;
      break;
    default:
      type = ui::EventType::ET_UNKNOWN;
      break;
  }

  int button_flags = 0;
  switch (event.button) {
    case blink::WebMouseEvent::Button::kBack:
      button_flags |= ui::EF_BACK_MOUSE_BUTTON;
      break;
    case blink::WebMouseEvent::Button::kForward:
      button_flags |= ui::EF_FORWARD_MOUSE_BUTTON;
      break;
    case blink::WebMouseEvent::Button::kLeft:
      button_flags |= ui::EF_LEFT_MOUSE_BUTTON;
      break;
    case blink::WebMouseEvent::Button::kMiddle:
      button_flags |= ui::EF_MIDDLE_MOUSE_BUTTON;
      break;
    case blink::WebMouseEvent::Button::kRight:
      button_flags |= ui::EF_RIGHT_MOUSE_BUTTON;
      break;
    default:
      button_flags = 0;
      break;
  }

  ui::MouseEvent ui_event(type,
                          gfx::Point(std::floor(event.PositionInWidget().x()),
                                     std::floor(event.PositionInWidget().y())),
                          gfx::Point(std::floor(event.PositionInWidget().x()),
                                     std::floor(event.PositionInWidget().y())),
                          ui::EventTimeForNow(), button_flags, button_flags);
  ui_event.SetClickCount(event.click_count);

  return ui_event;
}

ui::MouseWheelEvent UiMouseWheelEventFromWebMouseEvent(
    blink::WebMouseWheelEvent event) {
  return ui::MouseWheelEvent(UiMouseEventFromWebMouseEvent(event),
                             std::floor(event.delta_x),
                             std::floor(event.delta_y));
}

}  // namespace

class ElectronDelegatedFrameHostClient
    : public content::DelegatedFrameHostClient {
 public:
  explicit ElectronDelegatedFrameHostClient(OffScreenRenderWidgetHostView* view)
      : view_(view) {}

  // disable copy
  ElectronDelegatedFrameHostClient(const ElectronDelegatedFrameHostClient&) =
      delete;
  ElectronDelegatedFrameHostClient& operator=(
      const ElectronDelegatedFrameHostClient&) = delete;

  ui::Layer* DelegatedFrameHostGetLayer() const override {
    return view_->GetRootLayer();
  }

  bool DelegatedFrameHostIsVisible() const override {
    return view_->IsShowing();
  }

  SkColor DelegatedFrameHostGetGutterColor() const override {
    if (view_->render_widget_host()->delegate() &&
        view_->render_widget_host()->delegate()->IsFullscreen()) {
      return SK_ColorWHITE;
    }
    return *view_->GetBackgroundColor();
  }

  void OnFrameTokenChanged(uint32_t frame_token,
                           base::TimeTicks activation_time) override {
    view_->render_widget_host()->DidProcessFrame(frame_token, activation_time);
  }

  float GetDeviceScaleFactor() const override {
    return view_->GetDeviceScaleFactor();
  }

  std::vector<viz::SurfaceId> CollectSurfaceIdsForEviction() override {
    return view_->render_widget_host()->CollectSurfaceIdsForEviction();
  }

  bool ShouldShowStaleContentOnEviction() override { return false; }

  void InvalidateLocalSurfaceIdOnEviction() override {}

 private:
  OffScreenRenderWidgetHostView* const view_;
};

OffScreenRenderWidgetHostView::OffScreenRenderWidgetHostView(
    bool transparent,
    bool painting,
    int frame_rate,
    const OnPaintCallback& callback,
    content::RenderWidgetHost* host,
    OffScreenRenderWidgetHostView* parent_host_view,
    gfx::Size initial_size)
    : content::RenderWidgetHostViewBase(host),
      render_widget_host_(content::RenderWidgetHostImpl::From(host)),
      parent_host_view_(parent_host_view),
      transparent_(transparent),
      callback_(callback),
      frame_rate_(frame_rate),
      size_(initial_size),
      painting_(painting),
      cursor_manager_(std::make_unique<content::CursorManager>(this)),
      mouse_wheel_phase_handler_(this),
      backing_(std::make_unique<SkBitmap>()) {
  DCHECK(render_widget_host_);
  DCHECK(!render_widget_host_->GetView());

  // Initialize a screen_infos_ struct as needed, to cache the scale factor.
  if (screen_infos_.screen_infos.empty()) {
    UpdateScreenInfo();
  }
  screen_infos_.mutable_current().device_scale_factor = kDefaultScaleFactor;

  delegated_frame_host_allocator_.GenerateId();
  delegated_frame_host_surface_id_ =
      delegated_frame_host_allocator_.GetCurrentLocalSurfaceId();
  compositor_allocator_.GenerateId();
  compositor_surface_id_ = compositor_allocator_.GetCurrentLocalSurfaceId();

  delegated_frame_host_client_ =
      std::make_unique<ElectronDelegatedFrameHostClient>(this);
  delegated_frame_host_ = std::make_unique<content::DelegatedFrameHost>(
      AllocateFrameSinkId(), delegated_frame_host_client_.get(),
      true /* should_register_frame_sink_id */);

  root_layer_ = std::make_unique<ui::Layer>(ui::LAYER_SOLID_COLOR);

  bool opaque = SkColorGetA(background_color_) == SK_AlphaOPAQUE;
  GetRootLayer()->SetFillsBoundsOpaquely(opaque);
  GetRootLayer()->SetColor(background_color_);

  ui::ContextFactory* context_factory = content::GetContextFactory();
  compositor_ = std::make_unique<ui::Compositor>(
      context_factory->AllocateFrameSinkId(), context_factory,
      base::ThreadTaskRunnerHandle::Get(), false /* enable_pixel_canvas */,
      false /* use_external_begin_frame_control */);
  compositor_->SetAcceleratedWidget(gfx::kNullAcceleratedWidget);
  compositor_->SetDelegate(this);
  compositor_->SetRootLayer(root_layer_.get());

  ResizeRootLayer(false);
  render_widget_host_->SetView(this);

  if (content::GpuDataManager::GetInstance()->HardwareAccelerationEnabled()) {
    video_consumer_ = std::make_unique<OffScreenVideoConsumer>(
        this, base::BindRepeating(&OffScreenRenderWidgetHostView::OnPaint,
                                  weak_ptr_factory_.GetWeakPtr()));
    video_consumer_->SetActive(IsPainting());
    video_consumer_->SetFrameRate(GetFrameRate());
  }
}

OffScreenRenderWidgetHostView::~OffScreenRenderWidgetHostView() {
  // Marking the DelegatedFrameHost as removed from the window hierarchy is
  // necessary to remove all connections to its old ui::Compositor.
  if (is_showing_)
    delegated_frame_host_->WasHidden(
        content::DelegatedFrameHost::HiddenCause::kOther);
  delegated_frame_host_->DetachFromCompositor();

  delegated_frame_host_.reset();
  compositor_.reset();
  root_layer_.reset();
}

void OffScreenRenderWidgetHostView::InitAsChild(gfx::NativeView) {
  DCHECK(parent_host_view_);

  if (parent_host_view_->child_host_view_) {
    parent_host_view_->child_host_view_->CancelWidget();
  }

  parent_host_view_->set_child_host_view(this);
  parent_host_view_->Hide();

  ResizeRootLayer(false);
  SetPainting(parent_host_view_->IsPainting());
}

void OffScreenRenderWidgetHostView::SetSize(const gfx::Size& size) {
  size_ = size;
  SynchronizeVisualProperties();
}

void OffScreenRenderWidgetHostView::SetBounds(const gfx::Rect& new_bounds) {
  SetSize(new_bounds.size());
}

gfx::NativeView OffScreenRenderWidgetHostView::GetNativeView() {
  return gfx::NativeView();
}

gfx::NativeViewAccessible
OffScreenRenderWidgetHostView::GetNativeViewAccessible() {
  return gfx::NativeViewAccessible();
}

ui::TextInputClient* OffScreenRenderWidgetHostView::GetTextInputClient() {
  return nullptr;
}

void OffScreenRenderWidgetHostView::Focus() {}

bool OffScreenRenderWidgetHostView::HasFocus() {
  return false;
}

bool OffScreenRenderWidgetHostView::IsSurfaceAvailableForCopy() {
  return GetDelegatedFrameHost()->CanCopyFromCompositingSurface();
}

void OffScreenRenderWidgetHostView::ShowWithVisibility(
    content::PageVisibilityState /*page_visibility*/) {
  if (is_showing_)
    return;

  is_showing_ = true;

  delegated_frame_host_->AttachToCompositor(compositor_.get());
  delegated_frame_host_->WasShown(GetLocalSurfaceId(),
                                  GetRootLayer()->bounds().size(), {});

  if (render_widget_host_)
    render_widget_host_->WasShown({});
}

void OffScreenRenderWidgetHostView::Hide() {
  if (!is_showing_)
    return;

  if (render_widget_host_)
    render_widget_host_->WasHidden();

  // TODO(deermichel): correct or kOther?
  GetDelegatedFrameHost()->WasHidden(
      content::DelegatedFrameHost::HiddenCause::kOccluded);
  GetDelegatedFrameHost()->DetachFromCompositor();

  is_showing_ = false;
}

bool OffScreenRenderWidgetHostView::IsShowing() {
  return is_showing_;
}

void OffScreenRenderWidgetHostView::EnsureSurfaceSynchronizedForWebTest() {
  ++latest_capture_sequence_number_;
  SynchronizeVisualProperties();
}

gfx::Rect OffScreenRenderWidgetHostView::GetViewBounds() {
  if (IsPopupWidget())
    return popup_position_;

  return gfx::Rect(size_);
}

void OffScreenRenderWidgetHostView::SetBackgroundColor(SkColor color) {
  // The renderer will feed its color back to us with the first CompositorFrame.
  // We short-cut here to show a sensible color before that happens.
  UpdateBackgroundColorFromRenderer(color);

  if (render_widget_host_ && render_widget_host_->owner_delegate()) {
    render_widget_host_->owner_delegate()->SetBackgroundOpaque(
        SkColorGetA(color) == SK_AlphaOPAQUE);
  }
}

absl::optional<SkColor> OffScreenRenderWidgetHostView::GetBackgroundColor() {
  return background_color_;
}

void OffScreenRenderWidgetHostView::UpdateBackgroundColor() {}

gfx::Size OffScreenRenderWidgetHostView::GetVisibleViewportSize() {
  return size_;
}

void OffScreenRenderWidgetHostView::SetInsets(const gfx::Insets& insets) {}

blink::mojom::PointerLockResult OffScreenRenderWidgetHostView::LockMouse(
    bool request_unadjusted_movement) {
  return blink::mojom::PointerLockResult::kUnsupportedOptions;
}

blink::mojom::PointerLockResult OffScreenRenderWidgetHostView::ChangeMouseLock(
    bool request_unadjusted_movement) {
  return blink::mojom::PointerLockResult::kUnsupportedOptions;
}

void OffScreenRenderWidgetHostView::UnlockMouse() {}

void OffScreenRenderWidgetHostView::TakeFallbackContentFrom(
    content::RenderWidgetHostView* view) {
  DCHECK(!static_cast<content::RenderWidgetHostViewBase*>(view)
              ->IsRenderWidgetHostViewChildFrame());
  auto* view_osr = static_cast<OffScreenRenderWidgetHostView*>(view);
  SetBackgroundColor(view_osr->background_color_);
  if (GetDelegatedFrameHost() && view_osr->GetDelegatedFrameHost()) {
    GetDelegatedFrameHost()->TakeFallbackContentFrom(
        view_osr->GetDelegatedFrameHost());
  }
  host()->GetContentRenderingTimeoutFrom(view_osr->host());
}

void OffScreenRenderWidgetHostView::ResetFallbackToFirstNavigationSurface() {
  GetDelegatedFrameHost()->ResetFallbackToFirstNavigationSurface();
}

void OffScreenRenderWidgetHostView::InitAsPopup(
    content::RenderWidgetHostView* parent_host_view,
    const gfx::Rect& bounds,
    const gfx::Rect& anchor_rect) {
  DCHECK_EQ(parent_host_view_, parent_host_view);
  DCHECK_EQ(widget_type_, content::WidgetType::kPopup);

  if (parent_host_view_->popup_host_view_) {
    parent_host_view_->popup_host_view_->CancelWidget();
  }

  parent_host_view_->set_popup_host_view(this);
  parent_callback_ =
      base::BindRepeating(&OffScreenRenderWidgetHostView::OnPopupPaint,
                          parent_host_view_->weak_ptr_factory_.GetWeakPtr());

  popup_position_ = bounds;

  ResizeRootLayer(true);
  SetPainting(parent_host_view_->IsPainting());
  Show();
}

void OffScreenRenderWidgetHostView::UpdateCursor(const content::WebCursor&) {}

content::CursorManager* OffScreenRenderWidgetHostView::GetCursorManager() {
  return cursor_manager_.get();
}

void OffScreenRenderWidgetHostView::SetIsLoading(bool loading) {}

void OffScreenRenderWidgetHostView::TextInputStateChanged(
    const ui::mojom::TextInputState& params) {}

void OffScreenRenderWidgetHostView::ImeCancelComposition() {}

void OffScreenRenderWidgetHostView::RenderProcessGone() {
  Destroy();
}

void OffScreenRenderWidgetHostView::Destroy() {
  if (!is_destroyed_) {
    is_destroyed_ = true;

    if (parent_host_view_ != nullptr) {
      CancelWidget();
    } else {
      if (popup_host_view_)
        popup_host_view_->CancelWidget();
      if (child_host_view_)
        child_host_view_->CancelWidget();
      if (!guest_host_views_.empty()) {
        // Guest RWHVs will be destroyed when the associated RWHVGuest is
        // destroyed. This parent RWHV may be destroyed first, so disassociate
        // the guest RWHVs here without destroying them.
        for (auto* guest_host_view : guest_host_views_)
          guest_host_view->parent_host_view_ = nullptr;
        guest_host_views_.clear();
      }
      for (auto* proxy_view : proxy_views_)
        proxy_view->RemoveObserver();
      Hide();
    }
  }

  delete this;
}

void OffScreenRenderWidgetHostView::UpdateTooltipUnderCursor(
    const std::u16string&) {}

uint32_t OffScreenRenderWidgetHostView::GetCaptureSequenceNumber() const {
  return latest_capture_sequence_number_;
}

void OffScreenRenderWidgetHostView::CopyFromSurface(
    const gfx::Rect& src_rect,
    const gfx::Size& output_size,
    base::OnceCallback<void(const SkBitmap&)> callback) {
  GetDelegatedFrameHost()->CopyFromCompositingSurface(src_rect, output_size,
                                                      std::move(callback));
}

display::ScreenInfo OffScreenRenderWidgetHostView::GetScreenInfo() const {
  display::ScreenInfo screen_info;
  screen_info.depth = 24;
  screen_info.depth_per_component = 8;
  screen_info.orientation_angle = 0;
  screen_info.device_scale_factor = GetDeviceScaleFactor();
  screen_info.orientation_type =
      display::mojom::ScreenOrientation::kLandscapePrimary;
  screen_info.rect = gfx::Rect(size_);
  screen_info.available_rect = gfx::Rect(size_);
  return screen_info;
}

void OffScreenRenderWidgetHostView::TransformPointToRootSurface(
    gfx::PointF* point) {}

gfx::Rect OffScreenRenderWidgetHostView::GetBoundsInRootWindow() {
  return gfx::Rect(size_);
}

absl::optional<content::DisplayFeature>
OffScreenRenderWidgetHostView::GetDisplayFeature() {
  return absl::nullopt;
}

void OffScreenRenderWidgetHostView::SetDisplayFeatureForTesting(
    const content::DisplayFeature* display_feature) {}

viz::SurfaceId OffScreenRenderWidgetHostView::GetCurrentSurfaceId() const {
  return GetDelegatedFrameHost()
             ? GetDelegatedFrameHost()->GetCurrentSurfaceId()
             : viz::SurfaceId();
}

std::unique_ptr<content::SyntheticGestureTarget>
OffScreenRenderWidgetHostView::CreateSyntheticGestureTarget() {
  NOTIMPLEMENTED();
  return nullptr;
}

void OffScreenRenderWidgetHostView::ImeCompositionRangeChanged(
    const gfx::Range&,
    const std::vector<gfx::Rect>&) {}

gfx::Size OffScreenRenderWidgetHostView::GetCompositorViewportPixelSize() {
  return gfx::ScaleToCeiledSize(GetRequestedRendererSize(),
                                GetDeviceScaleFactor());
}

ui::Compositor* OffScreenRenderWidgetHostView::GetCompositor() {
  return compositor_.get();
}

content::RenderWidgetHostViewBase*
OffScreenRenderWidgetHostView::CreateViewForWidget(
    content::RenderWidgetHost* render_widget_host,
    content::RenderWidgetHost* embedder_render_widget_host,
    content::WebContentsView* web_contents_view) {
  if (render_widget_host->GetView()) {
    return static_cast<content::RenderWidgetHostViewBase*>(
        render_widget_host->GetView());
  }

  OffScreenRenderWidgetHostView* embedder_host_view = nullptr;
  if (embedder_render_widget_host) {
    embedder_host_view = static_cast<OffScreenRenderWidgetHostView*>(
        embedder_render_widget_host->GetView());
  }

  return new OffScreenRenderWidgetHostView(
      transparent_, true, embedder_host_view->GetFrameRate(), callback_,
      render_widget_host, embedder_host_view, size());
}

const viz::FrameSinkId& OffScreenRenderWidgetHostView::GetFrameSinkId() const {
  return GetDelegatedFrameHost()->frame_sink_id();
}

void OffScreenRenderWidgetHostView::DidNavigate() {
  ResizeRootLayer(true);
  if (delegated_frame_host_)
    delegated_frame_host_->DidNavigate();
}

bool OffScreenRenderWidgetHostView::TransformPointToCoordSpaceForView(
    const gfx::PointF& point,
    RenderWidgetHostViewBase* target_view,
    gfx::PointF* transformed_point) {
  if (target_view == this) {
    *transformed_point = point;
    return true;
  }

  return false;
}

void OffScreenRenderWidgetHostView::CancelWidget() {
  if (render_widget_host_)
    render_widget_host_->LostCapture();
  Hide();

  if (parent_host_view_) {
    if (parent_host_view_->popup_host_view_ == this) {
      parent_host_view_->set_popup_host_view(nullptr);
    } else if (parent_host_view_->child_host_view_ == this) {
      parent_host_view_->set_child_host_view(nullptr);
      parent_host_view_->Show();
    } else {
      parent_host_view_->RemoveGuestHostView(this);
    }
    parent_host_view_ = nullptr;
  }

  if (render_widget_host_ && !is_destroyed_) {
    is_destroyed_ = true;
    // Results in a call to Destroy().
    render_widget_host_->ShutdownAndDestroyWidget(true);
  }
}

void OffScreenRenderWidgetHostView::AddGuestHostView(
    OffScreenRenderWidgetHostView* guest_host) {
  guest_host_views_.insert(guest_host);
}

void OffScreenRenderWidgetHostView::RemoveGuestHostView(
    OffScreenRenderWidgetHostView* guest_host) {
  guest_host_views_.erase(guest_host);
}

void OffScreenRenderWidgetHostView::AddViewProxy(OffscreenViewProxy* proxy) {
  proxy->SetObserver(this);
  proxy_views_.insert(proxy);
}

void OffScreenRenderWidgetHostView::RemoveViewProxy(OffscreenViewProxy* proxy) {
  proxy->RemoveObserver();
  proxy_views_.erase(proxy);
}

void OffScreenRenderWidgetHostView::ProxyViewDestroyed(
    OffscreenViewProxy* proxy) {
  proxy_views_.erase(proxy);
  Invalidate();
}

bool OffScreenRenderWidgetHostView::IsOffscreen() const {
  return true;
}

std::unique_ptr<viz::HostDisplayClient>
OffScreenRenderWidgetHostView::CreateHostDisplayClient(
    ui::Compositor* compositor) {
  host_display_client_ = new OffScreenHostDisplayClient(
      gfx::kNullAcceleratedWidget,
      base::BindRepeating(&OffScreenRenderWidgetHostView::OnPaint,
                          weak_ptr_factory_.GetWeakPtr()));
  host_display_client_->SetActive(IsPainting());
  return base::WrapUnique(host_display_client_);
}

bool OffScreenRenderWidgetHostView::InstallTransparency() {
  if (transparent_) {
    SetBackgroundColor(SkColor());
    compositor_->SetBackgroundColor(SK_ColorTRANSPARENT);
    return true;
  }
  return false;
}

#if BUILDFLAG(IS_MAC)
void OffScreenRenderWidgetHostView::SetActive(bool active) {}

void OffScreenRenderWidgetHostView::ShowDefinitionForSelection() {}

void OffScreenRenderWidgetHostView::SpeakSelection() {}

void OffScreenRenderWidgetHostView::SetWindowFrameInScreen(
    const gfx::Rect& rect) {}

void OffScreenRenderWidgetHostView::ShowSharePicker(
    const std::string& title,
    const std::string& text,
    const std::string& url,
    const std::vector<std::string>& file_paths,
    blink::mojom::ShareService::ShareCallback callback) {}

bool OffScreenRenderWidgetHostView::UpdateNSViewAndDisplay() {
  return false;
}
#endif

void OffScreenRenderWidgetHostView::OnPaint(const gfx::Rect& damage_rect,
                                            const SkBitmap& bitmap) {
  backing_ = std::make_unique<SkBitmap>();
  backing_->allocN32Pixels(bitmap.width(), bitmap.height(), !transparent_);
  bitmap.readPixels(backing_->pixmap());

  if (IsPopupWidget() && parent_callback_) {
    parent_callback_.Run(this->popup_position_);
  } else {
    CompositeFrame(damage_rect);
  }
}

gfx::Size OffScreenRenderWidgetHostView::SizeInPixels() {
  float sf = GetDeviceScaleFactor();
  return gfx::ToFlooredSize(
      gfx::ConvertSizeToPixels(GetViewBounds().size(), sf));
}

void OffScreenRenderWidgetHostView::CompositeFrame(
    const gfx::Rect& damage_rect) {
  HoldResize();

  gfx::Size size_in_pixels = SizeInPixels();

  SkBitmap frame;

  // Optimize for the case when there is no popup
  if (proxy_views_.empty() && !popup_host_view_) {
    frame = GetBacking();
  } else {
    float sf = GetDeviceScaleFactor();
    frame.allocN32Pixels(size_in_pixels.width(), size_in_pixels.height(),
                         false);
    if (!GetBacking().drawsNothing()) {
      SkCanvas canvas(frame);
      canvas.writePixels(GetBacking(), 0, 0);

      if (popup_host_view_ && !popup_host_view_->GetBacking().drawsNothing()) {
        gfx::Rect rect = popup_host_view_->popup_position_;
        gfx::Point origin_in_pixels =
            gfx::ToFlooredPoint(gfx::ConvertPointToPixels(rect.origin(), sf));
        canvas.writePixels(popup_host_view_->GetBacking(), origin_in_pixels.x(),
                           origin_in_pixels.y());
      }

      for (auto* proxy_view : proxy_views_) {
        gfx::Rect rect = proxy_view->GetBounds();
        gfx::Point origin_in_pixels =
            gfx::ToFlooredPoint(gfx::ConvertPointToPixels(rect.origin(), sf));
        canvas.writePixels(*proxy_view->GetBitmap(), origin_in_pixels.x(),
                           origin_in_pixels.y());
      }
    }
  }

  paint_callback_running_ = true;
  callback_.Run(gfx::IntersectRects(gfx::Rect(size_in_pixels), damage_rect),
                frame);
  paint_callback_running_ = false;

  ReleaseResize();
}

void OffScreenRenderWidgetHostView::OnPopupPaint(const gfx::Rect& damage_rect) {
  InvalidateBounds(gfx::ToEnclosingRect(
      gfx::ConvertRectToPixels(damage_rect, GetDeviceScaleFactor())));
}

void OffScreenRenderWidgetHostView::OnProxyViewPaint(
    const gfx::Rect& damage_rect) {
  InvalidateBounds(gfx::ToEnclosingRect(
      gfx::ConvertRectToPixels(damage_rect, GetDeviceScaleFactor())));
}

void OffScreenRenderWidgetHostView::HoldResize() {
  if (!hold_resize_)
    hold_resize_ = true;
}

void OffScreenRenderWidgetHostView::ReleaseResize() {
  if (!hold_resize_)
    return;

  hold_resize_ = false;
  if (pending_resize_) {
    pending_resize_ = false;
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE,
        base::BindOnce(
            &OffScreenRenderWidgetHostView::SynchronizeVisualProperties,
            weak_ptr_factory_.GetWeakPtr()));
  }
}

void OffScreenRenderWidgetHostView::SynchronizeVisualProperties() {
  if (hold_resize_) {
    if (!pending_resize_)
      pending_resize_ = true;
    return;
  }

  ResizeRootLayer(true);
}

void OffScreenRenderWidgetHostView::SendMouseEvent(
    const blink::WebMouseEvent& event) {
  for (auto* proxy_view : proxy_views_) {
    gfx::Rect bounds = proxy_view->GetBounds();
    if (bounds.Contains(event.PositionInWidget().x(),
                        event.PositionInWidget().y())) {
      blink::WebMouseEvent proxy_event(event);
      proxy_event.SetPositionInWidget(
          proxy_event.PositionInWidget().x() - bounds.x(),
          proxy_event.PositionInWidget().y() - bounds.y());

      ui::MouseEvent ui_event = UiMouseEventFromWebMouseEvent(proxy_event);
      proxy_view->OnEvent(&ui_event);
      return;
    }
  }

  if (!IsPopupWidget()) {
    if (popup_host_view_ &&
        popup_host_view_->popup_position_.Contains(
            event.PositionInWidget().x(), event.PositionInWidget().y())) {
      blink::WebMouseEvent popup_event(event);
      popup_event.SetPositionInWidget(
          popup_event.PositionInWidget().x() -
              popup_host_view_->popup_position_.x(),
          popup_event.PositionInWidget().y() -
              popup_host_view_->popup_position_.y());

      popup_host_view_->ProcessMouseEvent(popup_event, ui::LatencyInfo());
      return;
    }
  }

  if (!render_widget_host_)
    return;
  render_widget_host_->ForwardMouseEvent(event);
}

void OffScreenRenderWidgetHostView::SendMouseWheelEvent(
    const blink::WebMouseWheelEvent& event) {
  for (auto* proxy_view : proxy_views_) {
    gfx::Rect bounds = proxy_view->GetBounds();
    if (bounds.Contains(event.PositionInWidget().x(),
                        event.PositionInWidget().y())) {
      blink::WebMouseWheelEvent proxy_event(event);
      proxy_event.SetPositionInWidget(
          proxy_event.PositionInWidget().x() - bounds.x(),
          proxy_event.PositionInWidget().y() - bounds.y());

      ui::MouseWheelEvent ui_event =
          UiMouseWheelEventFromWebMouseEvent(proxy_event);
      proxy_view->OnEvent(&ui_event);
      return;
    }
  }

  blink::WebMouseWheelEvent mouse_wheel_event(event);

  bool should_route_event =
      render_widget_host_->delegate() &&
      render_widget_host_->delegate()->GetInputEventRouter();
  mouse_wheel_phase_handler_.SendWheelEndForTouchpadScrollingIfNeeded(
      should_route_event);
  mouse_wheel_phase_handler_.AddPhaseIfNeededAndScheduleEndEvent(
      mouse_wheel_event, false);

  if (!IsPopupWidget()) {
    if (popup_host_view_) {
      if (popup_host_view_->popup_position_.Contains(
              mouse_wheel_event.PositionInWidget().x(),
              mouse_wheel_event.PositionInWidget().y())) {
        blink::WebMouseWheelEvent popup_mouse_wheel_event(mouse_wheel_event);
        popup_mouse_wheel_event.SetPositionInWidget(
            mouse_wheel_event.PositionInWidget().x() -
                popup_host_view_->popup_position_.x(),
            mouse_wheel_event.PositionInWidget().y() -
                popup_host_view_->popup_position_.y());
        popup_mouse_wheel_event.SetPositionInScreen(
            popup_mouse_wheel_event.PositionInWidget().x(),
            popup_mouse_wheel_event.PositionInWidget().y());

        popup_host_view_->SendMouseWheelEvent(popup_mouse_wheel_event);
        return;
      } else {
        // Scrolling outside of the popup widget so destroy it.
        // Execute asynchronously to avoid deleting the widget from inside some
        // other callback.
        content::GetUIThreadTaskRunner({})->PostTask(
            FROM_HERE,
            base::BindOnce(&OffScreenRenderWidgetHostView::CancelWidget,
                           popup_host_view_->weak_ptr_factory_.GetWeakPtr()));
      }
    } else if (!guest_host_views_.empty()) {
      for (auto* guest_host_view : guest_host_views_) {
        if (!guest_host_view->render_widget_host_ ||
            !guest_host_view->render_widget_host_->GetView()) {
          continue;
        }
        const gfx::Rect& guest_bounds =
            guest_host_view->render_widget_host_->GetView()->GetViewBounds();
        if (guest_bounds.Contains(mouse_wheel_event.PositionInWidget().x(),
                                  mouse_wheel_event.PositionInWidget().y())) {
          blink::WebMouseWheelEvent guest_mouse_wheel_event(mouse_wheel_event);
          guest_mouse_wheel_event.SetPositionInWidget(
              mouse_wheel_event.PositionInWidget().x() - guest_bounds.x(),
              mouse_wheel_event.PositionInWidget().y() - guest_bounds.y());
          guest_mouse_wheel_event.SetPositionInScreen(
              guest_mouse_wheel_event.PositionInWidget().x(),
              guest_mouse_wheel_event.PositionInWidget().y());

          guest_host_view->SendMouseWheelEvent(guest_mouse_wheel_event);
          return;
        }
      }
    }
  }
  if (!render_widget_host_)
    return;
  render_widget_host_->ForwardWheelEvent(event);
}

void OffScreenRenderWidgetHostView::SetPainting(bool painting) {
  painting_ = painting;

  if (popup_host_view_) {
    popup_host_view_->SetPainting(painting);
  }

  for (auto* guest_host_view : guest_host_views_)
    guest_host_view->SetPainting(painting);

  if (video_consumer_) {
    video_consumer_->SetActive(IsPainting());
  } else if (host_display_client_) {
    host_display_client_->SetActive(IsPainting());
  }
}

bool OffScreenRenderWidgetHostView::IsPainting() const {
  return painting_;
}

void OffScreenRenderWidgetHostView::SetFrameRate(int frame_rate) {
  if (parent_host_view_) {
    if (parent_host_view_->GetFrameRate() == GetFrameRate())
      return;

    frame_rate_ = parent_host_view_->GetFrameRate();
  } else {
    if (frame_rate <= 0)
      frame_rate = 1;
    if (frame_rate > 240)
      frame_rate = 240;

    frame_rate_ = frame_rate;
  }

  SetupFrameRate(true);

  if (video_consumer_) {
    video_consumer_->SetFrameRate(GetFrameRate());
  }

  for (auto* guest_host_view : guest_host_views_)
    guest_host_view->SetFrameRate(frame_rate);
}

int OffScreenRenderWidgetHostView::GetFrameRate() const {
  return frame_rate_;
}

ui::Layer* OffScreenRenderWidgetHostView::GetRootLayer() const {
  return root_layer_.get();
}

const viz::LocalSurfaceId& OffScreenRenderWidgetHostView::GetLocalSurfaceId()
    const {
  return delegated_frame_host_surface_id_;
}

content::DelegatedFrameHost*
OffScreenRenderWidgetHostView::GetDelegatedFrameHost() const {
  return delegated_frame_host_.get();
}

void OffScreenRenderWidgetHostView::SetupFrameRate(bool force) {
  if (!force && frame_rate_threshold_us_ != 0)
    return;

  frame_rate_threshold_us_ = 1000000 / frame_rate_;

  if (compositor_) {
    compositor_->SetDisplayVSyncParameters(
        base::TimeTicks::Now(), base::Microseconds(frame_rate_threshold_us_));
  }
}

void OffScreenRenderWidgetHostView::Invalidate() {
  InvalidateBounds(gfx::Rect(GetRequestedRendererSize()));
}

void OffScreenRenderWidgetHostView::InvalidateBounds(const gfx::Rect& bounds) {
  CompositeFrame(bounds);
}

void OffScreenRenderWidgetHostView::ResizeRootLayer(bool force) {
  SetupFrameRate(false);

  display::Display display =
      display::Screen::GetScreen()->GetDisplayNearestView(GetNativeView());
  const float scaleFactor = display.device_scale_factor();
  float sf = GetDeviceScaleFactor();
  const bool sf_did_change = scaleFactor != sf;

  // Initialize a screen_infos_ struct as needed, to cache the scale factor.
  if (screen_infos_.screen_infos.empty()) {
    UpdateScreenInfo();
  }
  screen_infos_.mutable_current().device_scale_factor = scaleFactor;

  gfx::Size size = GetViewBounds().size();

  if (!force && !sf_did_change && size == GetRootLayer()->bounds().size())
    return;

  GetRootLayer()->SetBounds(gfx::Rect(size));

  const gfx::Size& size_in_pixels =
      gfx::ToFlooredSize(gfx::ConvertSizeToPixels(size, sf));

  if (compositor_) {
    compositor_allocator_.GenerateId();
    compositor_surface_id_ = compositor_allocator_.GetCurrentLocalSurfaceId();
    compositor_->SetScaleAndSize(sf, size_in_pixels, compositor_surface_id_);
  }

  delegated_frame_host_allocator_.GenerateId();
  delegated_frame_host_surface_id_ =
      delegated_frame_host_allocator_.GetCurrentLocalSurfaceId();

  GetDelegatedFrameHost()->EmbedSurface(
      delegated_frame_host_surface_id_, size,
      cc::DeadlinePolicy::UseDefaultDeadline());

  // Note that |render_widget_host_| will retrieve resize parameters from the
  // DelegatedFrameHost, so it must have SynchronizeVisualProperties called
  // after.
  if (render_widget_host_) {
    render_widget_host_->SynchronizeVisualProperties();
  }
}

viz::FrameSinkId OffScreenRenderWidgetHostView::AllocateFrameSinkId() {
  return viz::FrameSinkId(
      base::checked_cast<uint32_t>(render_widget_host_->GetProcess()->GetID()),
      base::checked_cast<uint32_t>(render_widget_host_->GetRoutingID()));
}

void OffScreenRenderWidgetHostView::UpdateBackgroundColorFromRenderer(
    SkColor color) {
  if (color == background_color_)
    return;
  background_color_ = color;

  bool opaque = SkColorGetA(color) == SK_AlphaOPAQUE;
  GetRootLayer()->SetFillsBoundsOpaquely(opaque);
  GetRootLayer()->SetColor(color);
}

void OffScreenRenderWidgetHostView::NotifyHostAndDelegateOnWasShown(
    blink::mojom::RecordContentToVisibleTimeRequestPtr) {
  NOTREACHED();
}

void OffScreenRenderWidgetHostView::RequestPresentationTimeFromHostOrDelegate(
    blink::mojom::RecordContentToVisibleTimeRequestPtr) {
  NOTREACHED();
}

void OffScreenRenderWidgetHostView::
    CancelPresentationTimeRequestForHostAndDelegate() {
  NOTREACHED();
}

}  // namespace electron
