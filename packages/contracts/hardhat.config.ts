import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem';
import { defineConfig } from 'hardhat/config';

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: '0.8.28',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      production: {
        version: '0.8.28',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    localhost: {
      type: 'http',
      url: 'http://127.0.0.1:8545',
    },
    baseSepolia: {
      type: 'http',
      chainType: 'op',
      url: process.env.CHAIN_RPC_URL || 'https://sepolia.base.org',
      accounts: process.env.RELAYER_PRIVATE_KEY
        ? [process.env.RELAYER_PRIVATE_KEY]
        : [],
    },
  },
});
