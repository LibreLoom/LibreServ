# Luna Mobile (Android)

Photo backup for Luna: sign in with your Luna account, then photos are
backed up automatically on unmetered Wi-Fi while the phone charges, through
Luna's resumable chunked upload API into `Phone Backup/<year>/<month>`.

First-time setup without a cable uses Luna's open "Luna Setup" Wi-Fi
network in the phone's browser — this app is backup only.

## Build
```sh
export ANDROID_HOME=$HOME/Android/Sdk   # or edit local.properties
./gradlew testDebugUnitTest             # host JVM tests
./gradlew assembleDebug                 # app-debug.apk
```
