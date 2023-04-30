// Copyright (c) 2014 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/ui/x/x_window_utils.h"

#include <memory>

#include "base/environment.h"
#include "base/strings/string_util.h"
#include "base/threading/thread_restrictions.h"
#include "dbus/bus.h"
#include "dbus/message.h"
#include "dbus/object_proxy.h"
#include "ui/base/x/x11_util.h"
#include "ui/gfx/x/x11_atom_cache.h"
#include "ui/gfx/x/xproto.h"
#include "ui/gfx/x/xproto_util.h"

namespace electron {

void SetWMSpecState(x11::Window window, bool enabled, x11::Atom state) {
  ui::SendClientMessage(
      window, ui::GetX11RootWindow(), x11::GetAtom("_NET_WM_STATE"),
      {static_cast<uint32_t>(enabled ? 1 : 0), static_cast<uint32_t>(state),
       static_cast<uint32_t>(x11::Window::None), 1, 0});
}

void SetWindowType(x11::Window window, const std::string& type) {
  std::string type_prefix = "_NET_WM_WINDOW_TYPE_";
  x11::Atom window_type = x11::GetAtom(type_prefix + base::ToUpperASCII(type));
  x11::SetProperty(window, x11::GetAtom("_NET_WM_WINDOW_TYPE"), x11::Atom::ATOM,
                   window_type);
}

bool ShouldUseGlobalMenuBar() {
  base::ThreadRestrictions::ScopedAllowIO allow_io;
  auto env = base::Environment::Create();
  if (env->HasVar("ELECTRON_FORCE_WINDOW_MENU_BAR"))
    return false;

  dbus::Bus::Options options;
  auto bus = base::MakeRefCounted<dbus::Bus>(options);

  dbus::ObjectProxy* object_proxy =
      bus->GetObjectProxy(DBUS_SERVICE_DBUS, dbus::ObjectPath(DBUS_PATH_DBUS));
  dbus::MethodCall method_call(DBUS_INTERFACE_DBUS, "ListNames");
  std::unique_ptr<dbus::Response> response(object_proxy->CallMethodAndBlock(
      &method_call, dbus::ObjectProxy::TIMEOUT_USE_DEFAULT));
  if (!response) {
    bus->ShutdownAndBlock();
    return false;
  }

  dbus::MessageReader reader(response.get());
  dbus::MessageReader array_reader(nullptr);
  if (!reader.PopArray(&array_reader)) {
    bus->ShutdownAndBlock();
    return false;
  }
  while (array_reader.HasMoreData()) {
    std::string name;
    if (array_reader.PopString(&name) &&
        name == "com.canonical.AppMenu.Registrar") {
      bus->ShutdownAndBlock();
      return true;
    }
  }

  bus->ShutdownAndBlock();
  return false;
}

void MoveWindowToForeground(x11::Window window) {
  MoveWindowAbove(window, static_cast<x11::Window>(0));
}

void MoveWindowAbove(x11::Window window, x11::Window other_window) {
  ui::SendClientMessage(window, ui::GetX11RootWindow(),
                        x11::GetAtom("_NET_RESTACK_WINDOW"),
                        {2, static_cast<uint32_t>(other_window),
                         static_cast<uint32_t>(x11::StackMode::Above), 0, 0});
}

bool IsWindowValid(x11::Window window) {
  auto* conn = x11::Connection::Get();
  return conn->GetWindowAttributes({window}).Sync();
}

}  // namespace electron
