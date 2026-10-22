#!/usr/bin/env bash
# Install the Android SDK the app build needs, once, onto the persistent
# volume. Idempotent: a later container creation re-checks the sentinel and
# returns in milliseconds.
#
# Usage:  bash /workspace/.devcontainer/android-sdk.sh
#
# Why this is not part of restore-post-rebuild.sh: that script restores the
# /voice chain (netcat, ssh config, tailscaled, ssh verification), and a ~1.5 GB
# download sitting between the tailscaled launch and the verification would
# stall the check that script exists to perform on a slow first run, and would
# make "restore the voice container side" mean two unrelated things. Called
# last in postCreateCommand for the same reason: the container is usable, and
# /voice is verified, before this starts.
#
# Why the SDK is on the volume and not in the image: it is ~1.5 GB and only one
# project needs it. The JDK and unzip are in the Dockerfile instead, because
# apt needs root and those are small. The SDK path is stable
# (/home/vscode/.pi/android-sdk), so a project's local.properties written
# against it keeps working across rebuilds; the exports for it are baked into
# the image's shell rc files, not written here.
#
# Deliberately no `set -e`: the Android SDK is optional for this container, and
# a failed install must not abort the rest of container creation. Failures are
# reported as warnings, with the full sdkmanager output in
# $PI/cache/sdkmanager.log.

PI="${AGENT_PI_DIR:-/home/vscode/.pi}"
SDK="$PI/android-sdk"
ZIP="$PI/cache/cmdline-tools.zip"
LOG="$PI/cache/sdkmanager.log"
PLATFORM=android-35
BUILD_TOOLS=35.0.0

# The sentinel is written only after every component is verified present. A
# probe on directories alone is not enough: postCreateCommand can be killed
# mid-install, and an interrupted sdkmanager leaves an empty platforms/android-35
# behind, which a `-d` test reports as installed forever.
if [ -f "$SDK/.ready" ] \
	&& [ -x "$SDK/platform-tools/adb" ] \
	&& [ -x "$SDK/build-tools/$BUILD_TOOLS/aapt2" ]; then
	echo "[android-sdk] present at $SDK"
	exit 0
fi

mkdir -p "$SDK/cmdline-tools" "$PI/cache"
echo "[android-sdk] installing into $SDK (first time only, ~1.5 GB)"

# A cached zip is reused, but only if it is a *valid* archive. `[ -s ]` is not
# enough: an interrupted curl leaves a non-empty partial file, and that would
# then fail to unzip on every subsequent run with the download skipped.
if ! unzip -tq "$ZIP" >/dev/null 2>&1; then
	rm -f "$ZIP" "$ZIP.part"
	# Newest first. Google keeps old cmdline-tools builds up, but there is no
	# promise it will, so the second URL is the fallback rather than the default.
	for ver in 13114758 11076708; do
		if curl -fsSL --max-time 900 -o "$ZIP.part" \
			"https://dl.google.com/android/repository/commandlinetools-linux-${ver}_latest.zip" \
			&& unzip -tq "$ZIP.part" >/dev/null 2>&1; then
			mv "$ZIP.part" "$ZIP"
			break
		fi
		rm -f "$ZIP.part"
	done
fi

if [ ! -s "$ZIP" ]; then
	echo "[android-sdk] WARNING: could not download the Android cmdline-tools; the app build will fail" >&2
	exit 0
fi

rm -rf "$SDK/cmdline-tools/latest" "$SDK/cmdline-tools/tmp"
mkdir -p "$SDK/cmdline-tools/tmp"
if ! unzip -q "$ZIP" -d "$SDK/cmdline-tools/tmp"; then
	echo "[android-sdk] WARNING: $ZIP did not unpack; deleting it so the next run re-downloads" >&2
	rm -f "$ZIP"
	rm -rf "$SDK/cmdline-tools/tmp"
	exit 0
fi
mv "$SDK/cmdline-tools/tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
rm -rf "$SDK/cmdline-tools/tmp"
# The zip carries the mode, but a filesystem or an unzip that drops it leaves
# sdkmanager unrunnable, and the failure then reads as "install did not
# complete" with no hint. One chmod is cheaper than that hunt.
chmod +x "$SDK/cmdline-tools/latest/bin/sdkmanager" 2>/dev/null

# sdkmanager writes progress to stderr and its failures are otherwise
# indistinguishable from its success, since both are discarded below.
: > "$LOG"
yes 2>/dev/null | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >>"$LOG" 2>&1
"$SDK/cmdline-tools/latest/bin/sdkmanager" \
	"platform-tools" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" >>"$LOG" 2>&1

if [ -x "$SDK/platform-tools/adb" ] && [ -x "$SDK/build-tools/$BUILD_TOOLS/aapt2" ]; then
	: > "$SDK/.ready"
	echo "[android-sdk] ready: $SDK"
else
	echo "[android-sdk] WARNING: the SDK install did not complete; see $LOG" >&2
fi

exit 0
