import {BitcoinClient} from "./chains/bitcoin/bitcoinClient";
import config from "./config";
import {EthereumClient} from "./chains/ethereum/ethereumClient";
import {BlockchainClient} from "./chains/blockchainClient";
import {Currency} from "./common";
import {Transaction} from "./chains/transaction";
import {BitcoinTransaction} from "./chains/bitcoin/bitcoinTransaction";
import {EthereumTransaction} from "./chains/ethereum/ethereumTransaction";

export class BlockchainManager {

    private bitcoinClient: BlockchainClient;
    private ethereumClient: BlockchainClient;

    constructor() {}

    public async init(): Promise<void> {
        this.bitcoinClient = new BitcoinClient(config);
        this.ethereumClient = new EthereumClient(config);
        await Promise.all([this.bitcoinClient.init(), this.ethereumClient.init()]);
    }

    public async close(): Promise<void> {
        await Promise.all([this.bitcoinClient.close(), this.ethereumClient.close()]);
    }

    public getAddress(currency: Currency, publicKey: Buffer): string {
        return this.getClient(currency).getAddress(publicKey);
    }

    public buildTransaction(currency: Currency, fromPublicKey: Buffer, amount: string | 'all', toPublicKey: Buffer): Promise<Transaction> {
        return this.getClient(currency).buildTransaction(fromPublicKey, amount, toPublicKey);
    }

    public getBalance(currency: Currency, publicKey: Buffer): Promise<string> {
        return this.getClient(currency).getBalance(publicKey);
    }

    public sendSignedTransaction(currency: Currency, txHex: string): Promise<string> {
        return this.getClient(currency).sendSignedTransaction(txHex);
    }

    public transactionFromBuffer(currency: Currency, buffer: Buffer): Transaction {
        let tx: Transaction;
        switch (currency) {
            case "BTC":
                tx = BitcoinTransaction.fromBuffer(buffer);
                break;
            case "ETH":
                tx = EthereumTransaction.fromBuffer(buffer);
                break;
        }

        return tx;
    }

    private getClient(currency: Currency): BlockchainClient {
        let client: BlockchainClient;
        switch (currency) {
            case "BTC":
                client = this.bitcoinClient;
                break;
            case "ETH":
                client = this.ethereumClient;
                break;
        }

        return client;
    }
}