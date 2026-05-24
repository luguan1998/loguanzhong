#!/usr/bin/env node
/**
 * Luo Six Formations (六阵) Stop Hook
 * Monitors luo skill output — if the response lacks 六阵 markers (emoji or text),
 * prints a systemMessage reminding the model to follow the six formations.
 *
 * Reads hook input JSON from stdin (contains transcript_path, session_id, etc.).
 */

const fs = require('fs');
const readline = require('readline');

// ── Normalize emojis: strip variation selectors ─────────────────────
function normalize(text) {
  return text.replace(/\uFE0F/g, '').replace(/\uFE0E/g, '');
}

// ── Six Formations definition ───────────────────────────────────────
// Each formation has: text name patterns + primary emojis + alternative emojis
// Primary emojis are stored WITHOUT variation selectors (FE0F stripped)
const LIU_ZHEN = [
  {
    // 1. 勘察敌情 🐎🕊️✉️
    text: /勘察敌情|侦察敌情|勘测敌情|察勘敌情/,
    emojis: ['🐎', '🕊', '✉'],
    alt:   ['🔍', '👀', '🔎', '🐴', '🏇', '📨', '📧', '📩', '🕵', '🔭'],
  },
  {
    // 2. 圈定战场 ⛓️🧶🕳️
    text: /圈定战场|划定战场|锁定战场|定位战场/,
    emojis: ['⛓', '🧶', '🕳'],
    alt:   ['📍', '🎯', '🔗', '⛓', '💢', '🪤', '🕳', '🔘', '🪢'],
  },
  {
    // 3. 推演因果 ☯️🧮📜
    text: /推演因果|推演根[由因源]|推断因果|因果推演/,
    emojis: ['☯', '🧮', '📜'],
    alt:   ['🤔', '💭', '🔮', '📊', '🧠', '📋', '📝', '🗺', '⚖'],
  },
  {
    // 4. 披甲出战 ⚔️🏹🛡️
    text: /披甲出战|披甲上阵|提枪出战|拔刀出战/,
    emojis: ['⚔', '🏹', '🛡'],
    alt:   ['🔧', '🛠', '💻', '✏', '🖊', '🔨', '💡', '🗡', '⚒'],
  },
  {
    // 5. 战后清点 🏆🐉✍️ (optional but nice to have)
    text: /战后清点|战后盘点|鸣金清点|清点战[场果]/,
    emojis: ['🏆', '🐉', '✍'],
    alt:   ['✅', '✔', '🧪', '📄', '📃', '📝', '✏', '🏅'],
  },
  {
    // 6. 败阵善后 💥🔥🌊 (optional but nice to have)
    text: /败阵善后|善后之策|败[局阵]善后|善后处理/,
    emojis: ['💥', '🔥', '🌊'],
    alt:   ['🚨', '⚠', '📊', '🔔', '📡', '📋', '🪵', '📓'],
  },
];

// ── Build combined regexes ──────────────────────────────────────────
function buildZhenRegex(zhen) {
  const allEmojis = [...zhen.emojis, ...zhen.alt];
  // Escape emojis for regex (most emojis are multi-codepoint but safe in [] sets)
  const emojiSet = allEmojis.join('');
  // Match: text pattern OR any primary emoji OR any alt emoji
  // Use a character class for emojis where possible, but since emojis are multi-codepoint,
  // we use alternation
  const emojiAlts = allEmojis.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`${zhen.text.source}|${emojiAlts}`, 'u');
}

const ZHEN_REGEXES = LIU_ZHEN.map(buildZhenRegex);

// ── Read all stdin ──────────────────────────────────────────────────
async function readStdin() {
  let data = '';
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    data += line + '\n';
  }
  return data.trim();
}

// ── Parse transcript JSONL ──────────────────────────────────────────
function parseTranscript(path) {
  if (!fs.existsSync(path)) return [];
  const raw = fs.readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  return lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ── Main ────────────────────────────────────────────────────────────
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

  // Check if context involves a bug / error (六阵 only required for bugs)
  const userMessages = messages.filter((m) => m.role === 'user');
  const recentUserText = userMessages.slice(-10).flatMap((msg) => {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    return content.filter((b) => b.type === 'text').map((b) => b.text);
  }).join(' ');

  const bugKeywords = /bug|报错|错误|异常|崩溃|crash|error|exception|故障|不工作|坏了|出错|不对|修复|修[复改]|debug|trace|stack|堆栈/iu;
  const isBugContext = bugKeywords.test(recentUserText);

  // Collect ALL assistant text blocks from luo-invoked session (not just last)
  const assistantMessages = messages.filter((m) => m.role === 'assistant').slice(-100);
  const allText = assistantMessages.flatMap((msg) => {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    return content.filter((b) => b.type === 'text').map((b) => b.text);
  }).join('\n');

  const normalizedText = normalize(allText);

  // Count how many formations are present
  const presentZhen = [];
  const missingZhen = [];
  for (let i = 0; i < ZHEN_REGEXES.length; i++) {
    if (ZHEN_REGEXES[i].test(normalizedText)) {
      presentZhen.push(i + 1);
    } else {
      missingZhen.push(i + 1);
    }
  }

  // For non-bug contexts, only require at least 2 formations (casual use)
  // For bug contexts, require at least 4 of 6 (1-4 are core, 5-6 optional)
  const minRequired = isBugContext ? 4 : 2;

  if (presentZhen.length >= minRequired) { process.exit(0); }

  // Missing too many — output systemMessage
  const zhenNames = [
    '🐎 勘察敌情',
    '⛓ 圈定战场',
    '☯ 推演因果',
    '⚔ 披甲出战',
    '🏆 战后清点',
    '💥 败阵善后',
  ];
  const missingNames = missingZhen.map((i) => zhenNames[i - 1]).join(' | ');

  const msg = isBugContext
    ? `⚠️ 军师令：六阵未全！遇 bug 须过六阵（至少4阵），缺：${missingNames}\n   可用文字（如"勘察敌情"）或 emoji 标记各阵。`
    : `💡 军师提醒：罗贯中模式下，遣词造句不妨点缀六阵文字或 emoji，以壮声色。`;

  process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
  process.exit(0);
})();
