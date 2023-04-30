import * as path from 'path';
import * as url from 'url';
import { BrowserWindow, session, ipcMain, app, WebContents } from 'electron/main';
import { closeAllWindows } from './window-helpers';
import { emittedOnce, emittedUntil } from './events-helpers';
import { ifit, ifdescribe, delay, defer, itremote, useRemoteContext } from './spec-helpers';
import { expect } from 'chai';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as auth from 'basic-auth';

declare let WebView: any;
const features = process._linkedBinding('electron_common_features');

async function loadWebView (w: WebContents, attributes: Record<string, string>, opts?: {openDevTools?: boolean}): Promise<void> {
  const { openDevTools } = {
    openDevTools: false,
    ...opts
  };
  await w.executeJavaScript(`
    new Promise((resolve, reject) => {
      const webview = new WebView()
      webview.id = 'webview'
      for (const [k, v] of Object.entries(${JSON.stringify(attributes)})) {
        webview.setAttribute(k, v)
      }
      document.body.appendChild(webview)
      webview.addEventListener('dom-ready', () => {
        if (${openDevTools}) {
          webview.openDevTools()
        }
      })
      webview.addEventListener('did-finish-load', () => {
        resolve()
      })
    })
  `);
}
async function loadWebViewAndWaitForEvent (w: WebContents, attributes: Record<string, string>, eventName: string): Promise<any> {
  return await w.executeJavaScript(`new Promise((resolve, reject) => {
    const webview = new WebView()
    webview.id = 'webview'
    for (const [k, v] of Object.entries(${JSON.stringify(attributes)})) {
      webview.setAttribute(k, v)
    }
    webview.addEventListener(${JSON.stringify(eventName)}, (e) => resolve({...e}), {once: true})
    document.body.appendChild(webview)
  })`);
};
async function loadWebViewAndWaitForMessage (w: WebContents, attributes: Record<string, string>): Promise<string> {
  const { message } = await loadWebViewAndWaitForEvent(w, attributes, 'console-message');
  return message;
};

describe('<webview> tag', function () {
  const fixtures = path.join(__dirname, 'fixtures');
  const blankPageUrl = url.pathToFileURL(path.join(fixtures, 'pages', 'blank.html')).toString();

  function hideChildWindows (e: any, wc: WebContents) {
    wc.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: false
      }
    }));
  }

  before(() => {
    app.on('web-contents-created', hideChildWindows);
  });

  after(() => {
    app.off('web-contents-created', hideChildWindows);
  });

  describe('behavior', () => {
    afterEach(closeAllWindows);

    it('works without script tag in page', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      w.loadFile(path.join(fixtures, 'pages', 'webview-no-script.html'));
      await emittedOnce(ipcMain, 'pong');
    });

    it('works with sandbox', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          sandbox: true
        }
      });
      w.loadFile(path.join(fixtures, 'pages', 'webview-isolated.html'));
      await emittedOnce(ipcMain, 'pong');
    });

    it('works with contextIsolation', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          contextIsolation: true
        }
      });
      w.loadFile(path.join(fixtures, 'pages', 'webview-isolated.html'));
      await emittedOnce(ipcMain, 'pong');
    });

    it('works with contextIsolation + sandbox', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          contextIsolation: true,
          sandbox: true
        }
      });
      w.loadFile(path.join(fixtures, 'pages', 'webview-isolated.html'));
      await emittedOnce(ipcMain, 'pong');
    });

    it('works with Trusted Types', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true
        }
      });
      w.loadFile(path.join(fixtures, 'pages', 'webview-trusted-types.html'));
      await emittedOnce(ipcMain, 'pong');
    });

    it('is disabled by default', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(fixtures, 'module', 'preload-webview.js'),
          nodeIntegration: true
        }
      });

      const webview = emittedOnce(ipcMain, 'webview');
      w.loadFile(path.join(fixtures, 'pages', 'webview-no-script.html'));
      const [, type] = await webview;

      expect(type).to.equal('undefined', 'WebView still exists');
    });
  });

  // FIXME(deepak1556): Ch69 follow up.
  xdescribe('document.visibilityState/hidden', () => {
    afterEach(() => {
      ipcMain.removeAllListeners('pong');
    });

    afterEach(closeAllWindows);

    it('updates when the window is shown after the ready-to-show event', async () => {
      const w = new BrowserWindow({ show: false });
      const readyToShowSignal = emittedOnce(w, 'ready-to-show');
      const pongSignal1 = emittedOnce(ipcMain, 'pong');
      w.loadFile(path.join(fixtures, 'pages', 'webview-visibilitychange.html'));
      await pongSignal1;
      const pongSignal2 = emittedOnce(ipcMain, 'pong');
      await readyToShowSignal;
      w.show();

      const [, visibilityState, hidden] = await pongSignal2;
      expect(visibilityState).to.equal('visible');
      expect(hidden).to.be.false();
    });

    it('inherits the parent window visibility state and receives visibilitychange events', async () => {
      const w = new BrowserWindow({ show: false });
      w.loadFile(path.join(fixtures, 'pages', 'webview-visibilitychange.html'));
      const [, visibilityState, hidden] = await emittedOnce(ipcMain, 'pong');
      expect(visibilityState).to.equal('hidden');
      expect(hidden).to.be.true();

      // We have to start waiting for the event
      // before we ask the webContents to resize.
      const getResponse = emittedOnce(ipcMain, 'pong');
      w.webContents.emit('-window-visibility-change', 'visible');

      return getResponse.then(([, visibilityState, hidden]) => {
        expect(visibilityState).to.equal('visible');
        expect(hidden).to.be.false();
      });
    });
  });

  describe('did-attach-webview event', () => {
    afterEach(closeAllWindows);
    it('is emitted when a webview has been attached', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      const didAttachWebview = emittedOnce(w.webContents, 'did-attach-webview');
      const webviewDomReady = emittedOnce(ipcMain, 'webview-dom-ready');
      w.loadFile(path.join(fixtures, 'pages', 'webview-did-attach-event.html'));

      const [, webContents] = await didAttachWebview;
      const [, id] = await webviewDomReady;
      expect(webContents.id).to.equal(id);
    });
  });

  describe('did-attach event', () => {
    afterEach(closeAllWindows);
    it('is emitted when a webview has been attached', async () => {
      const w = new BrowserWindow({
        webPreferences: {
          webviewTag: true
        }
      });
      await w.loadURL('about:blank');
      const message = await w.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const webview = new WebView()
        webview.setAttribute('src', 'about:blank')
        webview.addEventListener('did-attach', (e) => {
          resolve('ok')
        })
        document.body.appendChild(webview)
      })`);
      expect(message).to.equal('ok');
    });
  });

  describe('did-change-theme-color event', () => {
    afterEach(closeAllWindows);
    it('emits when theme color changes', async () => {
      const w = new BrowserWindow({
        webPreferences: {
          webviewTag: true
        }
      });
      await w.loadURL('about:blank');
      const src = url.format({
        pathname: `${fixtures.replace(/\\/g, '/')}/pages/theme-color.html`,
        protocol: 'file',
        slashes: true
      });
      const message = await w.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const webview = new WebView()
        webview.setAttribute('src', '${src}')
        webview.addEventListener('did-change-theme-color', (e) => {
          resolve('ok')
        })
        document.body.appendChild(webview)
      })`);
      expect(message).to.equal('ok');
    });
  });

  describe('devtools', () => {
    afterEach(closeAllWindows);
    // This test is flaky on WOA, so skip it there.
    ifit(process.platform !== 'win32' || process.arch !== 'arm64')('loads devtools extensions registered on the parent window', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      w.webContents.session.removeExtension('foo');

      const extensionPath = path.join(__dirname, 'fixtures', 'devtools-extensions', 'foo');
      await w.webContents.session.loadExtension(extensionPath);

      w.loadFile(path.join(__dirname, 'fixtures', 'pages', 'webview-devtools.html'));
      loadWebView(w.webContents, {
        nodeintegration: 'on',
        webpreferences: 'contextIsolation=no',
        src: `file://${path.join(__dirname, 'fixtures', 'blank.html')}`
      }, { openDevTools: true });
      let childWebContentsId = 0;
      app.once('web-contents-created', (e, webContents) => {
        childWebContentsId = webContents.id;
        webContents.on('devtools-opened', function () {
          const showPanelIntervalId = setInterval(function () {
            if (!webContents.isDestroyed() && webContents.devToolsWebContents) {
              webContents.devToolsWebContents.executeJavaScript('(' + function () {
                const { UI } = (window as any);
                const tabs = UI.inspectorView.tabbedPane.tabs;
                const lastPanelId: any = tabs[tabs.length - 1].id;
                UI.inspectorView.showPanel(lastPanelId);
              }.toString() + ')()');
            } else {
              clearInterval(showPanelIntervalId);
            }
          }, 100);
        });
      });

      const [, { runtimeId, tabId }] = await emittedOnce(ipcMain, 'answer');
      expect(runtimeId).to.match(/^[a-z]{32}$/);
      expect(tabId).to.equal(childWebContentsId);
      await w.webContents.executeJavaScript('webview.closeDevTools()');
    });
  });

  describe('zoom behavior', () => {
    const zoomScheme = standardScheme;
    const webviewSession = session.fromPartition('webview-temp');

    afterEach(closeAllWindows);

    before(() => {
      const protocol = webviewSession.protocol;
      protocol.registerStringProtocol(zoomScheme, (request, callback) => {
        callback('hello');
      });
    });

    after(() => {
      const protocol = webviewSession.protocol;
      protocol.unregisterProtocol(zoomScheme);
    });

    it('inherits the zoomFactor of the parent window', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          zoomFactor: 1.2,
          contextIsolation: false
        }
      });
      const zoomEventPromise = emittedOnce(ipcMain, 'webview-parent-zoom-level');
      w.loadFile(path.join(fixtures, 'pages', 'webview-zoom-factor.html'));

      const [, zoomFactor, zoomLevel] = await zoomEventPromise;
      expect(zoomFactor).to.equal(1.2);
      expect(zoomLevel).to.equal(1);
    });

    it('maintains zoom level on navigation', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          zoomFactor: 1.2,
          contextIsolation: false
        }
      });
      const promise = new Promise<void>((resolve) => {
        ipcMain.on('webview-zoom-level', (event, zoomLevel, zoomFactor, newHost, final) => {
          if (!newHost) {
            expect(zoomFactor).to.equal(1.44);
            expect(zoomLevel).to.equal(2.0);
          } else {
            expect(zoomFactor).to.equal(1.2);
            expect(zoomLevel).to.equal(1);
          }

          if (final) {
            resolve();
          }
        });
      });

      w.loadFile(path.join(fixtures, 'pages', 'webview-custom-zoom-level.html'));

      await promise;
    });

    it('maintains zoom level when navigating within same page', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          zoomFactor: 1.2,
          contextIsolation: false
        }
      });
      const promise = new Promise<void>((resolve) => {
        ipcMain.on('webview-zoom-in-page', (event, zoomLevel, zoomFactor, final) => {
          expect(zoomFactor).to.equal(1.44);
          expect(zoomLevel).to.equal(2.0);

          if (final) {
            resolve();
          }
        });
      });

      w.loadFile(path.join(fixtures, 'pages', 'webview-in-page-navigate.html'));

      await promise;
    });

    it('inherits zoom level for the origin when available', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          zoomFactor: 1.2,
          contextIsolation: false
        }
      });
      w.loadFile(path.join(fixtures, 'pages', 'webview-origin-zoom-level.html'));

      const [, zoomLevel] = await emittedOnce(ipcMain, 'webview-origin-zoom-level');
      expect(zoomLevel).to.equal(2.0);
    });

    it('does not crash when navigating with zoom level inherited from parent', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          zoomFactor: 1.2,
          session: webviewSession,
          contextIsolation: false
        }
      });
      const attachPromise = emittedOnce(w.webContents, 'did-attach-webview');
      const readyPromise = emittedOnce(ipcMain, 'dom-ready');
      w.loadFile(path.join(fixtures, 'pages', 'webview-zoom-inherited.html'));
      const [, webview] = await attachPromise;
      await readyPromise;
      expect(webview.getZoomFactor()).to.equal(1.2);
      await w.loadURL(`${zoomScheme}://host1`);
    });

    it('does not crash when changing zoom level after webview is destroyed', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          session: webviewSession,
          contextIsolation: false
        }
      });
      const attachPromise = emittedOnce(w.webContents, 'did-attach-webview');
      await w.loadFile(path.join(fixtures, 'pages', 'webview-zoom-inherited.html'));
      await attachPromise;
      await w.webContents.executeJavaScript('view.remove()');
      w.webContents.setZoomLevel(0.5);
    });
  });

  describe('requestFullscreen from webview', () => {
    afterEach(closeAllWindows);
    const loadWebViewWindow = async () => {
      const w = new BrowserWindow({
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          contextIsolation: false
        }
      });

      const attachPromise = emittedOnce(w.webContents, 'did-attach-webview');
      const loadPromise = emittedOnce(w.webContents, 'did-finish-load');
      const readyPromise = emittedOnce(ipcMain, 'webview-ready');

      w.loadFile(path.join(__dirname, 'fixtures', 'webview', 'fullscreen', 'main.html'));

      const [, webview] = await attachPromise;
      await Promise.all([readyPromise, loadPromise]);

      return [w, webview];
    };

    afterEach(async () => {
      // The leaving animation is un-observable but can interfere with future tests
      // Specifically this is async on macOS but can be on other platforms too
      await delay(1000);

      closeAllWindows();
    });

    ifit(process.platform !== 'darwin')('should make parent frame element fullscreen too (non-macOS)', async () => {
      const [w, webview] = await loadWebViewWindow();
      expect(await w.webContents.executeJavaScript('isIframeFullscreen()')).to.be.false();

      const parentFullscreen = emittedOnce(ipcMain, 'fullscreenchange');
      await webview.executeJavaScript('document.getElementById("div").requestFullscreen()', true);
      await parentFullscreen;

      expect(await w.webContents.executeJavaScript('isIframeFullscreen()')).to.be.true();

      const close = emittedOnce(w, 'closed');
      w.close();
      await close;
    });

    ifit(process.platform === 'darwin')('should make parent frame element fullscreen too (macOS)', async () => {
      const [w, webview] = await loadWebViewWindow();
      expect(await w.webContents.executeJavaScript('isIframeFullscreen()')).to.be.false();

      const parentFullscreen = emittedOnce(ipcMain, 'fullscreenchange');
      const enterHTMLFS = emittedOnce(w.webContents, 'enter-html-full-screen');
      const leaveHTMLFS = emittedOnce(w.webContents, 'leave-html-full-screen');

      await webview.executeJavaScript('document.getElementById("div").requestFullscreen()', true);
      expect(await w.webContents.executeJavaScript('isIframeFullscreen()')).to.be.true();

      await webview.executeJavaScript('document.exitFullscreen()');
      await Promise.all([enterHTMLFS, leaveHTMLFS, parentFullscreen]);

      const close = emittedOnce(w, 'closed');
      w.close();
      await close;
    });

    // FIXME(zcbenz): Fullscreen events do not work on Linux.
    ifit(process.platform !== 'linux')('exiting fullscreen should unfullscreen window', async () => {
      const [w, webview] = await loadWebViewWindow();
      const enterFullScreen = emittedOnce(w, 'enter-full-screen');
      await webview.executeJavaScript('document.getElementById("div").requestFullscreen()', true);
      await enterFullScreen;

      const leaveFullScreen = emittedOnce(w, 'leave-full-screen');
      await webview.executeJavaScript('document.exitFullscreen()', true);
      await leaveFullScreen;
      await delay(0);
      expect(w.isFullScreen()).to.be.false();

      const close = emittedOnce(w, 'closed');
      w.close();
      await close;
    });

    // Sending ESC via sendInputEvent only works on Windows.
    ifit(process.platform === 'win32')('pressing ESC should unfullscreen window', async () => {
      const [w, webview] = await loadWebViewWindow();
      const enterFullScreen = emittedOnce(w, 'enter-full-screen');
      await webview.executeJavaScript('document.getElementById("div").requestFullscreen()', true);
      await enterFullScreen;

      const leaveFullScreen = emittedOnce(w, 'leave-full-screen');
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await leaveFullScreen;
      await delay(0);
      expect(w.isFullScreen()).to.be.false();

      const close = emittedOnce(w, 'closed');
      w.close();
      await close;
    });

    it('pressing ESC should emit the leave-html-full-screen event', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          contextIsolation: false
        }
      });

      const didAttachWebview = emittedOnce(w.webContents, 'did-attach-webview');
      w.loadFile(path.join(fixtures, 'pages', 'webview-did-attach-event.html'));

      const [, webContents] = await didAttachWebview;

      const enterFSWindow = emittedOnce(w, 'enter-html-full-screen');
      const enterFSWebview = emittedOnce(webContents, 'enter-html-full-screen');
      await webContents.executeJavaScript('document.getElementById("div").requestFullscreen()', true);
      await enterFSWindow;
      await enterFSWebview;

      const leaveFSWindow = emittedOnce(w, 'leave-html-full-screen');
      const leaveFSWebview = emittedOnce(webContents, 'leave-html-full-screen');
      webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await leaveFSWebview;
      await leaveFSWindow;

      const close = emittedOnce(w, 'closed');
      w.close();
      await close;
    });

    it('should support user gesture', async () => {
      const [w, webview] = await loadWebViewWindow();

      const waitForEnterHtmlFullScreen = emittedOnce(webview, 'enter-html-full-screen');

      const jsScript = "document.querySelector('video').webkitRequestFullscreen()";
      webview.executeJavaScript(jsScript, true);

      await waitForEnterHtmlFullScreen;

      const close = emittedOnce(w, 'closed');
      w.close();
      await close;
    });
  });

  describe('child windows', () => {
    let w: BrowserWindow;
    beforeEach(async () => {
      w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, webviewTag: true, contextIsolation: false } });
      await w.loadURL('about:blank');
    });
    afterEach(closeAllWindows);

    it('opens window of about:blank with cross-scripting enabled', async () => {
      // Don't wait for loading to finish.
      loadWebView(w.webContents, {
        allowpopups: 'on',
        nodeintegration: 'on',
        webpreferences: 'contextIsolation=no',
        src: `file://${path.join(fixtures, 'api', 'native-window-open-blank.html')}`
      });

      const [, content] = await emittedOnce(ipcMain, 'answer');
      expect(content).to.equal('Hello');
    });

    it('opens window of same domain with cross-scripting enabled', async () => {
      // Don't wait for loading to finish.
      loadWebView(w.webContents, {
        allowpopups: 'on',
        nodeintegration: 'on',
        webpreferences: 'contextIsolation=no',
        src: `file://${path.join(fixtures, 'api', 'native-window-open-file.html')}`
      });

      const [, content] = await emittedOnce(ipcMain, 'answer');
      expect(content).to.equal('Hello');
    });

    it('returns null from window.open when allowpopups is not set', async () => {
      // Don't wait for loading to finish.
      loadWebView(w.webContents, {
        nodeintegration: 'on',
        webpreferences: 'contextIsolation=no',
        src: `file://${path.join(fixtures, 'api', 'native-window-open-no-allowpopups.html')}`
      });

      const [, { windowOpenReturnedNull }] = await emittedOnce(ipcMain, 'answer');
      expect(windowOpenReturnedNull).to.be.true();
    });

    it('blocks accessing cross-origin frames', async () => {
      // Don't wait for loading to finish.
      loadWebView(w.webContents, {
        allowpopups: 'on',
        nodeintegration: 'on',
        webpreferences: 'contextIsolation=no',
        src: `file://${path.join(fixtures, 'api', 'native-window-open-cross-origin.html')}`
      });

      const [, content] = await emittedOnce(ipcMain, 'answer');
      const expectedContent =
          'Blocked a frame with origin "file://" from accessing a cross-origin frame.';

      expect(content).to.equal(expectedContent);
    });

    it('emits a browser-window-created event', async () => {
      // Don't wait for loading to finish.
      loadWebView(w.webContents, {
        allowpopups: 'on',
        webpreferences: 'contextIsolation=no',
        src: `file://${fixtures}/pages/window-open.html`
      });

      await emittedOnce(app, 'browser-window-created');
    });

    it('emits a web-contents-created event', async () => {
      const webContentsCreated = emittedUntil(app, 'web-contents-created',
        (event: Electron.Event, contents: Electron.WebContents) => contents.getType() === 'window');

      loadWebView(w.webContents, {
        allowpopups: 'on',
        webpreferences: 'contextIsolation=no',
        src: `file://${fixtures}/pages/window-open.html`
      });

      await webContentsCreated;
    });

    it('does not crash when creating window with noopener', async () => {
      loadWebView(w.webContents, {
        allowpopups: 'on',
        src: `file://${path.join(fixtures, 'api', 'native-window-open-noopener.html')}`
      });
      await emittedOnce(app, 'browser-window-created');
    });
  });

  describe('webpreferences attribute', () => {
    let w: BrowserWindow;
    beforeEach(async () => {
      w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, webviewTag: true } });
      await w.loadURL('about:blank');
    });
    afterEach(closeAllWindows);

    it('can enable context isolation', async () => {
      loadWebView(w.webContents, {
        allowpopups: 'yes',
        preload: `file://${fixtures}/api/isolated-preload.js`,
        src: `file://${fixtures}/api/isolated.html`,
        webpreferences: 'contextIsolation=yes'
      });

      const [, data] = await emittedOnce(ipcMain, 'isolated-world');
      expect(data).to.deep.equal({
        preloadContext: {
          preloadProperty: 'number',
          pageProperty: 'undefined',
          typeofRequire: 'function',
          typeofProcess: 'object',
          typeofArrayPush: 'function',
          typeofFunctionApply: 'function',
          typeofPreloadExecuteJavaScriptProperty: 'undefined'
        },
        pageContext: {
          preloadProperty: 'undefined',
          pageProperty: 'string',
          typeofRequire: 'undefined',
          typeofProcess: 'undefined',
          typeofArrayPush: 'number',
          typeofFunctionApply: 'boolean',
          typeofPreloadExecuteJavaScriptProperty: 'number',
          typeofOpenedWindow: 'object'
        }
      });
    });
  });

  describe('permission request handlers', () => {
    let w: BrowserWindow;
    beforeEach(async () => {
      w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, webviewTag: true, contextIsolation: false } });
      await w.loadURL('about:blank');
    });
    afterEach(closeAllWindows);

    const partition = 'permissionTest';

    function setUpRequestHandler (webContentsId: number, requestedPermission: string) {
      return new Promise<void>((resolve, reject) => {
        session.fromPartition(partition).setPermissionRequestHandler(function (webContents, permission, callback) {
          if (webContents.id === webContentsId) {
            // requestMIDIAccess with sysex requests both midi and midiSysex so
            // grant the first midi one and then reject the midiSysex one
            if (requestedPermission === 'midiSysex' && permission === 'midi') {
              return callback(true);
            }

            try {
              expect(permission).to.equal(requestedPermission);
            } catch (e) {
              return reject(e);
            }
            callback(false);
            resolve();
          }
        });
      });
    }
    afterEach(() => {
      session.fromPartition(partition).setPermissionRequestHandler(null);
    });

    // This is disabled because CI machines don't have cameras or microphones,
    // so Chrome responds with "NotFoundError" instead of
    // "PermissionDeniedError". It should be re-enabled if we find a way to mock
    // the presence of a microphone & camera.
    xit('emits when using navigator.getUserMedia api', async () => {
      const errorFromRenderer = emittedOnce(ipcMain, 'message');
      loadWebView(w.webContents, {
        src: `file://${fixtures}/pages/permissions/media.html`,
        partition,
        nodeintegration: 'on'
      });
      const [, webViewContents] = await emittedOnce(app, 'web-contents-created');
      setUpRequestHandler(webViewContents.id, 'media');
      const [, errorName] = await errorFromRenderer;
      expect(errorName).to.equal('PermissionDeniedError');
    });

    it('emits when using navigator.geolocation api', async () => {
      const errorFromRenderer = emittedOnce(ipcMain, 'message');
      loadWebView(w.webContents, {
        src: `file://${fixtures}/pages/permissions/geolocation.html`,
        partition,
        nodeintegration: 'on',
        webpreferences: 'contextIsolation=no'
      });
      const [, webViewContents] = await emittedOnce(app, 'web-contents-created');
      setUpRequestHandler(webViewContents.id, 'geolocation');
      const [, error] = await errorFromRenderer;
      expect(error).to.equal('User denied Geolocation');
    });

    it('emits when using navigator.requestMIDIAccess without sysex api', async () => {
      const errorFromRenderer = emittedOnce(ipcMain, 'message');
      loadWebView(w.webContents, {
        src: `file://${fixtures}/pages/permissions/midi.html`,
        partition,
        nodeintegration: 'on',
        webpreferences: 'contextIsolation=no'
      });
      const [, webViewContents] = await emittedOnce(app, 'web-contents-created');
      setUpRequestHandler(webViewContents.id, 'midi');
      const [, error] = await errorFromRenderer;
      expect(error).to.equal('SecurityError');
    });

    it('emits when using navigator.requestMIDIAccess with sysex api', async () => {
      const errorFromRenderer = emittedOnce(ipcMain, 'message');
      loadWebView(w.webContents, {
        src: `file://${fixtures}/pages/permissions/midi-sysex.html`,
        partition,
        nodeintegration: 'on',
        webpreferences: 'contextIsolation=no'
      });
      const [, webViewContents] = await emittedOnce(app, 'web-contents-created');
      setUpRequestHandler(webViewContents.id, 'midiSysex');
      const [, error] = await errorFromRenderer;
      expect(error).to.equal('SecurityError');
    });

    it('emits when accessing external protocol', async () => {
      loadWebView(w.webContents, {
        src: 'magnet:test',
        partition
      });
      const [, webViewContents] = await emittedOnce(app, 'web-contents-created');
      await setUpRequestHandler(webViewContents.id, 'openExternal');
    });

    it('emits when using Notification.requestPermission', async () => {
      const errorFromRenderer = emittedOnce(ipcMain, 'message');
      loadWebView(w.webContents, {
        src: `file://${fixtures}/pages/permissions/notification.html`,
        partition,
        nodeintegration: 'on',
        webpreferences: 'contextIsolation=no'
      });
      const [, webViewContents] = await emittedOnce(app, 'web-contents-created');

      await setUpRequestHandler(webViewContents.id, 'notifications');

      const [, error] = await errorFromRenderer;
      expect(error).to.equal('denied');
    });
  });

  describe('DOM events', () => {
    afterEach(closeAllWindows);
    it('receives extra properties on DOM events when contextIsolation is enabled', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          contextIsolation: true
        }
      });
      await w.loadURL('about:blank');
      const message = await w.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const webview = new WebView()
        webview.setAttribute('src', 'data:text/html,<script>console.log("hi")</script>')
        webview.addEventListener('console-message', (e) => {
          resolve(e.message)
        })
        document.body.appendChild(webview)
      })`);
      expect(message).to.equal('hi');
    });

    it('emits focus event when contextIsolation is enabled', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          contextIsolation: true
        }
      });
      await w.loadURL('about:blank');
      await w.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const webview = new WebView()
        webview.setAttribute('src', 'about:blank')
        webview.addEventListener('dom-ready', () => {
          webview.focus()
        })
        webview.addEventListener('focus', () => {
          resolve();
        })
        document.body.appendChild(webview)
      })`);
    });
  });

  describe('attributes', () => {
    let w: WebContents;
    before(async () => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      await window.loadURL(`file://${fixtures}/pages/blank.html`);
      w = window.webContents;
    });
    afterEach(async () => {
      await w.executeJavaScript(`{
        document.querySelectorAll('webview').forEach(el => el.remove())
      }`);
    });
    after(closeAllWindows);

    describe('src attribute', () => {
      it('specifies the page to load', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          src: `file://${fixtures}/pages/a.html`
        });
        expect(message).to.equal('a');
      });

      it('navigates to new page when changed', async () => {
        await loadWebView(w, {
          src: `file://${fixtures}/pages/a.html`
        });

        const { message } = await w.executeJavaScript(`new Promise(resolve => {
          webview.addEventListener('console-message', e => resolve({message: e.message}))
          webview.src = ${JSON.stringify(`file://${fixtures}/pages/b.html`)}
        })`);

        expect(message).to.equal('b');
      });

      it('resolves relative URLs', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          src: './e.html'
        });
        expect(message).to.equal('Window script is loaded before preload script');
      });

      it('ignores empty values', async () => {
        loadWebView(w, {});

        for (const emptyValue of ['""', 'null', 'undefined']) {
          const src = await w.executeJavaScript(`webview.src = ${emptyValue}, webview.src`);
          expect(src).to.equal('');
        }
      });

      it('does not wait until loadURL is resolved', async () => {
        await loadWebView(w, { src: 'about:blank' });

        const delay = await w.executeJavaScript(`new Promise(resolve => {
          const before = Date.now();
          webview.src = 'file://${fixtures}/pages/blank.html';
          const now = Date.now();
          resolve(now - before);
        })`);

        // Setting src is essentially sending a sync IPC message, which should
        // not exceed more than a few ms.
        //
        // This is for testing #18638.
        expect(delay).to.be.below(100);
      });
    });

    describe('nodeintegration attribute', () => {
      it('inserts no node symbols when not set', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          src: `file://${fixtures}/pages/c.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'undefined',
          module: 'undefined',
          process: 'undefined',
          global: 'undefined'
        });
      });

      it('inserts node symbols when set', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          nodeintegration: 'on',
          webpreferences: 'contextIsolation=no',
          src: `file://${fixtures}/pages/d.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'function',
          module: 'object',
          process: 'object'
        });
      });

      it('loads node symbols after POST navigation when set', async function () {
        const message = await loadWebViewAndWaitForMessage(w, {
          nodeintegration: 'on',
          webpreferences: 'contextIsolation=no',
          src: `file://${fixtures}/pages/post.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'function',
          module: 'object',
          process: 'object'
        });
      });

      it('disables node integration on child windows when it is disabled on the webview', async () => {
        const src = url.format({
          pathname: `${fixtures}/pages/webview-opener-no-node-integration.html`,
          protocol: 'file',
          query: {
            p: `${fixtures}/pages/window-opener-node.html`
          },
          slashes: true
        });
        const message = await loadWebViewAndWaitForMessage(w, {
          allowpopups: 'on',
          webpreferences: 'contextIsolation=no',
          src
        });
        expect(JSON.parse(message).isProcessGlobalUndefined).to.be.true();
      });

      ifit(!process.env.ELECTRON_SKIP_NATIVE_MODULE_TESTS)('loads native modules when navigation happens', async function () {
        await loadWebView(w, {
          nodeintegration: 'on',
          webpreferences: 'contextIsolation=no',
          src: `file://${fixtures}/pages/native-module.html`
        });

        const message = await w.executeJavaScript(`new Promise(resolve => {
          webview.addEventListener('console-message', e => resolve(e.message))
          webview.reload();
        })`);

        expect(message).to.equal('function');
      });
    });

    describe('preload attribute', () => {
      useRemoteContext({ webPreferences: { webviewTag: true } });
      it('loads the script before other scripts in window', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          preload: `${fixtures}/module/preload.js`,
          src: `file://${fixtures}/pages/e.html`
        });

        expect(message).to.be.a('string');
        expect(message).to.be.not.equal('Window script is loaded before preload script');
      });

      it('preload script can still use "process" and "Buffer" when nodeintegration is off', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          preload: `${fixtures}/module/preload-node-off.js`,
          src: `file://${fixtures}/api/blank.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          process: 'object',
          Buffer: 'function'
        });
      });

      it('runs in the correct scope when sandboxed', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          preload: `${fixtures}/module/preload-context.js`,
          src: `file://${fixtures}/api/blank.html`,
          webpreferences: 'sandbox=yes'
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'function', // arguments passed to it should be available
          electron: 'undefined', // objects from the scope it is called from should not be available
          window: 'object', // the window object should be available
          localVar: 'undefined' // but local variables should not be exposed to the window
        });
      });

      it('preload script can require modules that still use "process" and "Buffer" when nodeintegration is off', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          preload: `${fixtures}/module/preload-node-off-wrapper.js`,
          webpreferences: 'sandbox=no',
          src: `file://${fixtures}/api/blank.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          process: 'object',
          Buffer: 'function'
        });
      });

      it('receives ipc message in preload script', async () => {
        await loadWebView(w, {
          preload: `${fixtures}/module/preload-ipc.js`,
          src: `file://${fixtures}/pages/e.html`
        });

        const message = 'boom!';
        const { channel, args } = await w.executeJavaScript(`new Promise(resolve => {
          webview.send('ping', ${JSON.stringify(message)})
          webview.addEventListener('ipc-message', ({channel, args}) => resolve({channel, args}))
        })`);

        expect(channel).to.equal('pong');
        expect(args).to.deep.equal([message]);
      });

      itremote('<webview>.sendToFrame()', async (fixtures: string) => {
        const w = new WebView();
        w.setAttribute('nodeintegration', 'on');
        w.setAttribute('webpreferences', 'contextIsolation=no');
        w.setAttribute('preload', `file://${fixtures}/module/preload-ipc.js`);
        w.setAttribute('src', `file://${fixtures}/pages/ipc-message.html`);
        document.body.appendChild(w);
        const { frameId } = await new Promise(resolve => w.addEventListener('ipc-message', resolve, { once: true }));

        const message = 'boom!';

        w.sendToFrame(frameId, 'ping', message);
        const { channel, args } = await new Promise(resolve => w.addEventListener('ipc-message', resolve, { once: true }));

        expect(channel).to.equal('pong');
        expect(args).to.deep.equal([message]);
      }, [fixtures]);

      it('works without script tag in page', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          preload: `${fixtures}/module/preload.js`,
          webpreferences: 'sandbox=no',
          src: `file://${fixtures}/pages/base-page.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'function',
          module: 'object',
          process: 'object',
          Buffer: 'function'
        });
      });

      it('resolves relative URLs', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          preload: '../module/preload.js',
          webpreferences: 'sandbox=no',
          src: `file://${fixtures}/pages/e.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'function',
          module: 'object',
          process: 'object',
          Buffer: 'function'
        });
      });

      itremote('ignores empty values', async () => {
        const webview = new WebView();

        for (const emptyValue of ['', null, undefined]) {
          webview.preload = emptyValue;
          expect(webview.preload).to.equal('');
        }
      });
    });

    describe('httpreferrer attribute', () => {
      it('sets the referrer url', async () => {
        const referrer = 'http://github.com/';
        const received = await new Promise<string | undefined>((resolve, reject) => {
          const server = http.createServer((req, res) => {
            try {
              resolve(req.headers.referer);
            } catch (e) {
              reject(e);
            } finally {
              res.end();
              server.close();
            }
          }).listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            loadWebView(w, {
              httpreferrer: referrer,
              src: `http://127.0.0.1:${port}`
            });
          });
        });
        expect(received).to.equal(referrer);
      });
    });

    describe('useragent attribute', () => {
      it('sets the user agent', async () => {
        const referrer = 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; AS; rv:11.0) like Gecko';
        const message = await loadWebViewAndWaitForMessage(w, {
          src: `file://${fixtures}/pages/useragent.html`,
          useragent: referrer
        });
        expect(message).to.equal(referrer);
      });
    });

    describe('disablewebsecurity attribute', () => {
      it('does not disable web security when not set', async () => {
        await loadWebView(w, { src: 'about:blank' });
        const result = await w.executeJavaScript(`webview.executeJavaScript(\`fetch(${JSON.stringify(blankPageUrl)}).then(() => 'ok', () => 'failed')\`)`);
        expect(result).to.equal('failed');
      });

      it('disables web security when set', async () => {
        await loadWebView(w, { src: 'about:blank', disablewebsecurity: '' });
        const result = await w.executeJavaScript(`webview.executeJavaScript(\`fetch(${JSON.stringify(blankPageUrl)}).then(() => 'ok', () => 'failed')\`)`);
        expect(result).to.equal('ok');
      });

      it('does not break node integration', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          disablewebsecurity: '',
          nodeintegration: 'on',
          webpreferences: 'contextIsolation=no',
          src: `file://${fixtures}/pages/d.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'function',
          module: 'object',
          process: 'object'
        });
      });

      it('does not break preload script', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          disablewebsecurity: '',
          preload: `${fixtures}/module/preload.js`,
          webpreferences: 'sandbox=no',
          src: `file://${fixtures}/pages/e.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'function',
          module: 'object',
          process: 'object',
          Buffer: 'function'
        });
      });
    });

    describe('partition attribute', () => {
      it('inserts no node symbols when not set', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          partition: 'test1',
          src: `file://${fixtures}/pages/c.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'undefined',
          module: 'undefined',
          process: 'undefined',
          global: 'undefined'
        });
      });

      it('inserts node symbols when set', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          nodeintegration: 'on',
          partition: 'test2',
          webpreferences: 'contextIsolation=no',
          src: `file://${fixtures}/pages/d.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'function',
          module: 'object',
          process: 'object'
        });
      });

      it('isolates storage for different id', async () => {
        await w.executeJavaScript('localStorage.setItem(\'test\', \'one\')');

        const message = await loadWebViewAndWaitForMessage(w, {
          partition: 'test3',
          src: `file://${fixtures}/pages/partition/one.html`
        });

        const parsedMessage = JSON.parse(message);
        expect(parsedMessage).to.include({
          numberOfEntries: 0,
          testValue: null
        });
      });

      it('uses current session storage when no id is provided', async () => {
        await w.executeJavaScript('localStorage.setItem(\'test\', \'two\')');
        const testValue = 'two';

        const message = await loadWebViewAndWaitForMessage(w, {
          src: `file://${fixtures}/pages/partition/one.html`
        });

        const parsedMessage = JSON.parse(message);
        expect(parsedMessage).to.include({
          testValue
        });
      });
    });

    describe('allowpopups attribute', () => {
      const generateSpecs = (description: string, webpreferences = '') => {
        describe(description, () => {
          it('can not open new window when not set', async () => {
            const message = await loadWebViewAndWaitForMessage(w, {
              webpreferences,
              src: `file://${fixtures}/pages/window-open-hide.html`
            });
            expect(message).to.equal('null');
          });

          it('can open new window when set', async () => {
            const message = await loadWebViewAndWaitForMessage(w, {
              webpreferences,
              allowpopups: 'on',
              src: `file://${fixtures}/pages/window-open-hide.html`
            });
            expect(message).to.equal('window');
          });
        });
      };

      generateSpecs('without sandbox');
      generateSpecs('with sandbox', 'sandbox=yes');
    });

    describe('webpreferences attribute', () => {
      it('can enable nodeintegration', async () => {
        const message = await loadWebViewAndWaitForMessage(w, {
          src: `file://${fixtures}/pages/d.html`,
          webpreferences: 'nodeIntegration,contextIsolation=no'
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'function',
          module: 'object',
          process: 'object'
        });
      });

      it('can disable web security and enable nodeintegration', async () => {
        await loadWebView(w, { src: 'about:blank', webpreferences: 'webSecurity=no, nodeIntegration=yes, contextIsolation=no' });
        const result = await w.executeJavaScript(`webview.executeJavaScript(\`fetch(${JSON.stringify(blankPageUrl)}).then(() => 'ok', () => 'failed')\`)`);
        expect(result).to.equal('ok');
        const type = await w.executeJavaScript('webview.executeJavaScript("typeof require")');
        expect(type).to.equal('function');
      });
    });
  });

  describe('events', () => {
    useRemoteContext({ webPreferences: { webviewTag: true } });
    let w: WebContents;
    before(async () => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      await window.loadURL(`file://${fixtures}/pages/blank.html`);
      w = window.webContents;
    });
    afterEach(async () => {
      await w.executeJavaScript(`{
        document.querySelectorAll('webview').forEach(el => el.remove())
      }`);
    });
    after(closeAllWindows);

    describe('ipc-message event', () => {
      it('emits when guest sends an ipc message to browser', async () => {
        const { frameId, channel, args } = await loadWebViewAndWaitForEvent(w, {
          src: `file://${fixtures}/pages/ipc-message.html`,
          nodeintegration: 'on',
          webpreferences: 'contextIsolation=no'
        }, 'ipc-message');

        expect(frameId).to.be.an('array').that.has.lengthOf(2);
        expect(channel).to.equal('channel');
        expect(args).to.deep.equal(['arg1', 'arg2']);
      });
    });

    describe('page-title-updated event', () => {
      it('emits when title is set', async () => {
        const { title, explicitSet } = await loadWebViewAndWaitForEvent(w, {
          src: `file://${fixtures}/pages/a.html`
        }, 'page-title-updated');

        expect(title).to.equal('test');
        expect(explicitSet).to.be.true();
      });
    });

    describe('page-favicon-updated event', () => {
      it('emits when favicon urls are received', async () => {
        const { favicons } = await loadWebViewAndWaitForEvent(w, {
          src: `file://${fixtures}/pages/a.html`
        }, 'page-favicon-updated');

        expect(favicons).to.be.an('array').of.length(2);
        if (process.platform === 'win32') {
          expect(favicons[0]).to.match(/^file:\/\/\/[A-Z]:\/favicon.png$/i);
        } else {
          expect(favicons[0]).to.equal('file:///favicon.png');
        }
      });
    });

    describe('did-redirect-navigation event', () => {
      it('is emitted on redirects', async () => {
        const server = http.createServer((req, res) => {
          if (req.url === '/302') {
            res.setHeader('Location', '/200');
            res.statusCode = 302;
            res.end();
          } else {
            res.end();
          }
        });
        const uri = await new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => {
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        }));
        defer(() => { server.close(); });
        const event = await loadWebViewAndWaitForEvent(w, {
          src: `${uri}/302`
        }, 'did-redirect-navigation');

        expect(event.url).to.equal(`${uri}/200`);
        expect(event.isInPlace).to.be.false();
        expect(event.isMainFrame).to.be.true();
        expect(event.frameProcessId).to.be.a('number');
        expect(event.frameRoutingId).to.be.a('number');
      });
    });

    describe('will-navigate event', () => {
      it('emits when a url that leads to outside of the page is clicked', async () => {
        const { url } = await loadWebViewAndWaitForEvent(w, {
          src: `file://${fixtures}/pages/webview-will-navigate.html`
        }, 'will-navigate');

        expect(url).to.equal('http://host/');
      });
    });

    describe('did-navigate event', () => {
      it('emits when a url that leads to outside of the page is clicked', async () => {
        const pageUrl = url.pathToFileURL(path.join(fixtures, 'pages', 'webview-will-navigate.html')).toString();
        const event = await loadWebViewAndWaitForEvent(w, { src: pageUrl }, 'did-navigate');
        expect(event.url).to.equal(pageUrl);
      });
    });

    describe('did-navigate-in-page event', () => {
      it('emits when an anchor link is clicked', async () => {
        const pageUrl = url.pathToFileURL(path.join(fixtures, 'pages', 'webview-did-navigate-in-page.html')).toString();
        const event = await loadWebViewAndWaitForEvent(w, { src: pageUrl }, 'did-navigate-in-page');
        expect(event.url).to.equal(`${pageUrl}#test_content`);
      });

      it('emits when window.history.replaceState is called', async () => {
        const { url } = await loadWebViewAndWaitForEvent(w, {
          src: `file://${fixtures}/pages/webview-did-navigate-in-page-with-history.html`
        }, 'did-navigate-in-page');
        expect(url).to.equal('http://host/');
      });

      it('emits when window.location.hash is changed', async () => {
        const pageUrl = url.pathToFileURL(path.join(fixtures, 'pages', 'webview-did-navigate-in-page-with-hash.html')).toString();
        const event = await loadWebViewAndWaitForEvent(w, { src: pageUrl }, 'did-navigate-in-page');
        expect(event.url).to.equal(`${pageUrl}#test`);
      });
    });

    describe('close event', () => {
      it('should fire when interior page calls window.close', async () => {
        await loadWebViewAndWaitForEvent(w, { src: `file://${fixtures}/pages/close.html` }, 'close');
      });
    });

    describe('devtools-opened event', () => {
      it('should fire when webview.openDevTools() is called', async () => {
        await loadWebViewAndWaitForEvent(w, {
          src: `file://${fixtures}/pages/base-page.html`
        }, 'dom-ready');

        await w.executeJavaScript(`new Promise((resolve) => {
          webview.openDevTools()
          webview.addEventListener('devtools-opened', () => resolve(), {once: true})
        })`);
        await w.executeJavaScript('webview.closeDevTools()');
      });
    });

    describe('devtools-closed event', () => {
      itremote('should fire when webview.closeDevTools() is called', async (fixtures: string) => {
        const webview = new WebView();
        webview.src = `file://${fixtures}/pages/base-page.html`;
        document.body.appendChild(webview);
        await new Promise(resolve => webview.addEventListener('dom-ready', resolve, { once: true }));

        webview.openDevTools();
        await new Promise(resolve => webview.addEventListener('devtools-opened', resolve, { once: true }));

        webview.closeDevTools();
        await new Promise(resolve => webview.addEventListener('devtools-closed', resolve, { once: true }));
      }, [fixtures]);
    });

    describe('devtools-focused event', () => {
      itremote('should fire when webview.openDevTools() is called', async (fixtures: string) => {
        const webview = new WebView();
        webview.src = `file://${fixtures}/pages/base-page.html`;
        document.body.appendChild(webview);

        const waitForDevToolsFocused = new Promise(resolve => webview.addEventListener('devtools-focused', resolve, { once: true }));
        await new Promise(resolve => webview.addEventListener('dom-ready', resolve, { once: true }));
        webview.openDevTools();

        await waitForDevToolsFocused;
        webview.closeDevTools();
      }, [fixtures]);
    });

    describe('dom-ready event', () => {
      it('emits when document is loaded', async () => {
        const server = http.createServer(() => {});
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;
        await loadWebViewAndWaitForEvent(w, {
          src: `file://${fixtures}/pages/dom-ready.html?port=${port}`
        }, 'dom-ready');
      });

      itremote('throws a custom error when an API method is called before the event is emitted', () => {
        const expectedErrorMessage =
            'The WebView must be attached to the DOM ' +
            'and the dom-ready event emitted before this method can be called.';
        const webview = new WebView();
        expect(() => { webview.stop(); }).to.throw(expectedErrorMessage);
      });
    });

    describe('context-menu event', () => {
      it('emits when right-clicked in page', async () => {
        await loadWebView(w, { src: 'about:blank' });

        const { params, url } = await w.executeJavaScript(`new Promise(resolve => {
          webview.addEventListener('context-menu', (e) => resolve({...e, url: webview.getURL() }), {once: true})
          // Simulate right-click to create context-menu event.
          const opts = { x: 0, y: 0, button: 'right' };
          webview.sendInputEvent({ ...opts, type: 'mouseDown' });
          webview.sendInputEvent({ ...opts, type: 'mouseUp' });
        })`);

        expect(params.pageURL).to.equal(url);
        expect(params.frame).to.be.undefined();
        expect(params.x).to.be.a('number');
        expect(params.y).to.be.a('number');
      });
    });

    describe('found-in-page event', () => {
      itremote('emits when a request is made', async (fixtures: string) => {
        const webview = new WebView();
        const didFinishLoad = new Promise(resolve => webview.addEventListener('did-finish-load', resolve, { once: true }));
        webview.src = `file://${fixtures}/pages/content.html`;
        document.body.appendChild(webview);
        // TODO(deepak1556): With https://codereview.chromium.org/2836973002
        // focus of the webContents is required when triggering the api.
        // Remove this workaround after determining the cause for
        // incorrect focus.
        webview.focus();
        await didFinishLoad;

        const activeMatchOrdinal = [];

        for (;;) {
          const foundInPage = new Promise<any>(resolve => webview.addEventListener('found-in-page', resolve, { once: true }));
          const requestId = webview.findInPage('virtual');
          const event = await foundInPage;

          expect(event.result.requestId).to.equal(requestId);
          expect(event.result.matches).to.equal(3);

          activeMatchOrdinal.push(event.result.activeMatchOrdinal);

          if (event.result.activeMatchOrdinal === event.result.matches) {
            break;
          }
        }

        expect(activeMatchOrdinal).to.deep.equal([1, 2, 3]);
        webview.stopFindInPage('clearSelection');
      }, [fixtures]);
    });

    describe('will-attach-webview event', () => {
      itremote('does not emit when src is not changed', async () => {
        const webview = new WebView();
        document.body.appendChild(webview);
        await new Promise(resolve => setTimeout(resolve));
        const expectedErrorMessage = 'The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.';
        expect(() => { webview.stop(); }).to.throw(expectedErrorMessage);
      });

      it('supports changing the web preferences', async () => {
        w.once('will-attach-webview', (event, webPreferences, params) => {
          params.src = `file://${path.join(fixtures, 'pages', 'c.html')}`;
          webPreferences.nodeIntegration = false;
        });
        const message = await loadWebViewAndWaitForMessage(w, {
          nodeintegration: 'yes',
          src: `file://${fixtures}/pages/a.html`
        });

        const types = JSON.parse(message);
        expect(types).to.include({
          require: 'undefined',
          module: 'undefined',
          process: 'undefined',
          global: 'undefined'
        });
      });

      it('handler modifying params.instanceId does not break <webview>', async () => {
        w.once('will-attach-webview', (event, webPreferences, params) => {
          params.instanceId = null as any;
        });

        await loadWebViewAndWaitForMessage(w, {
          src: `file://${fixtures}/pages/a.html`
        });
      });

      it('supports preventing a webview from being created', async () => {
        w.once('will-attach-webview', event => event.preventDefault());

        await loadWebViewAndWaitForEvent(w, {
          src: `file://${fixtures}/pages/c.html`
        }, 'destroyed');
      });

      it('supports removing the preload script', async () => {
        w.once('will-attach-webview', (event, webPreferences, params) => {
          params.src = url.pathToFileURL(path.join(fixtures, 'pages', 'webview-stripped-preload.html')).toString();
          delete webPreferences.preload;
        });

        const message = await loadWebViewAndWaitForMessage(w, {
          nodeintegration: 'yes',
          preload: path.join(fixtures, 'module', 'preload-set-global.js'),
          src: `file://${fixtures}/pages/a.html`
        });

        expect(message).to.equal('undefined');
      });
    });

    describe('media-started-playing and media-paused events', () => {
      it('emits when audio starts and stops playing', async function () {
        if (!await w.executeJavaScript('document.createElement(\'audio\').canPlayType(\'audio/wav\')')) { return this.skip(); }

        await loadWebView(w, { src: blankPageUrl });

        // With the new autoplay policy, audio elements must be unmuted
        // see https://goo.gl/xX8pDD.
        await w.executeJavaScript(`new Promise(resolve => {
          webview.executeJavaScript(\`
            const audio = document.createElement("audio")
            audio.src = "../assets/tone.wav"
            document.body.appendChild(audio);
            audio.play()
          \`, true)
          webview.addEventListener('media-started-playing', () => resolve(), {once: true})
        })`);

        await w.executeJavaScript(`new Promise(resolve => {
          webview.executeJavaScript(\`
            document.querySelector("audio").pause()
          \`, true)
          webview.addEventListener('media-paused', () => resolve(), {once: true})
        })`);
      });
    });
  });

  describe('methods', () => {
    let w: WebContents;
    before(async () => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      await window.loadURL(`file://${fixtures}/pages/blank.html`);
      w = window.webContents;
    });
    afterEach(async () => {
      await w.executeJavaScript(`{
        document.querySelectorAll('webview').forEach(el => el.remove())
      }`);
    });
    after(closeAllWindows);

    describe('<webview>.reload()', () => {
      it('should emit beforeunload handler', async () => {
        await loadWebView(w, {
          nodeintegration: 'on',
          webpreferences: 'contextIsolation=no',
          src: `file://${fixtures}/pages/beforeunload-false.html`
        });

        // Event handler has to be added before reload.
        const channel = await w.executeJavaScript(`new Promise(resolve => {
          webview.addEventListener('ipc-message', e => resolve(e.channel))
          webview.reload();
        })`);

        expect(channel).to.equal('onbeforeunload');
      });
    });

    describe('<webview>.goForward()', () => {
      useRemoteContext({ webPreferences: { webviewTag: true } });
      itremote('should work after a replaced history entry', async (fixtures: string) => {
        const webview = new WebView();

        webview.setAttribute('nodeintegration', 'on');
        webview.setAttribute('webpreferences', 'contextIsolation=no');
        webview.src = `file://${fixtures}/pages/history-replace.html`;
        document.body.appendChild(webview);

        {
          const [e] = await Promise.all([
            new Promise<any>(resolve => webview.addEventListener('ipc-message', resolve, { once: true })),
            new Promise<void>(resolve => webview.addEventListener('did-stop-loading', resolve, { once: true }))
          ]);
          expect(e.channel).to.equal('history');
          expect(e.args[0]).to.equal(1);
          expect(webview.canGoBack()).to.be.false();
          expect(webview.canGoForward()).to.be.false();
        }

        webview.src = `file://${fixtures}/pages/base-page.html`;

        await new Promise<void>(resolve => webview.addEventListener('did-stop-loading', resolve, { once: true }));

        expect(webview.canGoBack()).to.be.true();
        expect(webview.canGoForward()).to.be.false();

        webview.goBack();

        {
          const [e] = await Promise.all([
            new Promise<any>(resolve => webview.addEventListener('ipc-message', resolve, { once: true })),
            new Promise<void>(resolve => webview.addEventListener('did-stop-loading', resolve, { once: true }))
          ]);
          expect(e.channel).to.equal('history');
          expect(e.args[0]).to.equal(2);
          expect(webview.canGoBack()).to.be.false();
          expect(webview.canGoForward()).to.be.true();
        }

        webview.goForward();

        await new Promise<void>(resolve => webview.addEventListener('did-stop-loading', resolve, { once: true }));

        expect(webview.canGoBack()).to.be.true();
        expect(webview.canGoForward()).to.be.false();
      }, [fixtures]);
    });

    describe('<webview>.clearHistory()', () => {
      it('should clear the navigation history', async () => {
        await loadWebView(w, {
          nodeintegration: 'on',
          webpreferences: 'contextIsolation=no',
          src: blankPageUrl
        });

        // Navigation must be triggered by a user gesture to make canGoBack() return true
        await w.executeJavaScript('webview.executeJavaScript(`history.pushState(null, "", "foo.html")`, true)');

        expect(await w.executeJavaScript('webview.canGoBack()')).to.be.true();

        await w.executeJavaScript('webview.clearHistory()');
        expect(await w.executeJavaScript('webview.canGoBack()')).to.be.false();
      });
    });

    describe('executeJavaScript', () => {
      it('can return the result of the executed script', async () => {
        await loadWebView(w, {
          src: 'about:blank'
        });

        const jsScript = "'4'+2";
        const expectedResult = '42';

        const result = await w.executeJavaScript(`webview.executeJavaScript(${JSON.stringify(jsScript)})`);
        expect(result).to.equal(expectedResult);
      });
    });

    it('supports inserting CSS', async () => {
      await loadWebView(w, { src: `file://${fixtures}/pages/base-page.html` });
      await w.executeJavaScript('webview.insertCSS(\'body { background-repeat: round; }\')');
      const result = await w.executeJavaScript('webview.executeJavaScript(\'window.getComputedStyle(document.body).getPropertyValue("background-repeat")\')');
      expect(result).to.equal('round');
    });

    it('supports removing inserted CSS', async () => {
      await loadWebView(w, { src: `file://${fixtures}/pages/base-page.html` });
      const key = await w.executeJavaScript('webview.insertCSS(\'body { background-repeat: round; }\')');
      await w.executeJavaScript(`webview.removeInsertedCSS(${JSON.stringify(key)})`);
      const result = await w.executeJavaScript('webview.executeJavaScript(\'window.getComputedStyle(document.body).getPropertyValue("background-repeat")\')');
      expect(result).to.equal('repeat');
    });

    describe('sendInputEvent', () => {
      it('can send keyboard event', async () => {
        await loadWebViewAndWaitForEvent(w, {
          nodeintegration: 'on',
          webpreferences: 'contextIsolation=no',
          src: `file://${fixtures}/pages/onkeyup.html`
        }, 'dom-ready');

        const waitForIpcMessage = w.executeJavaScript('new Promise(resolve => webview.addEventListener("ipc-message", e => resolve({...e})), {once: true})');
        w.executeJavaScript(`webview.sendInputEvent({
          type: 'keyup',
          keyCode: 'c',
          modifiers: ['shift']
        })`);

        const { channel, args } = await waitForIpcMessage;
        expect(channel).to.equal('keyup');
        expect(args).to.deep.equal(['C', 'KeyC', 67, true, false]);
      });

      it('can send mouse event', async () => {
        await loadWebViewAndWaitForEvent(w, {
          nodeintegration: 'on',
          webpreferences: 'contextIsolation=no',
          src: `file://${fixtures}/pages/onmouseup.html`
        }, 'dom-ready');

        const waitForIpcMessage = w.executeJavaScript('new Promise(resolve => webview.addEventListener("ipc-message", e => resolve({...e})), {once: true})');
        w.executeJavaScript(`webview.sendInputEvent({
          type: 'mouseup',
          modifiers: ['ctrl'],
          x: 10,
          y: 20
        })`);

        const { channel, args } = await waitForIpcMessage;
        expect(channel).to.equal('mouseup');
        expect(args).to.deep.equal([10, 20, false, true]);
      });
    });

    describe('<webview>.getWebContentsId', () => {
      it('can return the WebContents ID', async () => {
        await loadWebView(w, { src: 'about:blank' });

        expect(await w.executeJavaScript('webview.getWebContentsId()')).to.be.a('number');
      });
    });

    ifdescribe(features.isPrintingEnabled())('<webview>.printToPDF()', () => {
      it('rejects on incorrectly typed parameters', async () => {
        const badTypes = {
          landscape: [],
          displayHeaderFooter: '123',
          printBackground: 2,
          scale: 'not-a-number',
          pageSize: 'IAmAPageSize',
          margins: 'terrible',
          pageRanges: { oops: 'im-not-the-right-key' },
          headerTemplate: [1, 2, 3],
          footerTemplate: [4, 5, 6],
          preferCSSPageSize: 'no'
        };

        // These will hard crash in Chromium unless we type-check
        for (const [key, value] of Object.entries(badTypes)) {
          const param = { [key]: value };

          const src = 'data:text/html,%3Ch1%3EHello%2C%20World!%3C%2Fh1%3E';
          await loadWebView(w, { src });
          await expect(w.executeJavaScript(`webview.printToPDF(${JSON.stringify(param)})`)).to.eventually.be.rejected();
        }
      });

      it('can print to PDF', async () => {
        const src = 'data:text/html,%3Ch1%3EHello%2C%20World!%3C%2Fh1%3E';
        await loadWebView(w, { src });

        const data = await w.executeJavaScript('webview.printToPDF({})');
        expect(data).to.be.an.instanceof(Uint8Array).that.is.not.empty();
      });
    });

    describe('DOM events', () => {
      for (const [description, sandbox] of [
        ['without sandbox', false] as const,
        ['with sandbox', true] as const
      ]) {
        describe(description, () => {
          it('emits resize events', async () => {
            await loadWebViewAndWaitForEvent(w, {
              src: `file://${fixtures}/pages/a.html`,
              webpreferences: `sandbox=${sandbox ? 'yes' : 'no'}`
            }, 'dom-ready');

            const firstResizeSignal = w.executeJavaScript(`new Promise((resolve, reject) => {
              webview.addEventListener('resize', (e) => resolve({...e}), {once: true})
            })`);

            const insertedCSS = await w.insertCSS('webview { width: 100px; height: 10px; }');

            const firstResizeEvent = await firstResizeSignal;
            expect(firstResizeEvent.newWidth).to.equal(100);
            expect(firstResizeEvent.newHeight).to.equal(10);

            await w.removeInsertedCSS(insertedCSS);

            const secondResizeSignal = w.executeJavaScript(`new Promise((resolve, reject) => {
              webview.addEventListener('resize', (e) => resolve({...e}), {once: true})
            })`);

            const newWidth = 1234;
            const newHeight = 789;
            await w.insertCSS(`webview { width: ${newWidth}px; height: ${newHeight}px; }`);
            const secondResizeEvent = await secondResizeSignal;
            expect(secondResizeEvent.newWidth).to.equal(newWidth);
            expect(secondResizeEvent.newHeight).to.equal(newHeight);
          });

          it('emits focus event', async () => {
            await loadWebViewAndWaitForEvent(w, {
              src: `file://${fixtures}/pages/a.html`,
              webpreferences: `sandbox=${sandbox ? 'yes' : 'no'}`
            }, 'dom-ready');

            // If this test fails, check if webview.focus() still works.
            await w.executeJavaScript(`new Promise(resolve => {
              webview.addEventListener('focus', () => resolve(), {once: true});
              webview.focus();
            })`);
          });
        });
      }
    });

    // TODO(miniak): figure out why this is failing on windows
    ifdescribe(process.platform !== 'win32')('<webview>.capturePage()', () => {
      it('returns a Promise with a NativeImage', async () => {
        const src = 'data:text/html,%3Ch1%3EHello%2C%20World!%3C%2Fh1%3E';
        await loadWebViewAndWaitForEvent(w, { src }, 'did-stop-loading');

        // Retry a few times due to flake.
        for (let i = 0; i < 5; i++) {
          try {
            const image = await w.executeJavaScript('webview.capturePage()');
            const imgBuffer = image.toPNG();

            // Check the 25th byte in the PNG.
            // Values can be 0,2,3,4, or 6. We want 6, which is RGB + Alpha
            expect(imgBuffer[25]).to.equal(6);
            return;
          } catch (e) {
            /* drop the error */
          }
        }
        expect(false).to.be.true('could not successfully capture the page');
      });
    });

    // FIXME(zcbenz): Disabled because of moving to OOPIF webview.
    xdescribe('setDevToolsWebContents() API', () => {
      /*
      it('sets webContents of webview as devtools', async () => {
        const webview2 = new WebView();
        loadWebView(webview2);

        // Setup an event handler for further usage.
        const waitForDomReady = waitForEvent(webview2, 'dom-ready');

        loadWebView(webview, { src: 'about:blank' });
        await waitForEvent(webview, 'dom-ready');
        webview.getWebContents().setDevToolsWebContents(webview2.getWebContents());
        webview.getWebContents().openDevTools();

        await waitForDomReady;

        // Its WebContents should be a DevTools.
        const devtools = webview2.getWebContents();
        expect(devtools.getURL().startsWith('devtools://devtools')).to.be.true();

        const name = await devtools.executeJavaScript('InspectorFrontendHost.constructor.name');
        document.body.removeChild(webview2);

        expect(name).to.be.equal('InspectorFrontendHostImpl');
      });
      */
    });
  });

  describe('basic auth', () => {
    let w: WebContents;
    before(async () => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          webviewTag: true,
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      await window.loadURL(`file://${fixtures}/pages/blank.html`);
      w = window.webContents;
    });
    afterEach(async () => {
      await w.executeJavaScript(`{
        document.querySelectorAll('webview').forEach(el => el.remove())
      }`);
    });
    after(closeAllWindows);

    it('should authenticate with correct credentials', async () => {
      const message = 'Authenticated';
      const server = http.createServer((req, res) => {
        const credentials = auth(req)!;
        if (credentials.name === 'test' && credentials.pass === 'test') {
          res.end(message);
        } else {
          res.end('failed');
        }
      });
      defer(() => {
        server.close();
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const e = await loadWebViewAndWaitForEvent(w, {
        nodeintegration: 'on',
        webpreferences: 'contextIsolation=no',
        src: `file://${fixtures}/pages/basic-auth.html?port=${port}`
      }, 'ipc-message');
      expect(e.channel).to.equal(message);
    });
  });
});
