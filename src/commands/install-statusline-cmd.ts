import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

function getClaudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

function getClaudeMeterDir(): string {
  return join(homedir(), '.claude-meter');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function createUnixWrapper(originalCommand: string, wrapperPath: string): void {
  const script = `#!/bin/bash
INPUT=$(cat)
LINE1=$(echo "$INPUT" | ${originalCommand})
LINE2=$(echo "$INPUT" | claude-meter statusline --mode add --no-color)
echo "$LINE1"
echo "$LINE2"
`;
  writeFileSync(wrapperPath, script, { mode: 0o755 });
}

function createWindowsWrapper(originalCommand: string, wrapperPath: string): void {
  const script = `const { execSync } = require('child_process');
const input = require('fs').readFileSync(0, 'utf-8');
const line1 = execSync('${originalCommand.replace(/'/g, "\\'")}', { input, encoding: 'utf-8' }).trim();
const line2 = execSync('claude-meter statusline --mode add --no-color', { input, encoding: 'utf-8' }).trim();
console.log(line1);
console.log(line2);
`;
  writeFileSync(wrapperPath, script);
}

export async function runInstallStatuslineCommand(): Promise<string> {
  const settingsPath = getClaudeSettingsPath();
  const meterDir = getClaudeMeterDir();
  const backupPath = join(meterDir, 'settings-backup.json');
  const lines: string[] = [];

  // Read existing settings
  const settings = readJsonFile(settingsPath);
  const existingStatusLine = settings['statusLine'] as string | undefined;

  // Backup original settings
  ensureDir(meterDir);
  writeFileSync(backupPath, JSON.stringify(settings, null, 2), 'utf-8');
  lines.push(`Backed up settings to ${backupPath}`);

  if (!existingStatusLine) {
    // No existing statusLine - just set it
    settings['statusLine'] = 'claude-meter statusline';
    ensureDir(join(homedir(), '.claude'));
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    lines.push('Installed claude-meter as statusline command.');
    lines.push('');
    lines.push('Done! Restart Claude Code to see your statusline.');
    return lines.join('\n');
  }

  // Existing statusLine found - prompt user
  const { default: inquirer } = await import('inquirer');

  console.log('');
  console.log('Existing statusline found:');
  console.log(`  command: ${existingStatusLine}`);
  console.log('');

  const { choice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'choice',
      message: 'Choose an option:',
      choices: [
        { name: 'Replace — claude-meter becomes your full statusline', value: 'replace' },
        { name: 'Add — keeps yours, adds meter on next line', value: 'add' },
        { name: 'Skip — I\'ll set it up manually', value: 'skip' },
      ],
    },
  ]);

  if (choice === 'replace') {
    settings['statusLine'] = 'claude-meter statusline';
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    lines.push('Replaced statusline with claude-meter.');
    lines.push('');
    lines.push('Done! Restart Claude Code to see your statusline.');
  } else if (choice === 'add') {
    const isWindows = platform() === 'win32';

    if (isWindows) {
      const wrapperPath = join(meterDir, 'statusline-wrapper.js');
      createWindowsWrapper(existingStatusLine, wrapperPath);
      settings['statusLine'] = `node "${wrapperPath}"`;
      lines.push(`Created wrapper at ${wrapperPath}`);
    } else {
      const wrapperPath = join(meterDir, 'statusline-wrapper.sh');
      createUnixWrapper(existingStatusLine, wrapperPath);
      settings['statusLine'] = wrapperPath;
      lines.push(`Created wrapper at ${wrapperPath}`);
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    lines.push('Updated statusline to use wrapper (original + claude-meter).');
    lines.push('');
    lines.push('Done! Restart Claude Code to see your statusline.');
  } else {
    // skip
    lines.push('');
    lines.push('Skipped. To set up manually, add this to ~/.claude/settings.json:');
    lines.push('');
    lines.push('  "statusLine": "claude-meter statusline"');
    lines.push('');
    lines.push('Or to keep your existing statusline and add claude-meter:');
    lines.push(`  "statusLine": "${existingStatusLine} && claude-meter statusline --mode add --no-color"`);
  }

  return lines.join('\n');
}
