plugins {
    id("com.android.application") version "8.2.2"
    id("org.jetbrains.kotlin.android") version "1.9.22"
}

// Release signing is opt-in via environment so F-Droid's source builds and
// local dev produce an unsigned APK (F-Droid signs with its own key).
// release.sh sets these when cutting a release; see luna/mobile/README.md.
val releaseKeystore = System.getenv("LUNA_ANDROID_KEYSTORE")?.takeIf { it.isNotBlank() }

android {
    namespace = "net.plainskill.luna"
    compileSdk = 34

    defaultConfig {
        applicationId = "net.plainskill.luna"
        minSdk = 26
        targetSdk = 34
        // Keep these as plain literals: F-Droid's checkupdates parses this
        // file statically at each luna-android-v* tag.
        versionCode = 7
        versionName = "0.1.6"
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("LUNA_ANDROID_STORE_PASSWORD")
                keyAlias = System.getenv("LUNA_ANDROID_KEY_ALIAS") ?: "luna"
                keyPassword = System.getenv("LUNA_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            if (releaseKeystore != null) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.fragment:fragment-ktx:1.6.2")
    implementation("androidx.drawerlayout:drawerlayout:1.2.0")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
}
