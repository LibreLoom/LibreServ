# Luna Mobile (Android)

One app for two devices:
- **BLE setup** for Luna and LibreServ — the same GATT service UUIDs and
  HTTP-over-BLE proxy protocol as the LibreServ companion.
- **Photo backup** for Luna — sign in with your Luna account, then photos are
  backed up automatically on unmetered Wi-Fi while the phone charges, through
  Luna's resumable chunked upload API into `Phone Backup/<year>/<month>`.

## Build
```sh
export ANDROID_HOME=$HOME/Android/Sdk   # or edit local.properties
./gradlew testDebugUnitTest             # host JVM tests
./gradlew assembleDebug                 # app-debug.apk
```
