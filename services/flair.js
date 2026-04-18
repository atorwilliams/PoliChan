'use strict';

const { ethers } = require('ethers');
const FlairRule  = require('../models/FlairRule');
const config     = require('../config');

// Minimal ABIs
const ERC20_ABI      = ['function balanceOf(address) view returns (uint256)'];
const ERC721_ABI     = ['function balanceOf(address) view returns (uint256)'];
const ERC1155_ABI    = ['function balanceOf(address account, uint256 id) view returns (uint256)'];
const POLIPASS_ABI   = ['function getTier(address wallet) view returns (uint8)'];

function getProvider(chainId) {
  const rpc = config.rpc?.[chainId];
  if (!rpc) throw new Error(`No RPC configured for chainId ${chainId}`);
  return new ethers.JsonRpcProvider(rpc);
}

const POLITICIAN_SBT_ABI = ['function getValidLabel(address) view returns (string)'];

async function checkRule(rule, address) {
  if (rule.matchType === 'manual') {
    return rule.wallets.includes(address.toLowerCase());
  }

  try {
    const provider = getProvider(rule.chainId);

    if (rule.matchType === 'politician_sbt') {
      const contract = new ethers.Contract(rule.tokenAddress, POLITICIAN_SBT_ABI, provider);
      const label = await contract.getValidLabel(address);
      // Return the label string itself so the caller can use it directly
      return label && label.trim() ? label.trim() : false;
    }

    const min = BigInt(rule.minBalance || '1');

    if (rule.matchType === 'polipass') {
      const contract = new ethers.Contract(rule.tokenAddress, POLIPASS_ABI, provider);
      const tier = await contract.getTier(address);
      return Number(tier) >= Number(rule.minBalance || '1') ? Number(tier) : false;
    }

    if (rule.matchType === 'erc20' || rule.matchType === 'erc721') {
      const abi  = rule.matchType === 'erc20' ? ERC20_ABI : ERC721_ABI;
      const contract = new ethers.Contract(rule.tokenAddress, abi, provider);
      const bal = await contract.balanceOf(address);
      return bal >= min;
    }

    if (rule.matchType === 'erc1155') {
      const contract = new ethers.Contract(rule.tokenAddress, ERC1155_ABI, provider);
      const bal = await contract.balanceOf(address, BigInt(rule.tokenId || '0'));
      return bal >= min;
    }
  } catch (e) {
    console.error(`[flair] checkRule failed (${rule.matchType} / ${rule.name}):`, e.message);
    return false;
  }

  return false;
}

/**
 * Returns the highest-priority matching flair for a wallet address,
 * or null if no rules match.
 */
// Tiebreaker when two rules share the same priority number.
// Higher rank = wins.
const TYPE_RANK = {
  politician_sbt: 50,
  polipass:       45,
  erc721:         40,
  erc1155:        30,
  erc20:          20,
  manual:         10
};

async function getFlairForWallet(address) {
  console.log(`[flair] getFlairForWallet called for ${address}`);
  if (!address) return null;

  const rules = await FlairRule.find({ isActive: true }).lean();
  console.log(`[flair] ${rules.length} active rules found`);
  if (!rules.length) return null;

  // Sort: primary key = priority (desc), tiebreaker = TYPE_RANK (desc)
  rules.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return (TYPE_RANK[b.matchType] ?? 0) - (TYPE_RANK[a.matchType] ?? 0);
  });

  for (const rule of rules) {
    const result = await checkRule(rule, address);
    if (result) {
      return {
        label:        rule.matchType === 'politician_sbt' ? result : rule.label,
        color:        rule.color,
        bgColor:      rule.bgColor,
        poliPassTier: rule.matchType === 'polipass' ? result : 0
      };
    }
  }

  return null;
}

module.exports = { getFlairForWallet };
