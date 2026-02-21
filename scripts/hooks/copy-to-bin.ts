export default async function({ outFile, execName, platform, error }) {
  if (error) return;

  let destDir: string;
  if (platform === 'win32') {
    destDir = 'C:/bin';
  } else if (platform === 'linux') {
    destDir = '/usr/local/bin';
  } else {
    return;
  }

  const destPath = `${destDir}/${execName}`;
  await Bun.write(destPath, Bun.file(outFile));

  if (platform === 'linux') {
    const { chmod } = await import('fs/promises');
    await chmod(destPath, 0o755);
  }

  console.log(`Copied executable to ${destDir}`);
}
