#!/usr/bin/env bun
/**
 * Build script for stagehand
 * Creates a standalone executable using Bun's --compile flag
 */

import { mkdir, readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

const pkg = JSON.parse(await readFile('./package.json', 'utf8'));
const entrypoint = pkg.module;

const isWindows = process.platform === 'win32';
const execName = isWindows ? 'aegis.exe' : 'aegis';
const outDir = './dist';
const outFile = `${outDir}/${execName}`;

// Parse --hookPath from args, default to ./hooks
const hookPathArg = process.argv.find(arg => arg.startsWith('--hookPath='));
const hookDir = hookPathArg?.split('=')[1] ?? resolve(import.meta.dir, 'hooks');

/**
 * Run all hooks found in the hooks directory
 * @param {Object} context - Context object passed to each hook
 * @param {string} context.outFile - Path to the built executable
 * @param {string} context.execName - Name of the executable
 * @param {string} context.platform - Current platform (win32, darwin, linux)
 * @param {Error|null} context.error - Error object if build failed, null otherwise
 */
async function runHooks(context) {
  // Check if hooks directory exists
  if (!existsSync(hookDir)) {
    return;
  }

  try {
    const files = await readdir(hookDir);
    const hookFiles = files.filter(f => f.endsWith('.ts') || f.endsWith('.js'));

    for (const file of hookFiles) {
      const hookPath = resolve(hookDir, file);
      console.log(`Running hook: ${hookPath}`);

      try {
        const hook = await import(hookPath);
        if (typeof hook.default === 'function') {
          await hook.default(context);
        } else {
          console.warn(`Hook ${file} does not export a default function`);
        }
      } catch (err) {
        console.error(`Error running hook ${file}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`Error reading hooks directory:`, err.message);
  }
}

async function build() {
  console.log('Building stagehand...');
  console.log(`Platform: ${process.platform}`);
  console.log(`Output: ${outFile}`);

  // Ensure output directory exists
  if (!existsSync(outDir)) {
    await mkdir(outDir, { recursive: true });
    console.log(`Created output directory: ${outDir}`);
  }

  // Build standalone executable using Bun's compile feature
  const proc = Bun.spawn([
    'bun',
    'build',
    entrypoint,
    '--compile',
    '--outfile',
    outFile,
    '--minify',
    '--target',
    'bun',
  ], {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;

  const context = {
    outFile,
    execName,
    platform: process.platform,
    error: null,
  };

  if (exitCode === 0) {
    console.log(`\nBuild successful!`);
    console.log(`Executable created: ${outFile}`);
    console.log(`\nRun with: ${execName} --help`);
  } else {
    context.error = new Error(`Build failed with exit code: ${exitCode}`);
    console.error(`\n${context.error.message}`);
  }

  // Run hooks (always, so hooks can handle errors too)
  await runHooks(context);

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

build().catch((error) => {
  console.error('Build error:', error);
  process.exit(1);
});
