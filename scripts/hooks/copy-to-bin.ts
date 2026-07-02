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

  const { mkdir, chmod, rm } = await import('fs/promises');
  await mkdir(destDir, { recursive: true });

  const destPath = `${destDir}/${execName}`;

  // On macOS (Apple Silicon), overwriting the binary in place reuses the inode
  // and leaves a stale code-signature cache, so the kernel SIGKILLs the new
  // binary on launch ("zsh: kill"). Removing the old file first forces a fresh
  // inode and avoids the stale cache.
  if (platform === 'darwin') {
    await rm(destPath, { force: true });
  }

  await Bun.write(destPath, Bun.file(outFile));

  if (platform === 'linux' || platform === 'darwin') {
    await chmod(destPath, 0o755);
  }

  console.log(`Copied executable to ${destDir}`);
}
