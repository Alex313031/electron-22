// Copyright (c) 2019 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_COMMON_PROCESS_UTIL_H_
#define ELECTRON_SHELL_COMMON_PROCESS_UTIL_H_

#include <string>

namespace node {
class Environment;
}

namespace electron {

void EmitWarning(node::Environment* env,
                 const std::string& warning_msg,
                 const std::string& warning_type);

}  // namespace electron

#endif  // ELECTRON_SHELL_COMMON_PROCESS_UTIL_H_
