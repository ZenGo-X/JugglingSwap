import {EcdsaParty2, EcdsaParty2Share, EcdsaSignature} from "@kzen-networks/thresh-sig";
import {
    Balance,
    CoinDerivationIndex,
    Currency,
    ensureDirSync,
    REST_SERVER_URL,
    SIGNING_SERVER_URL,
    WEBSOCKETS_SERVER_URL
} from "./common";
import axios from "axios";
import FileSync from "lowdb/adapters/FileSync";
import low from "lowdb";
import WebSocket from 'ws';
import {BlockchainManager} from "./blockchainManager";
import {Transaction} from "./chains";
import BigNumber from "bignumber.js";
const debug = require('debug')('user');

export default abstract class User {

    protected db: any;
    private readonly p2: EcdsaParty2;
    private p2Share: EcdsaParty2Share;
    private ws: WebSocket;
    private blockchainManager: BlockchainManager;

    protected constructor() {
        this.p2 = new EcdsaParty2(SIGNING_SERVER_URL);
    }

    public async init() {
        await Promise.all([
            this.initDb(),
            this.initPrivateShare(),
            this.initBlockchainManager(),
        ]);
        await this.initWebSocketsClient();
    }

    public async getBalance(): Promise<Balance[]>  {
        const currencies: Currency[] = ['BTC', 'ETH'];
        const promises = currencies.map((currency: Currency) => {
            const publicKey = this.getPublicKey(currency);
            return this.blockchainManager.getBalance(currency, publicKey);
        });
        const balances = await Promise.all(promises);

        return balances.map((balance: string, i: number) => {
            return {
                currency: currencies[i],
                value: balance,
            }
        });
    }

    public async close(): Promise<void> {
        this.closeWebSocketsClient();
        await this.closeBlockchainManager();
    }

    private closeWebSocketsClient() {
        this.ws.close();
    }

    private async closeBlockchainManager() {
        return this.blockchainManager.close();
    }

    public getAddress(currency: Currency, accountIndex: number = 0): string {
        const publicKey = this.getPublicKey(currency, { accountIndex });
        return this.blockchainManager.getAddress(currency, publicKey);
    }

    protected abstract getDbPath(): string;

    protected getAndIncrementAccountIndex(currency: Currency): number {
        const lastAccountIndexPath = `accountIndexes.${currency}.last`;
        const currentAccountIndex = this.db.get(lastAccountIndexPath).value() || 0;
        this.db.set(lastAccountIndexPath, currentAccountIndex + 1).write();
        return currentAccountIndex;
    }

    protected getParty2(): EcdsaParty2 {
        return this.p2;
    }

    protected getMasterKeyId(): string {
        return this.p2Share.id;
    }

    protected getParty2Share(): EcdsaParty2Share {
        return EcdsaParty2Share.fromPlain(
            this.db
                .get('party2Shares')
                .find({ id: this.getMasterKeyId() })
                .value()
        );
    }

    protected getBlockchainManager(): BlockchainManager {
        return this.blockchainManager;
    }

    protected on(msg: any): void {
        switch (msg.type) {
            case 'gradualReleaseFirstMessage':
                this.onGradualReleaseFirstMessage(msg);
                break;
            case 'segment':
                this.onSegment(msg);
                break;
        }
    }

    protected abstract onGradualReleaseFirstMessage(msg: any): void;

    protected abstract onSegment(msg: any): void;

    protected async withdraw(orderId: string, currency: Currency, counterpartyDepositPrivateKey: Buffer, side: 'taker' | 'maker') {
        debug('Calling /withdraw');
        const { data } = await axios.post(
            `${REST_SERVER_URL}/withdraw`,
            {
                side,
                orderId,
                masterKeyId: this.getMasterKeyId(),
            });
        const {
            counterpartySharePublic,
            counterpartyMasterKeyId,
            counterpartyAccountIndex,
        } = data;

        debug('Constructing party2 share');
        const counterpartyShare = EcdsaParty2Share.fromPlain({
            id: counterpartyMasterKeyId,
            master_key: {
                public: counterpartySharePublic,
                chain_code: '0',
                private: {
                    x2: counterpartyDepositPrivateKey.toString('hex')
                }
            }
        });

        debug('Signing the transaction');
        const from = { accountIndex: counterpartyAccountIndex, party2Share: counterpartyShare };
        const withdrawTx = await this.buildAndSignTransaction(
            currency,
            'all',
            0,
            from,
        );

        debug('Sending withdraw transaction...');
        const withdrawTxHash = await this.blockchainManager.sendSignedTransaction(currency, withdrawTx.toBuffer().toString('hex'));
        debug(`Executed ${currency} withdraw: ${withdrawTxHash}`);
    }

    protected async buildAndSignTransaction(currency: Currency, amount: string | 'all', toAccountIndex: number, from: GetPublicKeyOptions = { accountIndex: 0 }): Promise<Transaction> {
        const tx = await this.buildTransaction(currency, from, amount, toAccountIndex);
        await this.signTransaction(currency, from, tx);
        return tx;
    }

    protected getPublicKey(currency: Currency, options: GetPublicKeyOptions = { accountIndex: 0 }): Buffer {
        const childShare = options.party2Share || this.getChildShare(currency, options.accountIndex);
        return Buffer.from(
            childShare.getPublicKey().encodeCompressed()
        );
    }

    protected async hasSufficientBalanceFor(currency: Currency, requestedAmount: string) {
        const balance = await this.getBalance();
        const sourceCurrencyBalance = balance.find(b => b.currency === currency);
        if (!sourceCurrencyBalance) {
            return false;
        }

        const sourceCurrencyBalanceBN = new BigNumber(sourceCurrencyBalance.value);
        const sourceCurrencyAmountToSwapBN = new BigNumber(requestedAmount);
        return sourceCurrencyBalanceBN.gt(sourceCurrencyAmountToSwapBN);
    }

    private async buildTransaction(currency: Currency, from: GetPublicKeyOptions, amount: string | 'all', toAccountIndex: number): Promise<Transaction> {
        const fromPublicKey = this.getPublicKey(currency, from);
        const toPublicKey = this.getPublicKey(currency, { accountIndex: toAccountIndex });
        return this.getBlockchainManager()
            .buildTransaction(
                currency,
                fromPublicKey,
                amount,
                toPublicKey,
            );
    }

    private async signTransaction(currency: Currency, from: GetPublicKeyOptions, transaction: Transaction): Promise<void> {
        const fromChildShare = from.party2Share || this.getChildShare(currency, from.accountIndex);
        const fromPublicKey = Buffer.from(fromChildShare.getPublicKey().encodeCompressed());
        const hashes = transaction.getHashesForSignatures([fromPublicKey]);  // TODO: allow multiple from public keys for UTXO-based
        const sig = await this.p2.sign(hashes[0], fromChildShare, CoinDerivationIndex[currency], from.accountIndex);
        transaction.injectSignatures([fromPublicKey], [sig]);
    }

    private getChildShare(currency: Currency, accountIndex: number): EcdsaParty2Share {
        return this.p2.getChildShare(this.p2Share, CoinDerivationIndex[currency], accountIndex);
    }

    private initDb() {
        const dbPath = this.getDbPath();
        ensureDirSync(dbPath);
        const adapter = new FileSync(`${dbPath}/db.json`);
        this.db = low(adapter);
        this.db.defaults({ party2Shares: [], accountIndexes: {}, orders: [] }).write();
    }

    private initWebSocketsClient(): Promise<void> {
        this.ws = new WebSocket(`${WEBSOCKETS_SERVER_URL}/${this.getMasterKeyId()}`);
        this.ws.on('message', (msg: any) => {
            this.on(JSON.parse(msg));
        });
        return new Promise(resolve => {
           this.ws.on('open', () => {
               resolve();
           })
        });
    }

    private initBlockchainManager(): Promise<void> {
        this.blockchainManager = new BlockchainManager();
        return this.blockchainManager.init();
    }

    private async initPrivateShare() {
        const previousShares = this.db.get('party2Shares').value();
        if (previousShares.length) {
            this.p2Share = previousShares[previousShares.length - 1];
        } else {
            this.p2Share = await this.p2.generateMasterKey();
            this.db
                .get('party2Shares')
                .push(this.p2Share)
                .write();
        }
    }
}
interface GetPublicKeyOptions {
    party2Share?: EcdsaParty2Share,
    accountIndex: number,
}
