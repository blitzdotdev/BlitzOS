export interface OnboardingQuestion {
  id: string
  prompt: string
  options: string[]
}

// FAKE questions, for walking the flow. In production an onboarding agent generates
// these from scraped macOS context — that's a SEPARATE agent's job and is not wired
// here yet. Swap this array for the agent's payload when the seam lands.
export const FAKE_QUESTIONS: OnboardingQuestion[] = [
  {
    id: 'focus',
    prompt: 'What should Blitz help you with first?',
    options: ['Triage my inbox', 'Plan my day', 'Research something', 'Build something', 'Just exploring']
  },
  {
    id: 'presence',
    prompt: 'How should Blitz show up?',
    options: ['Proactive — act for me', 'Suggestive — propose, I approve', 'Quiet — only when asked']
  },
  {
    id: 'work',
    prompt: 'What kind of work are you in?',
    options: ['Engineering', 'Design', 'Founder / ops', 'Research', 'Something else']
  },
  {
    id: 'apps',
    prompt: "What's open on your Mac most of the day?",
    options: ['Email & calendar', 'Code & terminal', 'Docs & notes', 'Design tools', 'A wall of browser tabs']
  },
  {
    id: 'trust',
    prompt: 'When Blitz acts on your accounts, how much rope?',
    options: ['Always ask first', 'Ask before anything is sent', 'Trust me on routine stuff']
  },
  {
    id: 'pace',
    prompt: 'How do you like information?',
    options: ['Dense & fast', 'Calm & spacious', 'Visual', 'Just the answer']
  },
  {
    id: 'rhythm',
    prompt: 'When does your day really start?',
    options: ['Before 7am', 'Morning', 'Midday', 'Night owl']
  },
  {
    id: 'limits',
    prompt: 'Anything Blitz should never touch?',
    options: ['Personal messages', 'Financial stuff', "Nothing's off-limits", "I'll decide per-thing"]
  }
]
