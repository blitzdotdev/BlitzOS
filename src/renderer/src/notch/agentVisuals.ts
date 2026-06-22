// Shared visual language for agent identity chips/rails in the island.
export function agentGradient(id: string): string {
  // Spread hues by the golden angle so sequential agent ids ('0','1','2'...) get maximally different colors.
  let n = 0
  for (let i = 0; i < id.length; i++) n = (n * 33 + id.charCodeAt(i)) >>> 0
  const base = /^\d+$/.test(id) ? parseInt(id, 10) : n
  const h = (base * 137.508) % 360
  return `radial-gradient(120% 120% at 28% 18%, rgba(255,255,255,0.42) 0%, transparent 40%), linear-gradient(145deg, hsl(${h} 85% 60%), hsl(${(h + 50) % 360} 80% 56%) 45%, hsl(${(h + 110) % 360} 82% 60%))`
}
