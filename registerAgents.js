import nacl from 'tweetnacl';
import bs58 from 'bs58';
import fetch from 'node-fetch';

const API_KEY = 'Zoroluffy444!';
const REGISTRY_URL = 'https://api.nooterra.ai';

const agents = [
  {
    did: 'did:noot:echo',
    endpoint: 'https://agent-echo-production.up.railway.app',
    capabilities: [
      { id: 'cap.test.echo', description: 'Echo stub' },
    ],
  },
  {
    did: 'did:noot:weather',
    endpoint: 'https://agent-weather-production.up.railway.app',
    capabilities: [
      { id: 'cap.weather.noaa.v1', description: 'Weather risk stub' },
    ],
  },
  {
    did: 'did:noot:customs',
    endpoint: 'https://agent-customs-production.up.railway.app',
    capabilities: [
      { id: 'cap.customs.classify.v1', description: 'Customs classification stub' },
    ],
  },
  {
    did: 'did:noot:rail',
    endpoint: 'https://agent-rail-production.up.railway.app',
    capabilities: [
      { id: 'cap.rail.optimize.v1', description: 'Rail optimization stub' },
    ],
  },
];

const keyMap = {
  'did:noot:echo': {
    publicKey: '66vrC6dKQqCaoQd2HFfChe7aXVCP4tfccNAUKeguTxj',
    privateKey: '5v1bD2JbmPtAVTx1FszELs316EG5nnEwTu153Yb9SuKdGswaRdn6qYM9VuB2yDibei2yzZfmxB8AWdVo6jbKnHwM',
  },
  'did:noot:weather': {
    publicKey: 'C39bYWzuCZZayomvbvqxrCymeidxG8b3wyFfhBvBUo3H',
    privateKey: '4xKLRWV2UREJNYjuNpNf9YtBETpTd64DLNY1PtPBb33o4imfCYXoETqLYod5AhDA8Nh2U2Shmn38GPRHM9m7fpqh',
  },
  'did:noot:customs': {
    publicKey: '3VQG3CsjaG8sC8yC6xT1CR6tjvAFwgyKzyqHj9HbEP3S',
    privateKey: '2JhzkDgECCq6hdcqjQFobcdgaNnbK8upAgZ2MH29QmXUk8sjNahy4AVHDXZpjV9HMgXYzt6ANmVh8DRnJHQg5Nbv',
  },
  'did:noot:rail': {
    publicKey: 'FsYxHH1TF6jf6fZrpXymi7b1KxXsm9ZrdxWXppqUozDE',
    privateKey: '2UFQUyDhMYzaxSwyxWxbfaXAskCfHdpSXCqYbsgLinjHaN7Cm1USwhXrwHDroq6ZX7F3PoJqLQkaJuyvfNrxxSeU',
  },
};

function canonicalize(card) {
  const ordered = {
    did: card.did,
    endpoint: card.endpoint.endsWith('/') ? card.endpoint.slice(0, -1) : card.endpoint,
    publicKey: card.publicKey,
    version: card.version,
    lineage: card.lineage ?? null,
    capabilities: card.capabilities.map((c) => ({
      id: c.id,
      description: c.description,
      inputSchema: c.inputSchema ?? null,
      outputSchema: c.outputSchema ?? null,
      embeddingDim: c.embeddingDim ?? null,
    })),
    metadata: card.metadata ?? null,
  };
  return JSON.stringify(ordered);
}

function signACARD(card, secretKey) {
  const payload = new TextEncoder().encode(canonicalize(card));
  const sig = nacl.sign.detached(payload, secretKey);
  return bs58.encode(sig);
}

async function register(agent) {
  const keys = keyMap[agent.did];
  const endpointNormalized = agent.endpoint.endsWith('/') ? agent.endpoint.slice(0, -1) : agent.endpoint;
  const card = {
    did: agent.did,
    endpoint: endpointNormalized,
    publicKey: keys.publicKey,
    version: 1,
    lineage: null,
    capabilities: agent.capabilities,
    metadata: {},
  };
  const signature = signACARD(card, bs58.decode(keys.privateKey));

  const payload = {
    did: agent.did,
    name: agent.did,
    endpoint: endpointNormalized,
    capabilities: agent.capabilities.map((c) => ({
      capability_id: c.id,
      description: c.description,
    })),
    acard: card,
    acard_signature: signature,
  };

  const res = await fetch(`${REGISTRY_URL}/v1/agent/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error('REGISTER FAILED', agent.did, res.status, text);
  } else {
    console.log('REGISTERED', agent.did, '->', text.trim());
  }
}

for (const a of agents) {
  await register(a);
}
