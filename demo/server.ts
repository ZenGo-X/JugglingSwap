#!/usr/bin/env node

import program from 'commander';
import Server from '../src/server'

program
  .command('run')
  .description('Run the server')
  .action(() => {
    const server = new Server();
    server.run();
  });

program.parse(process.argv);