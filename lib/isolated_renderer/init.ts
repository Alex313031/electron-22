/* global isolatedApi */

import type * as webViewElementModule from '@electron/internal/renderer/web-view/web-view-element';

if (isolatedApi.guestViewInternal) {
  // Must setup the WebView element in main world.
  const { setupWebView } = require('@electron/internal/renderer/web-view/web-view-element') as typeof webViewElementModule;
  setupWebView(isolatedApi);
}
