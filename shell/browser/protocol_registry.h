// Copyright (c) 2020 Slack Technologies, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_PROTOCOL_REGISTRY_H_
#define ELECTRON_SHELL_BROWSER_PROTOCOL_REGISTRY_H_

#include <string>

#include "content/public/browser/content_browser_client.h"
#include "shell/browser/net/electron_url_loader_factory.h"

namespace content {
class BrowserContext;
}

namespace electron {

class ProtocolRegistry {
 public:
  ~ProtocolRegistry();

  static ProtocolRegistry* FromBrowserContext(content::BrowserContext*);

  using URLLoaderFactoryType =
      content::ContentBrowserClient::URLLoaderFactoryType;

  void RegisterURLLoaderFactories(
      content::ContentBrowserClient::NonNetworkURLLoaderFactoryMap* factories,
      bool allow_file_access);

  const HandlersMap& intercept_handlers() const { return intercept_handlers_; }
  const HandlersMap& handlers() const { return handlers_; }

  bool RegisterProtocol(ProtocolType type,
                        const std::string& scheme,
                        const ProtocolHandler& handler);
  bool UnregisterProtocol(const std::string& scheme);
  bool IsProtocolRegistered(const std::string& scheme);

  bool InterceptProtocol(ProtocolType type,
                         const std::string& scheme,
                         const ProtocolHandler& handler);
  bool UninterceptProtocol(const std::string& scheme);
  bool IsProtocolIntercepted(const std::string& scheme);

 private:
  friend class ElectronBrowserContext;

  ProtocolRegistry();

  HandlersMap handlers_;
  HandlersMap intercept_handlers_;
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_PROTOCOL_REGISTRY_H_
