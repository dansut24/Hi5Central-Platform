plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The debug APK can be built without credentials. Supply the real,
// environment-specific Firebase config to enable push messaging.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "com.hi5central.rmm"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.hi5central.rmm"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("com.google.firebase:firebase-messaging:24.1.1")
}
