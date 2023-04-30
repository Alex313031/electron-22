// Copyright (c) 2013 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/browser.h"

#include <fcntl.h>
#include <stdlib.h>

#include "base/command_line.h"
#include "base/environment.h"
#include "base/process/launch.h"
#include "electron/electron_version.h"
#include "shell/browser/native_window.h"
#include "shell/browser/window_list.h"
#include "shell/common/application_info.h"

#if BUILDFLAG(IS_LINUX)
#include "shell/browser/linux/unity_service.h"
#include "ui/gtk/gtk_util.h"  // nogncheck
#endif

namespace electron {

const char kXdgSettings[] = "xdg-settings";
const char kXdgSettingsDefaultSchemeHandler[] = "default-url-scheme-handler";

// The use of the ForTesting flavors is a hack workaround to avoid having to
// patch these as friends into the associated guard classes.
class LaunchXdgUtilityScopedAllowBaseSyncPrimitives
    : public base::ScopedAllowBaseSyncPrimitivesForTesting {};

class GetXdgAppOutputScopedAllowBlocking
    : public base::ScopedAllowBlockingForTesting {};

bool LaunchXdgUtility(const std::vector<std::string>& argv, int* exit_code) {
  *exit_code = EXIT_FAILURE;
  int devnull = open("/dev/null", O_RDONLY);
  if (devnull < 0)
    return false;

  base::LaunchOptions options;
  options.fds_to_remap.emplace_back(devnull, STDIN_FILENO);

  base::Process process = base::LaunchProcess(argv, options);
  close(devnull);

  if (!process.IsValid())
    return false;
  LaunchXdgUtilityScopedAllowBaseSyncPrimitives allow_base_sync_primitives;
  return process.WaitForExit(exit_code);
}

absl::optional<std::string> GetXdgAppOutput(
    const std::vector<std::string>& argv) {
  std::string reply;
  int success_code;
  GetXdgAppOutputScopedAllowBlocking allow_blocking;
  bool ran_ok = base::GetAppOutputWithExitCode(base::CommandLine(argv), &reply,
                                               &success_code);

  if (!ran_ok || success_code != EXIT_SUCCESS)
    return absl::optional<std::string>();

  return absl::make_optional(reply);
}

bool SetDefaultWebClient(const std::string& protocol) {
  auto env = base::Environment::Create();

  std::vector<std::string> argv = {kXdgSettings, "set"};
  if (!protocol.empty()) {
    argv.emplace_back(kXdgSettingsDefaultSchemeHandler);
    argv.emplace_back(protocol);
  }
  std::string desktop_name;
  if (!env->GetVar("CHROME_DESKTOP", &desktop_name)) {
    return false;
  }
  argv.emplace_back(desktop_name);

  int exit_code;
  bool ran_ok = LaunchXdgUtility(argv, &exit_code);
  return ran_ok && exit_code == EXIT_SUCCESS;
}

void Browser::AddRecentDocument(const base::FilePath& path) {}

void Browser::ClearRecentDocuments() {}

bool Browser::SetAsDefaultProtocolClient(const std::string& protocol,
                                         gin::Arguments* args) {
  return SetDefaultWebClient(protocol);
}

bool Browser::IsDefaultProtocolClient(const std::string& protocol,
                                      gin::Arguments* args) {
  auto env = base::Environment::Create();

  if (protocol.empty())
    return false;

  std::string desktop_name;
  if (!env->GetVar("CHROME_DESKTOP", &desktop_name))
    return false;
  const std::vector<std::string> argv = {kXdgSettings, "check",
                                         kXdgSettingsDefaultSchemeHandler,
                                         protocol, desktop_name};
  const auto output = GetXdgAppOutput(argv);
  if (!output)
    return false;

  // Allow any reply that starts with "yes".
  return base::StartsWith(output.value(), "yes", base::CompareCase::SENSITIVE);
}

// Todo implement
bool Browser::RemoveAsDefaultProtocolClient(const std::string& protocol,
                                            gin::Arguments* args) {
  return false;
}

std::u16string Browser::GetApplicationNameForProtocol(const GURL& url) {
  const std::vector<std::string> argv = {
      "xdg-mime", "query", "default",
      std::string("x-scheme-handler/") + url.scheme()};

  return base::ASCIIToUTF16(GetXdgAppOutput(argv).value_or(std::string()));
}

bool Browser::SetBadgeCount(absl::optional<int> count) {
  if (IsUnityRunning() && count.has_value()) {
    unity::SetDownloadCount(count.value());
    badge_count_ = count.value();
    return true;
  } else {
    return false;
  }
}

void Browser::SetLoginItemSettings(LoginItemSettings settings) {}

Browser::LoginItemSettings Browser::GetLoginItemSettings(
    const LoginItemSettings& options) {
  return LoginItemSettings();
}

std::string Browser::GetExecutableFileVersion() const {
  return GetApplicationVersion();
}

std::string Browser::GetExecutableFileProductName() const {
  return GetApplicationName();
}

bool Browser::IsUnityRunning() {
  return unity::IsRunning();
}

bool Browser::IsEmojiPanelSupported() {
  return false;
}

void Browser::ShowAboutPanel() {
  const auto& opts = about_panel_options_;

  if (!opts.is_dict()) {
    LOG(WARNING) << "Called showAboutPanel(), but didn't use "
                    "setAboutPanelSettings() first";
    return;
  }

  GtkWidget* dialogWidget = gtk_about_dialog_new();
  GtkAboutDialog* dialog = GTK_ABOUT_DIALOG(dialogWidget);

  const std::string* str;
  const base::Value* val;

  if ((str = opts.FindStringKey("applicationName"))) {
    gtk_about_dialog_set_program_name(dialog, str->c_str());
  }
  if ((str = opts.FindStringKey("applicationVersion"))) {
    gtk_about_dialog_set_version(dialog, str->c_str());
  }
  if ((str = opts.FindStringKey("copyright"))) {
    gtk_about_dialog_set_copyright(dialog, str->c_str());
  }
  if ((str = opts.FindStringKey("website"))) {
    gtk_about_dialog_set_website(dialog, str->c_str());
  }
  if ((str = opts.FindStringKey("iconPath"))) {
    GError* error = nullptr;
    constexpr int width = 64;   // width of about panel icon in pixels
    constexpr int height = 64;  // height of about panel icon in pixels

    // set preserve_aspect_ratio to true
    GdkPixbuf* icon =
        gdk_pixbuf_new_from_file_at_size(str->c_str(), width, height, &error);
    if (error != nullptr) {
      g_warning("%s", error->message);
      g_clear_error(&error);
    } else {
      gtk_about_dialog_set_logo(dialog, icon);
      g_clear_object(&icon);
    }
  }

  if ((val = opts.FindListKey("authors"))) {
    std::vector<const char*> cstrs;
    for (const auto& authorVal : val->GetListDeprecated()) {
      if (authorVal.is_string()) {
        cstrs.push_back(authorVal.GetString().c_str());
      }
    }
    if (cstrs.empty()) {
      LOG(WARNING) << "No author strings found in 'authors' array";
    } else {
      cstrs.push_back(nullptr);  // null-terminated char* array
      gtk_about_dialog_set_authors(dialog, cstrs.data());
    }
  }

  gtk_dialog_run(GTK_DIALOG(dialog));
  gtk_widget_destroy(dialogWidget);
}

void Browser::SetAboutPanelOptions(base::Value::Dict options) {
  about_panel_options_ = base::Value(std::move(options));
}

}  // namespace electron
