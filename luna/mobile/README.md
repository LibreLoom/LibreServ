# Luna Mobile (Android)

Photo backup for Luna: sign in with your Luna account, then photos are
backed up automatically on unmetered Wi-Fi while the phone charges, through
Luna's resumable chunked upload API into `Phone Backup/<year>/<month>`.

This app is photo backup over the home network. First-time Luna setup uses
the Ethernet cable and the address on the screen (or luna.local).

## Build
```sh
export ANDROID_HOME=$HOME/Android/Sdk   # or edit local.properties
./gradlew testDebugUnitTest             # host JVM tests
./gradlew assembleDebug                 # app-debug.apk
```
