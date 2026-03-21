import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths, validatePath } from '../core/path-resolver.js';

export async function runSetupCommand(): Promise<string> {
  const { default: inquirer } = await import('inquirer');

  const mgr = new ConfigManager();
  const config = mgr.load();
  const lines: string[] = [];

  // 1. Scan default paths
  const autoDetected = discoverLogPaths();
  lines.push('Scanning for Claude Code log directories...\n');

  if (autoDetected.length === 0) {
    lines.push('  No default log paths found.\n');
  } else {
    for (const p of autoDetected) {
      const v = validatePath(p);
      lines.push(`  \u2713 ${p} (${v.fileCount.toLocaleString()} .jsonl files)`);
    }
    lines.push('');
  }
  console.log(lines.join('\n'));

  // 2. Ask if user wants to add more paths
  const addedPaths: string[] = [];
  let addMore = true;
  while (addMore) {
    const { wantMore } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'wantMore',
        message: 'Add a custom log path?',
        default: false,
      },
    ]);

    if (!wantMore) {
      addMore = false;
      break;
    }

    const { customPath } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customPath',
        message: 'Enter path to log directory:',
      },
    ]);

    // 3. Validate each added path
    const validation = validatePath(customPath);
    if (validation.valid) {
      console.log(`  \u2713 Valid: ${validation.fileCount.toLocaleString()} .jsonl files found`);
      addedPaths.push(customPath);
    } else {
      console.log(`  \u2717 Invalid: ${validation.error}`);
      const { addAnyway } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'addAnyway',
          message: 'Add this path anyway?',
          default: false,
        },
      ]);
      if (addAnyway) {
        addedPaths.push(customPath);
      }
    }
  }

  // 4. Save to config
  const finalPaths = [...new Set([...autoDetected, ...addedPaths])];
  if (finalPaths.length > 0) {
    mgr.set('logPaths', finalPaths);
    return `\nSaved ${finalPaths.length} log path(s) to config.`;
  }

  return '\nNo paths to save.';
}
