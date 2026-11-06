package com.example

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import com.example.ui.theme.MyApplicationTheme
import java.io.File
import java.io.FileOutputStream

class MainActivity : ComponentActivity() {

  private var filePathCallback: ValueCallback<Array<Uri>>? = null

  private val fileChooserLauncher =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      if (filePathCallback != null) {
        val uris: Array<Uri>? =
          if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val clipData = result.data?.clipData
            if (clipData != null && clipData.itemCount > 0) {
              Array(clipData.itemCount) { i -> clipData.getItemAt(i).uri }
            } else {
              result.data?.data?.let { arrayOf(it) }
            }
          } else {
            null
          }
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
      }
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    setContent {
      MyApplicationTheme(darkTheme = true) {
        CreatorToolkitApp(
          onFileChooser = { callback, params ->
            filePathCallback?.onReceiveValue(null)
            filePathCallback = callback
            try {
              val intent = params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "*/*"
              }
              fileChooserLauncher.launch(intent)
              true
            } catch (e: Exception) {
              filePathCallback = null
              false
            }
          }
        )
      }
    }
  }
}

class AndroidBridge(private val context: Context) {

  @JavascriptInterface
  fun getInjectedApiKey(): String {
    return try {
      val key = BuildConfig::class.java.getField("GEMINI_API_KEY").get(null) as? String ?: ""
      if (key == "MY_GEMINI_API_KEY" || key.isBlank()) "" else key
    } catch (_: Exception) {
      ""
    }
  }

  @JavascriptInterface
  fun showToast(message: String) {
    (context as? Activity)?.runOnUiThread {
      Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }
  }

  @JavascriptInterface
  fun downloadFile(base64Data: String, filename: String, mimeType: String) {
    (context as? Activity)?.runOnUiThread {
      try {
        val fileBytes = Base64.decode(base64Data, Base64.DEFAULT)
        val savedUri = saveFileToDevice(context, fileBytes, filename, mimeType)
        Toast.makeText(context, "Saved to Downloads: $filename", Toast.LENGTH_LONG).show()

        // Trigger Share / View intent for video editor workflows
        savedUri?.let { uri ->
          val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
          context.startActivity(Intent.createChooser(shareIntent, "Open or Share $filename"))
        }
      } catch (e: Exception) {
        Toast.makeText(context, "Download failed: ${e.localizedMessage}", Toast.LENGTH_LONG).show()
      }
    }
  }

  private fun saveFileToDevice(
    context: Context,
    data: ByteArray,
    filename: String,
    mimeType: String,
  ): Uri? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val contentValues =
        ContentValues().apply {
          put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
          put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
          put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        }
      val resolver = context.contentResolver
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues)
      if (uri != null) {
        resolver.openOutputStream(uri)?.use { outputStream ->
          outputStream.write(data)
          outputStream.flush()
        }
        return uri
      }
    }

    // Fallback: save to app external cache / files and share via FileProvider
    val targetDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.cacheDir
    val targetFile = File(targetDir, filename)
    FileOutputStream(targetFile).use { fos ->
      fos.write(data)
      fos.flush()
    }
    return try {
      FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", targetFile)
    } catch (_: Exception) {
      Uri.fromFile(targetFile)
    }
  }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun CreatorToolkitApp(
  onFileChooser: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams?) -> Boolean
) {
  val context = LocalContext.current
  var webViewInstance by remember { mutableStateOf<WebView?>(null) }

  BackHandler(enabled = webViewInstance?.canGoBack() == true) {
    webViewInstance?.goBack()
  }

  Box(
    modifier = Modifier
      .fillMaxSize()
      .background(Color(0xFF09090B))
      .statusBarsPadding()
  ) {
    AndroidView(
      modifier = Modifier.fillMaxSize(),
      factory = { ctx ->
        WebView(ctx).apply {
          setBackgroundColor(android.graphics.Color.parseColor("#09090B"))

          settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
            displayZoomControls = false
            builtInZoomControls = false
          }

          addJavascriptInterface(AndroidBridge(ctx), "AndroidBridge")

          webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
              webView: WebView?,
              filePathCallback: ValueCallback<Array<Uri>>?,
              fileChooserParams: FileChooserParams?
            ): Boolean {
              if (filePathCallback == null) return false
              return onFileChooser(filePathCallback, fileChooserParams)
            }
          }

          webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
              view: WebView?,
              request: WebResourceRequest?
            ): Boolean {
              val url = request?.url?.toString() ?: return false
              if (url.startsWith("file:///android_asset/") || url.startsWith("data:")) {
                return false
              }
              return try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                ctx.startActivity(intent)
                true
              } catch (e: Exception) {
                false
              }
            }
          }

          loadUrl("file:///android_asset/index.html")
          webViewInstance = this
        }
      },
      update = {
        webViewInstance = it
      }
    )
  }
}
