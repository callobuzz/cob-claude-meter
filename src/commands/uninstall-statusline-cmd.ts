import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

function getClaudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

function getClaudeMeterDir(): string {
  return join(homedir(), '.claude-meter');
}

export async function runUninstallStatuslineCommand(): Promise<string> {
  const settingsPath = getClaudeSettingsPath();
  const meterDir = getClaudeMeterDir();
  const backupPath = join(meterDir, 'settings-backup.json');
  const lines: string[] = [];

  if (existsSync(backupPath)) {
    // Restore from backup
    const backup = readFileSync(backupPath, 'utf-8');
    writeFileSync(settingsPath, backup, 'utf-8');
    unlinkSync(backupPath);
    lines.push('Restored settings from backup.');
  } else if (existsSync(settingsPath)) {
    // Remove statusLine key
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if ('statusLine' in settings) {
        delete settings['statusLine'];
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        lines.push('Removed statusLine from settings.');
      } else {
        lines.push('No statusLine found in settings. Nothing to remove.');
      }
    } catch {
      lines.push('Could not parse settings.json. No changes made.');
      return lines.join('\n');
    }
  } else {
    lines.push('No Claude settings file found. Nothing to uninstall.');
    return lines.join('\n');
  }

  // Clean up wrapper scripts
  const wrapperPaths = [
    join(meterDir, 'statusline-wrapper.sh'),
    join(meterDir, 'statusline-wrapper.js'),
    join(meterDir, 'statusline-wrapper.cmd'),
  ];

  for (const wp of wrapperPaths) {
    if (existsSync(wp)) {
      unlinkSync(wp);
      lines.push(`Removed wrapper: ${wp}`);
    }
  }

  lines.push('');
  lines.push('Done! Restart Claude Code to apply changes.');
  return lines.join('\n');
}
