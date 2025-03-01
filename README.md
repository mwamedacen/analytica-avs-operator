# Chain Analytica AVS Operator

A proof-of-concept implementation of an EigenLayer Active Validator Service (AVS) operator for Chain Analytica. This operator processes on-chain tasks, interacts with Chain Analytica's API, and stores results using EigenDA.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env`:
```
WS_RPC_URL=your_websocket_rpc_url
PK_OPERATOR=your_operator_private_key
PK_EIGENDA=your_eigenda_private_key
API_CHAIN_ANALYTICA_HTTP=chain_analytica_api_endpoint
```

## Usage

Development mode:
```bash
npm run dev
```

Production mode:
```bash
npm run build
npm start
```

## Features

- Automatic operator registration with EigenLayer
- WebSocket connection for real-time task monitoring
- Automatic reconnection handling
- Integration with EigenDA for data availability
- Task response processing and on-chain submission 