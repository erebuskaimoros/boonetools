export const TREASURY_SECTIONS = Object.freeze([
  Object.freeze({
    key: 'original',
    title: 'Original',
    description: 'Live treasury module holdings carried over from the earlier treasury setup.',
    addresses: Object.freeze([
      Object.freeze({
        address: 'thor1vmafl8f3s6uuzwnxkqz0eza47v6ecn0t086r2p',
        addressSource: 'treasury-module',
        label: 'Treasury Module (locked)',
        chain: 'THOR',
        showLpSection: true
      })
    ])
  }),
  Object.freeze({
    key: 'active',
    title: 'Active',
    description: 'Current treasury addresses across THORChain and active external chains.',
    addresses: Object.freeze([
      Object.freeze({
        address: '0x02d9e8506ba56d3f9be6007f712720eeadac5fdc',
        label: 'New ETH Treasury',
        chain: 'ETH',
        includeTokenBalances: true,
        includeEvmChainBalances: Object.freeze(['BSC', 'AVAX', 'BASE'])
      }),
      Object.freeze({
        address: 'bc1qpqwd0wf8egke8f28twlt4hv2ergcr4v86djxek',
        label: 'BTC Treasury Active',
        chain: 'BTC'
      }),
      Object.freeze({
        address: 'BEcrPLugbAY1zEJGUNYgzcsxMi72rPeVwG6qKm96LK5g',
        label: 'SOL Treasury Active',
        chain: 'SOL'
      }),
      Object.freeze({
        address: 'thor10qh5272ktq4wes8ex343ky9rsuehcypddjh08k',
        label: 'Treasury Vultisig',
        chain: 'THOR',
        compactBondLayout: true
      }),
      Object.freeze({
        address: 'thor19phfqh3ce3nnjhh0cssn433nydq9shx7wfmk7k',
        label: 'Treasury Test',
        chain: 'THOR'
      }),
      Object.freeze({
        address: 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g',
        label: 'Treasury Vultisig 2',
        chain: 'THOR'
      }),
      Object.freeze({
        address: 'TJ8LE5jBifN2CQmgE5TLiLZGFGVNny1dHT',
        label: 'Tron Treasury Active',
        chain: 'TRON'
      })
    ])
  })
]);

export const NATIVE_ASSET_BY_CHAIN = Object.freeze({
  AVAX: 'AVAX.AVAX',
  BASE: 'BASE.ETH',
  BSC: 'BSC.BNB',
  BTC: 'BTC.BTC',
  ETH: 'ETH.ETH',
  SOL: 'SOL.SOL',
  THOR: 'THOR.RUNE',
  TRON: 'TRON.TRX'
});

export const DECIMALS_BY_CHAIN = Object.freeze({
  AVAX: 18,
  BASE: 18,
  BSC: 18,
  BTC: 8,
  ETH: 18,
  SOL: 9,
  THOR: 8,
  TRON: 6
});

export function resolveTreasurySections(treasuryModule, sections = TREASURY_SECTIONS) {
  return sections.map((section) => ({
    ...section,
    addresses: section.addresses.map((entry) => entry.addressSource === 'treasury-module'
      ? {
          ...entry,
          address: treasuryModule?.address || entry.address,
          moduleBalances: Array.isArray(treasuryModule?.coins) ? treasuryModule.coins : []
        }
      : { ...entry })
  }));
}

export function getThorTreasuryAddresses(sections = TREASURY_SECTIONS) {
  return sections.flatMap((section) =>
    section.addresses
      .filter((entry) => entry.chain === 'THOR' && entry.address)
      .map((entry) => entry.address)
  );
}
