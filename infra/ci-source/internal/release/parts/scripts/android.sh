# Luna Android APK (android image). /src is read-only; gradle caches and the
# build dirs are volumes. A keystore (LUNA_ANDROID_KEYSTORE=/keys/...) makes a
# signed release build; without one the APK is debug-signed. Passwords arrive
# in the environment, never on a command line.
set -eu
cd /src/luna/mobile
# Persist the debug signing key, so debug APKs keep installing over each other.
export ANDROID_USER_HOME=/root/.gradle/android
mkdir -p "$ANDROID_USER_HOME"
if [ -n "${LUNA_ANDROID_KEYSTORE:-}" ]; then
	task=assembleRelease
	out=app/build/outputs/apk/release/app-release.apk
else
	echo "no keystore given: building a debug-signed APK"
	task=assembleDebug
	out=app/build/outputs/apk/debug/app-debug.apk
fi
rm -f "$out"
./gradlew "$task" --no-daemon --console=plain --warning-mode=summary -Dorg.gradle.jvmargs=-Xmx2g
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
if [ "$task" = assembleRelease ]; then
	apksigner=$(ls "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -1)
	certs=$("$apksigner" verify --print-certs "$out")
	echo "release APK signature verified"
	if [ -n "${EXPECT_CERT_SHA256:-}" ]; then
		got=$(printf '%s\n' "$certs" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr 'A-F' 'a-f')
		if [ "$got" != "$EXPECT_CERT_SHA256" ]; then
			echo "APK is signed by certificate $got, expected $EXPECT_CERT_SHA256" >&2
			exit 1
		fi
		echo "signing certificate matches"
	fi
fi
cp "$out" /out/luna-android.apk
