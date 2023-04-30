// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "shell/browser/badging/badge_manager_factory.h"

#include <memory>

#include "base/bind.h"
#include "base/memory/ptr_util.h"
#include "base/memory/singleton.h"
#include "components/keyed_service/content/browser_context_dependency_manager.h"
#include "shell/browser/badging/badge_manager.h"

namespace badging {

// static
BadgeManager* BadgeManagerFactory::GetForBrowserContext(
    content::BrowserContext* context) {
  return static_cast<badging::BadgeManager*>(
      GetInstance()->GetServiceForBrowserContext(context, true));
}

// static
BadgeManagerFactory* BadgeManagerFactory::GetInstance() {
  return base::Singleton<BadgeManagerFactory>::get();
}

BadgeManagerFactory::BadgeManagerFactory()
    : BrowserContextKeyedServiceFactory(
          "BadgeManager",
          BrowserContextDependencyManager::GetInstance()) {}

BadgeManagerFactory::~BadgeManagerFactory() = default;

KeyedService* BadgeManagerFactory::BuildServiceInstanceFor(
    content::BrowserContext* context) const {
  return new BadgeManager();
}

}  // namespace badging
