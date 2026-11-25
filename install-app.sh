#!/bin/sh
# Install the phone-code Mac app. Kept for links to it: this is install.sh --app.
#
#   curl -fsSL https://raw.githubusercontent.com/SloanBDavis/phone-code/main/install.sh | sh
#
# installs the phonecode command, the app, or both.
set -eu
curl -fsSL "${PHONECODE_INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/SloanBDavis/phone-code/main/install.sh}" | sh -s -- --app
