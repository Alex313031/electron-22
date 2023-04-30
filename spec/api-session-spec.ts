import { expect } from 'chai';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as ChildProcess from 'child_process';
import { app, session, BrowserWindow, net, ipcMain, Session, webFrameMain, WebFrameMain } from 'electron/main';
import * as send from 'send';
import * as auth from 'basic-auth';
import { closeAllWindows } from './window-helpers';
import { emittedOnce } from './events-helpers';
import { defer, delay } from './spec-helpers';
import { AddressInfo } from 'net';

/* The whole session API doesn't use standard callbacks */
/* eslint-disable standard/no-callback-literal */

describe('session module', () => {
  const fixtures = path.resolve(__dirname, 'fixtures');
  const url = 'http://127.0.0.1';

  describe('session.defaultSession', () => {
    it('returns the default session', () => {
      expect(session.defaultSession).to.equal(session.fromPartition(''));
    });
  });

  describe('session.fromPartition(partition, options)', () => {
    it('returns existing session with same partition', () => {
      expect(session.fromPartition('test')).to.equal(session.fromPartition('test'));
    });
  });

  describe('ses.cookies', () => {
    const name = '0';
    const value = '0';
    afterEach(closeAllWindows);

    // Clear cookie of defaultSession after each test.
    afterEach(async () => {
      const { cookies } = session.defaultSession;
      const cs = await cookies.get({ url });
      for (const c of cs) {
        await cookies.remove(url, c.name);
      }
    });

    it('should get cookies', async () => {
      const server = http.createServer((req, res) => {
        res.setHeader('Set-Cookie', [`${name}=${value}`]);
        res.end('finished');
        server.close();
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const w = new BrowserWindow({ show: false });
      await w.loadURL(`${url}:${port}`);
      const list = await w.webContents.session.cookies.get({ url });
      const cookie = list.find(cookie => cookie.name === name);
      expect(cookie).to.exist.and.to.have.property('value', value);
    });

    it('sets cookies', async () => {
      const { cookies } = session.defaultSession;
      const name = '1';
      const value = '1';

      await cookies.set({ url, name, value, expirationDate: (+new Date()) / 1000 + 120 });
      const c = (await cookies.get({ url }))[0];
      expect(c.name).to.equal(name);
      expect(c.value).to.equal(value);
      expect(c.session).to.equal(false);
    });

    it('sets session cookies', async () => {
      const { cookies } = session.defaultSession;
      const name = '2';
      const value = '1';

      await cookies.set({ url, name, value });
      const c = (await cookies.get({ url }))[0];
      expect(c.name).to.equal(name);
      expect(c.value).to.equal(value);
      expect(c.session).to.equal(true);
    });

    it('sets cookies without name', async () => {
      const { cookies } = session.defaultSession;
      const value = '3';

      await cookies.set({ url, value });
      const c = (await cookies.get({ url }))[0];
      expect(c.name).to.be.empty();
      expect(c.value).to.equal(value);
    });

    for (const sameSite of <const>['unspecified', 'no_restriction', 'lax', 'strict']) {
      it(`sets cookies with samesite=${sameSite}`, async () => {
        const { cookies } = session.defaultSession;
        const value = 'hithere';
        await cookies.set({ url, value, sameSite });
        const c = (await cookies.get({ url }))[0];
        expect(c.name).to.be.empty();
        expect(c.value).to.equal(value);
        expect(c.sameSite).to.equal(sameSite);
      });
    }

    it('fails to set cookies with samesite=garbage', async () => {
      const { cookies } = session.defaultSession;
      const value = 'hithere';
      await expect(cookies.set({ url, value, sameSite: 'garbage' as any })).to.eventually.be.rejectedWith('Failed to convert \'garbage\' to an appropriate cookie same site value');
    });

    it('gets cookies without url', async () => {
      const { cookies } = session.defaultSession;
      const name = '1';
      const value = '1';

      await cookies.set({ url, name, value, expirationDate: (+new Date()) / 1000 + 120 });
      const cs = await cookies.get({ domain: '127.0.0.1' });
      expect(cs.some(c => c.name === name && c.value === value)).to.equal(true);
    });

    it('yields an error when setting a cookie with missing required fields', async () => {
      const { cookies } = session.defaultSession;
      const name = '1';
      const value = '1';

      await expect(
        cookies.set({ url: '', name, value })
      ).to.eventually.be.rejectedWith('Failed to set cookie with an invalid domain attribute');
    });

    it('yields an error when setting a cookie with an invalid URL', async () => {
      const { cookies } = session.defaultSession;
      const name = '1';
      const value = '1';

      await expect(
        cookies.set({ url: 'asdf', name, value })
      ).to.eventually.be.rejectedWith('Failed to set cookie with an invalid domain attribute');
    });

    it('should overwrite previous cookies', async () => {
      const { cookies } = session.defaultSession;
      const name = 'DidOverwrite';
      for (const value of ['No', 'Yes']) {
        await cookies.set({ url, name, value, expirationDate: (+new Date()) / 1000 + 120 });
        const list = await cookies.get({ url });

        expect(list.some(cookie => cookie.name === name && cookie.value === value)).to.equal(true);
      }
    });

    it('should remove cookies', async () => {
      const { cookies } = session.defaultSession;
      const name = '2';
      const value = '2';

      await cookies.set({ url, name, value, expirationDate: (+new Date()) / 1000 + 120 });
      await cookies.remove(url, name);
      const list = await cookies.get({ url });

      expect(list.some(cookie => cookie.name === name && cookie.value === value)).to.equal(false);
    });

    it.skip('should set cookie for standard scheme', async () => {
      const { cookies } = session.defaultSession;
      const domain = 'fake-host';
      const url = `${standardScheme}://${domain}`;
      const name = 'custom';
      const value = '1';

      await cookies.set({ url, name, value, expirationDate: (+new Date()) / 1000 + 120 });
      const list = await cookies.get({ url });

      expect(list).to.have.lengthOf(1);
      expect(list[0]).to.have.property('name', name);
      expect(list[0]).to.have.property('value', value);
      expect(list[0]).to.have.property('domain', domain);
    });

    it('emits a changed event when a cookie is added or removed', async () => {
      const { cookies } = session.fromPartition('cookies-changed');
      const name = 'foo';
      const value = 'bar';

      const a = emittedOnce(cookies, 'changed');
      await cookies.set({ url, name, value, expirationDate: (+new Date()) / 1000 + 120 });
      const [, setEventCookie, setEventCause, setEventRemoved] = await a;

      const b = emittedOnce(cookies, 'changed');
      await cookies.remove(url, name);
      const [, removeEventCookie, removeEventCause, removeEventRemoved] = await b;

      expect(setEventCookie.name).to.equal(name);
      expect(setEventCookie.value).to.equal(value);
      expect(setEventCause).to.equal('explicit');
      expect(setEventRemoved).to.equal(false);

      expect(removeEventCookie.name).to.equal(name);
      expect(removeEventCookie.value).to.equal(value);
      expect(removeEventCause).to.equal('explicit');
      expect(removeEventRemoved).to.equal(true);
    });

    describe('ses.cookies.flushStore()', async () => {
      it('flushes the cookies to disk', async () => {
        const name = 'foo';
        const value = 'bar';
        const { cookies } = session.defaultSession;

        await cookies.set({ url, name, value });
        await cookies.flushStore();
      });
    });

    it('should survive an app restart for persistent partition', async function () {
      this.timeout(60000);
      const appPath = path.join(fixtures, 'api', 'cookie-app');

      const runAppWithPhase = (phase: string) => {
        return new Promise((resolve) => {
          let output = '';

          const appProcess = ChildProcess.spawn(
            process.execPath,
            [appPath],
            { env: { PHASE: phase, ...process.env } }
          );

          appProcess.stdout.on('data', data => { output += data; });
          appProcess.on('exit', () => {
            resolve(output.replace(/(\r\n|\n|\r)/gm, ''));
          });
        });
      };

      expect(await runAppWithPhase('one')).to.equal('011');
      expect(await runAppWithPhase('two')).to.equal('110');
    });
  });

  describe('ses.clearStorageData(options)', () => {
    afterEach(closeAllWindows);
    it('clears localstorage data', async () => {
      const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true } });
      await w.loadFile(path.join(fixtures, 'api', 'localstorage.html'));
      const options = {
        origin: 'file://',
        storages: ['localstorage'],
        quotas: ['persistent']
      };
      await w.webContents.session.clearStorageData(options);
      while (await w.webContents.executeJavaScript('localStorage.length') !== 0) {
        // The storage clear isn't instantly visible to the renderer, so keep
        // trying until it is.
      }
    });
  });

  describe('will-download event', () => {
    afterEach(closeAllWindows);
    it('can cancel default download behavior', async () => {
      const w = new BrowserWindow({ show: false });
      const mockFile = Buffer.alloc(1024);
      const contentDisposition = 'inline; filename="mockFile.txt"';
      const downloadServer = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Length': mockFile.length,
          'Content-Type': 'application/plain',
          'Content-Disposition': contentDisposition
        });
        res.end(mockFile);
        downloadServer.close();
      });
      await new Promise<void>(resolve => downloadServer.listen(0, '127.0.0.1', resolve));

      const port = (downloadServer.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/`;

      const downloadPrevented: Promise<{itemUrl: string, itemFilename: string, item: Electron.DownloadItem}> = new Promise(resolve => {
        w.webContents.session.once('will-download', function (e, item) {
          e.preventDefault();
          resolve({ itemUrl: item.getURL(), itemFilename: item.getFilename(), item });
        });
      });
      w.loadURL(url);
      const { item, itemUrl, itemFilename } = await downloadPrevented;
      expect(itemUrl).to.equal(url);
      expect(itemFilename).to.equal('mockFile.txt');
      // Delay till the next tick.
      await new Promise<void>(resolve => setImmediate(() => resolve()));
      expect(() => item.getURL()).to.throw('DownloadItem used after being destroyed');
    });
  });

  describe('ses.protocol', () => {
    const partitionName = 'temp';
    const protocolName = 'sp';
    let customSession: Session;
    const protocol = session.defaultSession.protocol;
    const handler = (ignoredError: any, callback: Function) => {
      callback({ data: '<script>require(\'electron\').ipcRenderer.send(\'hello\')</script>', mimeType: 'text/html' });
    };

    beforeEach(async () => {
      customSession = session.fromPartition(partitionName);
      await customSession.protocol.registerStringProtocol(protocolName, handler);
    });

    afterEach(async () => {
      await customSession.protocol.unregisterProtocol(protocolName);
      customSession = null as any;
    });
    afterEach(closeAllWindows);

    it('does not affect defaultSession', () => {
      const result1 = protocol.isProtocolRegistered(protocolName);
      expect(result1).to.equal(false);

      const result2 = customSession.protocol.isProtocolRegistered(protocolName);
      expect(result2).to.equal(true);
    });

    it('handles requests from partition', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          partition: partitionName,
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      customSession = session.fromPartition(partitionName);
      await customSession.protocol.registerStringProtocol(protocolName, handler);
      w.loadURL(`${protocolName}://fake-host`);
      await emittedOnce(ipcMain, 'hello');
    });
  });

  describe('ses.setProxy(options)', () => {
    let server: http.Server;
    let customSession: Electron.Session;
    let created = false;

    beforeEach(async () => {
      customSession = session.fromPartition('proxyconfig');
      if (!created) {
        // Work around for https://github.com/electron/electron/issues/26166 to
        // reduce flake
        await delay(100);
        created = true;
      }
    });

    afterEach(() => {
      if (server) {
        server.close();
      }
      customSession = null as any;
    });

    it('allows configuring proxy settings', async () => {
      const config = { proxyRules: 'http=myproxy:80' };
      await customSession.setProxy(config);
      const proxy = await customSession.resolveProxy('http://example.com/');
      expect(proxy).to.equal('PROXY myproxy:80');
    });

    it('allows removing the implicit bypass rules for localhost', async () => {
      const config = {
        proxyRules: 'http=myproxy:80',
        proxyBypassRules: '<-loopback>'
      };

      await customSession.setProxy(config);
      const proxy = await customSession.resolveProxy('http://localhost');
      expect(proxy).to.equal('PROXY myproxy:80');
    });

    it('allows configuring proxy settings with pacScript', async () => {
      server = http.createServer((req, res) => {
        const pac = `
          function FindProxyForURL(url, host) {
            return "PROXY myproxy:8132";
          }
        `;
        res.writeHead(200, {
          'Content-Type': 'application/x-ns-proxy-autoconfig'
        });
        res.end(pac);
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      {
        const config = { pacScript: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
        await customSession.setProxy(config);
        const proxy = await customSession.resolveProxy('https://google.com');
        expect(proxy).to.equal('PROXY myproxy:8132');
      }
      {
        const config = { mode: 'pac_script' as any, pacScript: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
        await customSession.setProxy(config);
        const proxy = await customSession.resolveProxy('https://google.com');
        expect(proxy).to.equal('PROXY myproxy:8132');
      }
    });

    it('allows bypassing proxy settings', async () => {
      const config = {
        proxyRules: 'http=myproxy:80',
        proxyBypassRules: '<local>'
      };
      await customSession.setProxy(config);
      const proxy = await customSession.resolveProxy('http://example/');
      expect(proxy).to.equal('DIRECT');
    });

    it('allows configuring proxy settings with mode `direct`', async () => {
      const config = { mode: 'direct' as any, proxyRules: 'http=myproxy:80' };
      await customSession.setProxy(config);
      const proxy = await customSession.resolveProxy('http://example.com/');
      expect(proxy).to.equal('DIRECT');
    });

    it('allows configuring proxy settings with mode `auto_detect`', async () => {
      const config = { mode: 'auto_detect' as any };
      await customSession.setProxy(config);
    });

    it('allows configuring proxy settings with mode `pac_script`', async () => {
      const config = { mode: 'pac_script' as any };
      await customSession.setProxy(config);
      const proxy = await customSession.resolveProxy('http://example.com/');
      expect(proxy).to.equal('DIRECT');
    });

    it('allows configuring proxy settings with mode `fixed_servers`', async () => {
      const config = { mode: 'fixed_servers' as any, proxyRules: 'http=myproxy:80' };
      await customSession.setProxy(config);
      const proxy = await customSession.resolveProxy('http://example.com/');
      expect(proxy).to.equal('PROXY myproxy:80');
    });

    it('allows configuring proxy settings with mode `system`', async () => {
      const config = { mode: 'system' as any };
      await customSession.setProxy(config);
    });

    it('disallows configuring proxy settings with mode `invalid`', async () => {
      const config = { mode: 'invalid' as any };
      await expect(customSession.setProxy(config)).to.eventually.be.rejectedWith(/Invalid mode/);
    });

    it('reload proxy configuration', async () => {
      let proxyPort = 8132;
      server = http.createServer((req, res) => {
        const pac = `
          function FindProxyForURL(url, host) {
            return "PROXY myproxy:${proxyPort}";
          }
        `;
        res.writeHead(200, {
          'Content-Type': 'application/x-ns-proxy-autoconfig'
        });
        res.end(pac);
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const config = { mode: 'pac_script' as any, pacScript: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      await customSession.setProxy(config);
      {
        const proxy = await customSession.resolveProxy('https://google.com');
        expect(proxy).to.equal(`PROXY myproxy:${proxyPort}`);
      }
      {
        proxyPort = 8133;
        await customSession.forceReloadProxyConfig();
        const proxy = await customSession.resolveProxy('https://google.com');
        expect(proxy).to.equal(`PROXY myproxy:${proxyPort}`);
      }
    });
  });

  describe('ses.getBlobData()', () => {
    const scheme = 'cors-blob';
    const protocol = session.defaultSession.protocol;
    const url = `${scheme}://host`;
    after(async () => {
      await protocol.unregisterProtocol(scheme);
    });
    afterEach(closeAllWindows);

    it('returns blob data for uuid', (done) => {
      const postData = JSON.stringify({
        type: 'blob',
        value: 'hello'
      });
      const content = `<html>
                       <script>
                       let fd = new FormData();
                       fd.append('file', new Blob(['${postData}'], {type:'application/json'}));
                       fetch('${url}', {method:'POST', body: fd });
                       </script>
                       </html>`;

      protocol.registerStringProtocol(scheme, (request, callback) => {
        try {
          if (request.method === 'GET') {
            callback({ data: content, mimeType: 'text/html' });
          } else if (request.method === 'POST') {
            const uuid = request.uploadData![1].blobUUID;
            expect(uuid).to.be.a('string');
            session.defaultSession.getBlobData(uuid!).then(result => {
              try {
                expect(result.toString()).to.equal(postData);
                done();
              } catch (e) {
                done(e);
              }
            });
          }
        } catch (e) {
          done(e);
        }
      });
      const w = new BrowserWindow({ show: false });
      w.loadURL(url);
    });
  });

  describe('ses.getBlobData2()', () => {
    const scheme = 'cors-blob';
    const protocol = session.defaultSession.protocol;
    const url = `${scheme}://host`;
    after(async () => {
      await protocol.unregisterProtocol(scheme);
    });
    afterEach(closeAllWindows);

    it('returns blob data for uuid', (done) => {
      const content = `<html>
                       <script>
                       let fd = new FormData();
                       fd.append("data", new Blob(new Array(65_537).fill('a')));
                       fetch('${url}', {method:'POST', body: fd });
                       </script>
                       </html>`;

      protocol.registerStringProtocol(scheme, (request, callback) => {
        try {
          if (request.method === 'GET') {
            callback({ data: content, mimeType: 'text/html' });
          } else if (request.method === 'POST') {
            const uuid = request.uploadData![1].blobUUID;
            expect(uuid).to.be.a('string');
            session.defaultSession.getBlobData(uuid!).then(result => {
              try {
                const data = new Array(65_537).fill('a');
                expect(result.toString()).to.equal(data.join(''));
                done();
              } catch (e) {
                done(e);
              }
            });
          }
        } catch (e) {
          done(e);
        }
      });
      const w = new BrowserWindow({ show: false });
      w.loadURL(url);
    });
  });

  describe('ses.setCertificateVerifyProc(callback)', () => {
    let server: http.Server;

    beforeEach((done) => {
      const certPath = path.join(fixtures, 'certificates');
      const options = {
        key: fs.readFileSync(path.join(certPath, 'server.key')),
        cert: fs.readFileSync(path.join(certPath, 'server.pem')),
        ca: [
          fs.readFileSync(path.join(certPath, 'rootCA.pem')),
          fs.readFileSync(path.join(certPath, 'intermediateCA.pem'))
        ],
        rejectUnauthorized: false
      };

      server = https.createServer(options, (req, res) => {
        res.writeHead(200);
        res.end('<title>hello</title>');
      });
      server.listen(0, '127.0.0.1', done);
    });

    afterEach((done) => {
      server.close(done);
    });
    afterEach(closeAllWindows);

    it('accepts the request when the callback is called with 0', async () => {
      const ses = session.fromPartition(`${Math.random()}`);
      let validate: () => void;
      ses.setCertificateVerifyProc(({ hostname, verificationResult, errorCode }, callback) => {
        if (hostname !== '127.0.0.1') return callback(-3);
        validate = () => {
          expect(verificationResult).to.be.oneOf(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID']);
          expect(errorCode).to.be.oneOf([-202, -200]);
        };
        callback(0);
      });

      const w = new BrowserWindow({ show: false, webPreferences: { session: ses } });
      await w.loadURL(`https://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(w.webContents.getTitle()).to.equal('hello');
      expect(validate!).not.to.be.undefined();
      validate!();
    });

    it('rejects the request when the callback is called with -2', async () => {
      const ses = session.fromPartition(`${Math.random()}`);
      let validate: () => void;
      ses.setCertificateVerifyProc(({ hostname, certificate, verificationResult, isIssuedByKnownRoot }, callback) => {
        if (hostname !== '127.0.0.1') return callback(-3);
        validate = () => {
          expect(certificate.issuerName).to.equal('Intermediate CA');
          expect(certificate.subjectName).to.equal('localhost');
          expect(certificate.issuer.commonName).to.equal('Intermediate CA');
          expect(certificate.subject.commonName).to.equal('localhost');
          expect(certificate.issuerCert.issuer.commonName).to.equal('Root CA');
          expect(certificate.issuerCert.subject.commonName).to.equal('Intermediate CA');
          expect(certificate.issuerCert.issuerCert.issuer.commonName).to.equal('Root CA');
          expect(certificate.issuerCert.issuerCert.subject.commonName).to.equal('Root CA');
          expect(certificate.issuerCert.issuerCert.issuerCert).to.equal(undefined);
          expect(verificationResult).to.be.oneOf(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID']);
          expect(isIssuedByKnownRoot).to.be.false();
        };
        callback(-2);
      });

      const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const w = new BrowserWindow({ show: false, webPreferences: { session: ses } });
      await expect(w.loadURL(url)).to.eventually.be.rejectedWith(/ERR_FAILED/);
      expect(w.webContents.getTitle()).to.equal(url);
      expect(validate!).not.to.be.undefined();
      validate!();
    });

    it('saves cached results', async () => {
      const ses = session.fromPartition(`${Math.random()}`);
      let numVerificationRequests = 0;
      ses.setCertificateVerifyProc((e, callback) => {
        if (e.hostname !== '127.0.0.1') return callback(-3);
        numVerificationRequests++;
        callback(-2);
      });

      const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const w = new BrowserWindow({ show: false, webPreferences: { session: ses } });
      await expect(w.loadURL(url), 'first load').to.eventually.be.rejectedWith(/ERR_FAILED/);
      await emittedOnce(w.webContents, 'did-stop-loading');
      await expect(w.loadURL(url + '/test'), 'second load').to.eventually.be.rejectedWith(/ERR_FAILED/);
      expect(w.webContents.getTitle()).to.equal(url + '/test');
      expect(numVerificationRequests).to.equal(1);
    });

    it('does not cancel requests in other sessions', async () => {
      const ses1 = session.fromPartition(`${Math.random()}`);
      ses1.setCertificateVerifyProc((opts, cb) => cb(0));
      const ses2 = session.fromPartition(`${Math.random()}`);

      const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const req = net.request({ url, session: ses1, credentials: 'include' });
      req.end();
      setTimeout(() => {
        ses2.setCertificateVerifyProc((opts, callback) => callback(0));
      });
      await expect(new Promise<void>((resolve, reject) => {
        req.on('error', (err) => {
          reject(err);
        });
        req.on('response', () => {
          resolve();
        });
      })).to.eventually.be.fulfilled();
    });
  });

  describe('ses.clearAuthCache()', () => {
    it('can clear http auth info from cache', async () => {
      const ses = session.fromPartition('auth-cache');
      const server = http.createServer((req, res) => {
        const credentials = auth(req);
        if (!credentials || credentials.name !== 'test' || credentials.pass !== 'test') {
          res.statusCode = 401;
          res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
          res.end();
        } else {
          res.end('authenticated');
        }
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const fetch = (url: string) => new Promise((resolve, reject) => {
        const request = net.request({ url, session: ses });
        request.on('response', (response) => {
          let data: string | null = null;
          response.on('data', (chunk) => {
            if (!data) {
              data = '';
            }
            data += chunk;
          });
          response.on('end', () => {
            if (!data) {
              reject(new Error('Empty response'));
            } else {
              resolve(data);
            }
          });
          response.on('error', (error: any) => { reject(new Error(error)); });
        });
        request.on('error', (error: any) => { reject(new Error(error)); });
        request.end();
      });
      // the first time should throw due to unauthenticated
      await expect(fetch(`http://127.0.0.1:${port}`)).to.eventually.be.rejected();
      // passing the password should let us in
      expect(await fetch(`http://test:test@127.0.0.1:${port}`)).to.equal('authenticated');
      // subsequently, the credentials are cached
      expect(await fetch(`http://127.0.0.1:${port}`)).to.equal('authenticated');
      await ses.clearAuthCache();
      // once the cache is cleared, we should get an error again
      await expect(fetch(`http://127.0.0.1:${port}`)).to.eventually.be.rejected();
    });
  });

  describe('DownloadItem', () => {
    const mockPDF = Buffer.alloc(1024 * 1024 * 5);
    const downloadFilePath = path.join(__dirname, '..', 'fixtures', 'mock.pdf');
    const protocolName = 'custom-dl';
    const contentDisposition = 'inline; filename="mock.pdf"';
    let address: AddressInfo;
    let downloadServer: http.Server;
    before(async () => {
      downloadServer = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Length': mockPDF.length,
          'Content-Type': 'application/pdf',
          'Content-Disposition': req.url === '/?testFilename' ? 'inline' : contentDisposition
        });
        res.end(mockPDF);
      });
      await new Promise<void>(resolve => downloadServer.listen(0, '127.0.0.1', resolve));
      address = downloadServer.address() as AddressInfo;
    });
    after(async () => {
      await new Promise(resolve => downloadServer.close(resolve));
    });
    afterEach(closeAllWindows);

    const isPathEqual = (path1: string, path2: string) => {
      return path.relative(path1, path2) === '';
    };
    const assertDownload = (state: string, item: Electron.DownloadItem, isCustom = false) => {
      expect(state).to.equal('completed');
      expect(item.getFilename()).to.equal('mock.pdf');
      expect(path.isAbsolute(item.savePath)).to.equal(true);
      expect(isPathEqual(item.savePath, downloadFilePath)).to.equal(true);
      if (isCustom) {
        expect(item.getURL()).to.equal(`${protocolName}://item`);
      } else {
        expect(item.getURL()).to.be.equal(`${url}:${address.port}/`);
      }
      expect(item.getMimeType()).to.equal('application/pdf');
      expect(item.getReceivedBytes()).to.equal(mockPDF.length);
      expect(item.getTotalBytes()).to.equal(mockPDF.length);
      expect(item.getContentDisposition()).to.equal(contentDisposition);
      expect(fs.existsSync(downloadFilePath)).to.equal(true);
      fs.unlinkSync(downloadFilePath);
    };

    it('can download using session.downloadURL', (done) => {
      const port = address.port;
      session.defaultSession.once('will-download', function (e, item) {
        item.savePath = downloadFilePath;
        item.on('done', function (e, state) {
          try {
            assertDownload(state, item);
            done();
          } catch (e) {
            done(e);
          }
        });
      });
      session.defaultSession.downloadURL(`${url}:${port}`);
    });

    it('can download using WebContents.downloadURL', (done) => {
      const port = address.port;
      const w = new BrowserWindow({ show: false });
      w.webContents.session.once('will-download', function (e, item) {
        item.savePath = downloadFilePath;
        item.on('done', function (e, state) {
          try {
            assertDownload(state, item);
            done();
          } catch (e) {
            done(e);
          }
        });
      });
      w.webContents.downloadURL(`${url}:${port}`);
    });

    it('can download from custom protocols using WebContents.downloadURL', (done) => {
      const protocol = session.defaultSession.protocol;
      const port = address.port;
      const handler = (ignoredError: any, callback: Function) => {
        callback({ url: `${url}:${port}` });
      };
      protocol.registerHttpProtocol(protocolName, handler);
      const w = new BrowserWindow({ show: false });
      w.webContents.session.once('will-download', function (e, item) {
        item.savePath = downloadFilePath;
        item.on('done', function (e, state) {
          try {
            assertDownload(state, item, true);
            done();
          } catch (e) {
            done(e);
          }
        });
      });
      w.webContents.downloadURL(`${protocolName}://item`);
    });

    it('can download using WebView.downloadURL', async () => {
      const port = address.port;
      const w = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } });
      await w.loadURL('about:blank');
      function webviewDownload ({ fixtures, url, port }: {fixtures: string, url: string, port: string}) {
        const webview = new (window as any).WebView();
        webview.addEventListener('did-finish-load', () => {
          webview.downloadURL(`${url}:${port}/`);
        });
        webview.src = `file://${fixtures}/api/blank.html`;
        document.body.appendChild(webview);
      }
      const done: Promise<[string, Electron.DownloadItem]> = new Promise(resolve => {
        w.webContents.session.once('will-download', function (e, item) {
          item.savePath = downloadFilePath;
          item.on('done', function (e, state) {
            resolve([state, item]);
          });
        });
      });
      await w.webContents.executeJavaScript(`(${webviewDownload})(${JSON.stringify({ fixtures, url, port })})`);
      const [state, item] = await done;
      assertDownload(state, item);
    });

    it('can cancel download', (done) => {
      const port = address.port;
      const w = new BrowserWindow({ show: false });
      w.webContents.session.once('will-download', function (e, item) {
        item.savePath = downloadFilePath;
        item.on('done', function (e, state) {
          try {
            expect(state).to.equal('cancelled');
            expect(item.getFilename()).to.equal('mock.pdf');
            expect(item.getMimeType()).to.equal('application/pdf');
            expect(item.getReceivedBytes()).to.equal(0);
            expect(item.getTotalBytes()).to.equal(mockPDF.length);
            expect(item.getContentDisposition()).to.equal(contentDisposition);
            done();
          } catch (e) {
            done(e);
          }
        });
        item.cancel();
      });
      w.webContents.downloadURL(`${url}:${port}/`);
    });

    it('can generate a default filename', function (done) {
      if (process.env.APPVEYOR === 'True') {
        // FIXME(alexeykuzmin): Skip the test.
        // this.skip()
        return done();
      }

      const port = address.port;
      const w = new BrowserWindow({ show: false });
      w.webContents.session.once('will-download', function (e, item) {
        item.savePath = downloadFilePath;
        item.on('done', function () {
          try {
            expect(item.getFilename()).to.equal('download.pdf');
            done();
          } catch (e) {
            done(e);
          }
        });
        item.cancel();
      });
      w.webContents.downloadURL(`${url}:${port}/?testFilename`);
    });

    it('can set options for the save dialog', (done) => {
      const filePath = path.join(__dirname, 'fixtures', 'mock.pdf');
      const port = address.port;
      const options = {
        window: null,
        title: 'title',
        message: 'message',
        buttonLabel: 'buttonLabel',
        nameFieldLabel: 'nameFieldLabel',
        defaultPath: '/',
        filters: [{
          name: '1', extensions: ['.1', '.2']
        }, {
          name: '2', extensions: ['.3', '.4', '.5']
        }],
        showsTagField: true,
        securityScopedBookmarks: true
      };

      const w = new BrowserWindow({ show: false });
      w.webContents.session.once('will-download', function (e, item) {
        item.setSavePath(filePath);
        item.setSaveDialogOptions(options);
        item.on('done', function () {
          try {
            expect(item.getSaveDialogOptions()).to.deep.equal(options);
            done();
          } catch (e) {
            done(e);
          }
        });
        item.cancel();
      });
      w.webContents.downloadURL(`${url}:${port}`);
    });

    describe('when a save path is specified and the URL is unavailable', () => {
      it('does not display a save dialog and reports the done state as interrupted', (done) => {
        const w = new BrowserWindow({ show: false });
        w.webContents.session.once('will-download', function (e, item) {
          item.savePath = downloadFilePath;
          if (item.getState() === 'interrupted') {
            item.resume();
          }
          item.on('done', function (e, state) {
            try {
              expect(state).to.equal('interrupted');
              done();
            } catch (e) {
              done(e);
            }
          });
        });
        w.webContents.downloadURL(`file://${path.join(__dirname, 'does-not-exist.txt')}`);
      });
    });
  });

  describe('ses.createInterruptedDownload(options)', () => {
    afterEach(closeAllWindows);
    it('can create an interrupted download item', async () => {
      const downloadFilePath = path.join(__dirname, '..', 'fixtures', 'mock.pdf');
      const options = {
        path: downloadFilePath,
        urlChain: ['http://127.0.0.1/'],
        mimeType: 'application/pdf',
        offset: 0,
        length: 5242880
      };
      const w = new BrowserWindow({ show: false });
      const p = emittedOnce(w.webContents.session, 'will-download');
      w.webContents.session.createInterruptedDownload(options);
      const [, item] = await p;
      expect(item.getState()).to.equal('interrupted');
      item.cancel();
      expect(item.getURLChain()).to.deep.equal(options.urlChain);
      expect(item.getMimeType()).to.equal(options.mimeType);
      expect(item.getReceivedBytes()).to.equal(options.offset);
      expect(item.getTotalBytes()).to.equal(options.length);
      expect(item.savePath).to.equal(downloadFilePath);
    });

    it('can be resumed', async () => {
      const downloadFilePath = path.join(fixtures, 'logo.png');
      const rangeServer = http.createServer((req, res) => {
        const options = { root: fixtures };
        send(req, req.url!, options)
          .on('error', (error: any) => { throw error; }).pipe(res);
      });
      try {
        await new Promise<void>(resolve => rangeServer.listen(0, '127.0.0.1', resolve));
        const port = (rangeServer.address() as AddressInfo).port;
        const w = new BrowserWindow({ show: false });
        const downloadCancelled: Promise<Electron.DownloadItem> = new Promise((resolve) => {
          w.webContents.session.once('will-download', function (e, item) {
            item.setSavePath(downloadFilePath);
            item.on('done', function () {
              resolve(item);
            });
            item.cancel();
          });
        });
        const downloadUrl = `http://127.0.0.1:${port}/assets/logo.png`;
        w.webContents.downloadURL(downloadUrl);
        const item = await downloadCancelled;
        expect(item.getState()).to.equal('cancelled');

        const options = {
          path: item.savePath,
          urlChain: item.getURLChain(),
          mimeType: item.getMimeType(),
          offset: item.getReceivedBytes(),
          length: item.getTotalBytes(),
          lastModified: item.getLastModifiedTime(),
          eTag: item.getETag()
        };
        const downloadResumed: Promise<Electron.DownloadItem> = new Promise((resolve) => {
          w.webContents.session.once('will-download', function (e, item) {
            expect(item.getState()).to.equal('interrupted');
            item.setSavePath(downloadFilePath);
            item.resume();
            item.on('done', function () {
              resolve(item);
            });
          });
        });
        w.webContents.session.createInterruptedDownload(options);
        const completedItem = await downloadResumed;
        expect(completedItem.getState()).to.equal('completed');
        expect(completedItem.getFilename()).to.equal('logo.png');
        expect(completedItem.savePath).to.equal(downloadFilePath);
        expect(completedItem.getURL()).to.equal(downloadUrl);
        expect(completedItem.getMimeType()).to.equal('image/png');
        expect(completedItem.getReceivedBytes()).to.equal(14022);
        expect(completedItem.getTotalBytes()).to.equal(14022);
        expect(fs.existsSync(downloadFilePath)).to.equal(true);
      } finally {
        rangeServer.close();
      }
    });
  });

  describe('ses.setPermissionRequestHandler(handler)', () => {
    afterEach(closeAllWindows);
    // These tests are done on an http server because navigator.userAgentData
    // requires a secure context.
    let server: http.Server;
    let serverUrl: string;
    before(async () => {
      server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('');
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      serverUrl = `http://localhost:${(server.address() as any).port}`;
    });
    after(() => {
      server.close();
    });

    it('cancels any pending requests when cleared', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          partition: 'very-temp-permission-handler',
          nodeIntegration: true,
          contextIsolation: false
        }
      });

      const ses = w.webContents.session;
      ses.setPermissionRequestHandler(() => {
        ses.setPermissionRequestHandler(null);
      });

      ses.protocol.interceptStringProtocol('https', (req, cb) => {
        cb(`<html><script>(${remote})()</script></html>`);
      });

      const result = emittedOnce(require('electron').ipcMain, 'message');

      function remote () {
        (navigator as any).requestMIDIAccess({ sysex: true }).then(() => {}, (err: any) => {
          require('electron').ipcRenderer.send('message', err.name);
        });
      }

      await w.loadURL('https://myfakesite');

      const [, name] = await result;
      expect(name).to.deep.equal('SecurityError');
    });

    it('successfully resolves when calling legacy getUserMedia', async () => {
      const ses = session.fromPartition('' + Math.random());
      ses.setPermissionRequestHandler(
        (_webContents, _permission, callback) => {
          callback(true);
        }
      );

      const w = new BrowserWindow({ show: false, webPreferences: { session: ses } });
      await w.loadURL(serverUrl);
      const { ok, message } = await w.webContents.executeJavaScript(`
        new Promise((resolve, reject) => navigator.getUserMedia({
          video: true,
          audio: true,
        }, x => resolve({ok: x instanceof MediaStream}), e => reject({ok: false, message: e.message})))
      `);
      expect(ok).to.be.true(message);
    });

    it('successfully rejects when calling legacy getUserMedia', async () => {
      const ses = session.fromPartition('' + Math.random());
      ses.setPermissionRequestHandler(
        (_webContents, _permission, callback) => {
          callback(false);
        }
      );

      const w = new BrowserWindow({ show: false, webPreferences: { session: ses } });
      await w.loadURL(serverUrl);
      await expect(w.webContents.executeJavaScript(`
        new Promise((resolve, reject) => navigator.getUserMedia({
          video: true,
          audio: true,
        }, x => resolve({ok: x instanceof MediaStream}), e => reject({ok: false, message: e.message})))
      `)).to.eventually.be.rejectedWith('Permission denied');
    });
  });

  describe('ses.setPermissionCheckHandler(handler)', () => {
    afterEach(closeAllWindows);
    it('details provides requestingURL for mainFrame', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          partition: 'very-temp-permission-handler'
        }
      });
      const ses = w.webContents.session;
      const loadUrl = 'https://myfakesite/';
      let handlerDetails : Electron.PermissionCheckHandlerHandlerDetails;

      ses.protocol.interceptStringProtocol('https', (req, cb) => {
        cb('<html><script>console.log(\'test\');</script></html>');
      });

      ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
        if (permission === 'clipboard-read') {
          handlerDetails = details;
          return true;
        }
        return false;
      });

      const readClipboardPermission: any = () => {
        return w.webContents.executeJavaScript(`
          navigator.permissions.query({name: 'clipboard-read'})
              .then(permission => permission.state).catch(err => err.message);
        `, true);
      };

      await w.loadURL(loadUrl);
      const state = await readClipboardPermission();
      expect(state).to.equal('granted');
      expect(handlerDetails!.requestingUrl).to.equal(loadUrl);
    });

    it('details provides requestingURL for cross origin subFrame', async () => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          partition: 'very-temp-permission-handler'
        }
      });
      const ses = w.webContents.session;
      const loadUrl = 'https://myfakesite/';
      let handlerDetails : Electron.PermissionCheckHandlerHandlerDetails;

      ses.protocol.interceptStringProtocol('https', (req, cb) => {
        cb('<html><script>console.log(\'test\');</script></html>');
      });

      ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
        if (permission === 'clipboard-read') {
          handlerDetails = details;
          return true;
        }
        return false;
      });

      const readClipboardPermission: any = (frame: WebFrameMain) => {
        return frame.executeJavaScript(`
          navigator.permissions.query({name: 'clipboard-read'})
              .then(permission => permission.state).catch(err => err.message);
        `, true);
      };

      await w.loadFile(path.join(fixtures, 'api', 'blank.html'));
      w.webContents.executeJavaScript(`
        var iframe = document.createElement('iframe');
        iframe.src = '${loadUrl}';
        document.body.appendChild(iframe);
        null;
      `);
      const [,, frameProcessId, frameRoutingId] = await emittedOnce(w.webContents, 'did-frame-finish-load');
      const state = await readClipboardPermission(webFrameMain.fromId(frameProcessId, frameRoutingId));
      expect(state).to.equal('granted');
      expect(handlerDetails!.requestingUrl).to.equal(loadUrl);
      expect(handlerDetails!.isMainFrame).to.be.false();
      expect(handlerDetails!.embeddingOrigin).to.equal('file:///');
    });
  });

  describe('ses.isPersistent()', () => {
    afterEach(closeAllWindows);

    it('returns default session as persistent', () => {
      const w = new BrowserWindow({
        show: false
      });

      const ses = w.webContents.session;

      expect(ses.isPersistent()).to.be.true();
    });

    it('returns persist: session as persistent', () => {
      const ses = session.fromPartition(`persist:${Math.random()}`);
      expect(ses.isPersistent()).to.be.true();
    });

    it('returns temporary session as not persistent', () => {
      const ses = session.fromPartition(`${Math.random()}`);
      expect(ses.isPersistent()).to.be.false();
    });
  });

  describe('ses.setUserAgent()', () => {
    afterEach(closeAllWindows);

    it('can be retrieved with getUserAgent()', () => {
      const userAgent = 'test-agent';
      const ses = session.fromPartition('' + Math.random());
      ses.setUserAgent(userAgent);
      expect(ses.getUserAgent()).to.equal(userAgent);
    });

    it('sets the User-Agent header for web requests made from renderers', async () => {
      const userAgent = 'test-agent';
      const ses = session.fromPartition('' + Math.random());
      ses.setUserAgent(userAgent, 'en-US,fr,de');
      const w = new BrowserWindow({ show: false, webPreferences: { session: ses } });
      let headers: http.IncomingHttpHeaders | null = null;
      const server = http.createServer((req, res) => {
        headers = req.headers;
        res.end();
        server.close();
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      await w.loadURL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(headers!['user-agent']).to.equal(userAgent);
      expect(headers!['accept-language']).to.equal('en-US,fr;q=0.9,de;q=0.8');
    });
  });

  describe('session-created event', () => {
    it('is emitted when a session is created', async () => {
      const sessionCreated = emittedOnce(app, 'session-created');
      const session1 = session.fromPartition('' + Math.random());
      const [session2] = await sessionCreated;
      expect(session1).to.equal(session2);
    });
  });

  describe('session.storagePage', () => {
    it('returns a string', () => {
      expect(session.defaultSession.storagePath).to.be.a('string');
    });

    it('returns null for in memory sessions', () => {
      expect(session.fromPartition('in-memory').storagePath).to.equal(null);
    });

    it('returns different paths for partitions and the default session', () => {
      expect(session.defaultSession.storagePath).to.not.equal(session.fromPartition('persist:two').storagePath);
    });

    it('returns different paths for different partitions', () => {
      expect(session.fromPartition('persist:one').storagePath).to.not.equal(session.fromPartition('persist:two').storagePath);
    });
  });

  describe('session.setCodeCachePath()', () => {
    it('throws when relative or empty path is provided', () => {
      expect(() => {
        session.defaultSession.setCodeCachePath('../fixtures');
      }).to.throw('Absolute path must be provided to store code cache.');
      expect(() => {
        session.defaultSession.setCodeCachePath('');
      }).to.throw('Absolute path must be provided to store code cache.');
      expect(() => {
        session.defaultSession.setCodeCachePath(path.join(app.getPath('userData'), 'electron-test-code-cache'));
      }).to.not.throw();
    });
  });

  describe('ses.setSSLConfig()', () => {
    it('can disable cipher suites', async () => {
      const ses = session.fromPartition('' + Math.random());
      const fixturesPath = path.resolve(__dirname, 'fixtures');
      const certPath = path.join(fixturesPath, 'certificates');
      const server = https.createServer({
        key: fs.readFileSync(path.join(certPath, 'server.key')),
        cert: fs.readFileSync(path.join(certPath, 'server.pem')),
        ca: [
          fs.readFileSync(path.join(certPath, 'rootCA.pem')),
          fs.readFileSync(path.join(certPath, 'intermediateCA.pem'))
        ],
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        ciphers: 'AES128-GCM-SHA256'
      }, (req, res) => {
        res.end('hi');
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      defer(() => server.close());
      const { port } = server.address() as AddressInfo;

      function request () {
        return new Promise((resolve, reject) => {
          const r = net.request({
            url: `https://127.0.0.1:${port}`,
            session: ses
          });
          r.on('response', (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk.toString('utf8');
            });
            res.on('end', () => {
              resolve(data);
            });
          });
          r.on('error', (err) => {
            reject(err);
          });
          r.end();
        });
      }

      await expect(request()).to.be.rejectedWith(/ERR_CERT_AUTHORITY_INVALID/);
      ses.setSSLConfig({
        disabledCipherSuites: [0x009C]
      });
      await expect(request()).to.be.rejectedWith(/ERR_SSL_VERSION_OR_CIPHER_MISMATCH/);
    });
  });
});
