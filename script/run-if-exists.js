const cp = require('child_process');
const fs = require('fs');

const checkPath = process.argv[2];
const command = process.argv.slice(3);

if (fs.existsSync(checkPath)) {
  const child = cp.spawn(
    `${command[0]}${process.platform === 'win32' ? '.cmd' : ''}`,
    command.slice(1),
    {
      stdio: 'inherit',
      cwd: checkPath
    }
  );
  child.on('exit', code => process.exit(code));
}
