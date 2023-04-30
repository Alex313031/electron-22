// Copyright (c) 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE-CHROMIUM file.

#include "shell/browser/ui/views/inspectable_web_contents_view_views.h"

#include <memory>

#include <utility>

#include "base/strings/utf_string_conversions.h"
#include "shell/browser/ui/inspectable_web_contents.h"
#include "shell/browser/ui/inspectable_web_contents_delegate.h"
#include "shell/browser/ui/inspectable_web_contents_view_delegate.h"
#include "ui/base/models/image_model.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/window/client_view.h"

namespace electron {

namespace {

class DevToolsWindowDelegate : public views::ClientView,
                               public views::WidgetDelegate {
 public:
  DevToolsWindowDelegate(InspectableWebContentsViewViews* shell,
                         views::View* view,
                         views::Widget* widget)
      : views::ClientView(widget, view),
        shell_(shell),
        view_(view),
        widget_(widget) {
    SetOwnedByWidget(true);
    set_owned_by_client();

    if (shell->GetDelegate())
      icon_ = shell->GetDelegate()->GetDevToolsWindowIcon();
  }
  ~DevToolsWindowDelegate() override = default;

  // disable copy
  DevToolsWindowDelegate(const DevToolsWindowDelegate&) = delete;
  DevToolsWindowDelegate& operator=(const DevToolsWindowDelegate&) = delete;

  // views::WidgetDelegate:
  views::View* GetInitiallyFocusedView() override { return view_; }
  std::u16string GetWindowTitle() const override { return shell_->GetTitle(); }
  ui::ImageModel GetWindowAppIcon() override { return GetWindowIcon(); }
  ui::ImageModel GetWindowIcon() override { return icon_; }
  views::Widget* GetWidget() override { return widget_; }
  const views::Widget* GetWidget() const override { return widget_; }
  views::View* GetContentsView() override { return view_; }
  views::ClientView* CreateClientView(views::Widget* widget) override {
    return this;
  }

  // views::ClientView:
  views::CloseRequestResult OnWindowCloseRequested() override {
    shell_->inspectable_web_contents()->CloseDevTools();
    return views::CloseRequestResult::kCannotClose;
  }

 private:
  InspectableWebContentsViewViews* shell_;
  views::View* view_;
  views::Widget* widget_;
  ui::ImageModel icon_;
};

}  // namespace

InspectableWebContentsView* CreateInspectableContentsView(
    InspectableWebContents* inspectable_web_contents) {
  return new InspectableWebContentsViewViews(inspectable_web_contents);
}

InspectableWebContentsViewViews::InspectableWebContentsViewViews(
    InspectableWebContents* inspectable_web_contents)
    : inspectable_web_contents_(inspectable_web_contents),
      devtools_web_view_(new views::WebView(nullptr)),
      title_(u"Developer Tools") {
  if (!inspectable_web_contents_->IsGuest() &&
      inspectable_web_contents_->GetWebContents()->GetNativeView()) {
    auto* contents_web_view = new views::WebView(nullptr);
    contents_web_view->SetWebContents(
        inspectable_web_contents_->GetWebContents());
    contents_web_view_ = contents_web_view;
  } else {
    contents_web_view_ = new views::Label(u"No content under offscreen mode");
  }

  devtools_web_view_->SetVisible(false);
  AddChildView(devtools_web_view_);
  AddChildView(contents_web_view_);
}

InspectableWebContentsViewViews::~InspectableWebContentsViewViews() {
  if (devtools_window_)
    inspectable_web_contents()->SaveDevToolsBounds(
        devtools_window_->GetWindowBoundsInScreen());
}

views::View* InspectableWebContentsViewViews::GetView() {
  return this;
}

views::View* InspectableWebContentsViewViews::GetWebView() {
  return contents_web_view_;
}

void InspectableWebContentsViewViews::ShowDevTools(bool activate) {
  if (devtools_visible_)
    return;

  devtools_visible_ = true;
  if (devtools_window_) {
    devtools_window_web_view_->SetWebContents(
        inspectable_web_contents_->GetDevToolsWebContents());
    devtools_window_->SetBounds(
        inspectable_web_contents()->GetDevToolsBounds());
    if (activate) {
      devtools_window_->Show();
    } else {
      devtools_window_->ShowInactive();
    }

    // Update draggable regions to account for the new dock position.
    if (GetDelegate())
      GetDelegate()->DevToolsResized();
  } else {
    devtools_web_view_->SetVisible(true);
    devtools_web_view_->SetWebContents(
        inspectable_web_contents_->GetDevToolsWebContents());
    devtools_web_view_->RequestFocus();
    Layout();
  }
}

void InspectableWebContentsViewViews::CloseDevTools() {
  if (!devtools_visible_)
    return;

  devtools_visible_ = false;
  if (devtools_window_) {
    inspectable_web_contents()->SaveDevToolsBounds(
        devtools_window_->GetWindowBoundsInScreen());
    devtools_window_.reset();
    devtools_window_web_view_ = nullptr;
    devtools_window_delegate_ = nullptr;
  } else {
    devtools_web_view_->SetVisible(false);
    devtools_web_view_->SetWebContents(nullptr);
    Layout();
  }
}

bool InspectableWebContentsViewViews::IsDevToolsViewShowing() {
  return devtools_visible_;
}

bool InspectableWebContentsViewViews::IsDevToolsViewFocused() {
  if (devtools_window_web_view_)
    return devtools_window_web_view_->HasFocus();
  else if (devtools_web_view_)
    return devtools_web_view_->HasFocus();
  else
    return false;
}

void InspectableWebContentsViewViews::SetIsDocked(bool docked, bool activate) {
  CloseDevTools();

  if (!docked) {
    devtools_window_ = std::make_unique<views::Widget>();
    devtools_window_web_view_ = new views::WebView(nullptr);
    devtools_window_delegate_ = new DevToolsWindowDelegate(
        this, devtools_window_web_view_, devtools_window_.get());

    views::Widget::InitParams params;
    params.ownership = views::Widget::InitParams::WIDGET_OWNS_NATIVE_WIDGET;
    params.delegate = devtools_window_delegate_;
    params.bounds = inspectable_web_contents()->GetDevToolsBounds();

#if BUILDFLAG(IS_LINUX)
    params.wm_role_name = "devtools";
    if (GetDelegate())
      GetDelegate()->GetDevToolsWindowWMClass(&params.wm_class_name,
                                              &params.wm_class_class);
#endif

    devtools_window_->Init(std::move(params));
    devtools_window_->UpdateWindowIcon();
    devtools_window_->widget_delegate()->SetHasWindowSizeControls(true);
  }

  ShowDevTools(activate);
}

void InspectableWebContentsViewViews::SetContentsResizingStrategy(
    const DevToolsContentsResizingStrategy& strategy) {
  strategy_.CopyFrom(strategy);
  Layout();
}

void InspectableWebContentsViewViews::SetTitle(const std::u16string& title) {
  if (devtools_window_) {
    title_ = title;
    devtools_window_->UpdateWindowTitle();
  }
}

void InspectableWebContentsViewViews::Layout() {
  if (!devtools_web_view_->GetVisible()) {
    contents_web_view_->SetBoundsRect(GetContentsBounds());
    return;
  }

  gfx::Size container_size(width(), height());
  gfx::Rect new_devtools_bounds;
  gfx::Rect new_contents_bounds;
  ApplyDevToolsContentsResizingStrategy(
      strategy_, container_size, &new_devtools_bounds, &new_contents_bounds);

  // DevTools cares about the specific position, so we have to compensate RTL
  // layout here.
  new_devtools_bounds.set_x(GetMirroredXForRect(new_devtools_bounds));
  new_contents_bounds.set_x(GetMirroredXForRect(new_contents_bounds));

  devtools_web_view_->SetBoundsRect(new_devtools_bounds);
  contents_web_view_->SetBoundsRect(new_contents_bounds);

  if (GetDelegate())
    GetDelegate()->DevToolsResized();
}

}  // namespace electron
