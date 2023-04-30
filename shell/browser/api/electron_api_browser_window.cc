// Copyright (c) 2013 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/api/electron_api_browser_window.h"

#include "base/threading/thread_task_runner_handle.h"
#include "content/browser/renderer_host/render_widget_host_impl.h"  // nogncheck
#include "content/browser/renderer_host/render_widget_host_owner_delegate.h"  // nogncheck
#include "content/browser/web_contents/web_contents_impl.h"  // nogncheck
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/render_view_host.h"
#include "content/public/common/color_parser.h"
#include "shell/browser/api/electron_api_web_contents_view.h"
#include "shell/browser/browser.h"
#include "shell/browser/native_browser_view.h"
#include "shell/browser/web_contents_preferences.h"
#include "shell/browser/window_list.h"
#include "shell/common/color_util.h"
#include "shell/common/gin_helper/constructor.h"
#include "shell/common/gin_helper/dictionary.h"
#include "shell/common/gin_helper/object_template_builder.h"
#include "shell/common/node_includes.h"
#include "shell/common/options_switches.h"
#include "ui/gl/gpu_switching_manager.h"

#if defined(TOOLKIT_VIEWS)
#include "shell/browser/native_window_views.h"
#endif

#if BUILDFLAG(IS_WIN)
#include "shell/browser/ui/views/win_frame_view.h"
#endif

namespace electron::api {

BrowserWindow::BrowserWindow(gin::Arguments* args,
                             const gin_helper::Dictionary& options)
    : BaseWindow(args->isolate(), options) {
  // Use options.webPreferences in WebContents.
  v8::Isolate* isolate = args->isolate();
  gin_helper::Dictionary web_preferences =
      gin::Dictionary::CreateEmpty(isolate);
  options.Get(options::kWebPreferences, &web_preferences);

  bool transparent = false;
  options.Get(options::kTransparent, &transparent);

  std::string vibrancy_type;
#if BUILDFLAG(IS_MAC)
  options.Get(options::kVibrancyType, &vibrancy_type);
#endif

  // Copy the backgroundColor to webContents.
  std::string color;
  if (options.Get(options::kBackgroundColor, &color)) {
    web_preferences.SetHidden(options::kBackgroundColor, color);
  } else if (!vibrancy_type.empty() || transparent) {
    // If the BrowserWindow is transparent or a vibrancy type has been set,
    // also propagate transparency to the WebContents unless a separate
    // backgroundColor has been set.
    web_preferences.SetHidden(options::kBackgroundColor,
                              ToRGBAHex(SK_ColorTRANSPARENT));
  }

  // Copy the show setting to webContents, but only if we don't want to paint
  // when initially hidden
  bool paint_when_initially_hidden = true;
  options.Get("paintWhenInitiallyHidden", &paint_when_initially_hidden);
  if (!paint_when_initially_hidden) {
    bool show = true;
    options.Get(options::kShow, &show);
    web_preferences.Set(options::kShow, show);
  }

  bool titleBarOverlay = false;
  options.Get(options::ktitleBarOverlay, &titleBarOverlay);
  if (titleBarOverlay) {
    std::string enabled_features = "";
    if (web_preferences.Get(options::kEnableBlinkFeatures, &enabled_features)) {
      enabled_features += ",";
    }
    enabled_features += features::kWebAppWindowControlsOverlay.name;
    web_preferences.Set(options::kEnableBlinkFeatures, enabled_features);
  }

  // Copy the webContents option to webPreferences.
  v8::Local<v8::Value> value;
  if (options.Get("webContents", &value)) {
    web_preferences.SetHidden("webContents", value);
  }

  // Creates the WebContentsView.
  gin::Handle<WebContentsView> web_contents_view =
      WebContentsView::Create(isolate, web_preferences);
  DCHECK(web_contents_view.get());

  // Save a reference of the WebContents.
  gin::Handle<WebContents> web_contents =
      web_contents_view->GetWebContents(isolate);
  web_contents_.Reset(isolate, web_contents.ToV8());
  api_web_contents_ = web_contents->GetWeakPtr();
  api_web_contents_->AddObserver(this);
  Observe(api_web_contents_->web_contents());

  // Associate with BrowserWindow.
  web_contents->SetOwnerWindow(window());

  InitWithArgs(args);

  // Install the content view after BaseWindow's JS code is initialized.
  SetContentView(gin::CreateHandle<View>(isolate, web_contents_view.get()));

#if BUILDFLAG(IS_MAC)
  OverrideNSWindowContentView(
      web_contents->inspectable_web_contents()->GetView());
#endif

  // Init window after everything has been setup.
  window()->InitFromOptions(options);
}

BrowserWindow::~BrowserWindow() {
  if (api_web_contents_) {
    // Cleanup the observers if user destroyed this instance directly instead of
    // gracefully closing content::WebContents.
    api_web_contents_->RemoveObserver(this);
    // Destroy the WebContents.
    OnCloseContents();
  }
}

void BrowserWindow::BeforeUnloadDialogCancelled() {
  WindowList::WindowCloseCancelled(window());
  // Cancel unresponsive event when window close is cancelled.
  window_unresponsive_closure_.Cancel();
}

void BrowserWindow::OnRendererUnresponsive(content::RenderProcessHost*) {
  // Schedule the unresponsive shortly later, since we may receive the
  // responsive event soon. This could happen after the whole application had
  // blocked for a while.
  // Also notice that when closing this event would be ignored because we have
  // explicitly started a close timeout counter. This is on purpose because we
  // don't want the unresponsive event to be sent too early when user is closing
  // the window.
  ScheduleUnresponsiveEvent(50);
}

void BrowserWindow::WebContentsDestroyed() {
  api_web_contents_ = nullptr;
  CloseImmediately();
}

void BrowserWindow::OnCloseContents() {
  BaseWindow::ResetBrowserViews();
  api_web_contents_->Destroy();
}

void BrowserWindow::OnRendererResponsive(content::RenderProcessHost*) {
  window_unresponsive_closure_.Cancel();
  Emit("responsive");
}

void BrowserWindow::OnDraggableRegionsUpdated(
    const std::vector<mojom::DraggableRegionPtr>& regions) {
  UpdateDraggableRegions(regions);
}

void BrowserWindow::OnSetContentBounds(const gfx::Rect& rect) {
  // window.resizeTo(...)
  // window.moveTo(...)
  window()->SetBounds(rect, false);
}

void BrowserWindow::OnActivateContents() {
  // Hide the auto-hide menu when webContents is focused.
#if !BUILDFLAG(IS_MAC)
  if (IsMenuBarAutoHide() && IsMenuBarVisible())
    window()->SetMenuBarVisibility(false);
#endif
}

void BrowserWindow::OnPageTitleUpdated(const std::u16string& title,
                                       bool explicit_set) {
  // Change window title to page title.
  auto self = GetWeakPtr();
  if (!Emit("page-title-updated", title, explicit_set)) {
    // |this| might be deleted, or marked as destroyed by close().
    if (self && !IsDestroyed())
      SetTitle(base::UTF16ToUTF8(title));
  }
}

void BrowserWindow::RequestPreferredWidth(int* width) {
  *width = web_contents()->GetPreferredSize().width();
}

void BrowserWindow::OnCloseButtonClicked(bool* prevent_default) {
  // When user tries to close the window by clicking the close button, we do
  // not close the window immediately, instead we try to close the web page
  // first, and when the web page is closed the window will also be closed.
  *prevent_default = true;

  // Assume the window is not responding if it doesn't cancel the close and is
  // not closed in 5s, in this way we can quickly show the unresponsive
  // dialog when the window is busy executing some script without waiting for
  // the unresponsive timeout.
  if (window_unresponsive_closure_.IsCancelled())
    ScheduleUnresponsiveEvent(5000);

  // Already closed by renderer.
  if (!web_contents() || !api_web_contents_)
    return;

  // Required to make beforeunload handler work.
  api_web_contents_->NotifyUserActivation();

  // Trigger beforeunload events for associated BrowserViews.
  for (NativeBrowserView* view : window_->browser_views()) {
    auto* vwc = view->web_contents();
    auto* api_web_contents = api::WebContents::From(vwc);

    // Required to make beforeunload handler work.
    if (api_web_contents)
      api_web_contents->NotifyUserActivation();

    if (vwc) {
      if (vwc->NeedToFireBeforeUnloadOrUnloadEvents()) {
        vwc->DispatchBeforeUnload(false /* auto_cancel */);
      }
    }
  }

  if (web_contents()->NeedToFireBeforeUnloadOrUnloadEvents()) {
    web_contents()->DispatchBeforeUnload(false /* auto_cancel */);
  } else {
    web_contents()->Close();
  }
}

void BrowserWindow::OnWindowBlur() {
  if (api_web_contents_)
    web_contents()->StoreFocus();

  BaseWindow::OnWindowBlur();
}

void BrowserWindow::OnWindowFocus() {
  // focus/blur events might be emitted while closing window.
  if (api_web_contents_) {
    web_contents()->RestoreFocus();
#if !BUILDFLAG(IS_MAC)
    if (!api_web_contents_->IsDevToolsOpened())
      web_contents()->Focus();
#endif
  }

  BaseWindow::OnWindowFocus();
}

void BrowserWindow::OnWindowIsKeyChanged(bool is_key) {
#if BUILDFLAG(IS_MAC)
  auto* rwhv = web_contents()->GetRenderWidgetHostView();
  if (rwhv)
    rwhv->SetActive(is_key);
  window()->SetActive(is_key);
#endif
}

void BrowserWindow::OnWindowResize() {
#if BUILDFLAG(IS_MAC)
  if (!draggable_regions_.empty()) {
    UpdateDraggableRegions(draggable_regions_);
  } else {
    for (NativeBrowserView* view : window_->browser_views()) {
      view->UpdateDraggableRegions(view->GetDraggableRegions());
    }
  }
#endif
  BaseWindow::OnWindowResize();
}

void BrowserWindow::OnWindowLeaveFullScreen() {
#if BUILDFLAG(IS_MAC)
  if (web_contents()->IsFullscreen())
    web_contents()->ExitFullscreen(true);
#endif
  BaseWindow::OnWindowLeaveFullScreen();
}

void BrowserWindow::UpdateWindowControlsOverlay(
    const gfx::Rect& bounding_rect) {
  web_contents()->UpdateWindowControlsOverlay(bounding_rect);
}

void BrowserWindow::CloseImmediately() {
  // Close all child windows before closing current window.
  v8::HandleScope handle_scope(isolate());
  for (v8::Local<v8::Value> value : child_windows_.Values(isolate())) {
    gin::Handle<BrowserWindow> child;
    if (gin::ConvertFromV8(isolate(), value, &child) && !child.IsEmpty())
      child->window()->CloseImmediately();
  }

  BaseWindow::CloseImmediately();

  // Do not sent "unresponsive" event after window is closed.
  window_unresponsive_closure_.Cancel();
}

void BrowserWindow::Focus() {
  if (api_web_contents_->IsOffScreen())
    FocusOnWebView();
  else
    BaseWindow::Focus();
}

void BrowserWindow::Blur() {
  if (api_web_contents_->IsOffScreen())
    BlurWebView();
  else
    BaseWindow::Blur();
}

void BrowserWindow::SetBackgroundColor(const std::string& color_name) {
  BaseWindow::SetBackgroundColor(color_name);
  SkColor color = ParseCSSColor(color_name);
  web_contents()->SetPageBaseBackgroundColor(color);
  auto* rwhv = web_contents()->GetRenderWidgetHostView();
  if (rwhv) {
    rwhv->SetBackgroundColor(color);
    static_cast<content::RenderWidgetHostViewBase*>(rwhv)
        ->SetContentBackgroundColor(color);
  }
  // Also update the web preferences object otherwise the view will be reset on
  // the next load URL call
  if (api_web_contents_) {
    auto* web_preferences =
        WebContentsPreferences::From(api_web_contents_->web_contents());
    if (web_preferences) {
      web_preferences->SetBackgroundColor(ParseCSSColor(color_name));
    }
  }
}

void BrowserWindow::SetBrowserView(
    absl::optional<gin::Handle<BrowserView>> browser_view) {
  BaseWindow::ResetBrowserViews();
  if (browser_view)
    BaseWindow::AddBrowserView(*browser_view);
#if BUILDFLAG(IS_MAC)
  UpdateDraggableRegions(draggable_regions_);
#endif
}

void BrowserWindow::AddBrowserView(gin::Handle<BrowserView> browser_view) {
  BaseWindow::AddBrowserView(browser_view);
#if BUILDFLAG(IS_MAC)
  UpdateDraggableRegions(draggable_regions_);
#endif
}

void BrowserWindow::RemoveBrowserView(gin::Handle<BrowserView> browser_view) {
  BaseWindow::RemoveBrowserView(browser_view);
#if BUILDFLAG(IS_MAC)
  UpdateDraggableRegions(draggable_regions_);
#endif
}

void BrowserWindow::SetTopBrowserView(gin::Handle<BrowserView> browser_view,
                                      gin_helper::Arguments* args) {
  BaseWindow::SetTopBrowserView(browser_view, args);
#if BUILDFLAG(IS_MAC)
  UpdateDraggableRegions(draggable_regions_);
#endif
}

void BrowserWindow::ResetBrowserViews() {
  BaseWindow::ResetBrowserViews();
#if BUILDFLAG(IS_MAC)
  UpdateDraggableRegions(draggable_regions_);
#endif
}

void BrowserWindow::OnDevToolsResized() {
  UpdateDraggableRegions(draggable_regions_);
}

void BrowserWindow::FocusOnWebView() {
  web_contents()->GetRenderViewHost()->GetWidget()->Focus();
}

void BrowserWindow::BlurWebView() {
  web_contents()->GetRenderViewHost()->GetWidget()->Blur();
}

bool BrowserWindow::IsWebViewFocused() {
  auto* host_view = web_contents()->GetRenderViewHost()->GetWidget()->GetView();
  return host_view && host_view->HasFocus();
}

v8::Local<v8::Value> BrowserWindow::GetWebContents(v8::Isolate* isolate) {
  if (web_contents_.IsEmpty())
    return v8::Null(isolate);
  return v8::Local<v8::Value>::New(isolate, web_contents_);
}

#if BUILDFLAG(IS_WIN)
void BrowserWindow::SetTitleBarOverlay(const gin_helper::Dictionary& options,
                                       gin_helper::Arguments* args) {
  // Ensure WCO is already enabled on this window
  if (!window_->titlebar_overlay_enabled()) {
    args->ThrowError("Titlebar overlay is not enabled");
    return;
  }

  auto* window = static_cast<NativeWindowViews*>(window_.get());
  bool updated = false;

  // Check and update the button color
  std::string btn_color;
  if (options.Get(options::kOverlayButtonColor, &btn_color)) {
    // Parse the string as a CSS color
    SkColor color;
    if (!content::ParseCssColorString(btn_color, &color)) {
      args->ThrowError("Could not parse color as CSS color");
      return;
    }

    // Update the view
    window->set_overlay_button_color(color);
    updated = true;
  }

  // Check and update the symbol color
  std::string symbol_color;
  if (options.Get(options::kOverlaySymbolColor, &symbol_color)) {
    // Parse the string as a CSS color
    SkColor color;
    if (!content::ParseCssColorString(symbol_color, &color)) {
      args->ThrowError("Could not parse symbol color as CSS color");
      return;
    }

    // Update the view
    window->set_overlay_symbol_color(color);
    updated = true;
  }

  // Check and update the height
  int height = 0;
  if (options.Get(options::kOverlayHeight, &height)) {
    window->set_titlebar_overlay_height(height);
    updated = true;
  }

  // If anything was updated, invalidate the layout and schedule a paint of the
  // window's frame view
  if (updated) {
    auto* frame_view = static_cast<WinFrameView*>(
        window->widget()->non_client_view()->frame_view());
    frame_view->InvalidateCaptionButtons();
  }
}
#endif

void BrowserWindow::ScheduleUnresponsiveEvent(int ms) {
  if (!window_unresponsive_closure_.IsCancelled())
    return;

  window_unresponsive_closure_.Reset(base::BindRepeating(
      &BrowserWindow::NotifyWindowUnresponsive, GetWeakPtr()));
  base::ThreadTaskRunnerHandle::Get()->PostDelayedTask(
      FROM_HERE, window_unresponsive_closure_.callback(),
      base::Milliseconds(ms));
}

void BrowserWindow::NotifyWindowUnresponsive() {
  window_unresponsive_closure_.Cancel();
  if (!window_->IsClosed() && window_->IsEnabled()) {
    Emit("unresponsive");
  }
}

void BrowserWindow::OnWindowShow() {
  web_contents()->WasShown();
  BaseWindow::OnWindowShow();
}

void BrowserWindow::OnWindowHide() {
  web_contents()->WasOccluded();
  BaseWindow::OnWindowHide();
}

// static
gin_helper::WrappableBase* BrowserWindow::New(gin_helper::ErrorThrower thrower,
                                              gin::Arguments* args) {
  if (!Browser::Get()->is_ready()) {
    thrower.ThrowError("Cannot create BrowserWindow before app is ready");
    return nullptr;
  }

  if (args->Length() > 1) {
    args->ThrowError();
    return nullptr;
  }

  gin_helper::Dictionary options;
  if (!(args->Length() == 1 && args->GetNext(&options))) {
    options = gin::Dictionary::CreateEmpty(args->isolate());
  }

  return new BrowserWindow(args, options);
}

// static
void BrowserWindow::BuildPrototype(v8::Isolate* isolate,
                                   v8::Local<v8::FunctionTemplate> prototype) {
  prototype->SetClassName(gin::StringToV8(isolate, "BrowserWindow"));
  gin_helper::ObjectTemplateBuilder(isolate, prototype->PrototypeTemplate())
      .SetMethod("focusOnWebView", &BrowserWindow::FocusOnWebView)
      .SetMethod("blurWebView", &BrowserWindow::BlurWebView)
      .SetMethod("isWebViewFocused", &BrowserWindow::IsWebViewFocused)
#if BUILDFLAG(IS_WIN)
      .SetMethod("setTitleBarOverlay", &BrowserWindow::SetTitleBarOverlay)
#endif
      .SetProperty("webContents", &BrowserWindow::GetWebContents);
}

// static
v8::Local<v8::Value> BrowserWindow::From(v8::Isolate* isolate,
                                         NativeWindow* native_window) {
  auto* existing = TrackableObject::FromWrappedClass(isolate, native_window);
  if (existing)
    return existing->GetWrapper();
  else
    return v8::Null(isolate);
}

}  // namespace electron::api

namespace {

using electron::api::BrowserWindow;

void Initialize(v8::Local<v8::Object> exports,
                v8::Local<v8::Value> unused,
                v8::Local<v8::Context> context,
                void* priv) {
  v8::Isolate* isolate = context->GetIsolate();
  gin_helper::Dictionary dict(isolate, exports);
  dict.Set("BrowserWindow",
           gin_helper::CreateConstructor<BrowserWindow>(
               isolate, base::BindRepeating(&BrowserWindow::New)));
}

}  // namespace

NODE_LINKED_MODULE_CONTEXT_AWARE(electron_browser_window, Initialize)
