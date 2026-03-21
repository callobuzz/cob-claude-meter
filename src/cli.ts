#!/usr/bin/env node
import { Command } from 'commander';
import { runReport } from './commands/report.js';

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

// Default action (no subcommand = this-month)
program.action(async () => {
  const output = await runReport('this-month', {});
  console.log(output);
});

program.parse();
