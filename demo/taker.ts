#!/usr/bin/env node

import program from 'commander';
import Taker from '../src/taker';

program
    .command('address')
    .alias('a')
    .option('-c, --currency [currency]')
    .option('-i, --index [number]')
    .action(async (options) => {
        const currency = (options && options.currency) || 'ETH';
        const taker = new Taker();
        await taker.init();
        const address = await taker.getAddress(currency, parseInt(options.index || '0'));
        taker.close();
        console.log(address);
    });

program
    .command('balance')
    .alias('b')
    .action(async () => {
        const taker = new Taker();
        await taker.init();
        const balance = await taker.getBalance();
        taker.close();
        console.log(balance);
    });

program
    .command('orders')
    .alias('o')
    .description('Get all orders')
    .action(async () => {
        const taker = new Taker();
        await taker.init();
        const orders = await taker.getOrders();
        taker.close();
        console.log(orders);
    });

program
    .command('take <orderId>')
    .alias('t')
    .description('Take an order')
    .action(async (orderId) => {
        const taker = new Taker();
        await taker.init();
        try {
            await taker.takeOrder(orderId);
        } catch (err) {
            console.error(err.message);
        }
    });

program.parse(process.argv);