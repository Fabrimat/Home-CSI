#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from '@homecsi/config';
import { resolveConfigPath } from './resolveConfigPath.js';
import { runOwnedCommand } from './lazyCommand.js';
import { runMigrateCommand } from './commands/migrate.js';
import { runDoctor } from './commands/doctor.js';

const program = new Command();

program
  .name('homecsi')
  .description('Home CSI operator CLI')
  .option('-c, --config <path>', 'path to config.yaml (default: $HOMECSI_CONFIG_PATH or ./config.yaml)');

function getConfigPath(): string {
  return resolveConfigPath(program.opts<{ config?: string }>().config);
}

program
  .command('migrate')
  .description('apply pending database migrations')
  .action(async () => {
    await runOwnedCommand(() => runMigrateCommand(getConfigPath()));
  });

program
  .command('doctor')
  .description('diagnose config validity, database reachability, and disk budget')
  .action(async () => {
    await runOwnedCommand(() => runDoctor(getConfigPath()));
  });

program
  .command('ingest')
  .description('run the UDP ingest server')
  .action(async () => {
    await runOwnedCommand(async () => {
      const config = loadConfig(getConfigPath());
      const mod = await import('@homecsi/ingest');
      await mod.runIngest(config);
    });
  });

program
  .command('replay')
  .argument('<path>', 'path to a raw capture file or directory to replay')
  .description('replay a raw capture into the ingest pipeline')
  .action(async (inputPath: string) => {
    await runOwnedCommand(async () => {
      const config = loadConfig(getConfigPath());
      const mod = await import('@homecsi/storage');
      await mod.replayCaptures(inputPath, config);
    });
  });

program
  .command('prune')
  .description('enforce raw-capture retention/disk-budget policy')
  .action(async () => {
    await runOwnedCommand(async () => {
      const config = loadConfig(getConfigPath());
      const mod = await import('@homecsi/storage');
      await mod.pruneStorage(config);
    });
  });

program
  .command('serve')
  .description('run the API + web UI server')
  .action(async () => {
    await runOwnedCommand(async () => {
      const config = loadConfig(getConfigPath());
      const mod = await import('@homecsi/api');
      await mod.startServer(config);
    });
  });

program
  .command('features')
  .description('run the windowed amplitude feature extraction pipeline')
  .action(async () => {
    await runOwnedCommand(async () => {
      const config = loadConfig(getConfigPath());
      const mod = await import('@homecsi/features');
      await mod.runFeaturePipeline(config);
    });
  });

program
  .command('occupancy')
  .description('run the latched occupancy state machine pipeline')
  .action(async () => {
    await runOwnedCommand(async () => {
      const config = loadConfig(getConfigPath());
      const mod = await import('@homecsi/occupancy');
      await mod.runOccupancyPipeline(config);
    });
  });

program
  .command('label')
  .argument('[args...]', 'labeling subcommand and its arguments')
  .allowUnknownOption()
  .description('manage ground-truth label sessions')
  .action(async (args: string[]) => {
    await runOwnedCommand(async () => {
      const config = loadConfig(getConfigPath());
      const mod = await import('@homecsi/labeling');
      await mod.runLabelCli(args, config);
    });
  });

program
  .command('train')
  .argument('[args...]', 'training subcommand and its arguments')
  .allowUnknownOption()
  .description('kick off / export data for occupancy model training')
  .action(async (args: string[]) => {
    await runOwnedCommand(async () => {
      const config = loadConfig(getConfigPath());
      const mod = await import('@homecsi/labeling');
      await mod.runTrain(args, config);
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
