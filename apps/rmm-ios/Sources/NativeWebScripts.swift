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
      style.id = 'hi5-native-viewer-style';
      style.textContent = [
        '@media (max-width: 820px), (pointer: coarse) {',
        '#topbar {min-height:44px!important;height:44px!important;padding:4px 7px!important;grid-template-columns:minmax(0,1fr)!important;grid-template-rows:minmax(0,1fr)!important;gap:0!important;}',
        '#topbar .brand,#topbar .right-actions {display:none!important;}',
        '#topbar .topbar-actions {grid-column:1/-1!important;grid-row:1!important;width:100%!important;min-width:0!important;display:flex!important;flex-wrap:nowrap!important;justify-content:flex-start!important;gap:4px!important;overflow-x:auto!important;padding:2px!important;-webkit-overflow-scrolling:touch;}',
        '#topbar .topbar-actions button {flex:0 0 36px!important;width:36px!important;min-width:36px!important;height:34px!important;min-height:34px!important;}',
        '#topbar .topbar-actions .label {display:none!important;}',
        '#mobile-bottom-actions {width:calc(100vw - 12px)!important;max-width:100vw!important;justify-content:flex-start!important;overflow-x:auto!important;overflow-y:hidden!important;-webkit-overflow-scrolling:touch;}',
        '#mobile-bottom-actions button {flex:0 0 auto!important;white-space:nowrap!important;}',
        '#mobile-bottom-actions #mobile-text-input {flex:1 0 112px!important;min-width:105px!important;max-width:168px!important;}',
        '}'
      ].join('\n');
      (document.head || document.documentElement).appendChild(style);
    })();
    """#
}
