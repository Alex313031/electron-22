// Copyright (c) 2015 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_COMMON_KEYBOARD_UTIL_H_
#define ELECTRON_SHELL_COMMON_KEYBOARD_UTIL_H_

#include <string>

#include "third_party/abseil-cpp/absl/types/optional.h"
#include "ui/events/keycodes/keyboard_codes.h"

namespace electron {

// Return key code of the char, and also determine whether the SHIFT key is
// pressed.
ui::KeyboardCode KeyboardCodeFromCharCode(char16_t c, bool* shifted);

// Return key code of the |str|, if the original key is a shifted character,
// for example + and /, set it in |shifted_char|.
// pressed.
ui::KeyboardCode KeyboardCodeFromStr(const std::string& str,
                                     absl::optional<char16_t>* shifted_char);

}  // namespace electron

#endif  // ELECTRON_SHELL_COMMON_KEYBOARD_UTIL_H_
