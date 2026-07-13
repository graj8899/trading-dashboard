// Symbol config table — backend `config.js`. Grouping ladders are derived:
// start at 1 tick, scale x5/x10, cap well below the symbol's price range.
export const SYMBOL_CONFIG = {
  BTCUSD: {
    range: [60000, 65000],
    precision: 1,
    groupingLadder: [1, 5, 10, 50, 100, 500],
  },
  ETHUSD: {
    range: [1500, 2000],
    precision: 2,
    groupingLadder: [0.5, 1, 5, 10, 50],
  },
  XRPUSD: {
    range: [1.0, 2.0],
    precision: 4,
    groupingLadder: [0.0001, 0.001, 0.01, 0.1],
  },
  SOLUSD: {
    range: [70, 80],
    precision: 4,
    groupingLadder: [0.0001, 0.001, 0.01, 0.1, 0.5],
  },
  PAXGUSD: {
    range: [5000, 5500],
    precision: 2,
    groupingLadder: [0.5, 1, 5, 10, 50],
  },
  DOGEUSD: {
    range: [0, 0.1],
    precision: 6,
    groupingLadder: [0.000001, 0.00001, 0.0001, 0.001],
  },
} as const;

export type Symbol = keyof typeof SYMBOL_CONFIG;

export const SYMBOLS = Object.keys(SYMBOL_CONFIG) as Symbol[];
