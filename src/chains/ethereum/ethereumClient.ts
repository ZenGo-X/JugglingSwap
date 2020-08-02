import {BlockchainClient} from "../blockchainClient";
import {publicToAddress as publicToEthAddress} from "ethereumjs-util/dist/account";
import Web3 from "web3";
import {Transaction as EthereumJsTransaction} from "ethereumjs-tx";
import {Transaction} from "../transaction";
import {EthereumTransaction} from "./ethereumTransaction";

export class EthereumClient implements BlockchainClient{

    private web3: Web3;

    constructor(config: any) {
        this.web3 = new Web3(config.infuraUrl);
    }

    public async init() {}

    public async close() {}

    public async buildTransaction(fromPublicKey: Buffer, amount: string | "all", toPublicKey: Buffer): Promise<Transaction> {
        const fromAddress = this.getAddress(fromPublicKey);
        const toAddress = this.getAddress(toPublicKey);
        const noncePromise = this.web3.eth.getTransactionCount(fromAddress);
        const gasPricePromise = this.web3.eth.getGasPrice();

        const [nonce, gasPrice] = await Promise.all([noncePromise, gasPricePromise]);
        const nonceHex = `0x${nonce.toString(16)}`;
        const gasPriceHex = `0x${this.web3.utils.toBN(gasPrice).toString(16)}`;
        const gasLimit = 21000;
        const gasLimitHex = `0x${gasLimit.toString(16)}`;
        let value;
        if (amount === 'all') {
            const balance = await this.web3.eth.getBalance(fromAddress);
            const balanceBN = this.web3.utils.toBN(balance);
            const feesBN = this.web3.utils.toBN(gasPrice).muln(gasLimit);
            value = balanceBN.sub(feesBN);
        } else {
            value = this.web3.utils.toWei(amount, 'ether');
        }
        const valueHex = this.web3.utils.toHex(value);

        const txParams = {
            nonce: nonceHex,
            gasPrice: gasPriceHex,
            gasLimit: gasLimitHex,
            to: toAddress,
            value: valueHex,
            data: '0x',
        };
        const tx = new EthereumJsTransaction(txParams, { chain: 'ropsten' });

        return new EthereumTransaction(tx);
    }

    public async getBalance(publicKey: Buffer): Promise<string> {
        const ethAddress = this.getAddress(publicKey);
        const balanceInWei = await this.web3.eth.getBalance(ethAddress, 'pending');
        return Web3.utils.fromWei(balanceInWei, 'ether');
    }

    public getAddress(publicKey: Buffer): string {
        return `0x${publicToEthAddress(publicKey, true).toString('hex')}`;
    }

    public async sendSignedTransaction(txHex: string): Promise<string> {
        const txHexPrefixed = txHex.startsWith('0x') ? txHex : `0x${txHex}`;
        // ensure promise resolved on confirmation
        return new Promise((resolve, reject) => {
            this.web3.eth.sendSignedTransaction(txHexPrefixed)
                .on('receipt', (receipt) => {
                    resolve(receipt.transactionHash);
                })
                .catch(reject);
        });
    }
}