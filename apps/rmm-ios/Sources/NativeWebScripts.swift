import Foundation

// Overrides run only inside the signed iOS app, never on the deployed website.
enum NativeWebScripts {
    static let portal = #"""
    (() => {
      if (window.__hi5NativePortal) return;
      window.__hi5NativePortal = true;
      const style = document.createElement('style');
      style.id = 'hi5-native-portal-style';
      style.textContent = [
        '.rmm-app { height:100dvh!important; min-height:0!important; }',
        '.rmm-app .rmm-sidebar,.rmm-app .rmm-sidebar-backdrop {display:none!important;}',
        '.rmm-app .rmm-shell-main {height:100%!important;min-height:0!important;grid-template-rows:minmax(0,1fr)!important;}',
        '.rmm-app .rmm-topbar {display:none!important;}',
        '.rmm-app .rmm-main-scroll {min-height:0!important;overflow-y:auto!important;}',
        '.rmm-app .rmm-page {padding-top:12px!important;}',
        'html.hi5-native-tools .rmm-app .rmm-shell-main {grid-template-rows:auto minmax(0,1fr)!important;}',
        'html.hi5-native-tools .rmm-app .rmm-topbar {display:grid!important;}'
      ].join('\n');
      (document.head || document.documentElement).appendChild(style);
      const report = () => {
        try { window.webkit.messageHandlers.rmmRoute.postMessage(location.pathname); } catch (_) {}
      };
      const push = history.pushState.bind(history);
      const replace = history.replaceState.bind(history);
      history.pushState = function (...args) { const result = push(...args); report(); return result; };
      history.replaceState = function (...args) { const result = replace(...args); report(); return result; };
      window.addEventListener('popstate', report);
      window.addEventListener('load', report);
      report();
    })();
    """#

    static let viewer = #"""
    (() => {
      if (window.__hi5NativeViewerStyle) return;
      window.__hi5NativeViewerStyle = true;
      const style = document.createElement('style');
      style.id = 'hi5-ios-native-viewer';
      // The WebRTC video, input and panel handlers remain in the existing viewer.
      // Only browser-built toolbars are replaced by native SwiftUI controls.
      style.textContent = [
        '#topbar {display:none!important;}',
        '#mobile-toolbar-handle,#mobile-view-controls,#mobile-bottom-actions,',
        '#mobile-quality-indicator,#mobile-scroll-rail {display:none!important;}',
        '#main {flex:1 1 auto!important;min-height:0!important;padding:0!important;}',
        'html,body {height:100%!important;min-height:0!important;overflow:hidden!important;}',
        '#remote-video,#remote-image {object-fit:contain!important;}',
        '#mobile-keyboard.visible {z-index:91!important;}'
      ].join('\n');
      (document.head || document.documentElement).appendChild(style);
    })();
    """#
}
