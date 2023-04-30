// Copyright (c) 2015 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/notifications/notification.h"

#include "shell/browser/notifications/notification_delegate.h"
#include "shell/browser/notifications/notification_presenter.h"

namespace electron {

NotificationOptions::NotificationOptions() = default;
NotificationOptions::~NotificationOptions() = default;

Notification::Notification(NotificationDelegate* delegate,
                           NotificationPresenter* presenter)
    : delegate_(delegate), presenter_(presenter) {}

Notification::~Notification() {
  if (delegate())
    delegate()->NotificationDestroyed();
}

void Notification::NotificationClicked() {
  if (delegate())
    delegate()->NotificationClick();
  Destroy();
}

void Notification::NotificationDismissed() {
  if (delegate())
    delegate()->NotificationClosed();
  Destroy();
}

void Notification::NotificationFailed(const std::string& error) {
  if (delegate())
    delegate()->NotificationFailed(error);
  Destroy();
}

void Notification::Destroy() {
  presenter()->RemoveNotification(this);
}

}  // namespace electron
