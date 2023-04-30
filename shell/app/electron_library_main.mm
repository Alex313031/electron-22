// Copyright (c) 2013 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include <utility>

#include "shell/app/electron_library_main.h"

#include "base/at_exit.h"
#include "base/i18n/icu_util.h"
#include "base/mac/bundle_locations.h"
#include "base/mac/scoped_nsautorelease_pool.h"
#include "content/public/app/content_main.h"
#include "electron/fuses.h"
#include "shell/app/electron_main_delegate.h"
#include "shell/app/node_main.h"
#include "shell/common/electron_command_line.h"
#include "shell/common/mac/main_application_bundle.h"

int ElectronMain(int argc, char* argv[]) {
  electron::ElectronMainDelegate delegate;
  content::ContentMainParams params(&delegate);
  params.argc = argc;
  params.argv = const_cast<const char**>(argv);
  electron::ElectronCommandLine::Init(argc, argv);
  return content::ContentMain(std::move(params));
}

#if BUILDFLAG(ENABLE_RUN_AS_NODE)
int ElectronInitializeICUandStartNode(int argc, char* argv[]) {
  if (!electron::fuses::IsRunAsNodeEnabled()) {
    CHECK(false) << "run_as_node fuse is disabled";
    return 1;
  }

  base::AtExitManager atexit_manager;
  base::mac::ScopedNSAutoreleasePool pool;
  base::mac::SetOverrideFrameworkBundlePath(
      electron::MainApplicationBundlePath()
          .Append("Contents")
          .Append("Frameworks")
          .Append(ELECTRON_PRODUCT_NAME " Framework.framework"));
  base::i18n::InitializeICU();
  return electron::NodeMain(argc, argv);
}
#endif
