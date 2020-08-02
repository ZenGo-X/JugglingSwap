#!/usr/bin/env node

import program from 'commander';
import Maker from '../src/maker';

program
    .command('address')
    .alias('a')
    .option('-c, --currency [currency]')
    .option('-i, --index [number]')
    .action(async (options) => {
        const currency = (options && options.currency) || 'BTC';
        const maker = new Maker();
        await maker.init();
        const address = await maker.getAddress(currency, parseInt(options.index || '0'));
        maker.close();
        console.log(address);
    });

program
    .command('balance')
    .alias('b')
    .action(async () => {
        const maker = new Maker();
        await maker.init();
        const balance = await maker.getBalance();
        maker.close();
        console.log(balance);
    });

program
    .command('make <sourceCurrency> <sourceAmount> <toCurrency> <toAmount>')
    .alias('m')
    .description('Make an order')
    .action(async (sourceCurrency, sourceAmount, destinationCurrency, destinationAmount) => {
        const maker = new Maker();
        await maker.init();
        try {
            await maker.makeOrder({ sourceCurrency, sourceAmount, destinationCurrency, destinationAmount });
            console.log('done');
        } catch (err) {
            console.error(err.message);
            maker.close();
        }
    });

program.parse(process.argv);