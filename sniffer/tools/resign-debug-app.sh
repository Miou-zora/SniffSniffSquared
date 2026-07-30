#!/usr/bin/env bash
# Make a debuggable copy of the Dofus client so Frida can attach to it.
#
# Why this is needed: the shipped binary is signed with the hardened runtime
# and WITHOUT `com.apple.security.get-task-allow`. Under SIP, nothing can
# attach to such a process — not even root. `sudo frida` fails with
#   frida.PermissionDeniedError: unable to access process with pid N
# The fix is to re-sign a COPY ad-hoc with that entitlement added. The original
# install is never touched.
#
# Usage:
#   ./tools/resign-debug-app.sh [SRC_APP] [DEST_APP]
# Defaults:
#   SRC  /Applications/Ankama/Dofus-dofus3/Dofus.app
#   DEST ./build/Dofus-debug.app
#
# Then:
#   "$DEST/Contents/MacOS/Dofus" &          # launch the copy
#   tools/frida/run.py -p <pid>             # attach and dump
set -euo pipefail

# The copy MUST live beside the original. Dofus resolves its Addressables
# catalogs relative to the launch directory; run it from anywhere else and it
# dies early with
#     ERROR [Addressables] (AddressableUtility:118) - Unable to find catalog list
# The window opens but the game never boots: DataCenter never loads, no
# per-frame method ever runs, and the protocol descriptors cannot initialise.
# It looks like a hung client rather than a failed one.
SRC="${1:-/Applications/Ankama/Dofus-dofus3/Dofus.app}"
DEST="${2:-$(dirname "${1:-/Applications/Ankama/Dofus-dofus3/Dofus.app}")/Dofus-debug.app}"

[ -d "$SRC" ] || { echo "source app not found: $SRC" >&2; exit 1; }

echo ">> copying $SRC"
echo "        -> $DEST   (~465 MB)"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

ENT="$(dirname "$DEST")/dofus-debug.entitlements"
cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<!-- the two the shipped binary already carries -->
	<key>com.apple.security.cs.disable-executable-page-protection</key>
	<true/>
	<key>com.apple.security.cs.disable-library-validation</key>
	<true/>
	<!-- added: what lets a debugger / Frida attach under SIP -->
	<key>com.apple.security.get-task-allow</key>
	<true/>
	<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
	<true/>
	<key>com.apple.security.cs.allow-dyld-environment-variables</key>
	<true/>
</dict>
PLIST
echo "</plist>" >> "$ENT"

# Nested code must be signed before the outer bundle, or sealing the bundle
# fails with "code object is not signed at all" for the inner Mach-Os.
echo ">> re-signing nested dylibs / bundles"
find "$DEST/Contents/Frameworks" "$DEST/Contents/PlugIns" -maxdepth 1 \
     \( -name "*.dylib" -o -name "*.bundle" \) -print0 2>/dev/null |
while IFS= read -r -d '' f; do
  codesign -f -s - --timestamp=none "$f" >/dev/null 2>&1 || echo "   FAILED: $(basename "$f")"
done

echo ">> re-signing bundle with get-task-allow"
codesign -f -s - --options runtime --entitlements "$ENT" --timestamp=none "$DEST"

echo ">> verifying"
codesign -v --verbose=2 "$DEST" 2>&1 | tail -2
# expect: flags=0x10002(adhoc,runtime)
codesign -dv "$DEST/Contents/MacOS/Dofus" 2>&1 | grep -E "CodeDirectory|Signature"
codesign -d --entitlements - "$DEST/Contents/MacOS/Dofus" 2>&1 | grep -q "get-task-allow" \
  && echo ">> OK: get-task-allow present" \
  || { echo ">> ERROR: entitlement missing" >&2; exit 1; }

cat <<EOF

Next — note the cd, it is required, see the comment at the top of this script:

  cd "$(dirname "$DEST")"
  ./$(basename "$DEST")/Contents/MacOS/Dofus --gameName dofus --gameRelease dofus3 --langCode fr &
  # give it ~30s, confirm it actually booted:
  grep -c "Unable to find catalog list" ~/Library/Logs/Ankama/Dofus/Player.log   # want 0
  tail ~/Library/Logs/Ankama/Dofus/Player.log                                    # want EventSystem:Update()
  ~/.local/pipx/venvs/frida-tools/bin/python tools/frida/run.py -p <pid>

The scan makes the client unresponsive for its whole duration. Run it against
this copy, not a client you are playing on.

To remove: rm -rf "$DEST"
EOF
