import { expect } from 'chai';
import { app, contentTracing, TraceConfig, TraceCategoriesAndOptions } from 'electron/main';
import * as fs from 'fs';
import * as path from 'path';
import { ifdescribe, delay } from './spec-helpers';

// FIXME: The tests are skipped on arm/arm64 and ia32.
ifdescribe(!(['arm', 'arm64', 'ia32'].includes(process.arch)))('contentTracing', () => {
  const record = async (options: TraceConfig | TraceCategoriesAndOptions, outputFilePath: string | undefined, recordTimeInMilliseconds = 1e1) => {
    await app.whenReady();

    await contentTracing.startRecording(options);
    await delay(recordTimeInMilliseconds);
    const resultFilePath = await contentTracing.stopRecording(outputFilePath);

    return resultFilePath;
  };

  const outputFilePath = path.join(app.getPath('temp'), 'trace.json');
  beforeEach(() => {
    if (fs.existsSync(outputFilePath)) {
      fs.unlinkSync(outputFilePath);
    }
  });

  describe('startRecording', function () {
    this.timeout(5e3);

    const getFileSizeInKiloBytes = (filePath: string) => {
      const stats = fs.statSync(filePath);
      const fileSizeInBytes = stats.size;
      const fileSizeInKiloBytes = fileSizeInBytes / 1024;
      return fileSizeInKiloBytes;
    };

    it('accepts an empty config', async () => {
      const config = {};
      await record(config, outputFilePath);

      expect(fs.existsSync(outputFilePath)).to.be.true('output exists');

      const fileSizeInKiloBytes = getFileSizeInKiloBytes(outputFilePath);
      expect(fileSizeInKiloBytes).to.be.above(0,
        `the trace output file is empty, check "${outputFilePath}"`);
    });

    it('accepts a trace config', async () => {
      // (alexeykuzmin): All categories are excluded on purpose,
      // so only metadata gets into the output file.
      const config = {
        excluded_categories: ['*']
      };
      await record(config, outputFilePath);

      // If the `excluded_categories` param above is not respected, categories
      // like `node,node.environment` will be included in the output.
      const content = fs.readFileSync(outputFilePath).toString();
      expect(content.includes('"cat":"node,node.environment"')).to.be.false();
    });

    it('accepts "categoryFilter" and "traceOptions" as a config', async () => {
      // (alexeykuzmin): All categories are excluded on purpose,
      // so only metadata gets into the output file.
      const config = {
        categoryFilter: '__ThisIsANonexistentCategory__',
        traceOptions: ''
      };
      await record(config, outputFilePath);

      expect(fs.existsSync(outputFilePath)).to.be.true('output exists');

      // If the `categoryFilter` param above is not respected
      // the file size will be above 50KB.
      const fileSizeInKiloBytes = getFileSizeInKiloBytes(outputFilePath);
      const expectedMaximumFileSize = 10; // Depends on a platform.

      expect(fileSizeInKiloBytes).to.be.above(0,
        `the trace output file is empty, check "${outputFilePath}"`);
      expect(fileSizeInKiloBytes).to.be.below(expectedMaximumFileSize,
        `the trace output file is suspiciously large (${fileSizeInKiloBytes}KB),
        check "${outputFilePath}"`);
    });
  });

  describe('stopRecording', function () {
    this.timeout(5e3);

    it('does not crash on empty string', async () => {
      const options = {
        categoryFilter: '*',
        traceOptions: 'record-until-full,enable-sampling'
      };

      await contentTracing.startRecording(options);
      const path = await contentTracing.stopRecording('');
      expect(path).to.be.a('string').that.is.not.empty('result path');
      expect(fs.statSync(path).isFile()).to.be.true('output exists');
    });

    it('calls its callback with a result file path', async () => {
      const resultFilePath = await record(/* options */ {}, outputFilePath);
      expect(resultFilePath).to.be.a('string').and.be.equal(outputFilePath);
    });

    it('creates a temporary file when an empty string is passed', async function () {
      const resultFilePath = await record(/* options */ {}, /* outputFilePath */ '');
      expect(resultFilePath).to.be.a('string').that.is.not.empty('result path');
    });

    it('creates a temporary file when no path is passed', async function () {
      const resultFilePath = await record(/* options */ {}, /* outputFilePath */ undefined);
      expect(resultFilePath).to.be.a('string').that.is.not.empty('result path');
    });

    it('rejects if no trace is happening', async () => {
      await expect(contentTracing.stopRecording()).to.be.rejected();
    });
  });

  describe('captured events', () => {
    it('include V8 samples from the main process', async function () {
      // This test is flaky on macOS CI.
      this.retries(3);

      await contentTracing.startRecording({
        categoryFilter: 'disabled-by-default-v8.cpu_profiler',
        traceOptions: 'record-until-full'
      });
      {
        const start = +new Date();
        let n = 0;
        const f = () => {};
        while (+new Date() - start < 200 || n < 500) {
          await delay(0);
          f();
          n++;
        }
      }
      const path = await contentTracing.stopRecording();
      const data = fs.readFileSync(path, 'utf8');
      const parsed = JSON.parse(data);
      expect(parsed.traceEvents.some((x: any) => x.cat === 'disabled-by-default-v8.cpu_profiler' && x.name === 'ProfileChunk')).to.be.true();
    });
  });
});
