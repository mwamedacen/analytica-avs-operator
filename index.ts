import { ethers } from 'ethers';
import { EigenDAClient } from 'eigenda-sdk';
import * as dotenv from 'dotenv';

// Import ABIs and addresses
import * as avsDeployment from './eigen-contracts/deployments/chain-analytica/17000.json';
import * as coreDeployment from './eigen-contracts/deployments/core/17000.json';
import chainAnalyticaServiceManagerABI from './eigen-contracts/abis/ChainAnalyticaServiceManager.json';
//import delegationManagerABI from './eigen-contracts/abis/IDelegationManager.json';
import stakeRegistryABI from './eigen-contracts/abis/ECDSAStakeRegistry.json';
import avsDirectoryABI from './eigen-contracts/abis/IAVSDirectory.json';

// Load environment variables
dotenv.config();

if (!process.env.WS_RPC_URL || !process.env.PK_OPERATOR || !process.env.PK_EIGENDA || !process.env.API_CHAIN_ANALYTICA_HTTP) {
  throw new Error('Missing required environment variables');
}

interface TaskResponse {
  agentStatus: string;
  response: string;
}

class AVSOperator {
  private provider: ethers.WebSocketProvider;
  private signer: ethers.Wallet;
  private eigenDAClient: EigenDAClient;
  private identifier: Uint8Array;
  private chainAnalyticaServiceManagerAddress: string;
  private chainAnalyticaServiceManager: ethers.Contract;
  private avsDirectory: ethers.Contract;
  private ecdsaRegistryContract: ethers.Contract;
  private isRunning: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    console.log('Initializing AVS Operator...');
    // Initialize WebSocket provider and signer
    this.provider = new ethers.WebSocketProvider(process.env.WS_RPC_URL!);
    this.signer = new ethers.Wallet(process.env.PK_OPERATOR!, this.provider);

    this.eigenDAClient = new EigenDAClient({
      privateKey: process.env.PK_EIGENDA
    });

    this.identifier = new Uint8Array(Array(31).fill(0).concat([9]));
    this.chainAnalyticaServiceManagerAddress = avsDeployment.addresses.chainAnalyticaServiceManager;
    
    // Initialize contracts
    this.chainAnalyticaServiceManager = new ethers.Contract(
      this.chainAnalyticaServiceManagerAddress,
      chainAnalyticaServiceManagerABI,
      this.signer
    );

    // Initialize AVS directory contract 
    this.avsDirectory = new ethers.Contract(
      coreDeployment.addresses.avsDirectory,
      avsDirectoryABI,
      this.signer
    );

    // Initialize ECDSA registry contract
    this.ecdsaRegistryContract = new ethers.Contract(
      avsDeployment.addresses.stakeRegistry,
      stakeRegistryABI, 
      this.signer
    );
    console.log('AVS Operator initialized successfully');
  }

  async registerOperator() {
    console.log('Starting operator registration process...');
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const expiry = Math.floor(Date.now() / 1000) + (3 * 24 * 3600); // 3 days in seconds

    let operatorSignatureWithSaltAndExpiry = {
        signature: "",
        salt: salt,
        expiry: expiry
    };

    const operatorDigestHash = await this.avsDirectory.calculateOperatorAVSRegistrationDigestHash(
        this.signer.address, 
        await this.chainAnalyticaServiceManager.getAddress(), 
        salt, 
        expiry
    );
    console.log('Generated operator digest hash:', operatorDigestHash);
    
    console.log("Signing digest hash with operator's private key");
    const operatorSigningKey = new ethers.SigningKey(process.env.PK_OPERATOR!);
    const operatorSignedDigestHash = operatorSigningKey.sign(operatorDigestHash);

    operatorSignatureWithSaltAndExpiry.signature = ethers.Signature.from(operatorSignedDigestHash).serialized;

    console.log("Registering Operator to AVS Registry contract");
    
    const tx2 = await this.ecdsaRegistryContract.registerOperatorWithSignature(
        operatorSignatureWithSaltAndExpiry,
        this.signer.address
    );
    await tx2.wait();
    console.log("Operator registered on AVS successfully");
}

  private async handleTask(taskIndex: number, taskCreatedBlock: number, taskName: string) {
    try {
      console.log(`[${new Date().toISOString()}] Processing task ${taskIndex}: ${taskName}`);

      const response = await fetch(process.env.API_CHAIN_ANALYTICA_HTTP!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: taskName, network: '' })
      });

      if (!response.ok) {
        throw new Error(`API call failed: ${response.statusText}`);
      }

      const responseData = await response.json() as TaskResponse;
      console.log(`[${new Date().toISOString()}] API Response received for task ${taskIndex}`);
      
      const parsedJson = JSON.parse(responseData.response.replace(/```json\n|\n```/g, ''));

      console.log(`[${new Date().toISOString()}] Uploading to EigenDA for task ${taskIndex}`);
      const uploadResult = await this.eigenDAClient.upload(
        JSON.stringify(parsedJson),
        this.identifier
      ) as unknown as { job_id: string };

      console.log(`[${new Date().toISOString()}] Upload Job ID for task ${taskIndex}:`, uploadResult.job_id);

      const taskResponse = `${uploadResult.job_id}:${parsedJson.message}`;

      console.log(`[${new Date().toISOString()}] Sending response transaction for task ${taskIndex}`);
      const tx = await this.chainAnalyticaServiceManager.respondToTask(
        { name: taskName, taskCreatedBlock },
        taskIndex,
        taskResponse
      );
      await tx.wait();

      console.log(`[${new Date().toISOString()}] Task ${taskIndex} completed successfully`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error handling task ${taskIndex}:`, error);
    }
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => {
      const ws = this.provider.websocket as WebSocket;
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
    this.chainAnalyticaServiceManager.on('NewTaskCreated', async (taskIndex: number, task: { taskCreatedBlock: number, name: string }) => {
      console.log(`[${new Date().toISOString()}] New task received: ${taskIndex}`);
      await this.handleTask(taskIndex, task.taskCreatedBlock, task.name);
    });

    // Set up WebSocket error handling and reconnection
    const ws = this.provider.websocket as WebSocket;
    ws.addEventListener('close', async () => {
      console.log(`[${new Date().toISOString()}] WebSocket connection closed. Attempting to reconnect...`);
      await this.reconnect();
    });

    this.provider.on('error', async (error: Error) => {
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

  private async reconnect() {
    try {
      console.log(`[${new Date().toISOString()}] Attempting to reconnect... (Attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
      
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
      }
      
      await this.stop(false); // Don't exit process on reconnect
      
      this.provider = new ethers.WebSocketProvider(process.env.WS_RPC_URL!);
      this.signer = new ethers.Wallet(process.env.PK_OPERATOR!, this.provider);
      this.chainAnalyticaServiceManager = new ethers.Contract(
        this.chainAnalyticaServiceManagerAddress,
        chainAnalyticaServiceManagerABI,
        this.signer
      );
      
      await this.start();
      this.reconnectAttempts = 0; // Reset attempts on successful reconnect
      console.log(`[${new Date().toISOString()}] Reconnection successful`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Failed to reconnect:`, error);
      this.reconnectAttempts++;
      
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        console.log(`[${new Date().toISOString()}] Retrying in ${this.reconnectDelay/1000} seconds...`);
        setTimeout(() => this.reconnect(), this.reconnectDelay);
      } else {
        console.error(`[${new Date().toISOString()}] Max reconnection attempts reached. Please check your connection and restart the operator.`);
        process.exit(1);
      }
    }
  }

  async stop(shouldExit: boolean = true) {
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
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Failed to register operator:`, error);
  }
  try {
    await operator.start();
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Failed to start operator:`, error);
    process.exit(1);
  }
}

main();
