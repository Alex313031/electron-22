// Copyright (c) 2012 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// This interface is for managing the global services of the application. Each
// service is lazily created when requested the first time. The service getters
// will return NULL if the service is not available, so callers must check for
// this condition.

#ifndef ELECTRON_SHELL_BROWSER_BROWSER_PROCESS_IMPL_H_
#define ELECTRON_SHELL_BROWSER_BROWSER_PROCESS_IMPL_H_

#include <memory>
#include <string>

#include "base/command_line.h"
#include "chrome/browser/browser_process.h"
#include "components/prefs/pref_service.h"
#include "components/prefs/value_map_pref_store.h"
#include "printing/buildflags/buildflags.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "shell/browser/net/system_network_context_manager.h"

namespace printing {
class PrintJobManager;
}

// Empty definition for std::unique_ptr, rather than a forward declaration
class BackgroundModeManager {};

// NOT THREAD SAFE, call only from the main thread.
// These functions shouldn't return NULL unless otherwise noted.
class BrowserProcessImpl : public BrowserProcess {
 public:
  BrowserProcessImpl();
  ~BrowserProcessImpl() override;

  // disable copy
  BrowserProcessImpl(const BrowserProcessImpl&) = delete;
  BrowserProcessImpl& operator=(const BrowserProcessImpl&) = delete;

  static void ApplyProxyModeFromCommandLine(ValueMapPrefStore* pref_store);

  BuildState* GetBuildState() override;
  breadcrumbs::BreadcrumbPersistentStorageManager*
  GetBreadcrumbPersistentStorageManager() override;
  void PostEarlyInitialization();
  void PreCreateThreads();
  void PostDestroyThreads() {}
  void PostMainMessageLoopRun();

  void SetSystemLocale(const std::string& locale);
  const std::string& GetSystemLocale() const;

  void EndSession() override {}
  void FlushLocalStateAndReply(base::OnceClosure reply) override {}
  bool IsShuttingDown() override;

  metrics_services_manager::MetricsServicesManager* GetMetricsServicesManager()
      override;
  metrics::MetricsService* metrics_service() override;
  ProfileManager* profile_manager() override;
  PrefService* local_state() override;
  scoped_refptr<network::SharedURLLoaderFactory> shared_url_loader_factory()
      override;
  variations::VariationsService* variations_service() override;
  BrowserProcessPlatformPart* platform_part() override;
  extensions::EventRouterForwarder* extension_event_router_forwarder() override;
  NotificationUIManager* notification_ui_manager() override;
  NotificationPlatformBridge* notification_platform_bridge() override;
  SystemNetworkContextManager* system_network_context_manager() override;
  network::NetworkQualityTracker* network_quality_tracker() override;
  policy::ChromeBrowserPolicyConnector* browser_policy_connector() override;
  policy::PolicyService* policy_service() override;
  IconManager* icon_manager() override;
  GpuModeManager* gpu_mode_manager() override;
  printing::PrintPreviewDialogController* print_preview_dialog_controller()
      override;
  printing::BackgroundPrintingManager* background_printing_manager() override;
  IntranetRedirectDetector* intranet_redirect_detector() override;
  DownloadStatusUpdater* download_status_updater() override;
  DownloadRequestLimiter* download_request_limiter() override;
  BackgroundModeManager* background_mode_manager() override;
  StatusTray* status_tray() override;
  safe_browsing::SafeBrowsingService* safe_browsing_service() override;
  subresource_filter::RulesetService* subresource_filter_ruleset_service()
      override;
  component_updater::ComponentUpdateService* component_updater() override;
  MediaFileSystemRegistry* media_file_system_registry() override;
  WebRtcLogUploader* webrtc_log_uploader() override;
  network_time::NetworkTimeTracker* network_time_tracker() override;
  gcm::GCMDriver* gcm_driver() override;
  resource_coordinator::ResourceCoordinatorParts* resource_coordinator_parts()
      override;
  resource_coordinator::TabManager* GetTabManager() override;
  SerialPolicyAllowedPorts* serial_policy_allowed_ports() override;
  HidPolicyAllowedDevices* hid_policy_allowed_devices() override;
  void CreateDevToolsProtocolHandler() override {}
  void CreateDevToolsAutoOpener() override {}
  void set_background_mode_manager_for_test(
      std::unique_ptr<BackgroundModeManager> manager) override {}
#if (BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX))
  void StartAutoupdateTimer() override {}
#endif
  void SetApplicationLocale(const std::string& locale) override;
  const std::string& GetApplicationLocale() override;
  printing::PrintJobManager* print_job_manager() override;
  StartupData* startup_data() override;

 private:
#if BUILDFLAG(ENABLE_PRINTING)
  std::unique_ptr<printing::PrintJobManager> print_job_manager_;
#endif
  std::unique_ptr<PrefService> local_state_;
  std::string locale_;
  std::string system_locale_;
};

#endif  // ELECTRON_SHELL_BROWSER_BROWSER_PROCESS_IMPL_H_
