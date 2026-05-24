#!/usr/bin/env node
/**
 * Luo Six Formations (六阵) Stop Hook
 * Monitors luo skill output — if the response lacks 六阵 emojis,
 * prints a systemMessage reminding the model to follow the six formations.
 *
 * Reads hook input JSON from stdin (contains transcript_path, session_id, etc.).
 */

const fs = require('fs');
const readline = require('readline');

// ── Six Formations emojis ──────────────────────────────────────────────
// 1. 勘察敌情: 🐎🕊️✉️
// 2. 圈定战场: ⛓️🧶🕳️
// 3. 推演因果: ☯️🧮📜
// 4. 披甲出战: ⚔️🏹🛡️
// 5. 战后清点: 🏆🐉✍️
// 6. 败阵善后: 💥🔥🌊
const LIU_ZHEN_EMOJIS = /🐎|🕊️|⛓️|🧶|🕳️|☯️|🧮|📜|⚔️|🏹|🛡️|🏆|🐉|✍️|💥|🔥|🌊/u;

// ── Read all stdin ─────────────────────────────────────────────────────
async function readStdin() {
  let data = '';
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    data += line + '\n';
  }
  return data.trim();
}

// ── Parse transcript JSONL ─────────────────────────────────────────────
function parseTranscript(path) {
  if (!fs.existsSync(path)) return [];
  const raw = fs.readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  return lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ── Main ───────────────────────────────────────────────────────────────
(async () => {
  const raw = await readStdin();
  if (!raw) { process.exit(0); }

  let hookInput;
  try { hookInput = JSON.parse(raw); } catch { process.exit(0); }

  const transcriptPath = hookInput.transcript_path;
  if (!transcriptPath) { process.exit(0); }

  const messages = parseTranscript(transcriptPath);
  if (messages.length === 0) { process.exit(0); }

  // Check if luo skill was invoked in the last 50 assistant messages
  const recentAssistant = messages.filter((m) => m.role === 'assistant').slice(-50);
  const luoUsed = recentAssistant.some((msg) => {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some((block) =>
      block.type === 'tool_use' &&
      block.name === 'Skill' &&
      block.input?.skill === 'luo'
    );
  });

  if (!luoUsed) { process.exit(0); }

  // Collect all assistant text blocks from the last 100 assistant messages
  const lastAssistant = messages.filter((m) => m.role === 'assistant').slice(-100);
  const textBlocks = lastAssistant.flatMap((msg) => {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    return content.filter((b) => b.type === 'text').map((b) => b.text);
  });

  const lastOutput = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1] : '';

  // Check for any 六阵 emoji
  if (LIU_ZHEN_EMOJIS.test(lastOutput)) { process.exit(0); }

  // Missing — output systemMessage
  const msg = '⚠️ 军师令：六阵未循！凡遇bug，必过六阵，不得跳步！\n   🐎🕊️✉️ 勘察敌情 | ⛓️🧶🕳️ 圈定战场 | ☯️🧮📜 推演因果\n   ⚔️🏹🛡️ 披甲出战 | 🏆🐉✍️ 战后清点 | 💥🔥🌊 败阵善后';

  process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
  process.exit(0);
})();
