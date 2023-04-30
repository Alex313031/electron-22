import * as childProcess from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as v8 from 'v8';
import { SuiteFunction, TestFunction } from 'mocha';
import { BrowserWindow } from 'electron/main';
import { AssertionError } from 'chai';

const addOnly = <T>(fn: Function): T => {
  const wrapped = (...args: any[]) => {
    return fn(...args);
  };
  (wrapped as any).only = wrapped;
  (wrapped as any).skip = wrapped;
  return wrapped as any;
};

export const ifit = (condition: boolean) => (condition ? it : addOnly<TestFunction>(it.skip));
export const ifdescribe = (condition: boolean) => (condition ? describe : addOnly<SuiteFunction>(describe.skip));

export const delay = (time: number = 0) => new Promise(resolve => setTimeout(resolve, time));

type CleanupFunction = (() => void) | (() => Promise<void>)
const cleanupFunctions: CleanupFunction[] = [];
export async function runCleanupFunctions () {
  for (const cleanup of cleanupFunctions) {
    const r = cleanup();
    if (r instanceof Promise) { await r; }
  }
  cleanupFunctions.length = 0;
}

export function defer (f: CleanupFunction) {
  cleanupFunctions.unshift(f);
}

class RemoteControlApp {
  process: childProcess.ChildProcess;
  port: number;

  constructor (proc: childProcess.ChildProcess, port: number) {
    this.process = proc;
    this.port = port;
  }

  remoteEval = (js: string): Promise<any> => {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: this.port,
        method: 'POST'
      }, res => {
        const chunks = [] as Buffer[];
        res.on('data', chunk => { chunks.push(chunk); });
        res.on('end', () => {
          const ret = v8.deserialize(Buffer.concat(chunks));
          if (Object.prototype.hasOwnProperty.call(ret, 'error')) {
            reject(new Error(`remote error: ${ret.error}\n\nTriggered at:`));
          } else {
            resolve(ret.result);
          }
        });
      });
      req.write(js);
      req.end();
    });
  }

  remotely = (script: Function, ...args: any[]): Promise<any> => {
    return this.remoteEval(`(${script})(...${JSON.stringify(args)})`);
  }
}

export async function startRemoteControlApp (extraArgs: string[] = [], options?: childProcess.SpawnOptionsWithoutStdio) {
  const appPath = path.join(__dirname, 'fixtures', 'apps', 'remote-control');
  const appProcess = childProcess.spawn(process.execPath, [appPath, ...extraArgs], options);
  appProcess.stderr.on('data', d => {
    process.stderr.write(d);
  });
  const port = await new Promise<number>(resolve => {
    appProcess.stdout.on('data', d => {
      const m = /Listening: (\d+)/.exec(d.toString());
      if (m && m[1] != null) {
        resolve(Number(m[1]));
      }
    });
  });
  defer(() => { appProcess.kill('SIGINT'); });
  return new RemoteControlApp(appProcess, port);
}

export function waitUntil (
  callback: () => boolean,
  opts: { rate?: number, timeout?: number } = {}
) {
  const { rate = 10, timeout = 10000 } = opts;
  return new Promise<void>((resolve, reject) => {
    let intervalId: NodeJS.Timeout | undefined; // eslint-disable-line prefer-const
    let timeoutId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
    };

    const check = () => {
      let result;

      try {
        result = callback();
      } catch (e) {
        cleanup();
        reject(e);
        return;
      }

      if (result === true) {
        cleanup();
        resolve();
        return true;
      }
    };

    if (check()) {
      return;
    }

    intervalId = setInterval(check, rate);

    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      cleanup();
      reject(new Error(`waitUntil timed out after ${timeout}ms`));
    }, timeout);
  });
}

export async function repeatedly<T> (
  fn: () => Promise<T>,
  opts?: { until?: (x: T) => boolean, timeLimit?: number }
) {
  const { until = (x: T) => !!x, timeLimit = 10000 } = opts ?? {};
  const begin = +new Date();
  while (true) {
    const ret = await fn();
    if (until(ret)) { return ret; }
    if (+new Date() - begin > timeLimit) { throw new Error(`repeatedly timed out (limit=${timeLimit})`); }
  }
}

async function makeRemoteContext (opts?: any) {
  const { webPreferences, setup, url = 'about:blank', ...rest } = opts ?? {};
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, ...webPreferences }, ...rest });
  await w.loadURL(url.toString());
  if (setup) await w.webContents.executeJavaScript(setup);
  return w;
}

const remoteContext: BrowserWindow[] = [];
export async function getRemoteContext () {
  if (remoteContext.length) { return remoteContext[0]; }
  const w = await makeRemoteContext();
  defer(() => w.close());
  return w;
}

export function useRemoteContext (opts?: any) {
  before(async () => {
    remoteContext.unshift(await makeRemoteContext(opts));
  });
  after(() => {
    const w = remoteContext.shift();
    w!.close();
  });
}

export async function itremote (name: string, fn: Function, args?: any[]) {
  it(name, async () => {
    const w = await getRemoteContext();
    const { ok, message } = await w.webContents.executeJavaScript(`(async () => {
      try {
        const chai_1 = require('chai')
        chai_1.use(require('chai-as-promised'))
        chai_1.use(require('dirty-chai'))
        await (${fn})(...${JSON.stringify(args ?? [])})
        return {ok: true};
      } catch (e) {
        return {ok: false, message: e.message}
      }
    })()`);
    if (!ok) { throw new AssertionError(message); }
  });
}
