import DEFAULT_TOKEN_LIST from '@uniswap/default-token-list'
import { Token } from '@uniswap/sdk-core'
import {
  AlphaRouterParams,
  CachingGasStationProvider,
  CachingPoolProvider,
  CachingTokenListProvider,
  CachingTokenProviderWithFallback,
  ChainId,
  EIP1559GasPriceProvider,
  GasPrice,
  HeuristicGasModelFactory,
  ID_TO_CHAIN_ID,
  IMetric,
  MetricLoggerUnit,
  PoolProvider,
  QuoteProvider,
  setGlobalMetric,
  TokenProvider,
  UniswapMulticallProvider,
  URISubgraphProvider,
} from '@uniswap/smart-order-router'
import { TokenList } from '@uniswap/token-lists'
import { Pool } from '@uniswap/v3-sdk'
import { timing } from 'components/analytics'
import { NETWORK_URLS } from 'connectors/networkUrls'
import UNSUPPORTED_TOKEN_LIST from 'constants/tokenLists/unsupported.tokenlist.json'
import { providers } from 'ethers/lib/ethers'
import ms from 'ms.macro'
import { MemoryCache } from 'utils/memoryCache'

import { SUPPORTED_CHAINS } from './constants'

class GAMetric extends IMetric {
  putDimensions() {
    return
  }

  putMetric(key: string, value: number, unit?: MetricLoggerUnit) {
    timing({
      category: 'Routing API',
      variable: `${key} | ${unit}`,
      value,
      label: 'client',
    })
  }
}
setGlobalMetric(new GAMetric())

export type Dependencies = { [chainId in ChainId]?: AlphaRouterParams }

// loosely inspired by https://github.com/Uniswap/routing-api/blob/main/lib/handlers/quote/injector.ts#L204-L286
export function buildDependencies(): Dependencies {
  const dependenciesByChain: Dependencies = {}
  for (const chainId of SUPPORTED_CHAINS) {
    const provider = new providers.JsonRpcProvider(NETWORK_URLS[chainId])

    const tokenCache = new MemoryCache<Token>()
    const blockedTokenCache = new MemoryCache<Token>()

    const tokenListProvider = new CachingTokenListProvider(chainId, DEFAULT_TOKEN_LIST, new MemoryCache<Token>())
    const multicall2Provider = new UniswapMulticallProvider(chainId, provider, 375_000)
    const tokenProvider = new CachingTokenProviderWithFallback(
      chainId,
      tokenCache,
      tokenListProvider,
      new TokenProvider(chainId, multicall2Provider)
    )

    // Some providers like Infura set a gas limit per call of 10x block gas which is approx 150m
    // 200*725k < 150m
    const quoteProvider = new QuoteProvider(
      chainId,
      provider,
      multicall2Provider,
      {
        retries: 2,
        minTimeout: 100,
        maxTimeout: 1000,
      },
      {
        multicallChunk: 210, // 210
        gasLimitPerCall: 705_000, // 705
        quoteMinSuccessRate: 0.15,
      },
      {
        gasLimitOverride: 2_000_000,
        multicallChunk: 70,
      }
    )

    dependenciesByChain[chainId] = {
      chainId,
      provider,
      blockedTokenListProvider: new CachingTokenListProvider(
        chainId,
        UNSUPPORTED_TOKEN_LIST as TokenList,
        blockedTokenCache
      ),
      multicall2Provider,
      poolProvider: new CachingPoolProvider(
        chainId,
        new PoolProvider(ID_TO_CHAIN_ID(chainId), multicall2Provider),
        new MemoryCache<Pool>()
      ),
      tokenProvider,
      subgraphProvider: new URISubgraphProvider(
        chainId,
        'https://ipfs.io/ipfs/QmfArMYESGVJpPALh4eQXnjF8HProSF1ky3v8RmuYLJZT4'
      ),
      quoteProvider,
      gasPriceProvider: new CachingGasStationProvider(
        chainId,
        new EIP1559GasPriceProvider(provider),
        new MemoryCache<GasPrice>(ms`15s`)
      ),
      gasModelFactory: new HeuristicGasModelFactory(),
    }
  }

  return dependenciesByChain
}
