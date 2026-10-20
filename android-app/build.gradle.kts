// Корневой build-файл: сам по себе ничего не собирает, только подключает
// плагины (AGP, Kotlin) версиями, которые модуль app применяет через alias.
plugins {
    id("com.android.application") version "8.5.2" apply false
    // 2.1.20, а не 1.9.x: androidx.webkit:1.17.0 (нужен для Service Worker в
    // WebView, см. app/build.gradle.kts) собран компилятором Kotlin 2.1 —
    // компилятор 1.9 не может прочитать его метаданные ("incompatible
    // version of Kotlin"), CI падал именно на этом.
    id("org.jetbrains.kotlin.android") version "2.1.20" apply false
}
