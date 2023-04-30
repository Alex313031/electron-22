// Copyright (c) 2012 The Chromium Authors. All rights reserved.
// Copyright (c) 2013 Adam Roben <adam@roben.org>. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE-CHROMIUM file.

#ifndef ELECTRON_SHELL_BROWSER_UI_INSPECTABLE_WEB_CONTENTS_VIEW_MAC_H_
#define ELECTRON_SHELL_BROWSER_UI_INSPECTABLE_WEB_CONTENTS_VIEW_MAC_H_

#include "shell/browser/ui/inspectable_web_contents_view.h"

#include "base/mac/scoped_nsobject.h"

@class ElectronInspectableWebContentsView;

namespace electron {

class InspectableWebContents;

class InspectableWebContentsViewMac : public InspectableWebContentsView {
 public:
  explicit InspectableWebContentsViewMac(
      InspectableWebContents* inspectable_web_contents);
  InspectableWebContentsViewMac(const InspectableWebContentsViewMac&) = delete;
  InspectableWebContentsViewMac& operator=(
      const InspectableWebContentsViewMac&) = delete;
  ~InspectableWebContentsViewMac() override;

  gfx::NativeView GetNativeView() const override;
  void ShowDevTools(bool activate) override;
  void CloseDevTools() override;
  bool IsDevToolsViewShowing() override;
  bool IsDevToolsViewFocused() override;
  void SetIsDocked(bool docked, bool activate) override;
  void SetContentsResizingStrategy(
      const DevToolsContentsResizingStrategy& strategy) override;
  void SetTitle(const std::u16string& title) override;

  InspectableWebContents* inspectable_web_contents() {
    return inspectable_web_contents_;
  }

 private:
  // Owns us.
  InspectableWebContents* inspectable_web_contents_;

  base::scoped_nsobject<ElectronInspectableWebContentsView> view_;
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_UI_INSPECTABLE_WEB_CONTENTS_VIEW_MAC_H_
