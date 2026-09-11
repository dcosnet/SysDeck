/**
 * Fester weighted scheduler — port of backend/scheduler/optimizer.py.
 * score = (100 - cpu_load) - temp + policy bonus - instability*10
 */

import type { NodeState } from './nodes'

export interface ScheduleDecision {
  node: string
  score: number
  reason: string
  scores: { node: string; score: number }[]
}

export function chooseBestNode(states: NodeState[], policy?: Map<string, 'preferred' | 'avoid'>): ScheduleDecision {
  let best: NodeState | null = null
  let bestScore = -Infinity
  const scores: { node: string; score: number }[] = []

  for (const s of states) {
    if (s.state === 'offline') continue
    let score = 100 - s.cpu_load - s.temp
    const pol = policy?.get(s.name)
    if (pol === 'preferred') score += 20
    if (pol === 'avoid') score -= 50
    score -= s.instability * 10
    // prefer nodes with free job slots
    score -= (s.active_jobs / Math.max(1, s.max_jobs)) * 30
    s.score = Math.round(score * 10) / 10
    scores.push({ node: s.name, score: s.score })
    if (score > bestScore) {
      bestScore = score
      best = s
    }
  }

  const chosen = best ?? states[0]
  return {
    node: chosen.name,
    score: Math.round((chosen.score ?? bestScore) * 10) / 10,
    reason: `cpu ${chosen.cpu_load.toFixed(0)}% · temp ${chosen.temp.toFixed(0)}°C · jobs ${chosen.active_jobs}/${chosen.max_jobs}`,
    scores: scores.sort((a, b) => b.score - a.score),
  }
}
