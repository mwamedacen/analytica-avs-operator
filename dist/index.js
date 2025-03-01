"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ethers_1 = require("ethers");
const eigenda_sdk_1 = require("eigenda-sdk");
const dotenv = __importStar(require("dotenv"));
// Import ABIs and addresses
const avsDeployment = __importStar(require("./eigen-contracts/deployments/chain-analytica/17000.json"));
const coreDeployment = __importStar(require("./eigen-contracts/deployments/core/17000.json"));
const ChainAnalyticaServiceManager_json_1 = __importDefault(require("./eigen-contracts/abis/ChainAnalyticaServiceManager.json"));
//import delegationManagerABI from './eigen-contracts/abis/IDelegationManager.json';
const ECDSAStakeRegistry_json_1 = __importDefault(require("./eigen-contracts/abis/ECDSAStakeRegistry.json"));
const IAVSDirectory_json_1 = __importDefault(require("./eigen-contracts/abis/IAVSDirectory.json"));
// Load environment variables
dotenv.config();
if (!process.env.WS_RPC_URL || !process.env.PK_OPERATOR || !process.env.PK_EIGENDA || !process.env.API_CHAIN_ANALYTICA_HTTP) {
    throw new Error('Missing required environment variables');
}
class AVSOperator {
    constructor() {
        this.isRunning = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.heartbeatInterval = null;
        console.log('Initializing AVS Operator...');
        // Initialize WebSocket provider and signer
        this.provider = new ethers_1.ethers.WebSocketProvider(process.env.WS_RPC_URL);
        this.signer = new ethers_1.ethers.Wallet(process.env.PK_OPERATOR, this.provider);
        this.eigenDAClient = new eigenda_sdk_1.EigenDAClient({
            privateKey: process.env.PK_EIGENDA
        });
        this.identifier = new Uint8Array(Array(31).fill(0).concat([9]));
        this.chainAnalyticaServiceManagerAddress = avsDeployment.addresses.chainAnalyticaServiceManager;
        // Initialize contracts
        this.chainAnalyticaServiceManager = new ethers_1.ethers.Contract(this.chainAnalyticaServiceManagerAddress, ChainAnalyticaServiceManager_json_1.default, this.signer);
        // Initialize AVS directory contract 
        this.avsDirectory = new ethers_1.ethers.Contract(coreDeployment.addresses.avsDirectory, IAVSDirectory_json_1.default, this.signer);
        // Initialize ECDSA registry contract
        this.ecdsaRegistryContract = new ethers_1.ethers.Contract(avsDeployment.addresses.stakeRegistry, ECDSAStakeRegistry_json_1.default, this.signer);
        console.log('AVS Operator initialized successfully');
    }
    async registerOperator() {
        console.log('Starting operator registration process...');
        const salt = ethers_1.ethers.hexlify(ethers_1.ethers.randomBytes(32));
        const expiry = Math.floor(Date.now() / 1000) + (3 * 24 * 3600); // 3 days in seconds
        let operatorSignatureWithSaltAndExpiry = {
            signature: "",
            salt: salt,
            expiry: expiry
        };
        const operatorDigestHash = await this.avsDirectory.calculateOperatorAVSRegistrationDigestHash(this.signer.address, await this.chainAnalyticaServiceManager.getAddress(), salt, expiry);
        console.log('Generated operator digest hash:', operatorDigestHash);
        console.log("Signing digest hash with operator's private key");
        const operatorSigningKey = new ethers_1.ethers.SigningKey(process.env.PK_OPERATOR);
        const operatorSignedDigestHash = operatorSigningKey.sign(operatorDigestHash);
        operatorSignatureWithSaltAndExpiry.signature = ethers_1.ethers.Signature.from(operatorSignedDigestHash).serialized;
        console.log("Registering Operator to AVS Registry contract");
        const tx2 = await this.ecdsaRegistryContract.registerOperatorWithSignature(operatorSignatureWithSaltAndExpiry, this.signer.address);
        await tx2.wait();
        console.log("Operator registered on AVS successfully");
    }
    async handleTask(taskIndex, taskCreatedBlock, taskName) {
        try {
            console.log(`[${new Date().toISOString()}] Processing task ${taskIndex}: ${taskName}`);
            const response = await fetch(process.env.API_CHAIN_ANALYTICA_HTTP, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: taskName })
            });
            if (!response.ok) {
                throw new Error(`API call failed: ${response.statusText}`);
            }
            const responseData = await response.json();
            console.log(`[${new Date().toISOString()}] API Response received for task ${taskIndex}`);
            const parsedJson = JSON.parse(responseData.response.replace(/```json\n|\n```/g, ''));
            console.log(`[${new Date().toISOString()}] Uploading to EigenDA for task ${taskIndex}`);
            const uploadResult = await this.eigenDAClient.upload(JSON.stringify(parsedJson), this.identifier);
            console.log(`[${new Date().toISOString()}] Upload Job ID for task ${taskIndex}:`, uploadResult.job_id);
            const taskResponse = `${uploadResult.job_id}:${parsedJson.message}`;
            console.log(`[${new Date().toISOString()}] Sending response transaction for task ${taskIndex}`);
            const tx = await this.chainAnalyticaServiceManager.respondToTask({ name: taskName, taskCreatedBlock }, taskIndex, taskResponse);
            await tx.wait();
            console.log(`[${new Date().toISOString()}] Task ${taskIndex} completed successfully`);
        }
        catch (error) {
            console.error(`[${new Date().toISOString()}] Error handling task ${taskIndex}:`, error);
        }
    }
    startHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        this.heartbeatInterval = setInterval(() => {
            const ws = this.provider.websocket;
            console.log(`[${new Date().toISOString()}] Operator heartbeat - Status: Running, WebSocket Connected: ${ws.readyState === 1}`);
        }, 30000); // Log every 30 seconds
    }
    async start() {
        if (this.isRunning) {
            console.log('Operator is already running');
            return;
        }
        console.log(`[${new Date().toISOString()}] Starting AVS operator...`);
        // Set up WebSocket event listener
        this.chainAnalyticaServiceManager.on('NewTaskCreated', async (taskIndex, task) => {
            console.log(`[${new Date().toISOString()}] New task received: ${taskIndex}`);
            await this.handleTask(taskIndex, task.taskCreatedBlock, task.name);
        });
        // Set up WebSocket error handling and reconnection
        const ws = this.provider.websocket;
        ws.addEventListener('close', async () => {
            console.log(`[${new Date().toISOString()}] WebSocket connection closed. Attempting to reconnect...`);
            await this.reconnect();
        });
        this.provider.on('error', async (error) => {
            console.error(`[${new Date().toISOString()}] WebSocket error:`, error);
            await this.reconnect();
        });
        // Start heartbeat monitoring
        this.startHeartbeat();
        this.isRunning = true;
        console.log(`[${new Date().toISOString()}] AVS operator is running with WebSocket connection`);
        // Set up process handlers
        process.on('SIGINT', () => this.stop());
        process.on('SIGTERM', () => this.stop());
        process.on('uncaughtException', (error) => {
            console.error(`[${new Date().toISOString()}] Uncaught Exception:`, error);
            this.reconnect();
        });
        process.on('unhandledRejection', (error) => {
            console.error(`[${new Date().toISOString()}] Unhandled Rejection:`, error);
            this.reconnect();
        });
        // Keep the process running indefinitely
        return new Promise(() => {
            setInterval(() => {
                // Additional check to ensure we're still connected
                if (!this.isRunning || this.provider.websocket.readyState !== 1) {
                    console.log(`[${new Date().toISOString()}] Connection check failed, initiating reconnect...`);
                    this.reconnect();
                }
            }, 60000); // Check every minute
        });
    }
    async reconnect() {
        try {
            console.log(`[${new Date().toISOString()}] Attempting to reconnect... (Attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
            }
            await this.stop(false); // Don't exit process on reconnect
            this.provider = new ethers_1.ethers.WebSocketProvider(process.env.WS_RPC_URL);
            this.signer = new ethers_1.ethers.Wallet(process.env.PK_OPERATOR, this.provider);
            this.chainAnalyticaServiceManager = new ethers_1.ethers.Contract(this.chainAnalyticaServiceManagerAddress, ChainAnalyticaServiceManager_json_1.default, this.signer);
            await this.start();
            this.reconnectAttempts = 0; // Reset attempts on successful reconnect
            console.log(`[${new Date().toISOString()}] Reconnection successful`);
        }
        catch (error) {
            console.error(`[${new Date().toISOString()}] Failed to reconnect:`, error);
            this.reconnectAttempts++;
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                console.log(`[${new Date().toISOString()}] Retrying in ${this.reconnectDelay / 1000} seconds...`);
                setTimeout(() => this.reconnect(), this.reconnectDelay);
            }
            else {
                console.error(`[${new Date().toISOString()}] Max reconnection attempts reached. Please check your connection and restart the operator.`);
                process.exit(1);
            }
        }
    }
    async stop(shouldExit = true) {
        if (!this.isRunning) {
            console.log('Operator is not running');
            return;
        }
        console.log(`[${new Date().toISOString()}] Stopping AVS operator...`);
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        this.chainAnalyticaServiceManager.removeAllListeners();
        await this.provider.destroy();
        this.isRunning = false;
        console.log(`[${new Date().toISOString()}] AVS operator stopped`);
        if (shouldExit) {
            process.exit(0);
        }
    }
}
// Start the operator
async function main() {
    const operator = new AVSOperator();
    try {
        await operator.registerOperator(); // can fail if operator is already registered. TODO: handle this gracefully by checking if operator is already registered
    }
    catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to register operator:`, error);
    }
    try {
        await operator.start();
    }
    catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to start operator:`, error);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=index.js.map