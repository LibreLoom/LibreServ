# Luna Android APK (android image). /src is read-only; gradle caches and the
# build dirs are volumes. A release build (LUNA_ANDROID_RELEASE=1) makes an
# UNSIGNED release APK: gradle runs plugins and dependencies from the network,
# so it never gets a keystore or a password. android-sign.sh signs it in a
# separate container with no network. Without it the APK is debug-signed.
# Every dependency is checked against gradle/verification-metadata.xml.
set -eu
cd /src/luna/mobile
# Persist the debug signing key, so debug APKs keep installing over each other.
export ANDROID_USER_HOME=/root/.gradle/android
mkdir -p "$ANDROID_USER_HOME"
if [ "${LUNA_ANDROID_RELEASE:-}" = 1 ]; then
	task=assembleRelease
	out=app/build/outputs/apk/release/app-release-unsigned.apk
	dest=/out/unsigned.apk
else
	echo "no keystore given: building a debug-signed APK"
	task=assembleDebug
	out=app/build/outputs/apk/debug/app-debug.apk
	dest=/out/luna-android.apk
fi
test -f gradle/verification-metadata.xml
rm -f "$out"
./gradlew "$task" --no-daemon --console=plain --warning-mode=summary --dependency-verification=strict -Dorg.gradle.jvmargs=-Xmx2g
test -f "$out"
# The APK must say it is the version this build is for (a stale build
# directory or a mismatched gradle file would show up here).
aapt2=$(ls "$ANDROID_HOME"/build-tools/*/aapt2 | sort -V | tail -1)
badging=$("$aapt2" dump badging "$out" | sed -n 's/^package: //p')
got_name=$(printf '%s\n' "$badging" | sed -n "s/.* versionName='\([^']*\)'.*/\1/p")
got_code=$(printf '%s\n' "$badging" | sed -n "s/.* versionCode='\([0-9]*\)'.*/\1/p")
if [ "$got_name" != "$EXPECT_VERSION_NAME" ] || [ "$got_code" != "$EXPECT_VERSION_CODE" ]; then
	echo "APK says version $got_name (code $got_code), expected $EXPECT_VERSION_NAME (code $EXPECT_VERSION_CODE)" >&2
	exit 1
fi
echo "APK version $got_name (code $got_code) matches"
cp "$out" "$dest"
