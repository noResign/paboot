/**
 * User-facing agent name.
 *
 * Implicit agents are daemon stand-ins for pre-agent sessions; their internal
 * names like `默认 (claude)` describe implementation details, not a person.
 * In a room the chosen main speaker is simply the leader.
 */
export function agentDisplayName(agent: {
  id: string;
  name: string;
  role?: 'leader' | 'member';
}): string {
  if (agent.role === 'leader' && (agent.id.startsWith('implicit:') || agent.name.startsWith('默认'))) {
    return '主答';
  }
  return agent.name;
}
