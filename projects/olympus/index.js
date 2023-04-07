const sdk = require("@defillama/sdk");
const { toUSDTBalances } = require("../helper/balances");
const { blockQuery } = require("../helper/http");
const BigNumber = require("bignumber.js");

const OlympusStakings = [
  // Old Staking Contract
  "0x0822F3C03dcc24d200AFF33493Dc08d0e1f274A2",
  // New Staking Contract
  "0xFd31c7d00Ca47653c6Ce64Af53c1571f9C36566a",
];

const OHM = "0x383518188c0c6d7730d91b2c03a03c837814a899";

/** Map any staked assets without price feeds to those with price feeds.
 * All balances are 1: 1 to their unstaked counterpart that has the price feed.
 **/
const addressMap = {
  "0xc8418af6358ffdda74e09ca9cc3fe03ca6adc5b0":
    "0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0", // veFXS -> FXS
  "0x3fa73f1e5d8a792c80f426fc8f84fbf7ce9bbcac":
    "0xc0c293ce456ff0ed870add98a0828dd4d2903dbf", //vlAURA -> AURA
  "0x72a19342e8f1838460ebfccef09f6585e32db86e":
    "0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b", //vlCVX -> CVX
  "0xa02d8861fbfd0ba3d8ebafa447fe7680a3fa9a93":
    "0xd1ec5e215e8148d76f4460e4097fd3d5ae0a3558", //aura50OHM-50WETH -> 50OHM-50WETH
  "0x0ef97ef0e20f84e82ec2d79cbd9eda923c3daf09":
    "0xd4f79ca0ac83192693bce4699d0c10c66aa6cf0f", //auraOHM-wstETH -> OHM-wstETH
  "0x81b0dcda53482a2ea9eb496342dc787643323e95":
    "0x5271045f7b73c17825a7a7aee6917ee46b0b7520", //stkcvxOHMFRAXBP-f-frax -> OHMFRAXBP-f
  "0x8a53ee42fb458d4897e15cc7dea3f75d0f1c3475":
    "0x3175df0976dfa876431c2e9ee6bc45b65d3473cc", //stkcvxcrvFRAX-frax -> crvFRAX-frax
  "0xb0c22d8d350c67420f06f48936654f567c73e8c8":
    "0x4e78011ce80ee02d2c3e649fb657e45898257815", //sKLIMA -> KLIMA
};

/*** Staking of native token (OHM) TVL Portion ***/
const staking = async (timestamp, ethBlock, chainBlocks) => {
  const balances = {};

  for (const stakings of OlympusStakings) {
    const stakingBalance = await sdk.api.abi.call({
      abi: "erc20:balanceOf",
      target: OHM,
      params: stakings,
      block: ethBlock,
    });

    sdk.util.sumSingleBalance(balances, OHM, stakingBalance.output);
  }

  return balances;
};

const protocolQuery = (block) => `
  query {
    tokenRecords(orderDirection: desc, orderBy: block, where: {block: ${block}}) {
      block
      timestamp
      category
      tokenAddress
      balance
    }
  }
`;

const getLatestBlockIndexed = `
query {
  lastBlock: tokenRecords(first: 1, orderBy: block, orderDirection: desc) {
    block
    timestamp
  }
}`;

const subgraphUrls = {
  ethereum:
    "https://api.thegraph.com/subgraphs/name/olympusdao/olympus-protocol-metrics",
  arbitrum:
    "https://api.thegraph.com/subgraphs/name/olympusdao/protocol-metrics-arbitrum",
  fantom:
    "https://api.thegraph.com/subgraphs/name/olympusdao/protocol-metrics-fantom",
  polygon:
    "https://api.thegraph.com/subgraphs/name/olympusdao/protocol-metrics-polygon",
};

//Subgraph returns balances in tokenAddress / allocator pairs. Need to return based on balance.
function sumBalancesByTokenAddress(arr) {
  return arr.reduce((acc, curr) => {
    const found = acc.find((item) => item.tokenAddress === curr.tokenAddress);
    if (found) {
      found.balance = +found.balance + +curr.balance;
    } else {
      const newItem = {
        tokenAddress: curr.tokenAddress,
        balance: curr.balance,
        category: curr.category,
      };
      acc.push(newItem);
    }
    return acc;
  }, []);
}

/*** Query Subgraphs for latest Treasury Allocations  ***
 * #1. Query tokenRecords for latestBlock indexed in subgraph.
 *     This allows us to filter protocol query to a list of results only for the latest block indexed
 * #2. Call tokenRecords with block num from prev query
 * #3. Sum values returned
 ***/
async function tvl(timestamp, block, _, { api }, poolsOnly = false) {
  const indexedBlockForEndpoint = await blockQuery(
    subgraphUrls[api.chain],
    getLatestBlockIndexed,
    { api }
  );
  const blockNum = indexedBlockForEndpoint.lastBlock[0].block;
  const { tokenRecords } = await blockQuery(
    subgraphUrls[api.chain],
    protocolQuery(blockNum),
    { api }
  );

  const aDay = 24 * 3600;
  const now = Date.now() / 1e3;
  if (now - blockNum[0].timestamp > 3 * aDay) {
    throw new Error("outdated");
  }
  const filteredTokenRecords = poolsOnly
    ? tokenRecords.filter((t) => t.category === "Protocol-Owned Liquidity")
    : tokenRecords;

  /**
   * iterates over filtered list from subgraph and returns any addresses
   * that need to be normalized for pricing .
   * See addressMap above
   **/
  const normalizedFilteredTokenRecords = filteredTokenRecords.map((token) => {
    const normalizedAddress = addressMap[token.tokenAddress]
      ? addressMap[token.tokenAddress]
      : token.tokenAddress;
    return { ...token, tokenAddress: normalizedAddress };
  });

  const tokensToBalances = sumBalancesByTokenAddress(
    normalizedFilteredTokenRecords
  );
  const balances = await Promise.all(
    tokensToBalances.map(async (token, index) => {
      const decimals = await sdk.api.abi.call({
        abi: "erc20:decimals",
        target: token.tokenAddress,
        chain: api.chain,
      });
      return [
        `${api.chain}:${token.tokenAddress}`,
        Number(
          BigNumber(token.balance)
            .times(10 ** decimals.output)
            .toFixed(0)
        ),
      ];
    })
  );
  return Object.fromEntries(balances);
}

async function pool2(timestamp, block, _, { api }) {
  return tvl(timestamp, block, _, { api }, true);
}

module.exports = {
  start: 1616569200, // March 24th, 2021
  timetravel: false,
  misrepresentedTokens: true,
  ethereum: {
    tvl: tvl,
    staking,
    pool2,
  },
  arbitrum: {
    tvl: tvl,
    pool2,
  },
  polygon: {
    tvl: tvl,
    pool2,
  },
  fantom: {
    tvl: tvl,
    pool2,
  },
};
