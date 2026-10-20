package online.shirinsweets.course

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewFeature

/**
 * Единственный экран приложения: полноэкранный WebView с платформой курса.
 *
 * Приложение не заменяет сайт — это дополнительный защищённый вход для
 * Android (у iPhone остаётся Safari/PWA как раньше). Единственная причина
 * существования этого нативного враппера — [WindowManager.LayoutParams.FLAG_SECURE]
 * ниже: из браузера/PWA такую защиту поставить нельзя, это системный флаг
 * окна, доступный только нативному приложению.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var fileChooserLauncher: ActivityResultLauncher<Intent>

    // Домен, за пределы которого WebView не должен грузить страницы сам —
    // ссылки на WhatsApp/Telegram/tel: из блока контактов сайта уходят во
    // внешние приложения, см. shouldOverrideUrlLoading ниже.
    private val allowedHost = "shirinsweets.online"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // === Защита от скриншотов/записи экрана (FLAG_SECURE) ===
        // Должен быть выставлен ДО setContentView. Это тот же системный флаг
        // окна, которым Telegram помечает "защищённый контент": пока приложение
        // на переднем плане, ОС не даёт снять скриншот и не даёт что-либо
        // записать с этого окна при записи экрана — вместо содержимого в
        // скриншоте/записи будет чёрный прямоугольник. Курс платный, поэтому
        // это единственная причина, по которой существует нативная обёртка —
        // из браузера такой флаг поставить невозможно.
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )

        // Системный чусер файла/камеры для <input type="file"> в чате ученицы
        // (загрузка фото чека) — без ActivityResult-контракта WebView не умеет
        // сама открыть системный picker, onShowFileChooser просто провалится.
        fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = filePathCallback
            filePathCallback = null
            if (callback == null) return@registerForActivityResult
            val data = result.data
            val uris = if (result.resultCode == RESULT_OK && data != null) {
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
            } else {
                null
            }
            callback.onReceiveValue(uris ?: emptyArray())
        }

        webView = WebView(this)
        setContentView(webView)

        configureWebView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        webView.loadUrl(urlToLoad(intent))
    }

    // Android App Links (см. AndroidManifest.xml, autoVerify intent-filter):
    // если приложение уже открыто (launchMode="singleTask"), новая ссылка
    // приходит сюда, а не пересоздаёт Activity — просто переводим WebView.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        webView.loadUrl(urlToLoad(intent))
    }

    // Ссылка на курс из Instagram-директ/WhatsApp (VIEW-intent с https-адресом
    // shirinsweets.online) — открываем именно её; обычный запуск с иконки
    // приходит без данных, тогда грузим адрес курса по умолчанию.
    private fun urlToLoad(intent: Intent): String {
        val uri = intent.data
        val isOurHttpsLink = uri != null && uri.scheme == "https" &&
            (uri.host == allowedHost || uri.host?.endsWith(".$allowedHost") == true)
        return if (isOurHttpsLink) uri.toString() else BuildConfig.COURSE_URL
    }

    private fun configureWebView(webView: WebView) {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        // Требуется сайту: авторизация ученицы и прогресс курса хранятся в
        // localStorage/IndexedDB (см. apps/web/src/course), без этого флага
        // WebView их не выдаёт.
        settings.domStorageEnabled = true
        // Курс — обычный видеоплеер, должен воспроизводиться по тапу так же,
        // как в мобильном браузере, без дополнительного жеста "разрешить звук".
        settings.mediaPlaybackRequiresUserGesture = false
        // Ни файловая система, ни content:// провайдеры сайту не нужны —
        // меньше поверхность атаки для WebView.
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        // Сайт целиком на https — подмешивать http-контент незачем.
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

        // Метка в User-Agent, чтобы бэкенд/фронтенд при необходимости могли
        // отличить запросы из этого приложения от обычного мобильного браузера.
        // Ничего на сервере под неё сейчас не завязано — задел на будущее.
        settings.userAgentString = "${settings.userAgentString} ShirinSweetsApp/1.0"

        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        // === Офлайн-уроки (Service Worker) ===
        // Сайт кеширует оболочку курса и скачанные уроки через
        // /course-sw.js + Cache Storage/IndexedDB (apps/web/public/course-sw.js,
        // apps/web/src/course/offline.ts) — так ученица открывает уже
        // скачанный урок в дороге без сети. В голом WebView для этого не нужно
        // включать отдельный флаг: JS и DOM Storage (уже включены выше) — это
        // всё, что требует сама спецификация. ServiceWorkerControllerCompat
        // ниже даём не для «включения» (Service Worker и так работает, если
        // конкретная версия системного WebView его поддерживает — проверяем
        // это через WebViewFeature, а не считаем само собой разумеющимся), а
        // чтобы не молчать вместо сети: по умолчанию (shouldInterceptRequest
        // возвращает null) WebView сам обслуживает fetch внутри Service
        // Worker'а обычной сетью/кешем — то же поведение, что в мобильном
        // браузере, без дополнительной логики с нашей стороны.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(object : ServiceWorkerClientCompat() {
                override fun shouldInterceptRequest(request: WebResourceRequest) = null
            })
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                val scheme = uri.scheme
                val host = uri.host

                val isHttpOrHttps = scheme == "http" || scheme == "https"
                val isOwnDomain = host != null && (host == allowedHost || host.endsWith(".$allowedHost"))

                if (isHttpOrHttps && isOwnDomain) {
                    // Наш сайт — грузим прямо в WebView как обычно.
                    return false
                }

                // Всё остальное — tel:, mailto:, wa.me, t.me и любой сторонний
                // домен (ссылки из блока контактов сайта) — открываем во внешнем
                // приложении, а не внутри WebView.
                return openExternally(uri)
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                // Сайт только по валидному https — при ошибке сертификата не
                // продолжаем молча, а закрываем соединение как обычный браузер.
                handler.cancel()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback
                return try {
                    fileChooserLauncher.launch(fileChooserParams.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    this@MainActivity.filePathCallback = null
                    false
                }
            }
        }
    }

    private fun openExternally(uri: Uri): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (e: ActivityNotFoundException) {
            // Нет приложения, способного открыть ссылку (например, WhatsApp не
            // установлен) — тихо игнорируем, не роняя WebView.
            true
        }
    }
}
