import type { Db } from '../db/db.js';
import { getAgent, getLeader, listSessionAgents } from './store.js';
import type { Agent } from './types.js';

/**
 * The stable half of room awareness: who else is here.
 *
 * Injected into the cacheable system context (04-context-memory §2.1), unlike
 * the timeline projection, which changes every turn. It exists because "知道
 * 该找谁" is half of what a room is for: without it an agent answers alone
 * instead of suggesting the reviewer.
 *
 * Only `summary` is exposed — never `readOnly`, the runtime id, or any other
 * mechanism. The roster describes what a colleague can do, not how it is
 * wired (02-agent A §5).
 */

export interface RoomSystemInput {
  sessionId: string;
  selfAgentId: string;
}

export function buildRoomSystem(db: Db, input: RoomSystemInput): string | null {
  const roster = listSessionAgents(db, input.sessionId);
  const self = roster.find((row) => row.agent.id === input.selfAgentId)?.agent;
  const leader = getLeader(db, input.sessionId);
  const others = roster
    .map((row) => row.agent)
    .filter((agent) => agent.id !== input.selfAgentId);
  // A single-assistant session is not a room; the roster would be noise.
  if (others.length === 0) return null;

  const isLeader = leader?.id === input.selfAgentId;
  const lines = others.map((agent) => `- ${labelFor(agent, leader?.id === agent.id)}：${summaryOf(agent)}`);
  const you = self?.name ?? getAgent(db, input.selfAgentId)?.name ?? '你';

  const rosterBlock = [
    `<room-agents you="${escapeAttr(you)}">`,
    isLeader
      ? '本房间的其他助手：'
      : '本房间的其他助手（你可以建议用户找他们，但你的 @ 不会召唤任何人 —— 需要补充时请让用户自己 @）：',
    ...lines,
    ...(isLeader ? [] : ['', '注意：你输出里写的 @名字 只是普通文本，不会生效。']),
    '</room-agents>',
  ].join('\n');

  if (!isLeader) return rosterBlock;
  return `${rosterBlock}\n\n${routingBlock()}`;
}

function routingBlock(): string {
  return [
    '<room-routing>',
    '你是这个房间的主答者。回答完用户的问题后，如果确实需要其他助手补充，可以在回复**最后单独一行**用 @名字 召唤他们（最多 3 个）。',
    '- 召唤只认**行首**的 @名字；正文中间、代码块、引用里的 @ 都只是文本',
    '- 你的回答要先说完，再 @ 别人 —— 不要只说「让 X 来看」就不说了',
    '- 只有你完全不擅长这个问题（真的答不上来），才可以只写 @ 不写内容',
    '- 补充是增量：说清楚你要他们补什么，不要让他们重复你刚说过的话',
    '- 不要叫不在上面列表里的人，最多 3 个',
    '</room-routing>',
  ].join('\n');
}

function labelFor(agent: Agent, isLeader: boolean): string {
  const name = agent.name.replace(/[[\]]/g, '）');
  const role = isLeader ? '（主手）' : '';
  const remote = agent.kind === 'peer' ? '（远端）' : '';
  return `${name}${role}${remote}`;
}

/** Empty summary falls back to the name; it is better than a blank line. */
function summaryOf(agent: Agent): string {
  return agent.summary.trim() || agent.name;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '”');
}
