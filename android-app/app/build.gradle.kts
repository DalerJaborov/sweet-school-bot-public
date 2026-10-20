plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "online.shirinsweets.course"
    compileSdk = 34

    defaultConfig {
        applicationId = "online.shirinsweets.course"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // Адрес платформы курсов открывается в WebView — вынесен в BuildConfig,
        // чтобы поменять его (например, на стейджинг) не трогая код Activity.
        buildConfigField("String", "COURSE_URL", "\"https://shirinsweets.online/course\"")
    }

    // Боевой upload-keystore для Play Store НЕ лежит в репозитории (см.
    // android-app/.secrets/, в .gitignore) — CI подставляет его через
    // переменные окружения, которые сам же готовит из зашифрованных секретов
    // GitHub Actions (ANDROID_KEYSTORE_BASE64 → декодируется в файл перед
    // сборкой) — см. .github/workflows/android-apk.yml. Локально в Android
    // Studio этих переменных нет, поэтому release там тихо подписывается
    // debug-ключом — достаточно, чтобы просто собрать и проверить приложение
    // на телефоне; настоящий .aab для Play Console выходит только из CI.
    val releaseKeystorePath = System.getenv("ANDROID_KEYSTORE_PATH")

    signingConfigs {
        if (releaseKeystorePath != null) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // Минификация выключена: обёртка над WebView — весь код умещается
            // в один экран, ужимать нечего, а R8 добавляет только риск сломать
            // WebView callback-и без пользы. Апгрейд на минификацию — по желанию.
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")

            signingConfig = if (releaseKeystorePath != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        // Сборка идёт в headless CI без возможности локально прогнать lint
        // заранее — не хотим ронять assembleRelease на некритичных находках
        // (например, AllowBackup) вместо того, чтобы получить готовый .apk.
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // Используется напрямую в MainActivity: registerForActivityResult (выбор
    // файла из чата) и onBackPressedDispatcher (кнопка "назад" в WebView).
    implementation("androidx.activity:activity-ktx:1.9.1")
    // ServiceWorkerControllerCompat/WebViewFeature — чтобы course-sw.js (офлайн
    // уроки) в WebView работал так же, как в мобильном браузере, см. MainActivity.
    implementation("androidx.webkit:webkit:1.17.0")
}
