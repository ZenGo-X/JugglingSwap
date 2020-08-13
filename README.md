## JugglingSwap

A scriptless _atomic cross-chain (and cross-curve) swap_ protocol based on a fair exchange of secrets and threshold-signatures. See [paper](https://arxiv.org/abs/2007.14423).
Demonstrating a BTC/ETH swap.

### Installation

1. Install Rust.<br>
   This demo was tested on rustc 1.38.0-nightly (0b680cfce 2019-07-09);
2. Clone and build the repository:
```
$ git clone https://github.com/KZen-networks/atomic-swaps
$ cd ./atomic-swaps
$ yarn install
$ yarn run build 
```

### Demo

You can use the command line demo, using 3 different shells, one for each of the different actors: a maker, a taker and a server.

#### Server
The server functions as both the co-signer of wallet owners (i.e. the maker and the taker) and as a hub for communication between them when performing a make/take order request and the atomic swap itself.
```
$ cd ./dist/demo
$ export DEBUG=server  # see useful logs throughout the demo
$ chmod +x ./server.js
$ ./server.js run
Server listening on port 8001
```

#### Maker
```
$ cd ./dist/demo
$ export DEBUG=user,maker  # see useful logs throughout the demo
$ chmod +x ./maker.js
$ ./maker.js --help
Usage: maker [options] [command]

Options:
  -h, --help                                                      display help for command

Commands:
  address|a [options]
  balance|b
  make|m <sourceCurrency> <sourceAmount> <toCurrency> <toAmount>  Make an order
  help [command]                                                  display help for command
```
For example, the maker would want to swap BTC for ETH.<br>
You'll first need to send some Bitcoin Testnet coins to the maker's address. One available faucet is: https://testnet-faucet.mempool.co/.<br>
To get the maker's address:
```
$ ./maker.js address
mys4d22g8t9h9j3W3JDDbPynYgh2dBj9tw
```
Then, you can make an order request (do not kill the process when done):
```
$ ./maker.js make BTC 0.0001 ETH 0.001
done
```

#### Taker
```
$ cd ./dist/demo
$ export DEBUG=user,taker  # see useful logs throughout the demo
$ chmod +x ./taker.js
$ ./taker.js --help
Usage: taker [options] [command]

Options:
  -h, --help           display help for command

Commands:
  address|a [options]
  balance|b
  orders|o             Get all orders
  take|t <orderId>     Take an order
  help [command]       display help for command
```
First, deposit some (ropsten) ether into the taker's ETH address. One available faucet is: https://faucet.ropsten.be/.<br>
To get the taker's address:
```
$ ./taker.js address
0x6eddb5f4826f0943069f5b09cade32c5e0bbcae6
```
Get all available orders (made by makers):
```
$ ./taker.js orders
[ { id: '10121dc1-49ac-426d-823a-af757c798aad',
    sourceCurrency: 'BTC',
    destinationCurrency: 'ETH',
    sourceAmount: '0.0001',
    destinationAmount: '0.001' } ]
```
Then, execute an order using its id:
```
./taker.js take 10121dc1-49ac-426d-823a-af757c798aad
```
Eventually, you'll see logs of the following formats at the maker's and taker's shells, respectively:
```
Executed ETH withdraw: 0x5b780bdb57a69fc0c5b0e1c8a43764a702e50202eb3a73524db48744396c94a7
```
```
Executed BTC withdraw: edef8ac64f9dcd2a1ee8dcea964249a4a23e9f83f827f17ea65d0f2ed7aefcf8
```
These transactions complete the cross-chains atomic-swap between the parties.

 |![Demo](https://raw.githubusercontent.com/KZen-networks/JugglingSwap/master/demo.gif "Bitcoin & Ethereum Atomic Cross Chain Swap")|
 |:--:|


## Contact

Feel free to [reach out](mailto:github@kzencorp.com) or join ZenGo X [Telegram](https://t.me/zengo_x) for discussions on code and research.
