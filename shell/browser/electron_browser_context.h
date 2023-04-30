// Copyright (c) 2013 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_ELECTRON_BROWSER_CONTEXT_H_
#define ELECTRON_SHELL_BROWSER_ELECTRON_BROWSER_CONTEXT_H_

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "chrome/browser/predictors/preconnect_manager.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/media_stream_request.h"
#include "content/public/browser/resource_context.h"
#include "electron/buildflags/buildflags.h"
#include "gin/arguments.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"
#include "shell/browser/media/media_device_id_salt.h"
#include "third_party/blink/public/common/permissions/permission_utils.h"

class PrefService;
class ValueMapPrefStore;

namespace network {
class SharedURLLoaderFactory;
}

namespace storage {
class SpecialStoragePolicy;
}

#if BUILDFLAG(ENABLE_ELECTRON_EXTENSIONS)
namespace extensions {
class ElectronExtensionSystem;
}
#endif

namespace v8 {
template <typename T>
class Local;
class Isolate;
class Value;
}  // namespace v8

namespace electron {

using DevicePermissionMap =
    std::map<blink::PermissionType,
             std::map<url::Origin, std::vector<std::unique_ptr<base::Value>>>>;

class ElectronDownloadManagerDelegate;
class ElectronPermissionManager;
class CookieChangeNotifier;
class ResolveProxyHelper;
class WebViewManager;
class ProtocolRegistry;

using DisplayMediaResponseCallbackJs =
    base::OnceCallback<void(gin::Arguments* args)>;
using DisplayMediaRequestHandler =
    base::RepeatingCallback<void(const content::MediaStreamRequest&,
                                 DisplayMediaResponseCallbackJs)>;

class ElectronBrowserContext : public content::BrowserContext {
 public:
  // disable copy
  ElectronBrowserContext(const ElectronBrowserContext&) = delete;
  ElectronBrowserContext& operator=(const ElectronBrowserContext&) = delete;

  // partition_id => browser_context
  struct PartitionKey {
    std::string partition;
    bool in_memory;

    PartitionKey(const std::string& partition, bool in_memory)
        : partition(partition), in_memory(in_memory) {}

    bool operator<(const PartitionKey& other) const {
      if (partition == other.partition)
        return in_memory < other.in_memory;
      return partition < other.partition;
    }

    bool operator==(const PartitionKey& other) const {
      return (partition == other.partition) && (in_memory == other.in_memory);
    }
  };
  using BrowserContextMap =
      std::map<PartitionKey, std::unique_ptr<ElectronBrowserContext>>;

  // Get or create the BrowserContext according to its |partition| and
  // |in_memory|. The |options| will be passed to constructor when there is no
  // existing BrowserContext.
  static ElectronBrowserContext* From(const std::string& partition,
                                      bool in_memory,
                                      base::Value::Dict options = {});

  static BrowserContextMap& browser_context_map();

  void SetUserAgent(const std::string& user_agent);
  std::string GetUserAgent() const;
  bool CanUseHttpCache() const;
  int GetMaxCacheSize() const;
  ResolveProxyHelper* GetResolveProxyHelper();
  predictors::PreconnectManager* GetPreconnectManager();
  scoped_refptr<network::SharedURLLoaderFactory> GetURLLoaderFactory();

  // content::BrowserContext:
  base::FilePath GetPath() override;
  bool IsOffTheRecord() override;
  content::ResourceContext* GetResourceContext() override;
  std::unique_ptr<content::ZoomLevelDelegate> CreateZoomLevelDelegate(
      const base::FilePath& partition_path) override;
  content::PushMessagingService* GetPushMessagingService() override;
  content::SSLHostStateDelegate* GetSSLHostStateDelegate() override;
  content::BackgroundFetchDelegate* GetBackgroundFetchDelegate() override;
  content::BackgroundSyncController* GetBackgroundSyncController() override;
  content::BrowsingDataRemoverDelegate* GetBrowsingDataRemoverDelegate()
      override;
  std::string GetMediaDeviceIDSalt() override;
  content::DownloadManagerDelegate* GetDownloadManagerDelegate() override;
  content::BrowserPluginGuestManager* GetGuestManager() override;
  content::PlatformNotificationService* GetPlatformNotificationService()
      override;
  content::PermissionControllerDelegate* GetPermissionControllerDelegate()
      override;
  storage::SpecialStoragePolicy* GetSpecialStoragePolicy() override;
  content::ClientHintsControllerDelegate* GetClientHintsControllerDelegate()
      override;
  content::StorageNotificationService* GetStorageNotificationService() override;
  content::ReduceAcceptLanguageControllerDelegate*
  GetReduceAcceptLanguageControllerDelegate() override;

  CookieChangeNotifier* cookie_change_notifier() const {
    return cookie_change_notifier_.get();
  }
  PrefService* prefs() const { return prefs_.get(); }
  ValueMapPrefStore* in_memory_pref_store() const {
    return in_memory_pref_store_.get();
  }
  base::WeakPtr<ElectronBrowserContext> GetWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

#if BUILDFLAG(ENABLE_ELECTRON_EXTENSIONS)
  extensions::ElectronExtensionSystem* extension_system() {
    // Guard usages of extension_system() with !IsOffTheRecord()
    // There is no extension system for in-memory sessions
    DCHECK(!IsOffTheRecord());
    return extension_system_;
  }
#endif

  ProtocolRegistry* protocol_registry() const {
    return protocol_registry_.get();
  }

  void SetSSLConfig(network::mojom::SSLConfigPtr config);
  network::mojom::SSLConfigPtr GetSSLConfig();
  void SetSSLConfigClient(mojo::Remote<network::mojom::SSLConfigClient> client);

  bool ChooseDisplayMediaDevice(const content::MediaStreamRequest& request,
                                content::MediaResponseCallback callback);
  void SetDisplayMediaRequestHandler(DisplayMediaRequestHandler handler);

  ~ElectronBrowserContext() override;

  // Grants |origin| access to |device|.
  // To be used in place of ObjectPermissionContextBase::GrantObjectPermission.
  void GrantDevicePermission(const url::Origin& origin,
                             const base::Value& device,
                             blink::PermissionType permissionType);

  // Revokes |origin| access to |device|.
  // To be used in place of ObjectPermissionContextBase::RevokeObjectPermission.
  void RevokeDevicePermission(const url::Origin& origin,
                              const base::Value& device,
                              blink::PermissionType permission_type);

  // Returns the list of devices that |origin| has been granted permission to
  // access. To be used in place of
  // ObjectPermissionContextBase::GetGrantedObjects.
  bool CheckDevicePermission(const url::Origin& origin,
                             const base::Value& device,
                             blink::PermissionType permissionType);

 private:
  ElectronBrowserContext(const std::string& partition,
                         bool in_memory,
                         base::Value::Dict options);

  static void DisplayMediaDeviceChosen(
      const content::MediaStreamRequest& request,
      content::MediaResponseCallback callback,
      gin::Arguments* args);

  // Initialize pref registry.
  void InitPrefs();

  bool DoesDeviceMatch(const base::Value& device,
                       const base::Value* device_to_compare,
                       blink::PermissionType permission_type);

  scoped_refptr<ValueMapPrefStore> in_memory_pref_store_;
  std::unique_ptr<content::ResourceContext> resource_context_;
  std::unique_ptr<CookieChangeNotifier> cookie_change_notifier_;
  std::unique_ptr<PrefService> prefs_;
  std::unique_ptr<ElectronDownloadManagerDelegate> download_manager_delegate_;
  std::unique_ptr<WebViewManager> guest_manager_;
  std::unique_ptr<ElectronPermissionManager> permission_manager_;
  std::unique_ptr<MediaDeviceIDSalt> media_device_id_salt_;
  scoped_refptr<ResolveProxyHelper> resolve_proxy_helper_;
  scoped_refptr<storage::SpecialStoragePolicy> storage_policy_;
  std::unique_ptr<predictors::PreconnectManager> preconnect_manager_;
  std::unique_ptr<ProtocolRegistry> protocol_registry_;

  absl::optional<std::string> user_agent_;
  base::FilePath path_;
  bool in_memory_ = false;
  bool use_cache_ = true;
  int max_cache_size_ = 0;

#if BUILDFLAG(ENABLE_ELECTRON_EXTENSIONS)
  // Owned by the KeyedService system.
  extensions::ElectronExtensionSystem* extension_system_;
#endif

  // Shared URLLoaderFactory.
  scoped_refptr<network::SharedURLLoaderFactory> url_loader_factory_;

  network::mojom::SSLConfigPtr ssl_config_;
  mojo::Remote<network::mojom::SSLConfigClient> ssl_config_client_;

  DisplayMediaRequestHandler display_media_request_handler_;

  // In-memory cache that holds objects that have been granted permissions.
  DevicePermissionMap granted_devices_;

  base::WeakPtrFactory<ElectronBrowserContext> weak_factory_{this};
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_ELECTRON_BROWSER_CONTEXT_H_
