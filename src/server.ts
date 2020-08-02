import config from './config';
const express = require('express');
import * as http from 'http';
import WebSocket from 'ws';
import {
    CoinDerivationIndex, Currency,
    ensureDirSync,
    Order,
} from './common';
import path from 'path';
import {EcdsaParty1, EcdsaParty1Share} from '@kzen-networks/thresh-sig';
import bodyParser from 'body-parser';
import { exec } from 'child_process';
import low from 'lowdb';
import FileSync from 'lowdb/adapters/FileSync';
import { v4 as uuid } from 'uuid';
import pick from 'lodash.pick';
import {BlockchainManager} from "./blockchainManager";
const debug = require('debug')('server');

enum OrderStatus {
    MADE = 'made',
    TAKEN = 'taken',
}

type DBOrder = MadeOrder | TakenOrder;

interface BaseOrder extends Order {
    id: string,
    masterKeyId: string,
    depositAccountIndex: number,
    depositTxHex: string,
    encryptionKey: string,
    status: OrderStatus,
}

interface MadeOrder extends BaseOrder {
    status: OrderStatus.MADE;
}

interface TakenOrder extends BaseOrder {
    takerMasterKeyId: string,
    takerDepositAccountIndex: number,
    takerDepositTxHex: string,
    takerEncryptionKey: string,
    status: OrderStatus.TAKEN;
}

interface BuildTransactionOptions {
    fromAccountIndex?: number,
    toMasterKeyId?: string,
    toAccountIndex?: number,
}

export default class Server {

    private static LOWDB_PATH = path.join(__dirname, '../../server-db');
    private static ROCKSDB_PATH = path.join(__dirname, '../../db');

    private static INVALID_SIGNATURE_ERROR = 'Invalid signature';
    private static ORDER_ID_NOT_FOUND = 'Order ID not found';
    private static INTERNAL_SERVER_ERROR = 'Internal server error';

    private party1: EcdsaParty1;
    private restServer: any;
    private wsServer: any;
    private wsMap: Map<string, WebSocket>;
    private lowdb: any; // orders DB
    private blockchainManager: BlockchainManager;

    constructor() {
        this.party1 = new EcdsaParty1(Server.ROCKSDB_PATH);
    }

    public async run() {
        this.initLowDb();
        this.initWebSocketServer();
        this.initRestServer();
        this.initSigningServer();
        await this.initBlockchainManager();
    }

    private initWebSocketServer() {
        this.wsMap = new Map<string, WebSocket>();
        this.wsServer = new WebSocket.Server({ port: config.webSocketsPort, clientTracking: false, noServer: true });
        this.wsServer.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
            const masterKeyId = request.url?.substring(1);
            if (masterKeyId) {
                // ideally this should be done after authentication.
                this.wsMap.set(masterKeyId, ws);
            }
        });
    }

    private initRestServer() {
        this.restServer = express();
        this.restServer.use(bodyParser.json());
        this.restServer.use((req: any, res: any, next: any) => {
            debug(`${req.method} ${req.url} ${req.body.side ? req.body.side : ''} ${req.body.segmentProof ? req.body.segmentProof.k : ''}`);
            next();
        });
        this.restServer.post('/order', async (req: any, res: any) => {
            const {
                masterKeyId,
                depositAccountIndex,
                depositTxHex,
                encryptionKey,
                sourceCurrency,
                sourceAmount,
                destinationCurrency,
                destinationAmount,
            } = req.body;
            const orderId = this.registerOrder(
                masterKeyId,
                depositAccountIndex,
                depositTxHex,
                encryptionKey,
                {
                    sourceCurrency,
                    destinationCurrency,
                    sourceAmount,
                    destinationAmount,
                }
            );

            res.send({ orderId })
        });
        this.restServer.get('/orders', async (req: any, res: any) => {
            res.send(this.getOrders());
        });
        this.restServer.get('/order/:orderId', async (req: any, res: any) => {
            const order = this.getOrder(req.params.orderId);
            if (!order) {
                return res.status(400).send(Server.ORDER_ID_NOT_FOUND);
            }
            res.send(order);
        });
        this.restServer.post('/takeOrder', async (req: any, res: any) => {
            const { masterKeyId: takerMasterKeyId, orderId, depositAccountIndex: takerDepositAccountIndex, depositTxHex: takerDepositTxHex, encryptionKey: takerEncryptionKey } = req.body;
            const order = this.getMadeOrder(orderId);
            if (!order) {
                return res.status(400).send(Server.ORDER_ID_NOT_FOUND);
            }

            const {
                masterKeyId: makerMasterKeyId,
                depositAccountIndex: makerDepositAccountIndex,
                depositTxHex: makerDepositTxHex,
                encryptionKey: makerEncryptionKey,
            } = order;

            // TODO: check that depositTx matches the order's destination parameters

            this.registerTakeOrder(
                orderId,
                takerMasterKeyId,
                takerDepositAccountIndex,
                takerDepositTxHex,
                takerEncryptionKey,
            );

            const makerDepositPublicKey = await this.getPublicKey(makerMasterKeyId, order.sourceCurrency, order.depositAccountIndex);
            res.send({
                orderId,
                counterpartyDepositTxHex: makerDepositTxHex,
                counterpartyDepositPublicKey: makerDepositPublicKey,
                counterpartyEncryptionKey: makerEncryptionKey
            });

            debug('Sending deposit transactions to the blockhains...');
            const [makerDepositTxHash, takerDepositTxHash] = await Promise.all([
                this.blockchainManager.sendSignedTransaction(order.sourceCurrency, makerDepositTxHex),
                this.blockchainManager.sendSignedTransaction(order.destinationCurrency, takerDepositTxHex),
            ]);
            debug(`Sent: maker: ${makerDepositTxHash}, taker: ${takerDepositTxHash}`);

            const ws = this.wsMap.get(makerMasterKeyId);
            if (ws) {
                const takerDepositPublicKey = await this.getPublicKey(takerMasterKeyId, order.destinationCurrency, takerDepositAccountIndex);
                ws.send(JSON.stringify({
                    type: 'match',
                    orderId,
                    counterpartyDepositPublicKey: takerDepositPublicKey,
                    counterpartyDepositTxHex: takerDepositTxHex,
                    counterpartyEncryptionKey: takerEncryptionKey,
                }));
            }
        });
        this.restServer.post('/gradualReleaseFirstMessage', async (req: any, res: any) => {
            const { side, masterKeyId, orderId, gradualReleaseFirstMessage } = req.body;
            const order: TakenOrder = this.getTakenOrder(
                orderId,
                side,
                masterKeyId,
            );
            if (!order) {
                return res.status(400).send(Server.ORDER_ID_NOT_FOUND);
            }

            res.send('OK');

            const ws = this.wsMap.get(side === 'maker' ? order.takerMasterKeyId : order.masterKeyId);
            if (ws) {
                ws.send(JSON.stringify({
                    type: 'gradualReleaseFirstMessage',
                    orderId,
                    gradualReleaseFirstMessage,
                }));
            }
        });
        this.restServer.post('/segment', async (req: any, res: any) => {
            const { side, masterKeyId, orderId, segmentProof } = req.body;
            const order: TakenOrder = this.getTakenOrder(
                orderId,
                side,
                masterKeyId,
            );
            if (!order) {
                return res.status(400).send(Server.ORDER_ID_NOT_FOUND);
            }

            res.send('OK');

            const ws = this.wsMap.get(side === 'maker' ? order.takerMasterKeyId : order.masterKeyId);
            if (ws) {
                ws.send(JSON.stringify({
                    type: 'segment',
                    orderId,
                    segmentProof
                }));
            }
        });
        this.restServer.post('/withdraw', async (req: any, res: any) => {
            const { side, orderId, masterKeyId } = req.body;

            const order: TakenOrder = this.getTakenOrder(orderId, side, masterKeyId);
            if (!order) {
                return res.status(400).send(Server.ORDER_ID_NOT_FOUND);
            }

            let counterpartyMasterKeyId: string;
            let counterpartyAccountIndex: number;
            let counterpartyCurrency: Currency;
            if (side === 'taker') {
                counterpartyMasterKeyId = order.masterKeyId;
                counterpartyAccountIndex = order.depositAccountIndex;
                counterpartyCurrency = order.sourceCurrency;
            } else {
                counterpartyMasterKeyId = order.takerMasterKeyId;
                counterpartyAccountIndex = order.takerDepositAccountIndex;
                counterpartyCurrency = order.destinationCurrency;
            }

            // Each party only recovers private part of share, so send it the public part.
            const masterKeyShare = await this.getMasterKeyShare(counterpartyMasterKeyId);
            const childShare = await this.party1.getChildShare(
                masterKeyShare,
                CoinDerivationIndex[counterpartyCurrency],
                counterpartyAccountIndex
            );
            const counterpartySharePublic = (childShare as any).public;

            res.send({
                counterpartySharePublic,
                counterpartyMasterKeyId,
                counterpartyAccountIndex,
            });
        });
        this.restServer.listen(config.restPort, () => {
            debug(`Server listening on port ${config.restPort}`);
        });
    }

    private initLowDb() {
        ensureDirSync(Server.LOWDB_PATH);
        const adapter = new FileSync(`${Server.LOWDB_PATH}/db.json`);
        this.lowdb = low(adapter);
        this.lowdb.defaults({ orders: [] }).write();
    }

    private async initBlockchainManager() {
        this.blockchainManager = new BlockchainManager();
        await this.blockchainManager.init();
    }

    private initSigningServer() {
        exec('npm run start-signing-server');
    }

    private async getMasterKeyShare(masterKeyId: string): Promise<EcdsaParty1Share> {
        return await this.party1.getMasterKey(masterKeyId);
    }

    // return uncompressed hex
    private async getPublicKey(masterKeyId: string, currency: Currency, accountIndex: number): Promise<string> {
        const masterKeyShare = await this.getMasterKeyShare(masterKeyId);
        const childShare = this.party1.getChildShare(masterKeyShare, CoinDerivationIndex[currency], accountIndex);
        return childShare.getPublicKey().encode('hex', false);
    }

    private registerOrder(masterKeyId: string, depositAccountIndex: number, depositTxHex: string, encryptionKey: string, order: Order): string {
        const orderId = uuid();
        const dbOrder: DBOrder = {
            id: orderId,
            masterKeyId,
            depositAccountIndex,
            depositTxHex,
            encryptionKey,
            status: OrderStatus.MADE,
            ...order,
        };
        this.lowdb
            .get('orders')
            .push(dbOrder)
            .write();
        return orderId;
    }
    
    private registerTakeOrder(
        orderId: string,
        takerMasterKeyId: string,
        takerDepositAccountIndex: number,
        takerDepositTxHex: number,
        takerEncryptionKey: string,
    ): void {
        this.lowdb
            .get('orders')
            .find({ id: orderId })
            .assign({
                status: OrderStatus.TAKEN,
                takerMasterKeyId,
                takerDepositAccountIndex,
                takerDepositTxHex,
                takerEncryptionKey,
            })
            .write();
    }

    private getOrders(): ({ id: string } & Order )[] {
        return this.lowdb
            .get('orders')
            .filter({ status: OrderStatus.MADE })
            .map((dbOrder: DBOrder) => pick(
                dbOrder,
                ['id', 'sourceCurrency', 'destinationCurrency', 'sourceAmount', 'destinationAmount']
            ))
            .value();
    }

    private getOrder(id: string): Order {
        const order = this.lowdb
            .get('orders')
            .find({ id })
            .value();

        return order && pick(order, ['sourceCurrency', 'destinationCurrency', 'sourceAmount', 'destinationAmount']);
    }

    private getMadeOrder(id: string): MadeOrder {
        return this.lowdb
            .get('orders')
            .find({ id, status: OrderStatus.MADE })
            .value();
    }

    private getTakenOrder(id: string, side: 'taker' | 'maker', masterKeyId: string): TakenOrder {
        return this.lowdb
            .get('orders')
            .find({
                id,
                status: OrderStatus.TAKEN,
                ...(side === 'maker' ? { masterKeyId } : { takerMasterKeyId: masterKeyId })
            })
            .value();
    }
}