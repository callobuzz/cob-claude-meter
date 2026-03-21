#!/usr/bin/env node
import { Command } from 'commander';
import { runReport } from './commands/report.js';
import { runConfigCommand } from './commands/config-cmd.js';
import { runPathsCommand } from './commands/paths-cmd.js';
import { runDoctorCommand } from './commands/doctor-cmd.js';
import { runSetupCommand } from './commands/setup-cmd.js';
import { renderStatusline } from './commands/statusline-cmd.js';
import { runInstallStatuslineCommand } from './commands/install-statusline-cmd.js';
import { runUninstallStatuslineCommand } from './commands/uninstall-statusline-cmd.js';
import { runWatch } from './commands/watch-cmd.js';

const program = new Command();

program
  .name('claude-meter')
  .description('Claude Code token usage tracking and cost estimation')
  .version('0.1.0');

// Time commands
const timeCommands = [
  { name: 'today', desc: 'Show today\'s usage' },
  { name: 'yesterday', desc: 'Show yesterday\'s usage' },
  { name: 'this-week', desc: 'Show this week\'s usage' },
  { name: 'last-week', desc: 'Show last week\'s usage' },
  { name: 'this-month', desc: 'Show this month\'s usage' },
  { name: 'last-month', desc: 'Show last month\'s usage' },
  { name: 'this-year', desc: 'Show this year\'s usage' },
  { name: 'last30', desc: 'Show last 30 days usage' },
  { name: 'all', desc: 'Show all-time usage' },
];

for (const { name, desc } of timeCommands) {
  program
    .command(name)
    .description(desc)
    .option('--json', 'Output as JSON')
    .option('--fresh', 'Show only fresh tokens')
    .option('--compact', 'Compact output')
    .option('--no-color', 'Disable colors')
    .option('--verbose', 'Show scan details')
    .action(async (opts) => {
      const output = await runReport(name, opts);
      console.log(output);
    });
}

program
  .command('range <start> <end>')
  .description('Show usage for date range (YYYY-MM-DD)')
  .option('--json', 'Output as JSON')
  .option('--compact', 'Compact output')
  .option('--no-color', 'Disable colors')
  .option('--verbose', 'Show scan details')
  .action(async (start, end, opts) => {
    const output = await runReport('range', opts, start, end);
    console.log(output);
  });

// Management commands
program
  .command('config')
  .description('View or modify configuration')
  .option('--set <keyvalue>', 'Set a config value (key=value)')
  .option('--reset', 'Reset config to defaults')
  .action(async (opts) => {
    const output = await runConfigCommand(opts);
    console.log(output);
  });

program
  .command('paths')
  .description('Show detected log paths')
  .action(async () => {
    const output = await runPathsCommand();
    console.log(output);
  });

program
  .command('doctor')
  .description('Run diagnostics')
  .action(async () => {
    const output = await runDoctorCommand();
    console.log(output);
  });

program
  .command('setup')
  .description('Interactive log path setup')
  .action(async () => {
    const output = await runSetupCommand();
    console.log(output);
  });

program
  .command('statusline')
  .description('Output for Claude Code statusline')
  .option('--mode <mode>', 'Output mode: replace, add, inline', 'replace')
  .option('--inline', 'Shortcut for --mode inline')
  .option('--no-color', 'Disable colors')
  .action(async (opts) => {
    let input = '';
    process.stdin.setEncoding('utf-8');
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    const data = JSON.parse(input);
    const mode = opts.inline ? 'inline' : (opts.mode || 'replace');
    const output = renderStatusline(data, mode, { noColor: opts.color === false });
    process.stdout.write(output);
  });

program
  .command('install-statusline')
  .description('Install claude-meter into Claude Code statusline')
  .action(async () => {
    const output = await runInstallStatuslineCommand();
    console.log(output);
  });

program
  .command('uninstall-statusline')
  .description('Remove claude-meter from Claude Code statusline')
  .action(async () => {
    const output = await runUninstallStatuslineCommand();
    console.log(output);
  });

program
  .command('watch')
  .description('Live updating usage dashboard')
  .option('--interval <seconds>', 'Refresh interval in seconds', '30')
  .option('--compact', 'Minimal output')
  .option('--json', 'Stream JSON objects')
  .option('--no-color', 'Disable colors')
  .action(async (opts) => {
    await runWatch({
      interval: parseInt(opts.interval, 10),
      compact: opts.compact,
      json: opts.json,
      noColor: opts.color === false,
    });
  });

// Default action (no subcommand = this-month)
program.action(async () => {
  const output = await runReport('this-month', {});
  console.log(output);
});

program.parse();
