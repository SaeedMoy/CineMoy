import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing: android/keystore.properties (not committed). Falls back to the debug key.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// Media3 and the Jellyfin FFmpeg decoder must be the exact same version.
val media3 = "1.9.0"
val abis = listOf("arm64-v8a", "armeabi-v7a", "x86_64") // the ABIs nodejs-mobile ships

android {
    namespace = "app.cinemoy"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.cinemoy"
        minSdk = 24
        targetSdk = 36
        versionCode = 3
        versionName = "0.2.1"
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    // libnode.so from nodejs-mobile (fetched by scripts/fetch-libnode.mjs).
    sourceSets {
        getByName("main") {
            jniLibs.srcDir("libnode/bin")
        }
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    // One APK per CPU type (smaller downloads) plus a universal APK that runs everywhere.
    splits {
        abi {
            isEnable = true
            reset()
            include(*abis.toTypedArray())
            isUniversalApk = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Node's bundled server is copied out of the APK at first launch; keep it uncompressed-friendly.
    androidResources {
        noCompress += listOf("mjs")
    }
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:$media3+1")
}
