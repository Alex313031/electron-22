// Copyright (c) 2012 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_UI_VIEWS_AUTOFILL_POPUP_VIEW_H_
#define ELECTRON_SHELL_BROWSER_UI_VIEWS_AUTOFILL_POPUP_VIEW_H_

#include <memory>

#include "shell/browser/ui/autofill_popup.h"

#include "content/public/browser/native_web_keyboard_event.h"
#include "content/public/browser/render_widget_host.h"
#include "electron/buildflags/buildflags.h"
#include "third_party/abseil-cpp/absl/types/optional.h"
#include "ui/accessibility/ax_node_data.h"
#include "ui/views/drag_controller.h"
#include "ui/views/focus/widget_focus_manager.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/widget/widget_observer.h"

#if BUILDFLAG(ENABLE_OSR)
#include "shell/browser/osr/osr_view_proxy.h"
#endif

namespace electron {

const int kPopupBorderThickness = 1;
const int kSmallerFontSizeDelta = -1;
const int kEndPadding = 8;
const int kNamePadding = 15;
const int kRowHeight = 24;

class AutofillPopup;

// Child view only for triggering accessibility events. Rendering is handled
// by |AutofillPopupViewViews|.
class AutofillPopupChildView : public views::View {
 public:
  explicit AutofillPopupChildView(const std::u16string& suggestion)
      : suggestion_(suggestion) {
    SetFocusBehavior(FocusBehavior::ALWAYS);
  }

  // disable copy
  AutofillPopupChildView(const AutofillPopupChildView&) = delete;
  AutofillPopupChildView& operator=(const AutofillPopupChildView&) = delete;

 private:
  ~AutofillPopupChildView() override {}

  // views::Views implementation
  void GetAccessibleNodeData(ui::AXNodeData* node_data) override;

  std::u16string suggestion_;
};

class AutofillPopupView : public views::WidgetDelegateView,
                          public views::WidgetFocusChangeListener,
                          public views::WidgetObserver,
                          public views::DragController {
 public:
  explicit AutofillPopupView(AutofillPopup* popup,
                             views::Widget* parent_widget);
  ~AutofillPopupView() override;

  void Show();
  void Hide();

  void OnSuggestionsChanged();

  int GetSelectedLine() { return selected_line_.value_or(-1); }

  void WriteDragDataForView(views::View*,
                            const gfx::Point&,
                            ui::OSExchangeData*) override;
  int GetDragOperationsForView(views::View*, const gfx::Point&) override;
  bool CanStartDragForView(views::View*,
                           const gfx::Point&,
                           const gfx::Point&) override;

 private:
  friend class AutofillPopup;

  void OnSelectedRowChanged(absl::optional<int> previous_row_selection,
                            absl::optional<int> current_row_selection);

  // Draw the given autofill entry in |entry_rect|.
  void DrawAutofillEntry(gfx::Canvas* canvas,
                         int index,
                         const gfx::Rect& entry_rect);

  // Creates child views based on the suggestions given by |controller_|. These
  // child views are used for accessibility events only. We need child views to
  // populate the correct |AXNodeData| when user selects a suggestion.
  void CreateChildViews();

  void DoUpdateBoundsAndRedrawPopup();

  // views::Views implementation.
  void OnPaint(gfx::Canvas* canvas) override;
  void GetAccessibleNodeData(ui::AXNodeData* node_data) override;
  void OnMouseCaptureLost() override;
  bool OnMouseDragged(const ui::MouseEvent& event) override;
  void OnMouseExited(const ui::MouseEvent& event) override;
  void OnMouseMoved(const ui::MouseEvent& event) override;
  bool OnMousePressed(const ui::MouseEvent& event) override;
  void OnMouseReleased(const ui::MouseEvent& event) override;
  void OnGestureEvent(ui::GestureEvent* event) override;
  bool AcceleratorPressed(const ui::Accelerator& accelerator) override;
  bool HandleKeyPressEvent(const content::NativeWebKeyboardEvent& event);

  // views::WidgetFocusChangeListener implementation.
  void OnNativeFocusChanged(gfx::NativeView focused_now) override;

  // views::WidgetObserver implementation.
  void OnWidgetBoundsChanged(views::Widget* widget,
                             const gfx::Rect& new_bounds) override;

  void AcceptSuggestion(int index);
  bool AcceptSelectedLine();
  void AcceptSelection(const gfx::Point& point);
  void SetSelectedLine(absl::optional<int> selected_line);
  void SetSelection(const gfx::Point& point);
  void SelectNextLine();
  void SelectPreviousLine();
  void ClearSelection();

  // Stop observing the widget.
  void RemoveObserver();

  // Controller for this popup. Weak reference.
  AutofillPopup* popup_;

  // The widget of the window that triggered this popup. Weak reference.
  views::Widget* parent_widget_;

  // The time when the popup was shown.
  base::Time show_time_;

  // The index of the currently selected line
  absl::optional<int> selected_line_;

#if BUILDFLAG(ENABLE_OSR)
  std::unique_ptr<OffscreenViewProxy> view_proxy_;
#endif

  // The registered keypress callback, responsible for switching lines on
  // key presses
  content::RenderWidgetHost::KeyPressEventCallback keypress_callback_;

  base::WeakPtrFactory<AutofillPopupView> weak_ptr_factory_{this};
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_UI_VIEWS_AUTOFILL_POPUP_VIEW_H_
