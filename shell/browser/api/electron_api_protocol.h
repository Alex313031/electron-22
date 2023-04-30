// Copyright (c) 2019 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_API_ELECTRON_API_PROTOCOL_H_
#define ELECTRON_SHELL_BROWSER_API_ELECTRON_API_PROTOCOL_H_

#include <string>
#include <vector>

#include "content/public/browser/content_browser_client.h"
#include "gin/handle.h"
#include "gin/wrappable.h"
#include "shell/browser/net/electron_url_loader_factory.h"

namespace electron {

class ElectronBrowserContext;
class ProtocolRegistry;

namespace api {

std::vector<std::string> GetStandardSchemes();

void AddServiceWorkerScheme(const std::string& scheme);

void RegisterSchemesAsPrivileged(gin_helper::ErrorThrower thrower,
                                 v8::Local<v8::Value> val);

// Possible errors.
enum class ProtocolError {
  kOK,  // no error
  kRegistered,
  kNotRegistered,
  kIntercepted,
  kNotIntercepted,
};

// Protocol implementation based on network services.
class Protocol : public gin::Wrappable<Protocol> {
 public:
  static gin::Handle<Protocol> Create(v8::Isolate* isolate,
                                      ElectronBrowserContext* browser_context);

  // gin::Wrappable
  static gin::WrapperInfo kWrapperInfo;
  gin::ObjectTemplateBuilder GetObjectTemplateBuilder(
      v8::Isolate* isolate) override;
  const char* GetTypeName() override;

 private:
  Protocol(v8::Isolate* isolate, ProtocolRegistry* protocol_registry);
  ~Protocol() override;

  // Callback types.
  using CompletionCallback =
      base::RepeatingCallback<void(v8::Local<v8::Value>)>;

  // JS APIs.
  ProtocolError RegisterProtocol(ProtocolType type,
                                 const std::string& scheme,
                                 const ProtocolHandler& handler);
  bool UnregisterProtocol(const std::string& scheme, gin::Arguments* args);
  bool IsProtocolRegistered(const std::string& scheme);

  ProtocolError InterceptProtocol(ProtocolType type,
                                  const std::string& scheme,
                                  const ProtocolHandler& handler);
  bool UninterceptProtocol(const std::string& scheme, gin::Arguments* args);
  bool IsProtocolIntercepted(const std::string& scheme);

  // Old async version of IsProtocolRegistered.
  v8::Local<v8::Promise> IsProtocolHandled(const std::string& scheme,
                                           gin::Arguments* args);

  // Helper for converting old registration APIs to new RegisterProtocol API.
  template <ProtocolType type>
  bool RegisterProtocolFor(const std::string& scheme,
                           const ProtocolHandler& handler,
                           gin::Arguments* args) {
    auto result = RegisterProtocol(type, scheme, handler);
    HandleOptionalCallback(args, result);
    return result == ProtocolError::kOK;
  }
  template <ProtocolType type>
  bool InterceptProtocolFor(const std::string& scheme,
                            const ProtocolHandler& handler,
                            gin::Arguments* args) {
    auto result = InterceptProtocol(type, scheme, handler);
    HandleOptionalCallback(args, result);
    return result == ProtocolError::kOK;
  }

  // Be compatible with old interface, which accepts optional callback.
  void HandleOptionalCallback(gin::Arguments* args, ProtocolError error);

  // Weak pointer; the lifetime of the ProtocolRegistry is guaranteed to be
  // longer than the lifetime of this JS interface.
  ProtocolRegistry* protocol_registry_;
};

}  // namespace api

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_API_ELECTRON_API_PROTOCOL_H_
