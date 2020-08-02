import config from "./config";
import fs from 'fs';
import { Transaction as EthTransaction } from 'ethereumjs-tx';
import { Transaction as BtcTransaction } from 'bitcoinjs-lib';

export function ensureDirSync(dirpath: string) {
    try {
        fs.mkdirSync(dirpath, { recursive: true })
    } catch (err) {
        if (err.code !== 'EEXIST') throw err
    }
}

export interface Balance {
    currency: Currency,
    value: string,
}

export type Currency = 'BTC' | 'ETH';

export const CoinDerivationIndex: {[currency: string]: number} = {
    BTC: 0,
    ETH: 1,
};

export interface Order {
    sourceCurrency: Currency,
    destinationCurrency: Currency,
    sourceAmount: string,
    destinationAmount: string,
}

export interface MatchParams {
    orderId: string,
    counterpartyDepositPublicKey: string,
    counterpartyDepositTxHex: string,
    counterpartyEncryptionKey: string,
}

export const SIGNING_SERVER_URL = `http://${config.host}:${config.signingPort}`;
export const REST_SERVER_URL = `http://${config.host}:${config.restPort}`;
export const WEBSOCKETS_SERVER_URL = `ws://${config.host}:${config.webSocketsPort}`;

export const SATS_IN_BTC = 100_000_000;

export const notEnoughFunds = 'Not enough funds.';

console.warn = () => {}; // cancel annoying warning logs from dependencies