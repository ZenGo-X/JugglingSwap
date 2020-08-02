import { BlockchainClient } from "../blockchainClient";
import {SATS_IN_BTC} from "../../common";
import * as bitcoin from "bitcoinjs-lib";
import { Transaction } from "../transaction";
import { BitcoinTransaction } from "./bitcoinTransaction";
const ElectrumCli = require('electrum-client');

export class BitcoinClient implements BlockchainClient {

    private electrumClient: any;

    constructor(config: { electrumPort: number, electrumHost: string }) {
        this.electrumClient = new ElectrumCli(config.electrumPort, config.electrumHost, 'tcp');
    }

    public async init() {
        await this.initElectrumClient();
    }

    public async close() {
        this.electrumClient.close();
    }

    private async initElectrumClient() {
        await this.electrumClient.connect();
    }

    public async buildTransaction(fromPublicKey: Buffer, amount: string | "all", toPublicKey: Buffer): Promise<Transaction> {
        const fromAddress = this.getAddress(fromPublicKey);
        const scriptHash = BitcoinClient.toScriptHash(fromAddress);
        const utxos: any[] = await this.electrumClient.blockchainScripthash_listunspent(scriptHash);
        const fee = await this.electrumClient.blockchainEstimatefee(2);
        let selectedUtxos: any[] = [];
        let selectedValue = 0;
        utxos.sort((a, b) => b.value - a.value);  // sort descending by value
        utxos.some((utxo: any) => {
            selectedUtxos.push(utxo);
            selectedValue += utxo.value;
            if (amount === 'all') {
                return false;
            }

            return selectedValue >= (parseFloat(amount) + fee) * SATS_IN_BTC;
        });

        const txBuilder = new bitcoin.TransactionBuilder(bitcoin.networks.testnet);
        selectedUtxos.forEach((utxo, i) => {
            txBuilder.addInput(utxo.tx_hash, utxo.tx_pos);
        });

        const toAddress = this.getAddress(toPublicKey);
        if (amount === 'all') {
            txBuilder.addOutput(toAddress, selectedValue - Math.round(fee * SATS_IN_BTC));
        } else {
            txBuilder.addOutput(toAddress, Math.round(parseFloat(amount) * SATS_IN_BTC));
            // change output - TODO generate a new address for user.
            txBuilder.addOutput(fromAddress, selectedValue - Math.round((parseFloat(amount) + fee) * SATS_IN_BTC));
        }

        return new BitcoinTransaction(txBuilder.buildIncomplete());
    }

    public async getBalance(publicKey: Buffer): Promise<string> {
        const btcAddress = this.getAddress(publicKey);
        const scriptHash = BitcoinClient.toScriptHash(btcAddress);
        const utxos = await this.electrumClient.blockchainScripthash_listunspent(scriptHash);
        const satsBalance = utxos.reduce((acc: number, utxo: any) => acc + utxo.value, 0);
        const btcBalance = satsBalance / SATS_IN_BTC;
        return btcBalance.toString();
    }

    public getAddress(publicKey: Buffer): string {
        return bitcoin.payments.p2pkh({
            pubkey: publicKey,
            network: bitcoin.networks.testnet,
        }).address as string;
    }

    public async sendSignedTransaction(txHex: string): Promise<string> {
        return this.electrumClient.blockchainTransaction_broadcast(txHex);
    }

    private static toScriptHash(address: string): string {
        const network = bitcoin.networks.testnet;
        let script = bitcoin.address.toOutputScript(address, network);
        let hash = bitcoin.crypto.sha256(script);
        return Buffer.from(hash.reverse()).toString('hex');
    }

}