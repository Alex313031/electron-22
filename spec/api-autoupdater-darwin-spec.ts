import { expect } from 'chai';
import * as cp from 'child_process';
import * as http from 'http';
import * as express from 'express';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as psList from 'ps-list';
import { AddressInfo } from 'net';
import { ifdescribe, ifit } from './spec-helpers';
import * as uuid from 'uuid';
import { systemPreferences } from 'electron';

const features = process._linkedBinding('electron_common_features');

const fixturesPath = path.resolve(__dirname, 'fixtures');

// We can only test the auto updater on darwin non-component builds
ifdescribe(process.platform === 'darwin' && !(process.env.CI && process.arch === 'arm64') && !process.mas && !features.isComponentBuild())('autoUpdater behavior', function () {
  this.timeout(120000);

  let identity = '';

  beforeEach(function () {
    const result = cp.spawnSync(path.resolve(__dirname, '../script/codesign/get-trusted-identity.sh'));
    if (result.status !== 0 || result.stdout.toString().trim().length === 0) {
      // Per https://circleci.com/docs/2.0/env-vars:
      // CIRCLE_PR_NUMBER is only present on forked PRs
      if (process.env.CI && !process.env.CIRCLE_PR_NUMBER) {
        throw new Error('No valid signing identity available to run autoUpdater specs');
      }
      this.skip();
    } else {
      identity = result.stdout.toString().trim();
    }
  });

  it('should have a valid code signing identity', () => {
    expect(identity).to.be.a('string').with.lengthOf.at.least(1);
  });

  const copyApp = async (newDir: string, fixture = 'initial') => {
    const appBundlePath = path.resolve(process.execPath, '../../..');
    const newPath = path.resolve(newDir, 'Electron.app');
    cp.spawnSync('cp', ['-R', appBundlePath, path.dirname(newPath)]);
    const appDir = path.resolve(newPath, 'Contents/Resources/app');
    await fs.mkdirp(appDir);
    await fs.copy(path.resolve(fixturesPath, 'auto-update', fixture), appDir);
    const plistPath = path.resolve(newPath, 'Contents', 'Info.plist');
    await fs.writeFile(
      plistPath,
      (await fs.readFile(plistPath, 'utf8')).replace('<key>BuildMachineOSBuild</key>', `<key>NSAppTransportSecurity</key>
      <dict>
          <key>NSAllowsArbitraryLoads</key>
          <true/>
          <key>NSExceptionDomains</key>
          <dict>
              <key>localhost</key>
              <dict>
                  <key>NSExceptionAllowsInsecureHTTPLoads</key>
                  <true/>
                  <key>NSIncludesSubdomains</key>
                  <true/>
              </dict>
          </dict>
      </dict><key>BuildMachineOSBuild</key>`)
    );
    return newPath;
  };

  const spawn = (cmd: string, args: string[], opts: any = {}) => {
    let out = '';
    const child = cp.spawn(cmd, args, opts);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    return new Promise<{ code: number, out: string }>((resolve) => {
      child.on('exit', (code, signal) => {
        expect(signal).to.equal(null);
        resolve({
          code: code!,
          out
        });
      });
    });
  };

  const signApp = (appPath: string) => {
    return spawn('codesign', ['-s', identity, '--deep', '--force', appPath]);
  };

  const launchApp = (appPath: string, args: string[] = []) => {
    return spawn(path.resolve(appPath, 'Contents/MacOS/Electron'), args);
  };

  const spawnAppWithHandle = (appPath: string, args: string[] = []) => {
    return cp.spawn(path.resolve(appPath, 'Contents/MacOS/Electron'), args);
  };

  const getRunningShipIts = async (appPath: string) => {
    const processes = await psList();
    const activeShipIts = processes.filter(p => p.cmd?.includes('Squirrel.framework/Resources/ShipIt com.github.Electron.ShipIt') && p.cmd!.startsWith(appPath));
    return activeShipIts;
  };

  const withTempDirectory = async (fn: (dir: string) => Promise<void>, autoCleanUp = true) => {
    const dir = await fs.mkdtemp(path.resolve(os.tmpdir(), 'electron-update-spec-'));
    try {
      await fn(dir);
    } finally {
      if (autoCleanUp) {
        cp.spawnSync('rm', ['-r', dir]);
      }
    }
  };

  const logOnError = (what: any, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      console.error(what);
      throw err;
    }
  };

  const cachedZips: Record<string, string> = {};

  const getOrCreateUpdateZipPath = async (version: string, fixture: string, mutateAppPostSign?: {
    mutate: (appPath: string) => Promise<void>,
    mutationKey: string,
  }) => {
    const key = `${version}-${fixture}-${mutateAppPostSign?.mutationKey || 'no-mutation'}`;
    if (!cachedZips[key]) {
      let updateZipPath: string;
      await withTempDirectory(async (dir) => {
        const secondAppPath = await copyApp(dir, fixture);
        const appPJPath = path.resolve(secondAppPath, 'Contents', 'Resources', 'app', 'package.json');
        await fs.writeFile(
          appPJPath,
          (await fs.readFile(appPJPath, 'utf8')).replace('1.0.0', version)
        );
        await signApp(secondAppPath);
        await mutateAppPostSign?.mutate(secondAppPath);
        updateZipPath = path.resolve(dir, 'update.zip');
        await spawn('zip', ['-0', '-r', '--symlinks', updateZipPath, './'], {
          cwd: dir
        });
      }, false);
      cachedZips[key] = updateZipPath!;
    }
    return cachedZips[key];
  };

  after(() => {
    for (const version of Object.keys(cachedZips)) {
      cp.spawnSync('rm', ['-r', path.dirname(cachedZips[version])]);
    }
  });

  // On arm64 builds the built app is self-signed by default so the setFeedURL call always works
  ifit(process.arch !== 'arm64')('should fail to set the feed URL when the app is not signed', async () => {
    await withTempDirectory(async (dir) => {
      const appPath = await copyApp(dir);
      const launchResult = await launchApp(appPath, ['http://myupdate']);
      console.log(launchResult);
      expect(launchResult.code).to.equal(1);
      expect(launchResult.out).to.include('Could not get code signature for running application');
    });
  });

  it('should cleanly set the feed URL when the app is signed', async () => {
    await withTempDirectory(async (dir) => {
      const appPath = await copyApp(dir);
      await signApp(appPath);
      const launchResult = await launchApp(appPath, ['http://myupdate']);
      expect(launchResult.code).to.equal(0);
      expect(launchResult.out).to.include('Feed URL Set: http://myupdate');
    });
  });

  describe('with update server', () => {
    let port = 0;
    let server: express.Application = null as any;
    let httpServer: http.Server = null as any;
    let requests: express.Request[] = [];

    beforeEach((done) => {
      requests = [];
      server = express();
      server.use((req, res, next) => {
        requests.push(req);
        next();
      });
      httpServer = server.listen(0, '127.0.0.1', () => {
        port = (httpServer.address() as AddressInfo).port;
        done();
      });
    });

    afterEach(async () => {
      if (httpServer) {
        await new Promise<void>(resolve => {
          httpServer.close(() => {
            httpServer = null as any;
            server = null as any;
            resolve();
          });
        });
      }
    });

    it('should hit the update endpoint when checkForUpdates is called', async () => {
      await withTempDirectory(async (dir) => {
        const appPath = await copyApp(dir, 'check');
        await signApp(appPath);
        server.get('/update-check', (req, res) => {
          res.status(204).send();
        });
        const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
        logOnError(launchResult, () => {
          expect(launchResult.code).to.equal(0);
          expect(requests).to.have.lengthOf(1);
          expect(requests[0]).to.have.property('url', '/update-check');
          expect(requests[0].header('user-agent')).to.include('Electron/');
        });
      });
    });

    it('should hit the update endpoint with customer headers when checkForUpdates is called', async () => {
      await withTempDirectory(async (dir) => {
        const appPath = await copyApp(dir, 'check-with-headers');
        await signApp(appPath);
        server.get('/update-check', (req, res) => {
          res.status(204).send();
        });
        const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
        logOnError(launchResult, () => {
          expect(launchResult.code).to.equal(0);
          expect(requests).to.have.lengthOf(1);
          expect(requests[0]).to.have.property('url', '/update-check');
          expect(requests[0].header('x-test')).to.equal('this-is-a-test');
        });
      });
    });

    it('should hit the download endpoint when an update is available and error if the file is bad', async () => {
      await withTempDirectory(async (dir) => {
        const appPath = await copyApp(dir, 'update');
        await signApp(appPath);
        server.get('/update-file', (req, res) => {
          res.status(500).send('This is not a file');
        });
        server.get('/update-check', (req, res) => {
          res.json({
            url: `http://localhost:${port}/update-file`,
            name: 'My Release Name',
            notes: 'Theses are some release notes innit',
            pub_date: (new Date()).toString()
          });
        });
        const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
        logOnError(launchResult, () => {
          expect(launchResult).to.have.property('code', 1);
          expect(launchResult.out).to.include('Update download failed. The server sent an invalid response.');
          expect(requests).to.have.lengthOf(2);
          expect(requests[0]).to.have.property('url', '/update-check');
          expect(requests[1]).to.have.property('url', '/update-file');
          expect(requests[0].header('user-agent')).to.include('Electron/');
          expect(requests[1].header('user-agent')).to.include('Electron/');
        });
      });
    });

    const withUpdatableApp = async (opts: {
      nextVersion: string;
      startFixture: string;
      endFixture: string;
      mutateAppPostSign?: {
        mutate: (appPath: string) => Promise<void>,
        mutationKey: string,
      }
    }, fn: (appPath: string, zipPath: string) => Promise<void>) => {
      await withTempDirectory(async (dir) => {
        const appPath = await copyApp(dir, opts.startFixture);
        await signApp(appPath);

        const updateZipPath = await getOrCreateUpdateZipPath(opts.nextVersion, opts.endFixture, opts.mutateAppPostSign);

        await fn(appPath, updateZipPath);
      });
    };

    it('should hit the download endpoint when an update is available and update successfully when the zip is provided', async () => {
      await withUpdatableApp({
        nextVersion: '2.0.0',
        startFixture: 'update',
        endFixture: 'update'
      }, async (appPath, updateZipPath) => {
        server.get('/update-file', (req, res) => {
          res.download(updateZipPath);
        });
        server.get('/update-check', (req, res) => {
          res.json({
            url: `http://localhost:${port}/update-file`,
            name: 'My Release Name',
            notes: 'Theses are some release notes innit',
            pub_date: (new Date()).toString()
          });
        });
        const relaunchPromise = new Promise<void>((resolve) => {
          server.get('/update-check/updated/:version', (req, res) => {
            res.status(204).send();
            resolve();
          });
        });
        const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
        logOnError(launchResult, () => {
          expect(launchResult).to.have.property('code', 0);
          expect(launchResult.out).to.include('Update Downloaded');
          expect(requests).to.have.lengthOf(2);
          expect(requests[0]).to.have.property('url', '/update-check');
          expect(requests[1]).to.have.property('url', '/update-file');
          expect(requests[0].header('user-agent')).to.include('Electron/');
          expect(requests[1].header('user-agent')).to.include('Electron/');
        });

        await relaunchPromise;
        expect(requests).to.have.lengthOf(3);
        expect(requests[2].url).to.equal('/update-check/updated/2.0.0');
        expect(requests[2].header('user-agent')).to.include('Electron/');
      });
    });

    it('should abort the update if the application is still running when ShipIt kicks off', async () => {
      await withUpdatableApp({
        nextVersion: '2.0.0',
        startFixture: 'update',
        endFixture: 'update'
      }, async (appPath, updateZipPath) => {
        server.get('/update-file', (req, res) => {
          res.download(updateZipPath);
        });
        server.get('/update-check', (req, res) => {
          res.json({
            url: `http://localhost:${port}/update-file`,
            name: 'My Release Name',
            notes: 'Theses are some release notes innit',
            pub_date: (new Date()).toString()
          });
        });

        enum FlipFlop {
          INITIAL,
          FLIPPED,
          FLOPPED,
        }

        const shipItFlipFlopPromise = new Promise<void>((resolve) => {
          let state = FlipFlop.INITIAL;
          const checker = setInterval(async () => {
            const running = await getRunningShipIts(appPath);
            switch (state) {
              case FlipFlop.INITIAL: {
                if (running.length) state = FlipFlop.FLIPPED;
                break;
              }
              case FlipFlop.FLIPPED: {
                if (!running.length) state = FlipFlop.FLOPPED;
                break;
              }
            }
            if (state === FlipFlop.FLOPPED) {
              clearInterval(checker);
              resolve();
            }
          }, 500);
        });

        const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
        const retainerHandle = spawnAppWithHandle(appPath, ['remain-open']);
        logOnError(launchResult, () => {
          expect(launchResult).to.have.property('code', 0);
          expect(launchResult.out).to.include('Update Downloaded');
          expect(requests).to.have.lengthOf(2);
          expect(requests[0]).to.have.property('url', '/update-check');
          expect(requests[1]).to.have.property('url', '/update-file');
          expect(requests[0].header('user-agent')).to.include('Electron/');
          expect(requests[1].header('user-agent')).to.include('Electron/');
        });

        await shipItFlipFlopPromise;
        expect(requests).to.have.lengthOf(2, 'should not have relaunched the updated app');
        expect(JSON.parse(await fs.readFile(path.resolve(appPath, 'Contents/Resources/app/package.json'), 'utf8')).version).to.equal('1.0.0', 'should still be the old version on disk');

        retainerHandle.kill('SIGINT');
      });
    });

    describe('with SquirrelMacEnableDirectContentsWrite enabled', () => {
      let previousValue: any;

      beforeEach(() => {
        previousValue = systemPreferences.getUserDefault('SquirrelMacEnableDirectContentsWrite', 'boolean');
        systemPreferences.setUserDefault('SquirrelMacEnableDirectContentsWrite', 'boolean', true as any);
      });

      afterEach(() => {
        systemPreferences.setUserDefault('SquirrelMacEnableDirectContentsWrite', 'boolean', previousValue as any);
      });

      it('should hit the download endpoint when an update is available and update successfully when the zip is provided leaving the parent directory untouched', async () => {
        await withUpdatableApp({
          nextVersion: '2.0.0',
          startFixture: 'update',
          endFixture: 'update'
        }, async (appPath, updateZipPath) => {
          const randomID = uuid.v4();
          cp.spawnSync('xattr', ['-w', 'spec-id', randomID, appPath]);
          server.get('/update-file', (req, res) => {
            res.download(updateZipPath);
          });
          server.get('/update-check', (req, res) => {
            res.json({
              url: `http://localhost:${port}/update-file`,
              name: 'My Release Name',
              notes: 'Theses are some release notes innit',
              pub_date: (new Date()).toString()
            });
          });
          const relaunchPromise = new Promise<void>((resolve) => {
            server.get('/update-check/updated/:version', (req, res) => {
              res.status(204).send();
              resolve();
            });
          });
          const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
          logOnError(launchResult, () => {
            expect(launchResult).to.have.property('code', 0);
            expect(launchResult.out).to.include('Update Downloaded');
            expect(requests).to.have.lengthOf(2);
            expect(requests[0]).to.have.property('url', '/update-check');
            expect(requests[1]).to.have.property('url', '/update-file');
            expect(requests[0].header('user-agent')).to.include('Electron/');
            expect(requests[1].header('user-agent')).to.include('Electron/');
          });

          await relaunchPromise;
          expect(requests).to.have.lengthOf(3);
          expect(requests[2].url).to.equal('/update-check/updated/2.0.0');
          expect(requests[2].header('user-agent')).to.include('Electron/');
          const result = cp.spawnSync('xattr', ['-l', appPath]);
          expect(result.stdout.toString()).to.include(`spec-id: ${randomID}`);
        });
      });
    });

    it('should hit the download endpoint when an update is available and fail when the zip signature is invalid', async () => {
      await withUpdatableApp({
        nextVersion: '2.0.0',
        startFixture: 'update',
        endFixture: 'update',
        mutateAppPostSign: {
          mutationKey: 'add-resource',
          mutate: async (appPath) => {
            const resourcesPath = path.resolve(appPath, 'Contents', 'Resources', 'app', 'injected.txt');
            await fs.writeFile(resourcesPath, 'demo');
          }
        }
      }, async (appPath, updateZipPath) => {
        server.get('/update-file', (req, res) => {
          res.download(updateZipPath);
        });
        server.get('/update-check', (req, res) => {
          res.json({
            url: `http://localhost:${port}/update-file`,
            name: 'My Release Name',
            notes: 'Theses are some release notes innit',
            pub_date: (new Date()).toString()
          });
        });
        const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
        logOnError(launchResult, () => {
          expect(launchResult).to.have.property('code', 1);
          expect(launchResult.out).to.include('Code signature at URL');
          expect(launchResult.out).to.include('a sealed resource is missing or invalid');
          expect(requests).to.have.lengthOf(2);
          expect(requests[0]).to.have.property('url', '/update-check');
          expect(requests[1]).to.have.property('url', '/update-file');
          expect(requests[0].header('user-agent')).to.include('Electron/');
          expect(requests[1].header('user-agent')).to.include('Electron/');
        });
      });
    });

    it('should hit the download endpoint when an update is available and fail when the ShipIt binary is a symlink', async () => {
      await withUpdatableApp({
        nextVersion: '2.0.0',
        startFixture: 'update',
        endFixture: 'update',
        mutateAppPostSign: {
          mutationKey: 'modify-shipit',
          mutate: async (appPath) => {
            const shipItPath = path.resolve(appPath, 'Contents', 'Frameworks', 'Squirrel.framework', 'Resources', 'ShipIt');
            await fs.remove(shipItPath);
            await fs.symlink('/tmp/ShipIt', shipItPath, 'file');
          }
        }
      }, async (appPath, updateZipPath) => {
        server.get('/update-file', (req, res) => {
          res.download(updateZipPath);
        });
        server.get('/update-check', (req, res) => {
          res.json({
            url: `http://localhost:${port}/update-file`,
            name: 'My Release Name',
            notes: 'Theses are some release notes innit',
            pub_date: (new Date()).toString()
          });
        });
        const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
        logOnError(launchResult, () => {
          expect(launchResult).to.have.property('code', 1);
          expect(launchResult.out).to.include('Code signature at URL');
          expect(launchResult.out).to.include('a sealed resource is missing or invalid');
          expect(requests).to.have.lengthOf(2);
          expect(requests[0]).to.have.property('url', '/update-check');
          expect(requests[1]).to.have.property('url', '/update-file');
          expect(requests[0].header('user-agent')).to.include('Electron/');
          expect(requests[1].header('user-agent')).to.include('Electron/');
        });
      });
    });

    it('should hit the download endpoint when an update is available and fail when the Electron Framework is modified', async () => {
      await withUpdatableApp({
        nextVersion: '2.0.0',
        startFixture: 'update',
        endFixture: 'update',
        mutateAppPostSign: {
          mutationKey: 'modify-eframework',
          mutate: async (appPath) => {
            const shipItPath = path.resolve(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
            await fs.appendFile(shipItPath, Buffer.from('123'));
          }
        }
      }, async (appPath, updateZipPath) => {
        server.get('/update-file', (req, res) => {
          res.download(updateZipPath);
        });
        server.get('/update-check', (req, res) => {
          res.json({
            url: `http://localhost:${port}/update-file`,
            name: 'My Release Name',
            notes: 'Theses are some release notes innit',
            pub_date: (new Date()).toString()
          });
        });
        const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
        logOnError(launchResult, () => {
          expect(launchResult).to.have.property('code', 1);
          expect(launchResult.out).to.include('Code signature at URL');
          expect(launchResult.out).to.include(' main executable failed strict validation');
          expect(requests).to.have.lengthOf(2);
          expect(requests[0]).to.have.property('url', '/update-check');
          expect(requests[1]).to.have.property('url', '/update-file');
          expect(requests[0].header('user-agent')).to.include('Electron/');
          expect(requests[1].header('user-agent')).to.include('Electron/');
        });
      });
    });

    it('should hit the download endpoint when an update is available and update successfully when the zip is provided with JSON update mode', async () => {
      await withUpdatableApp({
        nextVersion: '2.0.0',
        startFixture: 'update-json',
        endFixture: 'update-json'
      }, async (appPath, updateZipPath) => {
        server.get('/update-file', (req, res) => {
          res.download(updateZipPath);
        });
        server.get('/update-check', (req, res) => {
          res.json({
            currentRelease: '2.0.0',
            releases: [
              {
                version: '2.0.0',
                updateTo: {
                  version: '2.0.0',
                  url: `http://localhost:${port}/update-file`,
                  name: 'My Release Name',
                  notes: 'Theses are some release notes innit',
                  pub_date: (new Date()).toString()
                }
              }
            ]
          });
        });
        const relaunchPromise = new Promise<void>((resolve) => {
          server.get('/update-check/updated/:version', (req, res) => {
            res.status(204).send();
            resolve();
          });
        });
        const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
        logOnError(launchResult, () => {
          expect(launchResult).to.have.property('code', 0);
          expect(launchResult.out).to.include('Update Downloaded');
          expect(requests).to.have.lengthOf(2);
          expect(requests[0]).to.have.property('url', '/update-check');
          expect(requests[1]).to.have.property('url', '/update-file');
          expect(requests[0].header('user-agent')).to.include('Electron/');
          expect(requests[1].header('user-agent')).to.include('Electron/');
        });

        await relaunchPromise;
        expect(requests).to.have.lengthOf(3);
        expect(requests[2]).to.have.property('url', '/update-check/updated/2.0.0');
        expect(requests[2].header('user-agent')).to.include('Electron/');
      });
    });

    it('should hit the download endpoint when an update is available and not update in JSON update mode when the currentRelease is older than the current version', async () => {
      await withUpdatableApp({
        nextVersion: '0.1.0',
        startFixture: 'update-json',
        endFixture: 'update-json'
      }, async (appPath, updateZipPath) => {
        server.get('/update-file', (req, res) => {
          res.download(updateZipPath);
        });
        server.get('/update-check', (req, res) => {
          res.json({
            currentRelease: '0.1.0',
            releases: [
              {
                version: '0.1.0',
                updateTo: {
                  version: '0.1.0',
                  url: `http://localhost:${port}/update-file`,
                  name: 'My Release Name',
                  notes: 'Theses are some release notes innit',
                  pub_date: (new Date()).toString()
                }
              }
            ]
          });
        });
        const launchResult = await launchApp(appPath, [`http://localhost:${port}/update-check`]);
        logOnError(launchResult, () => {
          expect(launchResult).to.have.property('code', 1);
          expect(launchResult.out).to.include('No update available');
          expect(requests).to.have.lengthOf(1);
          expect(requests[0]).to.have.property('url', '/update-check');
          expect(requests[0].header('user-agent')).to.include('Electron/');
        });
      });
    });
  });
});
