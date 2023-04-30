const asar = require('asar');
const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const getArgGroup = (name) => {
  const group = [];
  let inGroup = false;
  for (const arg of process.argv) {
    // At the next flag we stop being in the current group
    if (arg.startsWith('--')) inGroup = false;
    // Push all args in the group
    if (inGroup) group.push(arg);
    // If we find the start flag, start pushing
    if (arg === `--${name}`) inGroup = true;
  }

  return group;
};

const base = getArgGroup('base');
const files = getArgGroup('files');
const out = getArgGroup('out');

assert(base.length === 1, 'should have a single base dir');
assert(files.length >= 1, 'should have at least one input file');
assert(out.length === 1, 'should have a single out path');

// Ensure all files are inside the base dir
for (const file of files) {
  if (!file.startsWith(base[0])) {
    console.error(`Expected all files to be inside the base dir but "${file}" was not in "${base[0]}"`);
    process.exit(1);
  }
}

const tmpPath = fs.mkdtempSync(path.resolve(os.tmpdir(), 'electron-gn-asar-'));

try {
  // Copy all files to a tmp dir to avoid including scrap files in the ASAR
  for (const file of files) {
    const newLocation = path.resolve(tmpPath, path.relative(base[0], file));
    fs.mkdirsSync(path.dirname(newLocation));
    fs.writeFileSync(newLocation, fs.readFileSync(file));
  }
} catch (err) {
  console.error('Unexpected error while generating ASAR', err);
  fs.remove(tmpPath)
    .then(() => process.exit(1))
    .catch(() => process.exit(1));
  return;
}

// Create the ASAR archive
asar.createPackageWithOptions(tmpPath, out[0], {})
  .catch(err => {
    const exit = () => {
      console.error('Unexpected error while generating ASAR', err);
      process.exit(1);
    };
    fs.remove(tmpPath).then(exit).catch(exit);
  }).then(() => fs.remove(tmpPath));
