// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "shell/browser/extensions/api/runtime/electron_runtime_api_delegate.h"

#include <string>

#include "build/build_config.h"
#include "components/update_client/update_query_params.h"
#include "extensions/common/api/runtime.h"
#include "shell/browser/extensions/electron_extension_system.h"

using extensions::api::runtime::PlatformInfo;

namespace extensions {

ElectronRuntimeAPIDelegate::ElectronRuntimeAPIDelegate(
    content::BrowserContext* browser_context)
    : browser_context_(browser_context) {
  DCHECK(browser_context_);
}

ElectronRuntimeAPIDelegate::~ElectronRuntimeAPIDelegate() = default;

void ElectronRuntimeAPIDelegate::AddUpdateObserver(UpdateObserver* observer) {}

void ElectronRuntimeAPIDelegate::RemoveUpdateObserver(
    UpdateObserver* observer) {}

void ElectronRuntimeAPIDelegate::ReloadExtension(
    const std::string& extension_id) {
  static_cast<ElectronExtensionSystem*>(ExtensionSystem::Get(browser_context_))
      ->ReloadExtension(extension_id);
}

bool ElectronRuntimeAPIDelegate::CheckForUpdates(
    const std::string& extension_id,
    UpdateCheckCallback callback) {
  return false;
}

void ElectronRuntimeAPIDelegate::OpenURL(const GURL& uninstall_url) {}

bool ElectronRuntimeAPIDelegate::GetPlatformInfo(PlatformInfo* info) {
  const char* os = update_client::UpdateQueryParams::GetOS();
  if (strcmp(os, "mac") == 0) {
    info->os = extensions::api::runtime::PLATFORM_OS_MAC;
  } else if (strcmp(os, "win") == 0) {
    info->os = extensions::api::runtime::PLATFORM_OS_WIN;
  } else if (strcmp(os, "linux") == 0) {
    info->os = extensions::api::runtime::PLATFORM_OS_LINUX;
  } else if (strcmp(os, "openbsd") == 0) {
    info->os = extensions::api::runtime::PLATFORM_OS_OPENBSD;
  } else {
    NOTREACHED();
    return false;
  }

  const char* arch = update_client::UpdateQueryParams::GetArch();
  if (strcmp(arch, "arm") == 0) {
    info->arch = extensions::api::runtime::PLATFORM_ARCH_ARM;
  } else if (strcmp(arch, "arm64") == 0) {
    info->arch = extensions::api::runtime::PLATFORM_ARCH_ARM64;
  } else if (strcmp(arch, "x86") == 0) {
    info->arch = extensions::api::runtime::PLATFORM_ARCH_X86_32;
  } else if (strcmp(arch, "x64") == 0) {
    info->arch = extensions::api::runtime::PLATFORM_ARCH_X86_64;
  } else {
    NOTREACHED();
    return false;
  }

  const char* nacl_arch = update_client::UpdateQueryParams::GetNaclArch();
  if (strcmp(nacl_arch, "arm") == 0) {
    info->nacl_arch = extensions::api::runtime::PLATFORM_NACL_ARCH_ARM;
  } else if (strcmp(nacl_arch, "arm64") == 0) {
    // Use ARM for ARM64 NaCl, as ARM64 NaCl is not available.
    info->nacl_arch = extensions::api::runtime::PLATFORM_NACL_ARCH_ARM;
  } else if (strcmp(nacl_arch, "x86-32") == 0) {
    info->nacl_arch = extensions::api::runtime::PLATFORM_NACL_ARCH_X86_32;
  } else if (strcmp(nacl_arch, "x86-64") == 0) {
    info->nacl_arch = extensions::api::runtime::PLATFORM_NACL_ARCH_X86_64;
  } else {
    NOTREACHED();
    return false;
  }

  return true;
}

bool ElectronRuntimeAPIDelegate::RestartDevice(std::string* error_message) {
  *error_message = "Restart is not supported in Electron";
  return false;
}

}  // namespace extensions
