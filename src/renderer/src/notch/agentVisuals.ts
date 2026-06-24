// Shared visual language for agent identity chips/rails in the island.
export function agentGradient(id: string): string {
  // Blitz (the primary agent '0') is the OS itself, not just another peer — so it wears the BlitzOS theme:
  // the island blue fading into obsidian black, instead of a random golden-angle hue.
  if (id === '0') {
    return 'radial-gradient(120% 120% at 28% 18%, rgba(255,255,255,0.4) 0%, transparent 42%), linear-gradient(150deg, #2a93ff 0%, #0066d6 40%, #08203c 72%, #05060a 100%)'
  }
  // Spread hues by the golden angle so sequential peer ids ('1','2'...) get maximally different colors.
  let n = 0
  for (let i = 0; i < id.length; i++) n = (n * 33 + id.charCodeAt(i)) >>> 0
  const base = /^\d+$/.test(id) ? parseInt(id, 10) : n
  const h = (base * 137.508) % 360
  return `radial-gradient(120% 120% at 28% 18%, rgba(255,255,255,0.42) 0%, transparent 40%), linear-gradient(145deg, hsl(${h} 85% 60%), hsl(${(h + 50) % 360} 80% 56%) 45%, hsl(${(h + 110) % 360} 82% 60%))`
}
