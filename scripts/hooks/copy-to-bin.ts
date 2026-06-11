export default async function({ outFile, execName, platform, error }) {
  if (error) return;

  const { homedir } = await import('os');

  let destDir: string;
  if (platform === 'win32') {
    destDir = 'C:/bin';
  } else if (platform === 'linux') {
    destDir = '/usr/local/bin';
  } else if (platform === 'darwin') {
    destDir = `${homedir()}/.local/bin`;
  } else {
    return;
  }

  const { mkdir, chmod } = await import('fs/promises');
  await mkdir(destDir, { recursive: true });

  const destPath = `${destDir}/${execName}`;
  await Bun.write(destPath, Bun.file(outFile));

  if (platform === 'linux' || platform === 'darwin') {
    await chmod(destPath, 0o755);
  }

  console.log(`Copied executable to ${destDir}`);
}
