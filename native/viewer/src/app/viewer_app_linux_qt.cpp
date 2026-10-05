#include "app/viewer_app.h"

#include "core/deep_link.h"
#include "core/logger.h"

#include <QApplication>
#include <QCoreApplication>
#include <QWebEnginePage>
#include <QWebEngineScript>
#include <QWebEngineScriptCollection>
#include <QWebEngineSettings>
#include <QWebEngineView>
#include <QUrl>
#include <QVariant>

#include <filesystem>
#include <sstream>
#include <string>
#include <system_error>
#include <unistd.h>

#ifndef HI5CENTRAL_VIEWER_VERSION
#define HI5CENTRAL_VIEWER_VERSION "0.0.0"
#endif

namespace hi5 {
namespace {

std::string JsEscape(const std::string& value) {
    std::string out;
    out.reserve(value.size() + 16);
    for (char c : value) {
        switch (c) {
        case '\\': out += "\\\\"; break;
        case '"': out += "\\\""; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        case '<': out += "\\x3C"; break;
        case '>': out += "\\x3E"; break;
        default: out.push_back(c); break;
        }
    }
    return out;
}

std::filesystem::path ExecutableDirectory() {
    std::error_code ec;
    const auto resolved = std::filesystem::read_symlink("/proc/self/exe", ec);
    if (!ec && !resolved.empty()) return resolved.parent_path();
    return std::filesystem::current_path();
}

std::string BuildBootstrapJs(const DeepLinkLaunch& launch) {
    std::ostringstream js;
    js
        << "(function(){\n"
        << "  const pending = {\n"
        << "    session_id: \"" << JsEscape(launch.sessionId) << "\",\n"
        << "    sessionId: \"" << JsEscape(launch.sessionId) << "\",\n"
        << "    token: \"" << JsEscape(launch.token) << "\",\n"
        << "    device_id: \"" << JsEscape(launch.deviceId) << "\",\n"
        << "    deviceId: \"" << JsEscape(launch.deviceId) << "\",\n"
        << "    wss_url: \"" << JsEscape(launch.wssUrl) << "\",\n"
        << "    wssUrl: \"" << JsEscape(launch.wssUrl) << "\",\n"
        << "    mode: \"" << JsEscape(launch.mode) << "\",\n"
        << "    session_type: \"" << JsEscape(launch.sessionType) << "\",\n"
        << "    sessionType: \"" << JsEscape(launch.sessionType) << "\",\n"
        << "    viewer_version: \"" << JsEscape(HI5CENTRAL_VIEWER_VERSION) << "\",\n"
        << "    viewerVersion: \"" << JsEscape(HI5CENTRAL_VIEWER_VERSION) << "\"\n"
        << "  };\n"
        << "  let connectHandler = null;\n"
        << "  window.hi5 = window.hi5 || {};\n"
        << "  window.hi5.onConnect = function(cb) {\n"
        << "    connectHandler = cb;\n"
        << "    if (typeof cb === 'function' && pending.sessionId && pending.deviceId && pending.wssUrl) {\n"
        << "      try { cb(pending); } catch (e) { console.error('[native-host] onConnect callback failed', e); }\n"
        << "    }\n"
        << "    return function() {};\n"
        << "  };\n"
        << "  window.hi5.getPendingConnect = async function() {\n"
        << "    return (pending.sessionId && pending.deviceId && pending.wssUrl) ? pending : null;\n"
        << "  };\n"
        << "  window.hi5.signalRendererReady = function() {\n"
        << "    if (typeof connectHandler === 'function' && pending.sessionId && pending.deviceId && pending.wssUrl) {\n"
        << "      try { connectHandler(pending); } catch (e) { console.error('[native-host] renderer-ready delivery failed', e); }\n"
        << "    }\n"
        << "    return true;\n"
        << "  };\n"
        << "  window.hi5ViewerLog = function(message) { console.log('[viewer-native-log]', String(message || '')); return true; };\n"
        << "})();";
    return js.str();
}

class LoggingPage final : public QWebEnginePage {
public:
    explicit LoggingPage(QObject* parent = nullptr) : QWebEnginePage(parent) {}

protected:
    void javaScriptConsoleMessage(JavaScriptConsoleMessageLevel level,
                                  const QString& message,
                                  int lineNumber,
                                  const QString& sourceId) override {
        const std::string line =
            "[qt-webengine] " + sourceId.toStdString() + ":" +
            std::to_string(lineNumber) + " " + message.toStdString();
        if (level == QWebEnginePage::ErrorMessageLevel) LogError(line);
        else if (level == QWebEnginePage::WarningMessageLevel) LogWarn(line);
        else LogInfo(line);
    }
};

} // namespace

int ViewerApp::Run(int argc, char* argv[]) {
    LogInfo(std::string("Viewer starting version=") + HI5CENTRAL_VIEWER_VERSION + " engine=QtWebEngine");

    DeepLinkLaunch launch{};
    if (argc >= 2 && argv && argv[1]) {
        launch = ParseDeepLink(argv[1]);
    }

    if (launch.valid) {
        LogInfo("Deep link parsed successfully");
        LogInfo("Deep link session_id=" + launch.sessionId);
        LogInfo("Deep link device_id=" + launch.deviceId);
        LogInfo("Deep link mode=" + launch.mode);
        LogInfo("Deep link session_type=" + launch.sessionType);
    } else {
        LogWarn("No valid deep link provided; argc=" + std::to_string(argc));
    }

    QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
    QApplication app(argc, argv);
    app.setApplicationName("Hi5Central Viewer");
    app.setOrganizationName("Hi5Central");

    const auto exeDir = ExecutableDirectory();
    const auto indexPath = exeDir / "web" / "index.html";
    const auto rendererPath = exeDir / "web" / "renderer.js";

    LogInfo("indexPath=" + indexPath.string());
    LogInfo("rendererPath=" + rendererPath.string());

    QWebEngineView view;
    auto* page = new LoggingPage(&view);
    view.setPage(page);

    auto* settings = page->settings();
    settings->setAttribute(QWebEngineSettings::JavascriptEnabled, true);
    settings->setAttribute(QWebEngineSettings::LocalStorageEnabled, true);
    settings->setAttribute(QWebEngineSettings::LocalContentCanAccessRemoteUrls, true);
    settings->setAttribute(QWebEngineSettings::LocalContentCanAccessFileUrls, true);
    settings->setAttribute(QWebEngineSettings::PlaybackRequiresUserGesture, false);
    settings->setAttribute(QWebEngineSettings::WebGLEnabled, true);

    QWebEngineScript bootstrap;
    bootstrap.setName("hi5central-native-bootstrap");
    bootstrap.setInjectionPoint(QWebEngineScript::DocumentCreation);
    bootstrap.setWorldId(QWebEngineScript::MainWorld);
    bootstrap.setRunsOnSubFrames(false);
    bootstrap.setSourceCode(QString::fromStdString(BuildBootstrapJs(launch)));
    page->scripts().insert(bootstrap);

    const bool selfTestWebRtc =
        argc >= 2 && argv && argv[1] && std::string(argv[1]) == "--self-test-webrtc";

    if (selfTestWebRtc) {
        QObject::connect(page, &QWebEnginePage::loadFinished, [&app, page](bool ok) {
            if (!ok) {
                LogError("[qt-webengine] WebRTC self-test page failed to load");
                app.exit(4);
                return;
            }
            page->runJavaScript(
                "typeof RTCPeerConnection === 'function' && typeof WebSocket === 'function'",
                [&app](const QVariant& result) {
                    const bool available = result.toBool();
                    LogInfo(std::string("[qt-webengine] WebRTC self-test available=") + (available ? "true" : "false"));
                    app.exit(available ? 0 : 5);
                });
        });
        page->load(QUrl("about:blank"));
        return app.exec();
    }

    QObject::connect(page, &QWebEnginePage::loadFinished, [&view](bool ok) {
        LogInfo(std::string("[qt-webengine] page load finished ok=") + (ok ? "true" : "false"));
        if (!ok) return;
        view.page()->runJavaScript(
            "console.log('[webrtc-capability]', "
            "JSON.stringify({rtc:typeof RTCPeerConnection, media:typeof MediaStream, ua:navigator.userAgent}));");
    });

    view.setWindowTitle(launch.sessionType == "connect"
        ? "Hi5Central Viewer - Connect"
        : "Hi5Central Viewer - Unattended");
    view.resize(1280, 800);

    if (!std::filesystem::exists(indexPath) || !std::filesystem::exists(rendererPath)) {
        const QString detail = QString::fromStdString(
            "Hi5Central Viewer files are missing.\n\nExpected:\n" +
            indexPath.string() + "\n" + rendererPath.string());
        view.setHtml(
            "<html><body style='background:#070b10;color:#e6edf3;font-family:sans-serif;padding:40px'>"
            "<h2>Hi5Central Viewer</h2><pre style='white-space:pre-wrap'>" +
            detail.toHtmlEscaped() + "</pre></body></html>");
    } else {
        view.load(QUrl::fromLocalFile(QString::fromStdString(indexPath.string())));
    }

    view.show();
    return app.exec();
}

} // namespace hi5
