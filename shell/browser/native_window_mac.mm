// Copyright (c) 2013 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/native_window_mac.h"

#include <AvailabilityMacros.h>
#include <objc/objc-runtime.h>

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "base/cxx17_backports.h"
#include "base/mac/mac_util.h"
#include "base/mac/scoped_cftyperef.h"
#include "base/strings/sys_string_conversions.h"
#include "components/remote_cocoa/app_shim/native_widget_ns_window_bridge.h"
#include "components/remote_cocoa/browser/scoped_cg_window_id.h"
#include "content/public/browser/browser_accessibility_state.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/desktop_media_id.h"
#include "shell/browser/browser.h"
#include "shell/browser/javascript_environment.h"
#include "shell/browser/native_browser_view_mac.h"
#include "shell/browser/ui/cocoa/electron_native_widget_mac.h"
#include "shell/browser/ui/cocoa/electron_ns_window.h"
#include "shell/browser/ui/cocoa/electron_ns_window_delegate.h"
#include "shell/browser/ui/cocoa/electron_preview_item.h"
#include "shell/browser/ui/cocoa/electron_touch_bar.h"
#include "shell/browser/ui/cocoa/root_view_mac.h"
#include "shell/browser/ui/cocoa/window_buttons_proxy.h"
#include "shell/browser/ui/inspectable_web_contents.h"
#include "shell/browser/ui/inspectable_web_contents_view.h"
#include "shell/browser/window_list.h"
#include "shell/common/gin_converters/gfx_converter.h"
#include "shell/common/gin_helper/dictionary.h"
#include "shell/common/node_includes.h"
#include "shell/common/options_switches.h"
#include "shell/common/process_util.h"
#include "skia/ext/skia_utils_mac.h"
#include "third_party/webrtc/modules/desktop_capture/mac/window_list_utils.h"
#include "ui/display/screen.h"
#include "ui/gfx/skia_util.h"
#include "ui/gl/gpu_switching_manager.h"
#include "ui/views/background.h"
#include "ui/views/cocoa/native_widget_mac_ns_window_host.h"
#include "ui/views/widget/widget.h"

// This view would inform Chromium to resize the hosted views::View.
//
// The overridden methods should behave the same with BridgedContentView.
@interface ElectronAdaptedContentView : NSView {
 @private
  views::NativeWidgetMacNSWindowHost* bridge_host_;
}
@end

@implementation ElectronAdaptedContentView

- (id)initWithShell:(electron::NativeWindowMac*)shell {
  if ((self = [self init])) {
    bridge_host_ = views::NativeWidgetMacNSWindowHost::GetFromNativeWindow(
        shell->GetNativeWindow());
  }
  return self;
}

- (void)viewDidMoveToWindow {
  // When this view is added to a window, AppKit calls setFrameSize before it is
  // added to the window, so the behavior in setFrameSize is not triggered.
  NSWindow* window = [self window];
  if (window)
    [self setFrameSize:NSZeroSize];
}

- (void)setFrameSize:(NSSize)newSize {
  // The size passed in here does not always use
  // -[NSWindow contentRectForFrameRect]. The following ensures that the
  // contentView for a frameless window can extend over the titlebar of the new
  // window containing it, since AppKit requires a titlebar to give frameless
  // windows correct shadows and rounded corners.
  NSWindow* window = [self window];
  if (window && [window contentView] == self) {
    newSize = [window contentRectForFrameRect:[window frame]].size;
    // Ensure that the window geometry be updated on the host side before the
    // view size is updated.
    bridge_host_->GetInProcessNSWindowBridge()->UpdateWindowGeometry();
  }

  [super setFrameSize:newSize];

  // The OnViewSizeChanged is marked private in derived class.
  static_cast<remote_cocoa::mojom::NativeWidgetNSWindowHost*>(bridge_host_)
      ->OnViewSizeChanged(gfx::Size(newSize.width, newSize.height));
}

@end

// This view always takes the size of its superview. It is intended to be used
// as a NSWindow's contentView.  It is needed because NSWindow's implementation
// explicitly resizes the contentView at inopportune times.
@interface FullSizeContentView : NSView
@end

@implementation FullSizeContentView

// This method is directly called by NSWindow during a window resize on OSX
// 10.10.0, beta 2. We must override it to prevent the content view from
// shrinking.
- (void)setFrameSize:(NSSize)size {
  if ([self superview])
    size = [[self superview] bounds].size;
  [super setFrameSize:size];
}

// The contentView gets moved around during certain full-screen operations.
// This is less than ideal, and should eventually be removed.
- (void)viewDidMoveToSuperview {
  [self setFrame:[[self superview] bounds]];
}

@end

@interface ElectronProgressBar : NSProgressIndicator
@end

@implementation ElectronProgressBar

- (void)drawRect:(NSRect)dirtyRect {
  if (self.style != NSProgressIndicatorBarStyle)
    return;
  // Draw edges of rounded rect.
  NSRect rect = NSInsetRect([self bounds], 1.0, 1.0);
  CGFloat radius = rect.size.height / 2;
  NSBezierPath* bezier_path = [NSBezierPath bezierPathWithRoundedRect:rect
                                                              xRadius:radius
                                                              yRadius:radius];
  [bezier_path setLineWidth:2.0];
  [[NSColor grayColor] set];
  [bezier_path stroke];

  // Fill the rounded rect.
  rect = NSInsetRect(rect, 2.0, 2.0);
  radius = rect.size.height / 2;
  bezier_path = [NSBezierPath bezierPathWithRoundedRect:rect
                                                xRadius:radius
                                                yRadius:radius];
  [bezier_path setLineWidth:1.0];
  [bezier_path addClip];

  // Calculate the progress width.
  rect.size.width =
      floor(rect.size.width * ([self doubleValue] / [self maxValue]));

  // Fill the progress bar with color blue.
  [[NSColor colorWithSRGBRed:0.2 green:0.6 blue:1 alpha:1] set];
  NSRectFill(rect);
}

@end

namespace gin {

template <>
struct Converter<electron::NativeWindowMac::VisualEffectState> {
  static bool FromV8(v8::Isolate* isolate,
                     v8::Handle<v8::Value> val,
                     electron::NativeWindowMac::VisualEffectState* out) {
    using VisualEffectState = electron::NativeWindowMac::VisualEffectState;
    std::string visual_effect_state;
    if (!ConvertFromV8(isolate, val, &visual_effect_state))
      return false;
    if (visual_effect_state == "followWindow") {
      *out = VisualEffectState::kFollowWindow;
    } else if (visual_effect_state == "active") {
      *out = VisualEffectState::kActive;
    } else if (visual_effect_state == "inactive") {
      *out = VisualEffectState::kInactive;
    } else {
      return false;
    }
    return true;
  }
};

}  // namespace gin

namespace electron {

namespace {

bool IsFramelessWindow(NSView* view) {
  NSWindow* nswindow = [view window];
  if (![nswindow respondsToSelector:@selector(shell)])
    return false;
  NativeWindow* window = [static_cast<ElectronNSWindow*>(nswindow) shell];
  return window && !window->has_frame();
}

IMP original_set_frame_size = nullptr;
IMP original_view_did_move_to_superview = nullptr;

// This method is directly called by NSWindow during a window resize on OSX
// 10.10.0, beta 2. We must override it to prevent the content view from
// shrinking.
void SetFrameSize(NSView* self, SEL _cmd, NSSize size) {
  if (!IsFramelessWindow(self)) {
    auto original =
        reinterpret_cast<decltype(&SetFrameSize)>(original_set_frame_size);
    return original(self, _cmd, size);
  }
  // For frameless window, resize the view to cover full window.
  if ([self superview])
    size = [[self superview] bounds].size;
  auto super_impl = reinterpret_cast<decltype(&SetFrameSize)>(
      [[self superclass] instanceMethodForSelector:_cmd]);
  super_impl(self, _cmd, size);
}

// The contentView gets moved around during certain full-screen operations.
// This is less than ideal, and should eventually be removed.
void ViewDidMoveToSuperview(NSView* self, SEL _cmd) {
  if (!IsFramelessWindow(self)) {
    // [BridgedContentView viewDidMoveToSuperview];
    auto original = reinterpret_cast<decltype(&ViewDidMoveToSuperview)>(
        original_view_did_move_to_superview);
    if (original)
      original(self, _cmd);
    return;
  }
  [self setFrame:[[self superview] bounds]];
}

}  // namespace

NativeWindowMac::NativeWindowMac(const gin_helper::Dictionary& options,
                                 NativeWindow* parent)
    : NativeWindow(options, parent), root_view_(new RootViewMac(this)) {
  ui::NativeTheme::GetInstanceForNativeUi()->AddObserver(this);
  display::Screen::GetScreen()->AddObserver(this);

  int width = 800, height = 600;
  options.Get(options::kWidth, &width);
  options.Get(options::kHeight, &height);

  NSRect main_screen_rect = [[[NSScreen screens] firstObject] frame];
  gfx::Rect bounds(round((NSWidth(main_screen_rect) - width) / 2),
                   round((NSHeight(main_screen_rect) - height) / 2), width,
                   height);

  bool resizable = true;
  options.Get(options::kResizable, &resizable);
  options.Get(options::kZoomToPageWidth, &zoom_to_page_width_);
  options.Get(options::kSimpleFullScreen, &always_simple_fullscreen_);
  options.GetOptional(options::kTrafficLightPosition, &traffic_light_position_);
  options.Get(options::kVisualEffectState, &visual_effect_state_);

  if (options.Has(options::kFullscreenWindowTitle)) {
    EmitWarning(
        node::Environment::GetCurrent(JavascriptEnvironment::GetIsolate()),
        "\"fullscreenWindowTitle\" option has been deprecated and is "
        "no-op now.",
        "electron");
  }

  bool minimizable = true;
  options.Get(options::kMinimizable, &minimizable);

  bool maximizable = true;
  options.Get(options::kMaximizable, &maximizable);

  bool closable = true;
  options.Get(options::kClosable, &closable);

  std::string tabbingIdentifier;
  options.Get(options::kTabbingIdentifier, &tabbingIdentifier);

  std::string windowType;
  options.Get(options::kType, &windowType);

  bool hiddenInMissionControl = false;
  options.Get(options::kHiddenInMissionControl, &hiddenInMissionControl);

  bool useStandardWindow = true;
  // eventually deprecate separate "standardWindow" option in favor of
  // standard / textured window types
  options.Get(options::kStandardWindow, &useStandardWindow);
  if (windowType == "textured") {
    useStandardWindow = false;
  }

  // The window without titlebar is treated the same with frameless window.
  if (title_bar_style_ != TitleBarStyle::kNormal)
    set_has_frame(false);

  NSUInteger styleMask = NSWindowStyleMaskTitled;

  // Removing NSWindowStyleMaskTitled removes window title, which removes
  // rounded corners of window.
  bool rounded_corner = true;
  options.Get(options::kRoundedCorners, &rounded_corner);
  if (!rounded_corner && !has_frame())
    styleMask = NSWindowStyleMaskBorderless;

  if (minimizable)
    styleMask |= NSWindowStyleMaskMiniaturizable;
  if (closable)
    styleMask |= NSWindowStyleMaskClosable;
  if (resizable)
    styleMask |= NSWindowStyleMaskResizable;
  if (!useStandardWindow || transparent() || !has_frame())
    styleMask |= NSWindowStyleMaskTexturedBackground;

  // Create views::Widget and assign window_ with it.
  // TODO(zcbenz): Get rid of the window_ in future.
  views::Widget::InitParams params;
  params.ownership = views::Widget::InitParams::WIDGET_OWNS_NATIVE_WIDGET;
  params.bounds = bounds;
  params.delegate = this;
  params.type = views::Widget::InitParams::TYPE_WINDOW;
  params.native_widget =
      new ElectronNativeWidgetMac(this, windowType, styleMask, widget());
  widget()->Init(std::move(params));
  SetCanResize(resizable);
  window_ = static_cast<ElectronNSWindow*>(
      widget()->GetNativeWindow().GetNativeNSWindow());

  RegisterDeleteDelegateCallback(base::BindOnce(
      [](NativeWindowMac* window) {
        if (window->window_)
          window->window_ = nil;
        if (window->buttons_proxy_)
          window->buttons_proxy_.reset();
      },
      this));

  [window_ setEnableLargerThanScreen:enable_larger_than_screen()];

  window_delegate_.reset([[ElectronNSWindowDelegate alloc] initWithShell:this]);
  [window_ setDelegate:window_delegate_];

  // Only use native parent window for non-modal windows.
  if (parent && !is_modal()) {
    SetParentWindow(parent);
  }

  if (transparent()) {
    // Setting the background color to clear will also hide the shadow.
    [window_ setBackgroundColor:[NSColor clearColor]];
  }

  if (windowType == "desktop") {
    [window_ setLevel:kCGDesktopWindowLevel - 1];
    [window_ setDisableKeyOrMainWindow:YES];
    [window_ setCollectionBehavior:(NSWindowCollectionBehaviorCanJoinAllSpaces |
                                    NSWindowCollectionBehaviorStationary |
                                    NSWindowCollectionBehaviorIgnoresCycle)];
  }

  if (windowType == "panel") {
    [window_ setLevel:NSFloatingWindowLevel];
  }

  bool focusable;
  if (options.Get(options::kFocusable, &focusable) && !focusable)
    [window_ setDisableKeyOrMainWindow:YES];

  if (transparent() || !has_frame()) {
    // Don't show title bar.
    [window_ setTitlebarAppearsTransparent:YES];
    [window_ setTitleVisibility:NSWindowTitleHidden];
    // Remove non-transparent corners, see
    // https://github.com/electron/electron/issues/517.
    [window_ setOpaque:NO];
    // Show window buttons if titleBarStyle is not "normal".
    if (title_bar_style_ == TitleBarStyle::kNormal) {
      InternalSetWindowButtonVisibility(false);
    } else {
      buttons_proxy_.reset([[WindowButtonsProxy alloc] initWithWindow:window_]);
      [buttons_proxy_ setHeight:titlebar_overlay_height()];
      if (traffic_light_position_) {
        [buttons_proxy_ setMargin:*traffic_light_position_];
      } else if (title_bar_style_ == TitleBarStyle::kHiddenInset) {
        // For macOS >= 11, while this value does not match official macOS apps
        // like Safari or Notes, it matches titleBarStyle's old implementation
        // before Electron <= 12.
        [buttons_proxy_ setMargin:gfx::Point(12, 11)];
      }
      if (title_bar_style_ == TitleBarStyle::kCustomButtonsOnHover) {
        [buttons_proxy_ setShowOnHover:YES];
      } else {
        // customButtonsOnHover does not show buttons initially.
        InternalSetWindowButtonVisibility(true);
      }
    }
  }

  // Create a tab only if tabbing identifier is specified and window has
  // a native title bar.
  if (tabbingIdentifier.empty() || transparent() || !has_frame()) {
    [window_ setTabbingMode:NSWindowTabbingModeDisallowed];
  } else {
    [window_ setTabbingIdentifier:base::SysUTF8ToNSString(tabbingIdentifier)];
  }

  // Resize to content bounds.
  bool use_content_size = false;
  options.Get(options::kUseContentSize, &use_content_size);
  if (!has_frame() || use_content_size)
    SetContentSize(gfx::Size(width, height));

  // Enable the NSView to accept first mouse event.
  bool acceptsFirstMouse = false;
  options.Get(options::kAcceptFirstMouse, &acceptsFirstMouse);
  [window_ setAcceptsFirstMouse:acceptsFirstMouse];

  // Disable auto-hiding cursor.
  bool disableAutoHideCursor = false;
  options.Get(options::kDisableAutoHideCursor, &disableAutoHideCursor);
  [window_ setDisableAutoHideCursor:disableAutoHideCursor];

  SetHiddenInMissionControl(hiddenInMissionControl);

  // Set maximizable state last to ensure zoom button does not get reset
  // by calls to other APIs.
  SetMaximizable(maximizable);

  // Default content view.
  SetContentView(new views::View());
  AddContentViewLayers();

  UpdateWindowOriginalFrame();
  original_level_ = [window_ level];
}

NativeWindowMac::~NativeWindowMac() = default;

void NativeWindowMac::SetContentView(views::View* view) {
  views::View* root_view = GetContentsView();
  if (content_view())
    root_view->RemoveChildView(content_view());

  set_content_view(view);
  root_view->AddChildView(content_view());

  root_view->Layout();
}

void NativeWindowMac::Close() {
  if (!IsClosable()) {
    WindowList::WindowCloseCancelled(this);
    return;
  }

  if (fullscreen_transition_state() != FullScreenTransitionState::NONE) {
    SetHasDeferredWindowClose(true);
    return;
  }

  // If a sheet is attached to the window when we call
  // [window_ performClose:nil], the window won't close properly
  // even after the user has ended the sheet.
  // Ensure it's closed before calling [window_ performClose:nil].
  if ([window_ attachedSheet])
    [window_ endSheet:[window_ attachedSheet]];

  [window_ performClose:nil];

  // Closing a sheet doesn't trigger windowShouldClose,
  // so we need to manually call it ourselves here.
  if (is_modal() && parent() && IsVisible()) {
    NotifyWindowCloseButtonClicked();
  }
}

void NativeWindowMac::CloseImmediately() {
  // Retain the child window before closing it. If the last reference to the
  // NSWindow goes away inside -[NSWindow close], then bad stuff can happen.
  // See e.g. http://crbug.com/616701.
  base::scoped_nsobject<NSWindow> child_window(window_,
                                               base::scoped_policy::RETAIN);
  [window_ close];
}

void NativeWindowMac::Focus(bool focus) {
  if (!IsVisible())
    return;

  if (focus) {
    [[NSApplication sharedApplication] activateIgnoringOtherApps:NO];
    [window_ makeKeyAndOrderFront:nil];
  } else {
    [window_ orderOut:nil];
    [window_ orderBack:nil];
  }
}

bool NativeWindowMac::IsFocused() {
  return [window_ isKeyWindow];
}

void NativeWindowMac::Show() {
  if (is_modal() && parent()) {
    NSWindow* window = parent()->GetNativeWindow().GetNativeNSWindow();
    if ([window_ sheetParent] == nil)
      [window beginSheet:window_
          completionHandler:^(NSModalResponse){
          }];
    return;
  }

  // Reattach the window to the parent to actually show it.
  if (parent())
    InternalSetParentWindow(parent(), true);

  // This method is supposed to put focus on window, however if the app does not
  // have focus then "makeKeyAndOrderFront" will only show the window.
  [NSApp activateIgnoringOtherApps:YES];

  [window_ makeKeyAndOrderFront:nil];
}

void NativeWindowMac::ShowInactive() {
  // Reattach the window to the parent to actually show it.
  if (parent())
    InternalSetParentWindow(parent(), true);

  [window_ orderFrontRegardless];
}

void NativeWindowMac::Hide() {
  // If a sheet is attached to the window when we call [window_ orderOut:nil],
  // the sheet won't be able to show again on the same window.
  // Ensure it's closed before calling [window_ orderOut:nil].
  if ([window_ attachedSheet])
    [window_ endSheet:[window_ attachedSheet]];

  if (is_modal() && parent()) {
    [window_ orderOut:nil];
    [parent()->GetNativeWindow().GetNativeNSWindow() endSheet:window_];
    return;
  }

  // Hide all children of the current window before hiding the window.
  // components/remote_cocoa/app_shim/native_widget_ns_window_bridge.mm
  // expects this when window visibility changes.
  if ([window_ childWindows]) {
    for (NSWindow* child in [window_ childWindows]) {
      [child orderOut:nil];
    }
  }

  // Detach the window from the parent before.
  if (parent())
    InternalSetParentWindow(parent(), false);

  [window_ orderOut:nil];
}

bool NativeWindowMac::IsVisible() {
  bool occluded = [window_ occlusionState] == NSWindowOcclusionStateVisible;

  // For a window to be visible, it must be visible to the user in the
  // foreground of the app, which means that it should not be minimized or
  // occluded
  return [window_ isVisible] && !occluded && !IsMinimized();
}

bool NativeWindowMac::IsEnabled() {
  return [window_ attachedSheet] == nil;
}

void NativeWindowMac::SetEnabled(bool enable) {
  if (!enable) {
    NSRect frame = [window_ frame];
    NSWindow* window =
        [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, frame.size.width,
                                                         frame.size.height)
                                    styleMask:NSWindowStyleMaskTitled
                                      backing:NSBackingStoreBuffered
                                        defer:NO];
    [window setAlphaValue:0.5];

    [window_ beginSheet:window
        completionHandler:^(NSModalResponse returnCode) {
          NSLog(@"main window disabled");
          return;
        }];
  } else if ([window_ attachedSheet]) {
    [window_ endSheet:[window_ attachedSheet]];
  }
}

void NativeWindowMac::Maximize() {
  const bool is_visible = [window_ isVisible];

  if (IsMaximized()) {
    if (!is_visible)
      ShowInactive();
    return;
  }

  // Take note of the current window size
  if (IsNormal())
    UpdateWindowOriginalFrame();
  [window_ zoom:nil];

  if (!is_visible) {
    ShowInactive();
    NotifyWindowMaximize();
  }
}

void NativeWindowMac::Unmaximize() {
  // Bail if the last user set bounds were the same size as the window
  // screen (e.g. the user set the window to maximized via setBounds)
  //
  // Per docs during zoom:
  // > If there’s no saved user state because there has been no previous
  // > zoom,the size and location of the window don’t change.
  //
  // However, in classic Apple fashion, this is not the case in practice,
  // and the frame inexplicably becomes very tiny. We should prevent
  // zoom from being called if the window is being unmaximized and its
  // unmaximized window bounds are themselves functionally maximized.
  if (!IsMaximized() || user_set_bounds_maximized_)
    return;

  [window_ zoom:nil];
}

bool NativeWindowMac::IsMaximized() {
  if (HasStyleMask(NSWindowStyleMaskResizable) != 0)
    return [window_ isZoomed];

  NSRect rectScreen = GetAspectRatio() > 0.0
                          ? default_frame_for_zoom()
                          : [[NSScreen mainScreen] visibleFrame];

  return NSEqualRects([window_ frame], rectScreen);
}

void NativeWindowMac::Minimize() {
  if (IsMinimized())
    return;

  // Take note of the current window size
  if (IsNormal())
    UpdateWindowOriginalFrame();
  [window_ miniaturize:nil];
}

void NativeWindowMac::Restore() {
  [window_ deminiaturize:nil];
}

bool NativeWindowMac::IsMinimized() {
  return [window_ isMiniaturized];
}

bool NativeWindowMac::HandleDeferredClose() {
  if (has_deferred_window_close_) {
    SetHasDeferredWindowClose(false);
    Close();
    return true;
  }
  return false;
}

void NativeWindowMac::SetFullScreen(bool fullscreen) {
  if (!has_frame() && !HasStyleMask(NSWindowStyleMaskTitled))
    return;

  // [NSWindow -toggleFullScreen] is an asynchronous operation, which means
  // that it's possible to call it while a fullscreen transition is currently
  // in process. This can create weird behavior (incl. phantom windows),
  // so we want to schedule a transition for when the current one has completed.
  if (fullscreen_transition_state() != FullScreenTransitionState::NONE) {
    if (!pending_transitions_.empty()) {
      bool last_pending = pending_transitions_.back();
      // Only push new transitions if they're different than the last transition
      // in the queue.
      if (last_pending != fullscreen)
        pending_transitions_.push(fullscreen);
    } else {
      pending_transitions_.push(fullscreen);
    }
    return;
  }

  if (fullscreen == IsFullscreen())
    return;

  // Take note of the current window size
  if (IsNormal())
    UpdateWindowOriginalFrame();

  // This needs to be set here because it can be the case that
  // SetFullScreen is called by a user before windowWillEnterFullScreen
  // or windowWillExitFullScreen are invoked, and so a potential transition
  // could be dropped.
  fullscreen_transition_state_ = fullscreen
                                     ? FullScreenTransitionState::ENTERING
                                     : FullScreenTransitionState::EXITING;

  [window_ toggleFullScreenMode:nil];
}

bool NativeWindowMac::IsFullscreen() const {
  return HasStyleMask(NSWindowStyleMaskFullScreen);
}

void NativeWindowMac::SetBounds(const gfx::Rect& bounds, bool animate) {
  // Do nothing if in fullscreen mode.
  if (IsFullscreen())
    return;

  // Check size constraints since setFrame does not check it.
  gfx::Size size = bounds.size();
  size.SetToMax(GetMinimumSize());
  gfx::Size max_size = GetMaximumSize();
  if (!max_size.IsEmpty())
    size.SetToMin(max_size);

  NSRect cocoa_bounds = NSMakeRect(bounds.x(), 0, size.width(), size.height());
  // Flip coordinates based on the primary screen.
  NSScreen* screen = [[NSScreen screens] firstObject];
  cocoa_bounds.origin.y = NSHeight([screen frame]) - size.height() - bounds.y();

  [window_ setFrame:cocoa_bounds display:YES animate:animate];
  user_set_bounds_maximized_ = IsMaximized() ? true : false;
  UpdateWindowOriginalFrame();
}

gfx::Rect NativeWindowMac::GetBounds() {
  NSRect frame = [window_ frame];
  gfx::Rect bounds(frame.origin.x, 0, NSWidth(frame), NSHeight(frame));
  NSScreen* screen = [[NSScreen screens] firstObject];
  bounds.set_y(NSHeight([screen frame]) - NSMaxY(frame));
  return bounds;
}

bool NativeWindowMac::IsNormal() {
  return NativeWindow::IsNormal() && !IsSimpleFullScreen();
}

gfx::Rect NativeWindowMac::GetNormalBounds() {
  if (IsNormal()) {
    return GetBounds();
  }
  NSRect frame = original_frame_;
  gfx::Rect bounds(frame.origin.x, 0, NSWidth(frame), NSHeight(frame));
  NSScreen* screen = [[NSScreen screens] firstObject];
  bounds.set_y(NSHeight([screen frame]) - NSMaxY(frame));
  return bounds;
  // Works on OS_WIN !
  // return widget()->GetRestoredBounds();
}

void NativeWindowMac::SetContentSizeConstraints(
    const extensions::SizeConstraints& size_constraints) {
  auto convertSize = [this](const gfx::Size& size) {
    // Our frameless window still has titlebar attached, so setting contentSize
    // will result in actual content size being larger.
    if (!has_frame()) {
      NSRect frame = NSMakeRect(0, 0, size.width(), size.height());
      NSRect content = [window_ originalContentRectForFrameRect:frame];
      return content.size;
    } else {
      return NSMakeSize(size.width(), size.height());
    }
  };

  NSView* content = [window_ contentView];
  if (size_constraints.HasMinimumSize()) {
    NSSize min_size = convertSize(size_constraints.GetMinimumSize());
    [window_ setContentMinSize:[content convertSize:min_size toView:nil]];
  }
  if (size_constraints.HasMaximumSize()) {
    NSSize max_size = convertSize(size_constraints.GetMaximumSize());
    [window_ setContentMaxSize:[content convertSize:max_size toView:nil]];
  }
  NativeWindow::SetContentSizeConstraints(size_constraints);
}

bool NativeWindowMac::MoveAbove(const std::string& sourceId) {
  const content::DesktopMediaID id = content::DesktopMediaID::Parse(sourceId);
  if (id.type != content::DesktopMediaID::TYPE_WINDOW)
    return false;

  // Check if the window source is valid.
  const CGWindowID window_id = id.id;
  if (!webrtc::GetWindowOwnerPid(window_id))
    return false;

  [window_ orderWindow:NSWindowAbove relativeTo:id.id];

  return true;
}

void NativeWindowMac::MoveTop() {
  [window_ orderWindow:NSWindowAbove relativeTo:0];
}

void NativeWindowMac::SetResizable(bool resizable) {
  ScopedDisableResize disable_resize;
  SetStyleMask(resizable, NSWindowStyleMaskResizable);
  SetCanResize(resizable);
}

bool NativeWindowMac::IsResizable() {
  bool in_fs_transition =
      fullscreen_transition_state() != FullScreenTransitionState::NONE;
  bool has_rs_mask = HasStyleMask(NSWindowStyleMaskResizable);
  return has_rs_mask && !IsFullscreen() && !in_fs_transition;
}

void NativeWindowMac::SetMovable(bool movable) {
  [window_ setMovable:movable];
}

bool NativeWindowMac::IsMovable() {
  return [window_ isMovable];
}

void NativeWindowMac::SetMinimizable(bool minimizable) {
  SetStyleMask(minimizable, NSWindowStyleMaskMiniaturizable);
}

bool NativeWindowMac::IsMinimizable() {
  return HasStyleMask(NSWindowStyleMaskMiniaturizable);
}

void NativeWindowMac::SetMaximizable(bool maximizable) {
  maximizable_ = maximizable;
  [[window_ standardWindowButton:NSWindowZoomButton] setEnabled:maximizable];
}

bool NativeWindowMac::IsMaximizable() {
  return [[window_ standardWindowButton:NSWindowZoomButton] isEnabled];
}

void NativeWindowMac::SetFullScreenable(bool fullscreenable) {
  SetCollectionBehavior(fullscreenable,
                        NSWindowCollectionBehaviorFullScreenPrimary);
  // On EL Capitan this flag is required to hide fullscreen button.
  SetCollectionBehavior(!fullscreenable,
                        NSWindowCollectionBehaviorFullScreenAuxiliary);
}

bool NativeWindowMac::IsFullScreenable() {
  NSUInteger collectionBehavior = [window_ collectionBehavior];
  return collectionBehavior & NSWindowCollectionBehaviorFullScreenPrimary;
}

void NativeWindowMac::SetClosable(bool closable) {
  SetStyleMask(closable, NSWindowStyleMaskClosable);
}

bool NativeWindowMac::IsClosable() {
  return HasStyleMask(NSWindowStyleMaskClosable);
}

void NativeWindowMac::SetAlwaysOnTop(ui::ZOrderLevel z_order,
                                     const std::string& level_name,
                                     int relative_level) {
  if (z_order == ui::ZOrderLevel::kNormal) {
    SetWindowLevel(NSNormalWindowLevel);
    return;
  }

  int level = NSNormalWindowLevel;
  if (level_name == "floating") {
    level = NSFloatingWindowLevel;
  } else if (level_name == "torn-off-menu") {
    level = NSTornOffMenuWindowLevel;
  } else if (level_name == "modal-panel") {
    level = NSModalPanelWindowLevel;
  } else if (level_name == "main-menu") {
    level = NSMainMenuWindowLevel;
  } else if (level_name == "status") {
    level = NSStatusWindowLevel;
  } else if (level_name == "pop-up-menu") {
    level = NSPopUpMenuWindowLevel;
  } else if (level_name == "screen-saver") {
    level = NSScreenSaverWindowLevel;
  }

  SetWindowLevel(level + relative_level);
}

std::string NativeWindowMac::GetAlwaysOnTopLevel() {
  std::string level_name = "normal";

  int level = [window_ level];
  if (level == NSFloatingWindowLevel) {
    level_name = "floating";
  } else if (level == NSTornOffMenuWindowLevel) {
    level_name = "torn-off-menu";
  } else if (level == NSModalPanelWindowLevel) {
    level_name = "modal-panel";
  } else if (level == NSMainMenuWindowLevel) {
    level_name = "main-menu";
  } else if (level == NSStatusWindowLevel) {
    level_name = "status";
  } else if (level == NSPopUpMenuWindowLevel) {
    level_name = "pop-up-menu";
  } else if (level == NSScreenSaverWindowLevel) {
    level_name = "screen-saver";
  }

  return level_name;
}

void NativeWindowMac::SetWindowLevel(int unbounded_level) {
  int level = std::min(
      std::max(unbounded_level, CGWindowLevelForKey(kCGMinimumWindowLevelKey)),
      CGWindowLevelForKey(kCGMaximumWindowLevelKey));
  ui::ZOrderLevel z_order_level = level == NSNormalWindowLevel
                                      ? ui::ZOrderLevel::kNormal
                                      : ui::ZOrderLevel::kFloatingWindow;
  bool did_z_order_level_change = z_order_level != GetZOrderLevel();

  was_maximizable_ = IsMaximizable();

  // We need to explicitly keep the NativeWidget up to date, since it stores the
  // window level in a local variable, rather than reading it from the NSWindow.
  // Unfortunately, it results in a second setLevel call. It's not ideal, but we
  // don't expect this to cause any user-visible jank.
  widget()->SetZOrderLevel(z_order_level);
  [window_ setLevel:level];

  // Set level will make the zoom button revert to default, probably
  // a bug of Cocoa or macOS.
  SetMaximizable(was_maximizable_);

  // This must be notified at the very end or IsAlwaysOnTop
  // will not yet have been updated to reflect the new status
  if (did_z_order_level_change)
    NativeWindow::NotifyWindowAlwaysOnTopChanged();
}

ui::ZOrderLevel NativeWindowMac::GetZOrderLevel() {
  return widget()->GetZOrderLevel();
}

void NativeWindowMac::Center() {
  [window_ center];
}

void NativeWindowMac::Invalidate() {
  [window_ flushWindow];
  [[window_ contentView] setNeedsDisplay:YES];
}

void NativeWindowMac::SetTitle(const std::string& title) {
  [window_ setTitle:base::SysUTF8ToNSString(title)];
  if (buttons_proxy_)
    [buttons_proxy_ redraw];
}

std::string NativeWindowMac::GetTitle() {
  return base::SysNSStringToUTF8([window_ title]);
}

void NativeWindowMac::FlashFrame(bool flash) {
  if (flash) {
    attention_request_id_ = [NSApp requestUserAttention:NSInformationalRequest];
  } else {
    [NSApp cancelUserAttentionRequest:attention_request_id_];
    attention_request_id_ = 0;
  }
}

void NativeWindowMac::SetSkipTaskbar(bool skip) {}

bool NativeWindowMac::IsExcludedFromShownWindowsMenu() {
  NSWindow* window = GetNativeWindow().GetNativeNSWindow();
  return [window isExcludedFromWindowsMenu];
}

void NativeWindowMac::SetExcludedFromShownWindowsMenu(bool excluded) {
  NSWindow* window = GetNativeWindow().GetNativeNSWindow();
  [window setExcludedFromWindowsMenu:excluded];
}

void NativeWindowMac::OnDisplayMetricsChanged(const display::Display& display,
                                              uint32_t changed_metrics) {
  // We only want to force screen recalibration if we're in simpleFullscreen
  // mode.
  if (!is_simple_fullscreen_)
    return;

  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE, base::BindOnce(&NativeWindow::UpdateFrame, GetWeakPtr()));
}

void NativeWindowMac::SetSimpleFullScreen(bool simple_fullscreen) {
  NSWindow* window = GetNativeWindow().GetNativeNSWindow();

  if (simple_fullscreen && !is_simple_fullscreen_) {
    is_simple_fullscreen_ = true;

    // Take note of the current window size and level
    if (IsNormal()) {
      UpdateWindowOriginalFrame();
      original_level_ = [window_ level];
    }

    simple_fullscreen_options_ = [NSApp currentSystemPresentationOptions];
    simple_fullscreen_mask_ = [window styleMask];

    // We can simulate the pre-Lion fullscreen by auto-hiding the dock and menu
    // bar
    NSApplicationPresentationOptions options =
        NSApplicationPresentationAutoHideDock |
        NSApplicationPresentationAutoHideMenuBar;
    [NSApp setPresentationOptions:options];

    was_maximizable_ = IsMaximizable();
    was_movable_ = IsMovable();

    NSRect fullscreenFrame = [window.screen frame];

    // If our app has dock hidden, set the window level higher so another app's
    // menu bar doesn't appear on top of our fullscreen app.
    if ([[NSRunningApplication currentApplication] activationPolicy] !=
        NSApplicationActivationPolicyRegular) {
      window.level = NSPopUpMenuWindowLevel;
    }

    // Always hide the titlebar in simple fullscreen mode.
    //
    // Note that we must remove the NSWindowStyleMaskTitled style instead of
    // using the [window_ setTitleVisibility:], as the latter would leave the
    // window with rounded corners.
    SetStyleMask(false, NSWindowStyleMaskTitled);

    if (!window_button_visibility_.has_value()) {
      // Lets keep previous behaviour - hide window controls in titled
      // fullscreen mode when not specified otherwise.
      InternalSetWindowButtonVisibility(false);
    }

    [window setFrame:fullscreenFrame display:YES animate:YES];

    // Fullscreen windows can't be resized, minimized, maximized, or moved
    SetMinimizable(false);
    SetResizable(false);
    SetMaximizable(false);
    SetMovable(false);
  } else if (!simple_fullscreen && is_simple_fullscreen_) {
    is_simple_fullscreen_ = false;

    [window setFrame:original_frame_ display:YES animate:YES];
    window.level = original_level_;

    [NSApp setPresentationOptions:simple_fullscreen_options_];

    // Restore original style mask
    ScopedDisableResize disable_resize;
    [window_ setStyleMask:simple_fullscreen_mask_];

    // Restore window manipulation abilities
    SetMaximizable(was_maximizable_);
    SetMovable(was_movable_);

    // Restore default window controls visibility state.
    if (!window_button_visibility_.has_value()) {
      bool visibility;
      if (has_frame())
        visibility = true;
      else
        visibility = title_bar_style_ != TitleBarStyle::kNormal;
      InternalSetWindowButtonVisibility(visibility);
    }

    if (buttons_proxy_)
      [buttons_proxy_ redraw];
  }
}

bool NativeWindowMac::IsSimpleFullScreen() {
  return is_simple_fullscreen_;
}

void NativeWindowMac::SetKiosk(bool kiosk) {
  if (kiosk && !is_kiosk_) {
    kiosk_options_ = [NSApp currentSystemPresentationOptions];
    NSApplicationPresentationOptions options =
        NSApplicationPresentationHideDock |
        NSApplicationPresentationHideMenuBar |
        NSApplicationPresentationDisableAppleMenu |
        NSApplicationPresentationDisableProcessSwitching |
        NSApplicationPresentationDisableForceQuit |
        NSApplicationPresentationDisableSessionTermination |
        NSApplicationPresentationDisableHideApplication;
    [NSApp setPresentationOptions:options];
    is_kiosk_ = true;
    SetFullScreen(true);
  } else if (!kiosk && is_kiosk_) {
    is_kiosk_ = false;
    SetFullScreen(false);

    // Set presentation options *after* asynchronously exiting
    // fullscreen to ensure they take effect.
    [NSApp setPresentationOptions:kiosk_options_];
  }
}

bool NativeWindowMac::IsKiosk() {
  return is_kiosk_;
}

void NativeWindowMac::SetBackgroundColor(SkColor color) {
  base::ScopedCFTypeRef<CGColorRef> cgcolor(
      skia::CGColorCreateFromSkColor(color));
  [[[window_ contentView] layer] setBackgroundColor:cgcolor];
}

SkColor NativeWindowMac::GetBackgroundColor() {
  CGColorRef color = [[[window_ contentView] layer] backgroundColor];
  if (!color)
    return SK_ColorTRANSPARENT;
  return skia::CGColorRefToSkColor(color);
}

void NativeWindowMac::SetHasShadow(bool has_shadow) {
  [window_ setHasShadow:has_shadow];
}

bool NativeWindowMac::HasShadow() {
  return [window_ hasShadow];
}

void NativeWindowMac::SetOpacity(const double opacity) {
  const double boundedOpacity = base::clamp(opacity, 0.0, 1.0);
  [window_ setAlphaValue:boundedOpacity];
}

double NativeWindowMac::GetOpacity() {
  return [window_ alphaValue];
}

void NativeWindowMac::SetRepresentedFilename(const std::string& filename) {
  [window_ setRepresentedFilename:base::SysUTF8ToNSString(filename)];
  if (buttons_proxy_)
    [buttons_proxy_ redraw];
}

std::string NativeWindowMac::GetRepresentedFilename() {
  return base::SysNSStringToUTF8([window_ representedFilename]);
}

void NativeWindowMac::SetDocumentEdited(bool edited) {
  [window_ setDocumentEdited:edited];
  if (buttons_proxy_)
    [buttons_proxy_ redraw];
}

bool NativeWindowMac::IsDocumentEdited() {
  return [window_ isDocumentEdited];
}

bool NativeWindowMac::IsHiddenInMissionControl() {
  NSUInteger collectionBehavior = [window_ collectionBehavior];
  return collectionBehavior & NSWindowCollectionBehaviorTransient;
}

void NativeWindowMac::SetHiddenInMissionControl(bool hidden) {
  SetCollectionBehavior(hidden, NSWindowCollectionBehaviorTransient);
}

void NativeWindowMac::SetIgnoreMouseEvents(bool ignore, bool forward) {
  [window_ setIgnoresMouseEvents:ignore];
  if (!ignore) {
    SetForwardMouseMessages(NO);
  } else {
    SetForwardMouseMessages(forward);
  }
}

void NativeWindowMac::SetContentProtection(bool enable) {
  [window_
      setSharingType:enable ? NSWindowSharingNone : NSWindowSharingReadOnly];
}

void NativeWindowMac::SetFocusable(bool focusable) {
  // No known way to unfocus the window if it had the focus. Here we do not
  // want to call Focus(false) because it moves the window to the back, i.e.
  // at the bottom in term of z-order.
  [window_ setDisableKeyOrMainWindow:!focusable];
}

bool NativeWindowMac::IsFocusable() {
  return ![window_ disableKeyOrMainWindow];
}

void NativeWindowMac::AddBrowserView(NativeBrowserView* view) {
  [CATransaction begin];
  [CATransaction setDisableActions:YES];

  if (!view) {
    [CATransaction commit];
    return;
  }

  add_browser_view(view);
  if (view->GetInspectableWebContentsView()) {
    auto* native_view = view->GetInspectableWebContentsView()
                            ->GetNativeView()
                            .GetNativeNSView();
    [[window_ contentView] addSubview:native_view
                           positioned:NSWindowAbove
                           relativeTo:nil];
    native_view.hidden = NO;
  }

  [CATransaction commit];
}

void NativeWindowMac::RemoveBrowserView(NativeBrowserView* view) {
  [CATransaction begin];
  [CATransaction setDisableActions:YES];

  if (!view) {
    [CATransaction commit];
    return;
  }

  if (view->GetInspectableWebContentsView())
    [view->GetInspectableWebContentsView()->GetNativeView().GetNativeNSView()
        removeFromSuperview];
  remove_browser_view(view);

  [CATransaction commit];
}

void NativeWindowMac::SetTopBrowserView(NativeBrowserView* view) {
  [CATransaction begin];
  [CATransaction setDisableActions:YES];

  if (!view) {
    [CATransaction commit];
    return;
  }

  remove_browser_view(view);
  add_browser_view(view);
  if (view->GetInspectableWebContentsView()) {
    auto* native_view = view->GetInspectableWebContentsView()
                            ->GetNativeView()
                            .GetNativeNSView();
    [[window_ contentView] addSubview:native_view
                           positioned:NSWindowAbove
                           relativeTo:nil];
    native_view.hidden = NO;
  }

  [CATransaction commit];
}

void NativeWindowMac::SetParentWindow(NativeWindow* parent) {
  InternalSetParentWindow(parent, IsVisible());
}

gfx::NativeView NativeWindowMac::GetNativeView() const {
  return [window_ contentView];
}

gfx::NativeWindow NativeWindowMac::GetNativeWindow() const {
  return window_;
}

gfx::AcceleratedWidget NativeWindowMac::GetAcceleratedWidget() const {
  return [window_ windowNumber];
}

content::DesktopMediaID NativeWindowMac::GetDesktopMediaID() const {
  auto desktop_media_id = content::DesktopMediaID(
      content::DesktopMediaID::TYPE_WINDOW, GetAcceleratedWidget());
  // c.f.
  // https://source.chromium.org/chromium/chromium/src/+/master:chrome/browser/media/webrtc/native_desktop_media_list.cc;l=372?q=kWindowCaptureMacV2&ss=chromium
  // Refs https://github.com/electron/electron/pull/30507
  // TODO(deepak1556): Match upstream for `kWindowCaptureMacV2`
#if 0
    if (remote_cocoa::ScopedCGWindowID::Get(desktop_media_id.id)) {
      desktop_media_id.window_id = desktop_media_id.id;
    }
#endif
  return desktop_media_id;
}

NativeWindowHandle NativeWindowMac::GetNativeWindowHandle() const {
  return [window_ contentView];
}

void NativeWindowMac::SetProgressBar(double progress,
                                     const NativeWindow::ProgressState state) {
  NSDockTile* dock_tile = [NSApp dockTile];

  // Sometimes macOS would install a default contentView for dock, we must
  // verify whether NSProgressIndicator has been installed.
  bool first_time = !dock_tile.contentView ||
                    [[dock_tile.contentView subviews] count] == 0 ||
                    ![[[dock_tile.contentView subviews] lastObject]
                        isKindOfClass:[NSProgressIndicator class]];

  // For the first time API invoked, we need to create a ContentView in
  // DockTile.
  if (first_time) {
    NSImageView* image_view = [[[NSImageView alloc] init] autorelease];
    [image_view setImage:[NSApp applicationIconImage]];
    [dock_tile setContentView:image_view];

    NSRect frame = NSMakeRect(0.0f, 0.0f, dock_tile.size.width, 15.0);
    NSProgressIndicator* progress_indicator =
        [[[ElectronProgressBar alloc] initWithFrame:frame] autorelease];
    [progress_indicator setStyle:NSProgressIndicatorBarStyle];
    [progress_indicator setIndeterminate:NO];
    [progress_indicator setBezeled:YES];
    [progress_indicator setMinValue:0];
    [progress_indicator setMaxValue:1];
    [progress_indicator setHidden:NO];
    [dock_tile.contentView addSubview:progress_indicator];
  }

  NSProgressIndicator* progress_indicator = static_cast<NSProgressIndicator*>(
      [[[dock_tile contentView] subviews] lastObject]);
  if (progress < 0) {
    [progress_indicator setHidden:YES];
  } else if (progress > 1) {
    [progress_indicator setHidden:NO];
    [progress_indicator setIndeterminate:YES];
    [progress_indicator setDoubleValue:1];
  } else {
    [progress_indicator setHidden:NO];
    [progress_indicator setDoubleValue:progress];
  }
  [dock_tile display];
}

void NativeWindowMac::SetOverlayIcon(const gfx::Image& overlay,
                                     const std::string& description) {}

void NativeWindowMac::SetVisibleOnAllWorkspaces(bool visible,
                                                bool visibleOnFullScreen,
                                                bool skipTransformProcessType) {
  // In order for NSWindows to be visible on fullscreen we need to invoke
  // app.dock.hide() since Apple changed the underlying functionality of
  // NSWindows starting with 10.14 to disallow NSWindows from floating on top of
  // fullscreen apps.
  if (!skipTransformProcessType) {
    if (visibleOnFullScreen) {
      Browser::Get()->DockHide();
    } else {
      Browser::Get()->DockShow(JavascriptEnvironment::GetIsolate());
    }
  }

  SetCollectionBehavior(visible, NSWindowCollectionBehaviorCanJoinAllSpaces);
  SetCollectionBehavior(visibleOnFullScreen,
                        NSWindowCollectionBehaviorFullScreenAuxiliary);
}

bool NativeWindowMac::IsVisibleOnAllWorkspaces() {
  NSUInteger collectionBehavior = [window_ collectionBehavior];
  return collectionBehavior & NSWindowCollectionBehaviorCanJoinAllSpaces;
}

void NativeWindowMac::SetAutoHideCursor(bool auto_hide) {
  [window_ setDisableAutoHideCursor:!auto_hide];
}

void NativeWindowMac::UpdateVibrancyRadii(bool fullscreen) {
  NSVisualEffectView* vibrantView = [window_ vibrantView];

  if (vibrantView != nil && !vibrancy_type_.empty()) {
    const bool no_rounded_corner = !HasStyleMask(NSWindowStyleMaskTitled);
    if (!has_frame() && !is_modal() && !no_rounded_corner) {
      CGFloat radius;
      if (fullscreen) {
        radius = 0.0f;
      } else if (@available(macOS 11.0, *)) {
        radius = 9.0f;
      } else {
        // Smaller corner radius on versions prior to Big Sur.
        radius = 5.0f;
      }

      CGFloat dimension = 2 * radius + 1;
      NSSize size = NSMakeSize(dimension, dimension);
      NSImage* maskImage = [NSImage imageWithSize:size
                                          flipped:NO
                                   drawingHandler:^BOOL(NSRect rect) {
                                     NSBezierPath* bezierPath = [NSBezierPath
                                         bezierPathWithRoundedRect:rect
                                                           xRadius:radius
                                                           yRadius:radius];
                                     [[NSColor blackColor] set];
                                     [bezierPath fill];
                                     return YES;
                                   }];

      [maskImage setCapInsets:NSEdgeInsetsMake(radius, radius, radius, radius)];
      [maskImage setResizingMode:NSImageResizingModeStretch];
      [vibrantView setMaskImage:maskImage];
      [window_ setCornerMask:maskImage];
    }
  }
}

void NativeWindowMac::UpdateWindowOriginalFrame() {
  original_frame_ = [window_ frame];
}

void NativeWindowMac::SetVibrancy(const std::string& type) {
  NSVisualEffectView* vibrantView = [window_ vibrantView];

  if (type.empty()) {
    if (vibrantView == nil)
      return;

    [vibrantView removeFromSuperview];
    [window_ setVibrantView:nil];

    return;
  }

  std::string dep_warn = " has been deprecated and removed as of macOS 10.15.";
  node::Environment* env =
      node::Environment::GetCurrent(JavascriptEnvironment::GetIsolate());

  NSVisualEffectMaterial vibrancyType{};
  if (type == "appearance-based") {
    EmitWarning(env, "NSVisualEffectMaterialAppearanceBased" + dep_warn,
                "electron");
    vibrancyType = NSVisualEffectMaterialAppearanceBased;
  } else if (type == "light") {
    EmitWarning(env, "NSVisualEffectMaterialLight" + dep_warn, "electron");
    vibrancyType = NSVisualEffectMaterialLight;
  } else if (type == "dark") {
    EmitWarning(env, "NSVisualEffectMaterialDark" + dep_warn, "electron");
    vibrancyType = NSVisualEffectMaterialDark;
  } else if (type == "titlebar") {
    vibrancyType = NSVisualEffectMaterialTitlebar;
  }

  if (type == "selection") {
    vibrancyType = NSVisualEffectMaterialSelection;
  } else if (type == "menu") {
    vibrancyType = NSVisualEffectMaterialMenu;
  } else if (type == "popover") {
    vibrancyType = NSVisualEffectMaterialPopover;
  } else if (type == "sidebar") {
    vibrancyType = NSVisualEffectMaterialSidebar;
  } else if (type == "medium-light") {
    EmitWarning(env, "NSVisualEffectMaterialMediumLight" + dep_warn,
                "electron");
    vibrancyType = NSVisualEffectMaterialMediumLight;
  } else if (type == "ultra-dark") {
    EmitWarning(env, "NSVisualEffectMaterialUltraDark" + dep_warn, "electron");
    vibrancyType = NSVisualEffectMaterialUltraDark;
  }

  if (@available(macOS 10.14, *)) {
    if (type == "header") {
      vibrancyType = NSVisualEffectMaterialHeaderView;
    } else if (type == "sheet") {
      vibrancyType = NSVisualEffectMaterialSheet;
    } else if (type == "window") {
      vibrancyType = NSVisualEffectMaterialWindowBackground;
    } else if (type == "hud") {
      vibrancyType = NSVisualEffectMaterialHUDWindow;
    } else if (type == "fullscreen-ui") {
      vibrancyType = NSVisualEffectMaterialFullScreenUI;
    } else if (type == "tooltip") {
      vibrancyType = NSVisualEffectMaterialToolTip;
    } else if (type == "content") {
      vibrancyType = NSVisualEffectMaterialContentBackground;
    } else if (type == "under-window") {
      vibrancyType = NSVisualEffectMaterialUnderWindowBackground;
    } else if (type == "under-page") {
      vibrancyType = NSVisualEffectMaterialUnderPageBackground;
    }
  }

  if (vibrancyType) {
    vibrancy_type_ = type;

    if (vibrantView == nil) {
      vibrantView = [[[NSVisualEffectView alloc]
          initWithFrame:[[window_ contentView] bounds]] autorelease];
      [window_ setVibrantView:vibrantView];

      [vibrantView
          setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
      [vibrantView setBlendingMode:NSVisualEffectBlendingModeBehindWindow];

      if (visual_effect_state_ == VisualEffectState::kActive) {
        [vibrantView setState:NSVisualEffectStateActive];
      } else if (visual_effect_state_ == VisualEffectState::kInactive) {
        [vibrantView setState:NSVisualEffectStateInactive];
      } else {
        [vibrantView setState:NSVisualEffectStateFollowsWindowActiveState];
      }

      [[window_ contentView] addSubview:vibrantView
                             positioned:NSWindowBelow
                             relativeTo:nil];

      UpdateVibrancyRadii(IsFullscreen());
    }

    [vibrantView setMaterial:vibrancyType];
  }
}

void NativeWindowMac::SetWindowButtonVisibility(bool visible) {
  window_button_visibility_ = visible;
  if (buttons_proxy_) {
    if (visible)
      [buttons_proxy_ redraw];
    [buttons_proxy_ setVisible:visible];
  }

  if (title_bar_style_ != TitleBarStyle::kCustomButtonsOnHover)
    InternalSetWindowButtonVisibility(visible);

  NotifyLayoutWindowControlsOverlay();
}

bool NativeWindowMac::GetWindowButtonVisibility() const {
  return ![window_ standardWindowButton:NSWindowZoomButton].hidden ||
         ![window_ standardWindowButton:NSWindowMiniaturizeButton].hidden ||
         ![window_ standardWindowButton:NSWindowCloseButton].hidden;
}

void NativeWindowMac::SetTrafficLightPosition(
    absl::optional<gfx::Point> position) {
  traffic_light_position_ = std::move(position);
  if (buttons_proxy_) {
    [buttons_proxy_ setMargin:traffic_light_position_];
    NotifyLayoutWindowControlsOverlay();
  }
}

absl::optional<gfx::Point> NativeWindowMac::GetTrafficLightPosition() const {
  return traffic_light_position_;
}

void NativeWindowMac::RedrawTrafficLights() {
  if (buttons_proxy_ && !IsFullscreen())
    [buttons_proxy_ redraw];
}

// In simpleFullScreen mode, update the frame for new bounds.
void NativeWindowMac::UpdateFrame() {
  NSWindow* window = GetNativeWindow().GetNativeNSWindow();
  NSRect fullscreenFrame = [window.screen frame];
  [window setFrame:fullscreenFrame display:YES animate:YES];
}

void NativeWindowMac::SetTouchBar(
    std::vector<gin_helper::PersistentDictionary> items) {
  touch_bar_.reset([[ElectronTouchBar alloc]
      initWithDelegate:window_delegate_.get()
                window:this
              settings:std::move(items)]);
  [window_ setTouchBar:nil];
}

void NativeWindowMac::RefreshTouchBarItem(const std::string& item_id) {
  if (touch_bar_ && [window_ touchBar])
    [touch_bar_ refreshTouchBarItem:[window_ touchBar] id:item_id];
}

void NativeWindowMac::SetEscapeTouchBarItem(
    gin_helper::PersistentDictionary item) {
  if (touch_bar_ && [window_ touchBar])
    [touch_bar_ setEscapeTouchBarItem:std::move(item)
                          forTouchBar:[window_ touchBar]];
}

void NativeWindowMac::SelectPreviousTab() {
  [window_ selectPreviousTab:nil];
}

void NativeWindowMac::SelectNextTab() {
  [window_ selectNextTab:nil];
}

void NativeWindowMac::MergeAllWindows() {
  [window_ mergeAllWindows:nil];
}

void NativeWindowMac::MoveTabToNewWindow() {
  [window_ moveTabToNewWindow:nil];
}

void NativeWindowMac::ToggleTabBar() {
  [window_ toggleTabBar:nil];
}

bool NativeWindowMac::AddTabbedWindow(NativeWindow* window) {
  if (window_ == window->GetNativeWindow().GetNativeNSWindow()) {
    return false;
  } else {
    [window_ addTabbedWindow:window->GetNativeWindow().GetNativeNSWindow()
                     ordered:NSWindowAbove];
  }
  return true;
}

void NativeWindowMac::SetAspectRatio(double aspect_ratio,
                                     const gfx::Size& extra_size) {
  NativeWindow::SetAspectRatio(aspect_ratio, extra_size);

  // Reset the behaviour to default if aspect_ratio is set to 0 or less.
  if (aspect_ratio > 0.0) {
    NSSize aspect_ratio_size = NSMakeSize(aspect_ratio, 1.0);
    if (has_frame())
      [window_ setContentAspectRatio:aspect_ratio_size];
    else
      [window_ setAspectRatio:aspect_ratio_size];
  } else {
    [window_ setResizeIncrements:NSMakeSize(1.0, 1.0)];
  }
}

void NativeWindowMac::PreviewFile(const std::string& path,
                                  const std::string& display_name) {
  preview_item_.reset([[ElectronPreviewItem alloc]
      initWithURL:[NSURL fileURLWithPath:base::SysUTF8ToNSString(path)]
            title:base::SysUTF8ToNSString(display_name)]);
  [[QLPreviewPanel sharedPreviewPanel] makeKeyAndOrderFront:nil];
}

void NativeWindowMac::CloseFilePreview() {
  if ([QLPreviewPanel sharedPreviewPanelExists]) {
    [[QLPreviewPanel sharedPreviewPanel] close];
  }
}

gfx::Rect NativeWindowMac::ContentBoundsToWindowBounds(
    const gfx::Rect& bounds) const {
  if (has_frame()) {
    gfx::Rect window_bounds(
        [window_ frameRectForContentRect:bounds.ToCGRect()]);
    int frame_height = window_bounds.height() - bounds.height();
    window_bounds.set_y(window_bounds.y() - frame_height);
    return window_bounds;
  } else {
    return bounds;
  }
}

gfx::Rect NativeWindowMac::WindowBoundsToContentBounds(
    const gfx::Rect& bounds) const {
  if (has_frame()) {
    gfx::Rect content_bounds(
        [window_ contentRectForFrameRect:bounds.ToCGRect()]);
    int frame_height = bounds.height() - content_bounds.height();
    content_bounds.set_y(content_bounds.y() + frame_height);
    return content_bounds;
  } else {
    return bounds;
  }
}

void NativeWindowMac::NotifyWindowEnterFullScreen() {
  NativeWindow::NotifyWindowEnterFullScreen();
  // Restore the window title under fullscreen mode.
  if (buttons_proxy_)
    [window_ setTitleVisibility:NSWindowTitleVisible];
}

void NativeWindowMac::NotifyWindowLeaveFullScreen() {
  NativeWindow::NotifyWindowLeaveFullScreen();
  // Restore window buttons.
  if (buttons_proxy_ && window_button_visibility_.value_or(true)) {
    [buttons_proxy_ redraw];
    [buttons_proxy_ setVisible:YES];
  }
}

void NativeWindowMac::NotifyWindowWillEnterFullScreen() {
  UpdateVibrancyRadii(true);
}

void NativeWindowMac::NotifyWindowWillLeaveFullScreen() {
  if (buttons_proxy_) {
    // Hide window title when leaving fullscreen.
    [window_ setTitleVisibility:NSWindowTitleHidden];
    // Hide the container otherwise traffic light buttons jump.
    [buttons_proxy_ setVisible:NO];
  }
  UpdateVibrancyRadii(false);
}

void NativeWindowMac::SetActive(bool is_key) {
  is_active_ = is_key;
}

bool NativeWindowMac::IsActive() const {
  return is_active_;
}

void NativeWindowMac::Cleanup() {
  DCHECK(!IsClosed());
  ui::NativeTheme::GetInstanceForNativeUi()->RemoveObserver(this);
  display::Screen::GetScreen()->RemoveObserver(this);
}

void NativeWindowMac::OverrideNSWindowContentView() {
  // When using `views::Widget` to hold WebContents, Chromium would use
  // `BridgedContentView` as content view, which does not support draggable
  // regions. In order to make draggable regions work, we have to replace the
  // content view with a simple NSView.
  if (has_frame()) {
    container_view_.reset(
        [[ElectronAdaptedContentView alloc] initWithShell:this]);
  } else {
    container_view_.reset([[FullSizeContentView alloc] init]);
    [container_view_ setFrame:[[[window_ contentView] superview] bounds]];
  }
  [container_view_
      setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
  [window_ setContentView:container_view_];
  AddContentViewLayers();
}

bool NativeWindowMac::HasStyleMask(NSUInteger flag) const {
  return [window_ styleMask] & flag;
}

void NativeWindowMac::SetStyleMask(bool on, NSUInteger flag) {
  // Changing the styleMask of a frameless windows causes it to change size so
  // we explicitly disable resizing while setting it.
  ScopedDisableResize disable_resize;

  if (on)
    [window_ setStyleMask:[window_ styleMask] | flag];
  else
    [window_ setStyleMask:[window_ styleMask] & (~flag)];

  // Change style mask will make the zoom button revert to default, probably
  // a bug of Cocoa or macOS.
  SetMaximizable(maximizable_);
}

void NativeWindowMac::SetCollectionBehavior(bool on, NSUInteger flag) {
  if (on)
    [window_ setCollectionBehavior:[window_ collectionBehavior] | flag];
  else
    [window_ setCollectionBehavior:[window_ collectionBehavior] & (~flag)];

  // Change collectionBehavior will make the zoom button revert to default,
  // probably a bug of Cocoa or macOS.
  SetMaximizable(maximizable_);
}

views::View* NativeWindowMac::GetContentsView() {
  return root_view_.get();
}

bool NativeWindowMac::CanMaximize() const {
  return maximizable_;
}

void NativeWindowMac::OnNativeThemeUpdated(ui::NativeTheme* observed_theme) {
  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE,
      base::BindOnce(&NativeWindow::RedrawTrafficLights, GetWeakPtr()));
}

void NativeWindowMac::AddContentViewLayers() {
  // Make sure the bottom corner is rounded for non-modal windows:
  // http://crbug.com/396264.
  if (!is_modal()) {
    // For normal window, we need to explicitly set layer for contentView to
    // make setBackgroundColor work correctly.
    // There is no need to do so for frameless window, and doing so would make
    // titleBarStyle stop working.
    if (has_frame()) {
      base::scoped_nsobject<CALayer> background_layer([[CALayer alloc] init]);
      [background_layer
          setAutoresizingMask:kCALayerWidthSizable | kCALayerHeightSizable];
      [[window_ contentView] setLayer:background_layer];
    }
    [[window_ contentView] setWantsLayer:YES];
  }

  if (!has_frame()) {
    // In OSX 10.10, adding subviews to the root view for the NSView hierarchy
    // produces warnings. To eliminate the warnings, we resize the contentView
    // to fill the window, and add subviews to that.
    // http://crbug.com/380412
    if (!original_set_frame_size) {
      Class cl = [[window_ contentView] class];
      original_set_frame_size = class_replaceMethod(
          cl, @selector(setFrameSize:), (IMP)SetFrameSize, "v@:{_NSSize=ff}");
      original_view_did_move_to_superview =
          class_replaceMethod(cl, @selector(viewDidMoveToSuperview),
                              (IMP)ViewDidMoveToSuperview, "v@:");
      [[window_ contentView] viewDidMoveToWindow];
    }
  }
}

void NativeWindowMac::InternalSetWindowButtonVisibility(bool visible) {
  [[window_ standardWindowButton:NSWindowCloseButton] setHidden:!visible];
  [[window_ standardWindowButton:NSWindowMiniaturizeButton] setHidden:!visible];
  [[window_ standardWindowButton:NSWindowZoomButton] setHidden:!visible];
}

void NativeWindowMac::InternalSetParentWindow(NativeWindow* parent,
                                              bool attach) {
  if (is_modal())
    return;

  NativeWindow::SetParentWindow(parent);

  // Do not remove/add if we are already properly attached.
  if (attach && parent &&
      [window_ parentWindow] == parent->GetNativeWindow().GetNativeNSWindow())
    return;

  // Remove current parent window.
  if ([window_ parentWindow])
    [[window_ parentWindow] removeChildWindow:window_];

  // Set new parent window.
  // Note that this method will force the window to become visible.
  if (parent && attach) {
    // Attaching a window as a child window resets its window level, so
    // save and restore it afterwards.
    NSInteger level = window_.level;
    [parent->GetNativeWindow().GetNativeNSWindow()
        addChildWindow:window_
               ordered:NSWindowAbove];
    [window_ setLevel:level];
  }
}

void NativeWindowMac::SetForwardMouseMessages(bool forward) {
  [window_ setAcceptsMouseMovedEvents:forward];
}

gfx::Rect NativeWindowMac::GetWindowControlsOverlayRect() {
  if (titlebar_overlay_ && buttons_proxy_ &&
      window_button_visibility_.value_or(true)) {
    NSRect buttons = [buttons_proxy_ getButtonsContainerBounds];
    gfx::Rect overlay;
    overlay.set_width(GetContentSize().width() - NSWidth(buttons));
    if ([buttons_proxy_ useCustomHeight]) {
      overlay.set_height(titlebar_overlay_height());
    } else {
      overlay.set_height(NSHeight(buttons));
    }

    if (!base::i18n::IsRTL())
      overlay.set_x(NSMaxX(buttons));
    return overlay;
  }
  return gfx::Rect();
}

// static
NativeWindow* NativeWindow::Create(const gin_helper::Dictionary& options,
                                   NativeWindow* parent) {
  return new NativeWindowMac(options, parent);
}

}  // namespace electron
